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

#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

const MAIN_WINDOW: &str = "main";
const SETUP_GRANT_BYTES: usize = 32;

/// Minimal desktop bridge, installed before any page script. It exposes the
/// one-use first-password grant only; no other desktop capability is reachable
/// from the console document. The origin and top-frame checks keep the bridge
/// out of iframes and any other document.
fn desktop_bridge(service_url: &Url) -> String {
    let origin = service_url.origin().ascii_serialization();
    let origin = serde_json::to_string(&origin).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  if (window.top !== window.self) return;
  if (window.location.origin !== {origin}) return;
  if ('amosDesktop' in window) return;
  const invokeGrant = () => window.__TAURI__.core.invoke('get_setup_grant');
  Object.defineProperty(window, 'amosDesktop', {{
    value: Object.freeze({{ isDesktop: true, getSetupGrant: () => invokeGrant() }}),
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
    setup_grant: Mutex<Option<String>>,
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

/// Spawn the desktop launcher, which in turn starts the CLI with a private IPC
/// channel. The grant travels only in the launcher's environment.
fn spawn_control_plane(app: &AppHandle, setup_grant: &str) -> Result<(Child, String), String> {
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
    let (url_tx, url_rx) = mpsc::channel::<String>();
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
                            if text.contains("本地控制台:") {
                                if let Some(url) = text.split_whitespace().last() {
                                    let _ = pending.send(url.to_string());
                                    sender = None;
                                }
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
            Ok(url) => return Ok((child, url)),
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

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let setup_grant = generate_setup_grant()?;
            let (child, service_url) = spawn_control_plane(app.handle(), &setup_grant)?;

            app.manage(ServiceState {
                process: Mutex::new(Some(child)),
                service_url: service_url.clone(),
                setup_grant: Mutex::new(Some(setup_grant)),
            });

            let window_url =
                Url::parse(&service_url).map_err(|_| "Failed to parse service URL".to_string())?;
            let bridge = desktop_bridge(&window_url);

            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(window_url))
                .title("Amos 控制台")
                .inner_size(1200.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .initialization_script(bridge)
                .on_navigation(move |url| is_service_document(url, &service_url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_setup_grant])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut process) = app_handle.state::<ServiceState>().process.lock() {
                if let Some(mut child) = process.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
