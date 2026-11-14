// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

struct ServiceState {
    process: Mutex<Option<Child>>,
}

#[tauri::command]
fn get_service_url(state: State<ServiceState>) -> Result<String, String> {
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
    use std::io::{BufRead, BufReader};
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        if let Ok(line) = line {
            if line.contains("本地控制台:") {
                if let Some(url) = line.split_whitespace().last() {
                    return Ok((child, url.to_string()));
                }
            }
        }
    }

    Err("Failed to parse service URL".to_string())
}

fn main() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
