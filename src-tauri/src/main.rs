// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const URL_TIMEOUT: Duration = Duration::from_secs(15);
const URL_POLL_INTERVAL: Duration = Duration::from_millis(100);
const LAUNCHER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

const MAIN_WINDOW: &str = "main";
const SETUP_GRANT_BYTES: usize = 32;

/// Minimal desktop bridge, installed before any page script. It exposes the
/// one-use first-password grant and the window controls the frameless window
/// needs; no other desktop capability is reachable from the console document.
/// The origin and top-frame checks keep the bridge out of iframes and any
/// other document.
fn desktop_bridge(service_url: &Url) -> String {
    let origin = service_url.origin().ascii_serialization();
    let origin = serde_json::to_string(&origin).unwrap_or_else(|_| "\"\"".to_string());
    let native_controls = cfg!(target_os = "macos");
    format!(
        r#"(() => {{
  if (window.top !== window.self) return;
  if (window.location.origin !== {origin}) return;
  if ('amosDesktop' in window) return;
  const invoke = command => window.__TAURI__.core.invoke(command);
  Object.defineProperty(window, 'amosDesktop', {{
    value: Object.freeze({{
      isDesktop: true,
      nativeWindowControls: {native_controls},
      getSetupGrant: () => invoke('get_setup_grant'),
      startWindowDrag: () => invoke('start_window_drag'),
      minimize: () => invoke('minimize_main_window'),
      toggleMaximize: () => invoke('toggle_main_window_maximize'),
      close: () => invoke('close_main_window')
    }}),
    writable: false,
    enumerable: true,
    configurable: false
  }});
}})();"#
    )
}

struct ServiceState {
    process: Mutex<Option<Child>>,
    service_url: String,
    /// One-use, ten-minute first-password grant. Taken by the main window.
    /// `None` when the launcher attached to an already running console, so the
    /// web UI falls back to human-token enrollment.
    setup_grant: Mutex<Option<String>>,
}

/// Whether this desktop session owns the service process or attached to one
/// that was already running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServiceMode {
    Owned,
    Reused,
}

/// Parse the launcher's URL startup line. The owned launcher forwards the
/// CLI's line; a reused session reports the existing console instead.
fn classify_startup_line(line: &str) -> Option<(ServiceMode, String)> {
    for (marker, mode) in [
        ("已有控制台:", ServiceMode::Reused),
        ("本地控制台:", ServiceMode::Owned),
    ] {
        let Some((_, rest)) = line.split_once(marker) else {
            continue;
        };
        let Some(url) = rest.split_whitespace().next() else {
            continue;
        };
        let Ok(parsed) = Url::parse(url) else {
            continue;
        };
        if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
            continue;
        }
        return Some((mode, url.to_string()));
    }
    None
}

/// 32 cryptographic random bytes as lowercase hex, the shape the control plane
/// accepts for `AMOS_SETUP_GRANT`.
fn generate_setup_grant() -> Result<String, String> {
    use std::fmt::Write as _;

    let mut bytes = [0u8; SETUP_GRANT_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| "Failed to generate setup grant".to_string())?;
    let mut grant = String::with_capacity(SETUP_GRANT_BYTES * 2);
    for byte in bytes {
        let _ = write!(&mut grant, "{byte:02x}");
    }
    Ok(grant)
}

#[cfg(any(debug_assertions, target_os = "linux"))]
fn find_node_on_path() -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(NODE_BIN))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(debug_assertions)]
fn control_plane_paths(
    _app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Failed to get project root")?
        .to_path_buf();
    let launcher_path = root.join("dist/control-plane/desktop-launcher.js");
    let node_path = find_node_on_path()
        .ok_or_else(|| format!("Node executable '{}' not found on PATH", NODE_BIN))?;
    Ok((node_path, launcher_path, root))
}

#[cfg(not(debug_assertions))]
fn control_plane_paths(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    #[cfg(target_os = "linux")]
    let node_path = find_node_on_path()
        .ok_or("Node.js 26 or later is required; executable 'node' was not found on PATH")?;
    #[cfg(not(target_os = "linux"))]
    let node_path = {
        let exe_path =
            std::env::current_exe().map_err(|e| format!("Failed to get executable path: {}", e))?;
        let exe_dir = exe_path
            .parent()
            .ok_or("Failed to get executable directory")?;
        exe_dir.join(NODE_BIN)
    };
    let launcher_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?
        .join("app/dist/control-plane/desktop-launcher.js");
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| {
        format!(
            "Failed to create app data directory {}: {}",
            data_dir.display(),
            e
        )
    })?;
    Ok((node_path, launcher_path, data_dir))
}

/// Spawn the desktop launcher, which either starts the CLI with a private IPC
/// channel or attaches to an existing console. The grant travels only in the
/// launcher's environment; a reused session never receives it.
fn spawn_control_plane(
    app: &AppHandle,
    setup_grant: &str,
) -> Result<(Child, ServiceMode, String), String> {
    let (node_path, launcher_path, working_dir) = control_plane_paths(app)?;

    if !node_path.is_file() {
        return Err(format!(
            "Node executable not found at {}",
            node_path.display()
        ));
    }

    if !launcher_path.is_file() {
        return Err(format!(
            "Control plane launcher not found at {}",
            launcher_path.display()
        ));
    }

    let mut child = Command::new(&node_path)
        .arg(&launcher_path)
        .current_dir(&working_dir)
        .env("AMOS_SETUP_GRANT", setup_grant)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn control plane launcher: {}", e))?;

    // Read stdout to get the URL
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // The URL is the first of several startup lines. Keep draining stdout to
    // EOF on a background thread so the child never writes into a closed pipe
    // (EPIPE) after the URL has been observed. Later lines are discarded; the
    // CLI also prints token file paths, which do not belong in application
    // logs. stderr stays inherited for diagnostics.
    let (url_tx, url_rx) = mpsc::channel::<(ServiceMode, String)>();
    if let Err(error) = thread::Builder::new()
        .name("control-plane-stdout".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut sender = Some(url_tx);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {
                        if let Some(pending) = sender.as_ref() {
                            let text = String::from_utf8_lossy(&line);
                            if let Some(startup) = classify_startup_line(&text) {
                                let _ = pending.send(startup);
                                sender = None;
                            }
                        }
                    }
                }
            }
        })
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Failed to start stdout reader: {}", error));
    }

    let deadline = Instant::now() + URL_TIMEOUT;
    loop {
        match url_rx.recv_timeout(URL_POLL_INTERVAL) {
            Ok((mode, url)) => return Ok((child, mode, url)),
            Err(RecvTimeoutError::Disconnected) => {
                let detail = match child.try_wait() {
                    Ok(Some(status)) => format!(" ({})", status),
                    _ => String::new(),
                };
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Control plane exited before reporting its service URL{}",
                    detail
                ));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Control plane exited before reporting its service URL ({})",
                    status
                ));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to poll control plane: {}", error));
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Timed out after {}s waiting for the control plane URL",
                URL_TIMEOUT.as_secs()
            ));
        }
    }
}

/// Stop only the launcher. Closing its stdin asks an owned launcher to forward
/// SIGTERM to its own service and exit; a reused launcher exits without touching
/// the existing service. A launcher that does not exit is killed after a bounded
/// wait.
fn shutdown_launcher(child: &mut Child) {
    drop(child.stdin.take());

    let deadline = Instant::now() + LAUNCHER_SHUTDOWN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// A navigable console document: exact loopback origin and path, no query,
/// userinfo, or alternate scheme. The fragment is local state and is ignored.
fn is_service_document(candidate: &Url, service_url: &str) -> bool {
    let Ok(expected) = Url::parse(service_url) else {
        return false;
    };
    if expected.scheme() != "http" || expected.host_str() != Some("127.0.0.1") {
        return false;
    }
    let (Some(expected_port), Some(candidate_port)) = (expected.port(), candidate.port()) else {
        return false;
    };

    candidate.scheme() == "http"
        && candidate.host_str() == Some("127.0.0.1")
        && candidate_port == expected_port
        && candidate.path() == "/"
        && candidate.query().is_none()
        && candidate.username().is_empty()
        && candidate.password().is_none()
}

/// Hand the first-password grant to the desktop console exactly once. The
/// grant is released only to the trusted main window while it shows the live
/// service document and the launcher process is still running.
#[tauri::command]
fn get_setup_grant(
    window: WebviewWindow,
    state: State<ServiceState>,
) -> Result<Option<String>, String> {
    if window.label() != MAIN_WINDOW {
        return Err("setup_grant_denied".to_string());
    }
    let current = window.url().map_err(|_| "setup_grant_denied".to_string())?;
    if !is_service_document(&current, &state.service_url) {
        return Err("setup_grant_denied".to_string());
    }
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "setup_grant_unavailable".to_string())?;
        let running = match process.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            return Err("setup_grant_unavailable".to_string());
        }
    }
    let mut grant = state
        .setup_grant
        .lock()
        .map_err(|_| "setup_grant_unavailable".to_string())?;
    Ok(grant.take())
}

/// Shared trust boundary for console document window controls: the main
/// window while it shows the live service document, exactly like the grant.
fn window_control_guard(window: &WebviewWindow, state: &ServiceState) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("window_control_denied".to_string());
    }
    let current = window.url().map_err(|_| "window_control_denied".to_string())?;
    if !is_service_document(&current, &state.service_url) {
        return Err("window_control_denied".to_string());
    }
    Ok(())
}

#[tauri::command]
fn minimize_main_window(window: WebviewWindow, state: State<ServiceState>) -> Result<(), String> {
    window_control_guard(&window, &state)?;
    window
        .minimize()
        .map_err(|_| "window_control_failed".to_string())
}

#[tauri::command]
fn toggle_main_window_maximize(
    window: WebviewWindow,
    state: State<ServiceState>,
) -> Result<(), String> {
    window_control_guard(&window, &state)?;
    let maximized = window
        .is_maximized()
        .map_err(|_| "window_control_failed".to_string())?;
    let result = if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
    result.map_err(|_| "window_control_failed".to_string())
}

#[tauri::command]
fn close_main_window(window: WebviewWindow, state: State<ServiceState>) -> Result<(), String> {
    window_control_guard(&window, &state)?;
    window
        .close()
        .map_err(|_| "window_control_failed".to_string())
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow, state: State<ServiceState>) -> Result<(), String> {
    window_control_guard(&window, &state)?;
    window
        .start_dragging()
        .map_err(|_| "window_control_failed".to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let setup_grant = generate_setup_grant()?;
            let (child, mode, service_url) = spawn_control_plane(app.handle(), &setup_grant)?;

            app.manage(ServiceState {
                process: Mutex::new(Some(child)),
                service_url: service_url.clone(),
                setup_grant: Mutex::new(match mode {
                    ServiceMode::Owned => Some(setup_grant),
                    ServiceMode::Reused => None,
                }),
            });

            let window_url =
                Url::parse(&service_url).map_err(|_| "Failed to parse service URL".to_string())?;
            let bridge = desktop_bridge(&window_url);

            let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(window_url))
                .inner_size(1200.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .initialization_script(bridge)
                .on_navigation(move |url| is_service_document(url, &service_url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

            // Frameless window. macOS overlays the native close/minimize/zoom
            // buttons on the content; every other platform drops the native
            // buttons too and the console document draws its own controls.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.decorations(false);
            }

            builder.build()?;

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_setup_grant,
            minimize_main_window,
            toggle_main_window_maximize,
            close_main_window,
            start_window_drag
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut process) = app_handle.state::<ServiceState>().process.lock() {
                if let Some(mut child) = process.take() {
                    shutdown_launcher(&mut child);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_owned_startup_line() {
        assert_eq!(
            classify_startup_line("Amos Governance 本地控制台: http://127.0.0.1:4310\n"),
            Some((ServiceMode::Owned, "http://127.0.0.1:4310".to_string()))
        );
    }

    #[test]
    fn classifies_reused_startup_line() {
        assert_eq!(
            classify_startup_line("Amos Governance 已有控制台: http://127.0.0.1:51234\r\n"),
            Some((ServiceMode::Reused, "http://127.0.0.1:51234".to_string()))
        );
    }

    #[test]
    fn ignores_api_only_and_foreign_startup_lines() {
        assert_eq!(
            classify_startup_line(
                "Amos Governance 治理 API（无控制台界面）: http://127.0.0.1:4310\n"
            ),
            None
        );
        assert_eq!(
            classify_startup_line("Amos Governance 已有控制台: https://example.com\n"),
            None
        );
        assert_eq!(classify_startup_line("模式: managed opt-in"), None);
    }
}
