fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "get_setup_grant",
                    "minimize_main_window",
                    "toggle_main_window_maximize",
                    "close_main_window",
                    "start_window_drag",
                    "pick_workspace_directory",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}
