// OS notifications for every saved server with Notify on, whether or not its
// window is open (plans/desktop-app.md T17). One background listener per
// server reads the `notify` events Perch writes to /api/open-url/events,
// signed in with the cookies of that server's own window profile; a click
// opens the server and switches to the terminal the alert was about.
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::{paths, windows, AppState};

const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Alerts {
    // A generation per server: bumping it tells a running listener to stop.
    generations: Mutex<HashMap<String, u64>>,
    // Servers whose stream said 401: shown in the launcher as "sign in to
    // get alerts" until a window load gives the listener a cookie.
    needs_sign_in: Mutex<HashSet<String>>,
}

impl Alerts {
    pub fn needs_sign_in(&self, id: &str) -> bool {
        self.needs_sign_in.lock().unwrap().contains(id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlertPayload {
    title: String,
    body: String,
    window_id: Option<String>,
}

/// Starts a listener for each server with Notify on, and stops the rest.
/// Call whenever the server list or a notify switch changes.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let wanted: Vec<String> = state
        .servers
        .list(state.local.port())
        .into_iter()
        .filter(|s| s.notify)
        .map(|s| s.id)
        .collect();
    let mut generations = state.alerts.generations.lock().unwrap();
    let running: Vec<String> = generations.keys().cloned().collect();
    for id in running {
        if !wanted.contains(&id) {
            generations.remove(&id);
        }
    }
    for id in wanted {
        if generations.contains_key(&id) {
            continue;
        }
        let generation = next_generation();
        generations.insert(id.clone(), generation);
        let app = app.clone();
        tauri::async_runtime::spawn(async move { listen(app, id, generation).await });
    }
}

/// A server window finished loading: its cookies may have just changed (a
/// sign-in), so reconnect that server's listener now rather than after its
/// backoff.
pub fn window_loaded(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let restart = {
        let mut generations = state.alerts.generations.lock().unwrap();
        generations.remove(id).is_some()
    };
    if restart {
        sync(app);
    }
}

fn next_generation() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn current(app: &AppHandle, id: &str, generation: u64) -> bool {
    app.state::<AppState>().alerts.generations.lock().unwrap().get(id) == Some(&generation)
}

async fn listen(app: AppHandle, id: String, generation: u64) {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("http client");
    let mut backoff = Duration::from_secs(1);
    while current(&app, &id, generation) {
        match stream_once(&app, &client, &id, generation).await {
            // Connected, then dropped: try again soon.
            Ok(true) => backoff = Duration::from_secs(1),
            // Unreachable: back off, up to a minute.
            Ok(false) => {}
            Err(Unauthorized) => {
                set_needs_sign_in(&app, &id, true);
                backoff = MAX_BACKOFF;
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

struct Unauthorized;

// One connection, until it drops. Ok(whether it connected) for anything
// but a sign-in problem.
async fn stream_once(app: &AppHandle, client: &reqwest::Client, id: &str, generation: u64) -> Result<bool, Unauthorized> {
    let state = app.state::<AppState>();
    let Some(entry) = state.servers.get(id, state.local.port()) else { return Ok(false) };
    if entry.url.is_empty() {
        return Ok(false); // the local server isn't running
    }
    let Ok(base) = Url::parse(&entry.url) else { return Ok(false) };
    let Ok(events) = base.join("api/open-url/events") else { return Ok(false) };
    let mut request = client.get(events).header("Accept", "text/event-stream");
    if let Some(cookie) = cookie_header(app, id, &base).await {
        request = request.header("Cookie", cookie);
    }
    let Ok(response) = request.send().await else { return Ok(false) };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Unauthorized);
    }
    if !response.status().is_success() {
        return Ok(false);
    }
    set_needs_sign_in(app, id, false);
    let mut body = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = body.next().await {
        if !current(app, id, generation) {
            return Ok(true);
        }
        let Ok(chunk) = chunk else { return Ok(true) };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..end + 2).collect();
            if let Some(data) = notify_data(&frame) {
                if let Ok(alert) = serde_json::from_str::<AlertPayload>(&data) {
                    show(app, id, &alert.title, &alert.body, alert.window_id.as_deref());
                }
            }
        }
    }
    Ok(true)
}

/// The data of a `notify` event in one SSE frame, if it is one.
fn notify_data(frame: &str) -> Option<String> {
    let mut event = None;
    let mut data = Vec::new();
    for line in frame.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            event = Some(v.trim());
        } else if let Some(v) = line.strip_prefix("data:") {
            data.push(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    (event == Some("notify") && !data.is_empty()).then(|| data.join("\n"))
}

// The server window's cookies when it's open (saved for later), else the
// ones saved the last time it was.
async fn cookie_header(app: &AppHandle, id: &str, base: &Url) -> Option<String> {
    let saved = saved_cookie_path(id);
    if let Some(window) = app.get_webview_window(&windows::label_for(id)) {
        let base = base.clone();
        // Not on the main thread: on Windows that would deadlock.
        let cookies = tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(base))
            .await
            .ok()
            .and_then(|r| r.ok());
        if let Some(cookies) = cookies {
            let header = cookies
                .iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ");
            if !header.is_empty() {
                let _ = std::fs::create_dir_all(saved.parent().unwrap());
                let _ = std::fs::write(&saved, &header);
                return Some(header);
            }
        }
    }
    std::fs::read_to_string(saved).ok().filter(|h| !h.is_empty())
}

fn saved_cookie_path(id: &str) -> PathBuf {
    paths::profile_dir(id).join("alert-cookies")
}

fn set_needs_sign_in(app: &AppHandle, id: &str, on: bool) {
    let state = app.state::<AppState>();
    let changed = {
        let mut set = state.alerts.needs_sign_in.lock().unwrap();
        if on { set.insert(id.to_string()) } else { set.remove(id) }
    };
    if changed {
        let _ = app.emit_to(windows::LAUNCHER, "servers-changed", ());
    }
}

/// Shows one alert as an OS notification. A click (where the OS reports
/// one) opens the server's window on the terminal it's about.
pub fn show(app: &AppHandle, server_id: &str, title: &str, body: &str, window_id: Option<&str>) {
    let state = app.state::<AppState>();
    let server_name = state
        .servers
        .get(server_id, state.local.port())
        .map(|s| s.name)
        .unwrap_or_else(|| "Perch".into());
    // Perch's own alerts are titled with its app name ("perch"); the server's
    // name says more.
    let summary = if title.eq_ignore_ascii_case("perch") { server_name } else { format!("{server_name}: {title}") };
    let mut notification = notify_rust::Notification::new();
    notification.summary(&summary).body(body).appname("Perch");
    // Linux: the icon by file path, since an AppImage or a development
    // build has none in the icon theme, plus the installed desktop entry
    // (the .deb's and .rpm's Perch.desktop) for desktops that group by app.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(icon) = icon_path() {
            notification.icon(&icon.to_string_lossy());
        }
        notification.hint(notify_rust::Hint::DesktopEntry("Perch".into()));
    }
    // Windows: notify-rust otherwise posts as PowerShell, with its icon. The
    // installer's Start menu shortcut carries this id.
    #[cfg(windows)]
    notification.app_id(crate::paths::IDENTIFIER);
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");

    let app = app.clone();
    let server_id = server_id.to_string();
    let window_id = window_id.map(str::to_string);
    std::thread::spawn(move || {
        let Ok(handle) = notification.show() else { return };
        #[cfg(all(unix, not(target_os = "macos")))]
        handle.wait_for_action(|action| {
            if action == "default" || action == "Open" {
                open_alert(&app, &server_id, window_id.as_deref());
            }
        });
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            let _ = (handle, &app, &server_id, &window_id);
        }
    });
}

fn open_alert(app: &AppHandle, server_id: &str, window_id: Option<&str>) {
    let script = window_id.map(|id| {
        format!("window.__perchDesktop.focusTerminal({});", serde_json::to_string(id).unwrap())
    });
    windows::open_server_then(app, server_id, script);
}


// The app icon, written once to the data dir for notifications to point at.
#[cfg(all(unix, not(target_os = "macos")))]
fn icon_path() -> Option<PathBuf> {
    static ICON: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    ICON.get_or_init(|| {
        let path = paths::data_dir().join("notification-icon.png");
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, include_bytes!("../icons/128x128.png")).ok()?;
        Some(path)
    })
    .clone()
}

/// macOS shows a notification with the icon of the app it says it's from;
/// without this, notify-rust says Finder. Call once at startup.
pub fn init() {
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(crate::paths::IDENTIFIER);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_notify_frames_only() {
        let frame = "event: notify\ndata: {\"title\":\"perch\",\"body\":\"x\"}\n\n";
        assert_eq!(notify_data(frame).as_deref(), Some("{\"title\":\"perch\",\"body\":\"x\"}"));
        assert_eq!(notify_data("data: {\"url\":\"https://x\"}\n\n"), None, "an open-url message");
        assert_eq!(notify_data("event: open-target\ndata: {}\n\n"), None);
        assert_eq!(notify_data(": ping\n\n"), None);
    }
}
