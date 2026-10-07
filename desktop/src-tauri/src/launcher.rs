// What the launcher window (desktop/launcher) asks the app for
// (plans/desktop-app.md T10).
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::local_server::Status;
use crate::servers::{ServerEntry, LOCAL_ID};
use crate::{alerts, tray, windows, AppState};

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
    state.servers.update(&id, name.as_deref(), url.as_deref(), notify)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_server(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    state.servers.remove(&id)?;
    if let Some(w) = app.get_webview_window(&windows::label_for(&id)) {
        let _ = w.close();
    }
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
