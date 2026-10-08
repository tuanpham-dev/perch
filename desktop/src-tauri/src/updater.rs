// The app updating itself (plans/app-versioning.md R14-R17). With its own
// automatic check on, it asks at launch and every 6 hours whether a newer
// release exists on its channel. On macOS, Windows and the AppImage the
// update downloads in the background and waits for "Restart to update";
// installed from a .deb or .rpm, where the system's package manager owns the
// files, it only says a new version exists and links to it. Only updates
// signed with the project's key (tauri.conf.json's plugins.updater.pubkey)
// install.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{paths, tray, windows, AppState};

const REPO: &str = "tuanpham-dev/perch";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const TICK: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

/// The app's own update switches, kept apart from any server's Settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "yes")]
    pub auto_check: bool,
    #[serde(default)]
    pub channel: Channel,
}

fn yes() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { auto_check: true, channel: Channel::Stable }
    }
}

fn settings_path() -> PathBuf {
    paths::config_dir().join("app-settings.json")
}

fn load_settings() -> AppSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings).unwrap()).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Downloading,
    // Downloaded and verified: restarting installs it.
    Ready,
    // Notice only (.deb / .rpm): a newer version exists, nothing downloads.
    Available,
    Error,
}

/// What the launcher and the tray show.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub app_version: String,
    pub auto_check: bool,
    pub channel: Channel,
    pub phase: Phase,
    pub version: Option<String>,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
    pub notice_only: bool,
    pub release_url: Option<String>,
}

struct Inner {
    settings: AppSettings,
    phase: Phase,
    version: Option<String>,
    error: Option<String>,
    checked_at: Option<u64>,
    checked_channel: Option<Channel>,
    ready: Option<(Update, Vec<u8>)>,
}

pub struct Updates {
    inner: Mutex<Inner>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                settings: load_settings(),
                phase: Phase::Idle,
                version: None,
                error: None,
                checked_at: None,
                checked_channel: None,
                ready: None,
            }),
        }
    }
}

/// Installed by a package manager (Linux, not an AppImage): the app can't
/// replace its own files, so it only tells.
pub fn notice_only() -> bool {
    notice_only_for(cfg!(target_os = "linux"), std::env::var_os("APPIMAGE").is_some())
}

fn notice_only_for(linux: bool, appimage: bool) -> bool {
    linux && !appimage
}

fn release_page(version: &str) -> String {
    format!("https://github.com/{REPO}/releases/tag/v{version}")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Updates {
    pub fn view(&self, app: &AppHandle) -> UpdateView {
        let inner = self.inner.lock().unwrap();
        UpdateView {
            app_version: app.package_info().version.to_string(),
            auto_check: inner.settings.auto_check,
            channel: inner.settings.channel,
            phase: inner.phase,
            version: inner.version.clone(),
            error: inner.error.clone(),
            checked_at: inner.checked_at,
            notice_only: notice_only(),
            release_url: inner.version.as_deref().map(release_page),
        }
    }

    pub fn settings(&self) -> AppSettings {
        self.inner.lock().unwrap().settings.clone()
    }

    fn due(&self, now: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        if !inner.settings.auto_check || matches!(inner.phase, Phase::Checking | Phase::Downloading | Phase::Ready) {
            return false;
        }
        if inner.checked_channel.is_some_and(|c| c != inner.settings.channel) {
            return true;
        }
        inner.checked_at.is_none_or(|at| now.saturating_sub(at) >= CHECK_INTERVAL.as_millis() as u64)
    }
}

/// Where a channel's newest release manifest (latest.json) is. Stable is
/// GitHub's "latest release", which skips pre-releases; Beta looks the
/// newest one up, pre-releases included. `PERCH_DESKTOP_UPDATE_URL` points
/// both elsewhere, for testing. The updater plugin refuses a plain-http
/// address unless the build sets `plugins.updater.dangerousInsecureTransportProtocol`
/// (docs/DEVELOPMENT.md shows how), which shipped builds never do.
async fn endpoint(channel: Channel) -> Result<Url, String> {
    if let Ok(url) = std::env::var("PERCH_DESKTOP_UPDATE_URL") {
        return url.parse().map_err(|_| "PERCH_DESKTOP_UPDATE_URL isn't an address".to_string());
    }
    match channel {
        Channel::Stable => Ok(stable_endpoint()),
        Channel::Beta => {
            let body = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent(concat!("perch-desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| e.to_string())?
                .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=30"))
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .map_err(|_| "GitHub couldn't be reached".to_string())?
                .error_for_status()
                .map_err(|e| format!("GitHub answered {}", e.status().map(|s| s.as_u16()).unwrap_or(0)))?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            let releases: Vec<GhRelease> = serde_json::from_slice(&body).map_err(|_| "GitHub sent something unexpected".to_string())?;
            Ok(beta_endpoint(&releases).unwrap_or_else(stable_endpoint))
        }
    }
}

fn stable_endpoint() -> Url {
    format!("https://github.com/{REPO}/releases/latest/download/latest.json").parse().unwrap()
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// The newest published release (pre-releases included) that has a
/// latest.json.
fn beta_endpoint(releases: &[GhRelease]) -> Option<Url> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
            let asset = r.assets.iter().find(|a| a.name == "latest.json")?;
            Some((version, asset.browser_download_url.clone()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .and_then(|(_, url)| url.parse().ok())
}

fn describe(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => {
            "The update wasn't signed with Perch's update key, so it wasn't installed.".into()
        }
        E::Reqwest(_) | E::Network(_) => "The update server couldn't be reached.".into(),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => "The newest release has no update for this platform yet.".into(),
        other => other.to_string(),
    }
}

fn changed(app: &AppHandle) {
    let view = app.state::<AppState>().updates.view(app);
    let _ = app.emit_to(windows::LAUNCHER, "updates-changed", view);
    tray::refresh(app);
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Inner)) {
    f(&mut app.state::<AppState>().updates.inner.lock().unwrap());
    changed(app);
}

/// Checks now, and downloads what it finds where the app can install it.
pub async fn check(app: AppHandle) {
    let channel = {
        let state = app.state::<AppState>();
        let mut inner = state.updates.inner.lock().unwrap();
        // One at a time; a downloaded update waits for its restart.
        if matches!(inner.phase, Phase::Checking | Phase::Downloading | Phase::Ready) {
            return;
        }
        inner.phase = Phase::Checking;
        inner.error = None;
        inner.settings.channel
    };
    changed(&app);
    let result = check_inner(&app, channel).await;
    set(&app, |inner| {
        inner.checked_at = Some(now_ms());
        inner.checked_channel = Some(channel);
        match result {
            Ok(Found::None) => {
                inner.phase = Phase::UpToDate;
                inner.version = None;
            }
            Ok(Found::Notice(version)) => {
                inner.phase = Phase::Available;
                inner.version = Some(version);
            }
            Ok(Found::Downloaded(update, bytes)) => {
                inner.phase = Phase::Ready;
                inner.version = Some(update.version.clone());
                inner.ready = Some((update, bytes));
            }
            Err(e) => {
                inner.phase = Phase::Error;
                inner.error = Some(e);
            }
        }
    });
}

enum Found {
    None,
    Notice(String),
    Downloaded(Update, Vec<u8>),
}

async fn check_inner(app: &AppHandle, channel: Channel) -> Result<Found, String> {
    let url = endpoint(channel).await?;
    if notice_only() {
        return notice_check(url, &app.package_info().version).await;
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.timeout(Duration::from_secs(60)).build())
        .map_err(|e| describe(&e))?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(Found::None),
        // No release published yet (latest.json 404s).
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => return Ok(Found::None),
        Err(e) => return Err(describe(&e)),
    };
    let version = update.version.clone();
    set(app, |inner| {
        inner.phase = Phase::Downloading;
        inner.version = Some(version);
    });
    // download() checks the signature before handing the bytes over.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| describe(&e))?;
    Ok(Found::Downloaded(update, bytes))
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
}

async fn notice_check(url: Url, current: &semver::Version) -> Result<Found, String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|_| "The update server couldn't be reached.".to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Found::None);
    }
    let body = response
        .error_for_status()
        .map_err(|e| format!("The update server answered {}", e.status().map(|s| s.as_u16()).unwrap_or(0)))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&body).map_err(|_| "The update server sent something unexpected.".to_string())?;
    let latest = semver::Version::parse(manifest.version.trim_start_matches('v')).map_err(|e| e.to_string())?;
    Ok(if &latest > current { Found::Notice(latest.to_string()) } else { Found::None })
}

/// Background checks: one shortly after launch, then whenever 6 hours have
/// passed (or the channel changed), while automatic checks are on.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            if app.state::<AppState>().updates.due(now_ms()) {
                check(app.clone()).await;
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Installs the downloaded update and relaunches the app on it, reopening
/// the server windows that were open. The bundled server keeps running and
/// is restarted on the new version at the next launch (lib.rs), so its
/// terminals carry on.
pub fn restart_now(app: &AppHandle) -> Result<(), String> {
    let ready = app.state::<AppState>().updates.inner.lock().unwrap().ready.take();
    let Some((update, bytes)) = ready else { return Err("No update is ready.".into()) };
    remember_open_windows(app);
    if let Err(e) = update.install(&bytes) {
        set(app, |inner| {
            inner.phase = Phase::Error;
            inner.error = Some(describe(&e));
        });
        let _ = std::fs::remove_file(reopen_path());
        return Err(describe(&e));
    }
    // Windows: install() has already started the installer and exited.
    app.state::<AppState>().quitting.store(true, std::sync::atomic::Ordering::SeqCst);
    app.restart();
}

fn reopen_path() -> PathBuf {
    paths::data_dir().join("reopen-after-update.json")
}

fn remember_open_windows(app: &AppHandle) {
    let ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| !label.contains(':'))
        .filter_map(|label| windows::server_id_of(label).map(str::to_string))
        .collect();
    let _ = std::fs::create_dir_all(paths::data_dir());
    let _ = std::fs::write(reopen_path(), serde_json::to_string(&ids).unwrap());
}

/// The server windows to bring back after an update's restart (and
/// forgets them). None when this launch isn't one.
pub fn take_windows_to_reopen() -> Option<Vec<String>> {
    let text = std::fs::read_to_string(reopen_path()).ok()?;
    let _ = std::fs::remove_file(reopen_path());
    serde_json::from_str(&text).ok()
}

pub fn set_settings(app: &AppHandle, auto_check: Option<bool>, channel: Option<Channel>) -> Result<(), String> {
    let settings = {
        let state = app.state::<AppState>();
        let mut inner = state.updates.inner.lock().unwrap();
        if let Some(on) = auto_check {
            inner.settings.auto_check = on;
        }
        if let Some(channel) = channel {
            inner.settings.channel = channel;
        }
        // An answer for the other channel no longer counts.
        if inner.checked_channel.is_some_and(|c| c != inner.settings.channel) && inner.phase != Phase::Ready {
            inner.phase = Phase::Idle;
            inner.version = None;
        }
        inner.settings.clone()
    };
    save_settings(&settings)?;
    changed(app);
    if app.state::<AppState>().updates.due(now_ms()) {
        tauri::async_runtime::spawn(check(app.clone()));
    }
    Ok(())
}

// ---- Commands (the launcher) ---------------------------------------------

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> UpdateView {
    app.state::<AppState>().updates.view(&app)
}

#[tauri::command]
pub fn check_updates(app: AppHandle) {
    tauri::async_runtime::spawn(check(app));
}

#[tauri::command]
pub fn restart_to_update(app: AppHandle) -> Result<(), String> {
    restart_now(&app)
}

#[tauri::command]
pub fn set_update_settings(app: AppHandle, auto_check: Option<bool>, channel: Option<Channel>) -> Result<(), String> {
    set_settings(&app, auto_check, channel)
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) {
    let url = app
        .state::<AppState>()
        .updates
        .view(&app)
        .release_url
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    windows::open_external(&app, &url);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, manifest: bool) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            draft,
            assets: if manifest {
                vec![GhAsset { name: "latest.json".into(), browser_download_url: format!("https://example.test/{tag}/latest.json") }]
            } else {
                Vec::new()
            },
        }
    }

    #[test]
    fn beta_takes_the_newest_release_with_a_manifest() {
        let releases = vec![
            release("v0.2.0", false, true),
            release("v0.3.0-rc.1", false, true),
            release("v0.4.0", true, true),
            release("v0.3.0", false, false),
        ];
        assert_eq!(beta_endpoint(&releases).unwrap().as_str(), "https://example.test/v0.3.0-rc.1/latest.json");
        assert_eq!(beta_endpoint(&[]), None);
    }

    #[test]
    fn stable_is_githubs_latest_release() {
        assert_eq!(stable_endpoint().as_str(), "https://github.com/tuanpham-dev/perch/releases/latest/download/latest.json");
    }

    #[test]
    fn only_a_linux_package_install_is_notice_only() {
        assert!(notice_only_for(true, false));
        assert!(!notice_only_for(true, true));
        assert!(!notice_only_for(false, false));
    }

    #[test]
    fn settings_default_to_automatic_stable() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, AppSettings { auto_check: true, channel: Channel::Stable });
        let s: AppSettings = serde_json::from_str(r#"{"autoCheck":false,"channel":"beta"}"#).unwrap();
        assert_eq!(s, AppSettings { auto_check: false, channel: Channel::Beta });
    }
}
