// One window per server (plans/desktop-app.md T11, T12). Each loads the
// server's own page, in its own browser profile, frameless (Perch draws the
// title bar), with exactly the native commands that server may call.
use std::sync::atomic::Ordering;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::servers::{ServerEntry, ServerKind, LOCAL_ID};
use crate::{paths, AppState};

pub const LAUNCHER: &str = "launcher";

pub fn label_for(server_id: &str) -> String {
    format!("server-{server_id}")
}

/// The server id a window label belongs to, for a server window or one of
/// its child windows (`server-<id>` / `server-<id>:<n>`).
pub fn server_id_of(label: &str) -> Option<&str> {
    let rest = label.strip_prefix("server-")?;
    Some(rest.split(':').next().unwrap_or(rest))
}

// Commands every server's page may call (bridge.rs). The local-only ones
// are added on top for the bundled server's window.
const BASE_COMMANDS: &[&str] = &[
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_is_maximized",
    "window_start_dragging",
    "window_set_decorations",
    "show_notification",
    "open_external",
];
const LOCAL_COMMANDS: &[&str] = &["reveal_path", "open_with_default", "pick_folder"];

pub fn show_launcher(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("Perch")
        .inner_size(560.0, 480.0)
        .min_inner_size(420.0, 320.0)
        .build();
}

/// Tells the launcher something went wrong, and brings it up to say so.
pub fn report_error(app: &AppHandle, message: impl Into<String>) {
    show_launcher(app);
    let _ = app.emit_to(LAUNCHER, "launcher-error", message.into());
}

/// Opens (or focuses) a server's window, starting the bundled server first
/// when it's the local one. Returns at once; the work runs on a thread.
pub fn open_server(app: &AppHandle, id: &str) {
    open_server_then(app, id, None);
}

/// Like `open_server`, then runs `script` in the page once Perch's desktop
/// hooks are installed (perch:// links, notification clicks).
pub fn open_server_then(app: &AppHandle, id: &str, script: Option<String>) {
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let label = label_for(&id);
        if let Some(w) = app.get_webview_window(&label) {
            focus(&w);
            if let Some(script) = script {
                eval_when_ready(&app, &label, &script);
            }
            return;
        }
        let state = app.state::<AppState>();
        let entry = if id == LOCAL_ID {
            crate::tray::refresh(&app);
            let result = state.local.ensure_running();
            crate::tray::refresh(&app);
            let _ = app.emit_to(LAUNCHER, "servers-changed", ());
            match result {
                Ok(port) => state.servers.get(LOCAL_ID, Some(port)),
                Err(status) => {
                    report_error(&app, describe_local_failure(&status));
                    return;
                }
            }
        } else {
            state.servers.get(&id, state.local.port())
        };
        let Some(entry) = entry else {
            report_error(&app, "That server isn't in the list any more.");
            return;
        };
        if let Some(script) = script {
            state.pending_scripts.lock().unwrap().entry(label.clone()).or_default().push(script);
        }
        if let Err(e) = build_server_window(&app, &entry) {
            report_error(&app, format!("Couldn't open {}: {e}", entry.name));
        }
    });
}

fn describe_local_failure(status: &crate::local_server::Status) -> String {
    use crate::local_server::Status;
    match status {
        Status::Missing => "This build of Perch has no bundled server.".into(),
        Status::Failed { message, log_tail } if !log_tail.is_empty() => format!("{message}\n\n{log_tail}"),
        Status::Failed { message, .. } => message.clone(),
        _ => "The local server isn't running.".into(),
    }
}

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn build_server_window(app: &AppHandle, entry: &ServerEntry) -> tauri::Result<()> {
    let url: Url = entry.url.parse().map_err(|_| tauri::Error::InvalidWebviewUrl("server address"))?;
    let origin = url.origin().ascii_serialization();
    let label = label_for(&entry.id);
    let is_local = entry.kind == ServerKind::Local;
    add_capability(app, &entry.id, &origin, is_local);

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(format!("{} - Perch", entry.name))
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 400.0);
    let builder = configure(app, builder, entry, &origin, is_local);
    builder.build()?;
    Ok(())
}

// Everything a server window and its child windows share: profile, chrome,
// what the page learns about itself, and where its links may go.
fn configure<'a>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    entry: &ServerEntry,
    origin: &str,
    is_local: bool,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let info = serde_json::json!({
        "platform": platform(),
        "version": app.package_info().version.to_string(),
        "isLocal": is_local,
    });
    let builder = builder
        .initialization_script(format!("window.__PERCH_DESKTOP__ = Object.freeze({info});"))
        // File drops go to the page's own upload handling; Tauri's handler
        // would swallow them (plans/desktop-app.spike.md).
        .disable_drag_drop_handler()
        .data_directory(paths::profile_dir(&entry.id));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .data_store_identifier(*uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, entry.id.as_bytes()).as_bytes());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    let nav_origin = origin.to_string();
    let nav_app = app.clone();
    let popup_origin = origin.to_string();
    let popup_app = app.clone();
    let popup_entry = entry.clone();
    builder
        .on_navigation(move |u| {
            if u.origin().ascii_serialization() == nav_origin || u.scheme() == "about" {
                return true;
            }
            open_external(&nav_app, u.as_str());
            false
        })
        .on_new_window(move |u, features| {
            if u.origin().ascii_serialization() != popup_origin {
                open_external(&popup_app, u.as_str());
                return NewWindowResponse::Deny;
            }
            // Same site: a tab popped out into its own window. It gets the
            // same profile and commands as its parent.
            let state = popup_app.state::<AppState>();
            let n = state.child_counter.fetch_add(1, Ordering::Relaxed);
            let label = format!("{}:{n}", label_for(&popup_entry.id));
            let child = WebviewWindowBuilder::new(&popup_app, &label, WebviewUrl::External(u.clone()))
                .title("Perch")
                .window_features(features);
            let child = configure(&popup_app, child, &popup_entry, &popup_origin, popup_entry.kind == ServerKind::Local);
            match child.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        })
        .on_page_load(|webview, payload| {
            let label = webview.label().to_string();
            let state = webview.app_handle().state::<AppState>();
            match payload.event() {
                PageLoadEvent::Started => {
                    state.loaded.lock().unwrap().remove(&label);
                }
                PageLoadEvent::Finished => {
                    state.loaded.lock().unwrap().insert(label.clone());
                    let pending = state.pending_scripts.lock().unwrap().remove(&label).unwrap_or_default();
                    for script in pending {
                        let _ = webview.eval(wait_for_hooks(&script));
                    }
                    if let Some(id) = server_id_of(&label) {
                        crate::alerts::window_loaded(webview.app_handle(), id);
                    }
                }
            }
        })
}

/// Runs `script` in a server window once its page has loaded.
pub fn eval_when_ready(app: &AppHandle, label: &str, script: &str) {
    let state = app.state::<AppState>();
    if state.loaded.lock().unwrap().contains(label) {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.eval(wait_for_hooks(script));
            return;
        }
    }
    state.pending_scripts.lock().unwrap().entry(label.to_string()).or_default().push(script.to_string());
}

// The page installs window.__perchDesktop from a React effect, a moment
// after the load event: retry for up to ten seconds.
fn wait_for_hooks(script: &str) -> String {
    format!(
        "(function run(n) {{ if (window.__perchDesktop) {{ {script} }} else if (n > 0) setTimeout(function () {{ run(n - 1); }}, 200); }})(50);"
    )
}

fn add_capability(app: &AppHandle, id: &str, origin: &str, is_local: bool) {
    let mut cap = CapabilityBuilder::new(format!("server-{id}"))
        .window(label_for(id))
        .window(format!("{}:*", label_for(id)))
        .remote(format!("{origin}/*"));
    for cmd in BASE_COMMANDS.iter().chain(if is_local { LOCAL_COMMANDS } else { &[] }) {
        cap = cap.permission(format!("allow-{}", cmd.replace('_', "-")));
    }
    // Already added when this server's window was open before; the
    // capability is unchanged, so the error is harmless.
    let _ = app.add_capability(cap);
}

pub fn open_external(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let Ok(parsed) = Url::parse(url) else { return };
    if parsed.scheme() == "http" || parsed.scheme() == "https" || parsed.scheme() == "mailto" {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_labels_to_servers() {
        assert_eq!(label_for("local"), "server-local");
        assert_eq!(server_id_of("server-local"), Some("local"));
        assert_eq!(server_id_of("server-local:3"), Some("local"));
        assert_eq!(server_id_of("server-1b2c-uuid"), Some("1b2c-uuid"));
        assert_eq!(server_id_of("launcher"), None);
    }
}
