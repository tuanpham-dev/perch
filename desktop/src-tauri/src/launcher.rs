// What the launcher window (desktop/launcher) asks the app for
// (plans/desktop-app.md T10).
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::local_server::Status;
use crate::servers::{ServerEntry, LOCAL_ID};
use crate::{alerts, paths, tray, windows, AppState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    entry: ServerEntry,
    // A remote server's stream refused the saved sign-in.
    needs_sign_in: bool,
    open: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherState {
    servers: Vec<ServerView>,
    local: Status,
}

#[tauri::command]
pub async fn list_servers(app: AppHandle) -> LauncherState {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let local = state.local.status();
        let port = match local {
            Status::Running { port } => Some(port),
            _ => None,
        };
        let servers = state
            .servers
            .list(port)
            .into_iter()
            .map(|entry| ServerView {
                needs_sign_in: state.alerts.needs_sign_in(&entry.id),
                open: app.get_webview_window(&windows::label_for(&entry.id)).is_some(),
                entry,
            })
            .collect();
        LauncherState { servers, local }
    })
    .await
    .unwrap_or(LauncherState { servers: Vec::new(), local: Status::Stopped })
}

fn changed(app: &AppHandle) {
    alerts::sync(app);
    tray::refresh(app);
    let _ = app.emit_to(windows::LAUNCHER, "servers-changed", ());
}

#[tauri::command]
pub fn add_server(app: AppHandle, state: State<AppState>, name: String, url: String) -> Result<ServerEntry, String> {
    let entry = state.servers.add(&name, &url)?;
    changed(&app);
    Ok(entry)
}

#[tauri::command]
pub fn update_server(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    name: Option<String>,
    url: Option<String>,
    notify: Option<bool>,
) -> Result<(), String> {
    let before = state.servers.get(&id, state.local.port()).map(|s| s.url);
    state.servers.update(&id, name.as_deref(), url.as_deref(), notify)?;
    let after = state.servers.get(&id, state.local.port()).map(|s| s.url);
    // A window shows the address it was opened on, and Open would only
    // focus it: a changed address closes the server's windows, so the next
    // Open builds one on the new address (with a capability to match).
    if before != after {
        for (label, w) in app.webview_windows() {
            if windows::server_id_of(&label) == Some(id.as_str()) {
                let _ = w.destroy();
            }
        }
    }
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_server(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    state.servers.remove(&id)?;
    // Its window and any tab popped out of it.
    for (label, w) in app.webview_windows() {
        if windows::server_id_of(&label) == Some(id.as_str()) {
            let _ = w.destroy();
        }
    }
    // Its browser profile holds the server's sign-in cookies (and the copy
    // alerts use): a removed server shouldn't stay signed in on disk. Once
    // the windows' web processes have let go of it.
    let profile = paths::profile_dir(&id);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let _ = std::fs::remove_dir_all(profile);
    });
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn open_server(app: AppHandle, id: String) {
    windows::open_server(&app, &id);
}

#[tauri::command]
pub fn start_local(app: AppHandle) {
    windows::open_server(&app, LOCAL_ID);
}

#[tauri::command]
pub async fn stop_local(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || app2.state::<AppState>().local.stop())
        .await
        .map_err(|e| e.to_string())?;
    changed(&app);
    result
}

/// Looks for an installed Perch again. The launcher calls this every few
/// seconds while it's visible.
#[tauri::command]
pub async fn detect_installed(app: AppHandle) -> bool {
    let app2 = app.clone();
    let found_change = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        state.servers.detect_installed(state.local.port())
    })
    .await
    .unwrap_or(false);
    if found_change {
        changed(&app);
    }
    found_change
}
