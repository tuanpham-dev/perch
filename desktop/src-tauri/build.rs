// Declares the app's own commands, so capabilities can grant them one by
// one (allow-<command>): every server window gets the base set, the bundled
// server's window the file commands too (src/windows.rs), the launcher its
// own (capabilities/launcher.json).
const COMMANDS: &[&str] = &[
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_is_maximized",
    "window_start_dragging",
    "window_set_decorations",
    "show_notification",
    "open_external",
    "reveal_path",
    "open_with_default",
    "pick_folder",
    "list_servers",
    "add_server",
    "update_server",
    "remove_server",
    "open_server",
    "start_local",
    "stop_local",
    "detect_installed",
    "server_versions",
    "get_update_state",
    "check_updates",
    "restart_to_update",
    "set_update_settings",
    "open_release_page",
    "spike_report",
];

fn main() {
    // `cargo build`/`cargo test` straight from a clone: tauri's codegen refuses
    // a missing frontendDist, and only `tauri dev`/`tauri build` run the
    // launcher build first (tauri.conf.json's before*Command).
    let _ = std::fs::create_dir_all("../launcher/dist");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
