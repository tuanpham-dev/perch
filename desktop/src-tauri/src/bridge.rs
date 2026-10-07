// The native commands a server's page may call (plans/desktop-app.md T13),
// reached through client/src/desktop.ts. Which window may call which is set
// per window by windows.rs's capabilities; the file commands also check the
// caller themselves, so a remote page can't reach the desktop's files even
// if a capability were ever too broad.
use tauri::{AppHandle, Manager, Url, Webview, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::servers::LOCAL_ID;
use crate::{paths, windows, AppState};

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized { window.unmaximize() } else { window.maximize() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/// Perch's "Use custom title bar" setting: off gives the window back the
/// OS's own title bar.
#[tauri::command]
pub fn window_set_decorations(app: AppHandle, window: WebviewWindow, on: bool) -> Result<(), String> {
    app.state::<AppState>().app_pages.lock().unwrap().insert(window.label().to_string());
    #[cfg(target_os = "macos")]
    {
        let style = if on { tauri::TitleBarStyle::Visible } else { tauri::TitleBarStyle::Overlay };
        window.set_title_bar_style(style).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_decorations(on).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn show_notification(app: AppHandle, webview: Webview, title: String, body: String) {
    if let Some(id) = windows::server_id_of(webview.label()) {
        crate::alerts::show(&app, id, &title, &body, None);
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Not a web address.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https addresses open outside the app.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, webview: Webview, path: String) -> Result<(), String> {
    let path = local_path(&app, &webview, &path)?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_with_default(app: AppHandle, webview: Webview, path: String) -> Result<(), String> {
    let path = local_path(&app, &webview, &path)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, webview: Webview, start: Option<String>) -> Result<Option<String>, String> {
    check_local(&app, &webview)?;
    let mut dialog = app.dialog().file().set_title("Open Folder");
    if let Some(start) = start {
        let dir = paths::expand_home(&start);
        if dir.is_dir() {
            dialog = dialog.set_directory(dir);
        }
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

fn local_path(app: &AppHandle, webview: &Webview, raw: &str) -> Result<std::path::PathBuf, String> {
    check_local(app, webview)?;
    let path = paths::expand_home(raw);
    if !path.is_absolute() {
        return Err("Give a full path.".into());
    }
    Ok(path)
}

fn check_local(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let local = app.state::<AppState>().local.port().map(|p| format!("http://127.0.0.1:{p}"));
    let url = webview.url().map_err(|e| e.to_string())?;
    if is_local_caller(webview.label(), &url, local.as_deref()) {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

/// Only the bundled server's own windows, showing that server's page, may
/// touch this machine's files.
pub fn is_local_caller(label: &str, url: &Url, local_origin: Option<&str>) -> bool {
    windows::server_id_of(label) == Some(LOCAL_ID)
        && local_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_local_window_on_the_local_origin_is_local() {
        let local = Some("http://127.0.0.1:3101");
        let page: Url = "http://127.0.0.1:3101/?x=1".parse().unwrap();
        let other: Url = "https://perch.example.com/".parse().unwrap();
        assert!(is_local_caller("server-local", &page, local));
        assert!(is_local_caller("server-local:2", &page, local));
        assert!(!is_local_caller("server-local", &other, local), "navigated away");
        assert!(!is_local_caller("server-installed", &page, local), "another window");
        assert!(!is_local_caller("server-local", &page, None), "local server down");
        assert!(!is_local_caller("launcher", &page, local));
    }
}
