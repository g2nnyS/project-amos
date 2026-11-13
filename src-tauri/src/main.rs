// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

struct ServiceState {
    process: Mutex<Option<Child>>,
}

#[tauri::command]
fn get_service_url(state: State<ServiceState>) -> Result<String, String> {
    // Service URL will be returned from the spawned process
    Ok("http://127.0.0.1:3000".to_string())
}

fn spawn_control_plane() -> Result<(Child, String), String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {}", e))?;
    
    let base_dir = exe_path
        .parent()
        .ok_or("Failed to get parent directory")?;
    
    // In development, use the project root
    #[cfg(debug_assertions)]
    let working_dir = base_dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or("Failed to get project root")?;
    
    // In production, resources are next to the executable
    #[cfg(not(debug_assertions))]
    let working_dir = base_dir;
    
    let cli_path = working_dir.join("dist/control-plane/cli.js");
    
    let mut child = Command::new("node")
        .arg(cli_path)
        .arg("serve")
        .arg("--port")
        .arg("0")
        .current_dir(working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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
            let (child, url) = spawn_control_plane()
                .map_err(|e| format!("Failed to start control plane: {}", e))?;
            
            app.manage(ServiceState {
                process: Mutex::new(Some(child)),
            });
            
            // Open the main window with the service URL
            let window = app.get_webview_window("main").unwrap();
            window.eval(&format!("window.location.href = '{}'", url))
                .map_err(|e| format!("Failed to navigate: {}", e))?;
            
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_service_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
