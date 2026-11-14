// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const URL_TIMEOUT: Duration = Duration::from_secs(15);
const URL_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

struct ServiceState {
    process: Mutex<Option<Child>>,
}

#[tauri::command]
fn get_service_url(_state: State<ServiceState>) -> Result<String, String> {
    // Service URL will be returned from the spawned process
    Ok("http://127.0.0.1:3000".to_string())
}

#[cfg(any(debug_assertions, target_os = "linux"))]
fn find_node_on_path() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(NODE_BIN))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(debug_assertions)]
fn control_plane_paths(_app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Failed to get project root")?
        .to_path_buf();
    let cli_path = root.join("dist/control-plane/cli.js");
    let node_path = find_node_on_path()
        .ok_or_else(|| format!("Node executable '{}' not found on PATH", NODE_BIN))?;
    Ok((node_path, cli_path, root))
}

#[cfg(not(debug_assertions))]
fn control_plane_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
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
    let cli_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?
        .join("app/dist/control-plane/cli.js");
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
    Ok((node_path, cli_path, data_dir))
}

fn spawn_control_plane(app: &AppHandle) -> Result<(Child, String), String> {
    let (node_path, cli_path, working_dir) = control_plane_paths(app)?;

    if !node_path.is_file() {
        return Err(format!(
            "Node executable not found at {}",
            node_path.display()
        ));
    }

    if !cli_path.is_file() {
        return Err(format!(
            "Control plane CLI not found at {}",
            cli_path.display()
        ));
    }

    let mut child = Command::new(&node_path)
        .arg(&cli_path)
        .arg("serve")
        .arg("--port")
        .arg("0")
        .current_dir(&working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn control plane: {}", e))?;

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

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (child, url) = spawn_control_plane(app.handle())
                .map_err(|e| format!("Failed to start control plane: {}", e))?;

            app.manage(ServiceState {
                process: Mutex::new(Some(child)),
            });

            // Open the main window with the service URL
            let window = app.get_webview_window("main").unwrap();
            window
                .eval(&format!("window.location.href = '{}'", url))
                .map_err(|e| format!("Failed to navigate: {}", e))?;

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_service_url])
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
