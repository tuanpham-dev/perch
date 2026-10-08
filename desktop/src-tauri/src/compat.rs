// Whether a server and this app can work together (plans/app-versioning.md
// R18, R19). Each side knows the oldest version of the other it supports:
// the server says so in its public /version.json, the app here. Outside that
// range the window still opens, with a banner naming both versions and the
// fix.
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::servers::{ServerEntry, ServerKind};
use crate::windows;

/// The oldest server this app works with.
pub const MIN_SERVER_VERSION: &str = "0.1.0";

/// What a server said when asked its version.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    Answered { version: String, min_app: Option<String> },
    // It answered, but not with a version: a Perch from before versions
    // (R19).
    Missing,
    // Nothing answered: no verdict either way.
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Ok,
    ServerTooOld,
    AppTooOld,
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionJson {
    version: String,
    min_desktop_version: Option<String>,
}

fn parse(v: &str) -> Option<Version> {
    Version::parse(v.trim().trim_start_matches('v')).ok()
}

pub fn verdict(app: &str, probe: &Probe) -> Verdict {
    match probe {
        Probe::Unreachable => Verdict::Unknown,
        Probe::Missing => Verdict::ServerTooOld,
        Probe::Answered { version, min_app } => {
            let (Some(server), Some(min_server)) = (parse(version), parse(MIN_SERVER_VERSION)) else {
                return Verdict::ServerTooOld;
            };
            if server < min_server {
                return Verdict::ServerTooOld;
            }
            match (min_app.as_deref().and_then(parse), parse(app)) {
                (Some(min_app), Some(app)) if app < min_app => Verdict::AppTooOld,
                _ => Verdict::Ok,
            }
        }
    }
}

/// One line for the launcher's row, when the two don't fit.
pub fn note(probe: &Probe) -> Option<String> {
    match (verdict_for_this_app(probe), probe) {
        (Verdict::ServerTooOld, _) => Some(format!("Older than this app supports ({MIN_SERVER_VERSION}+)")),
        (Verdict::AppTooOld, Probe::Answered { min_app: Some(min), .. }) => Some(format!("Needs app {min} or newer")),
        _ => None,
    }
}

/// The window banner's text: both versions and the fix.
pub fn banner_text(app: &str, name: &str, probe: &Probe) -> Option<String> {
    match (verdict(app, probe), probe) {
        (Verdict::ServerTooOld, Probe::Answered { version, .. }) => Some(format!(
            "{name} runs Perch {version}, older than this app supports ({MIN_SERVER_VERSION} or newer). Some features stay unavailable until the server is updated: run perch update there."
        )),
        (Verdict::ServerTooOld, _) => Some(format!(
            "{name} runs a Perch older than this app supports ({MIN_SERVER_VERSION} or newer). Some features stay unavailable until the server is updated: run perch update there."
        )),
        (Verdict::AppTooOld, Probe::Answered { version, min_app: Some(min), .. }) => Some(format!(
            "{name} runs Perch {version}, which needs desktop app {min} or newer (this is {app}). Update the app to use everything it offers."
        )),
        _ => None,
    }
}

fn verdict_for_this_app(probe: &Probe) -> Verdict {
    verdict(env!("CARGO_PKG_VERSION"), probe)
}

pub fn version_of(probe: &Probe) -> Option<String> {
    match probe {
        Probe::Answered { version, .. } => Some(version.clone()),
        _ => None,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default()
}

/// Asks a server (its address ending in "/") for its version.
pub async fn probe(url: &str) -> Probe {
    probe_with(&client(), url).await
}

async fn probe_with(client: &reqwest::Client, url: &str) -> Probe {
    let Ok(base) = url::Url::parse(url) else { return Probe::Unreachable };
    let Ok(target) = base.join("version.json") else { return Probe::Unreachable };
    let Ok(response) = client.get(target).send().await else { return Probe::Unreachable };
    // Sent elsewhere (a sign-in proxy in front of the server): what's
    // behind it is unknown, not old.
    if response.url().origin() != base.origin() {
        return Probe::Unreachable;
    }
    if response.status().is_server_error() {
        return Probe::Unreachable;
    }
    // A Perch from before versions answers 404, or its page for any path.
    let body = response.bytes().await.unwrap_or_default();
    match serde_json::from_slice::<VersionJson>(&body) {
        Ok(v) => Probe::Answered { version: v.version, min_app: v.min_desktop_version },
        Err(_) => Probe::Missing,
    }
}

/// Every server's version at once, in the order given; Local is the
/// bundled server, the app's own version, so it isn't asked.
pub async fn probe_all(entries: &[ServerEntry]) -> Vec<Probe> {
    let client = client();
    futures_util::future::join_all(entries.iter().map(|e| {
        let client = client.clone();
        async move {
            if e.url.is_empty() {
                Probe::Unreachable
            } else if e.kind == ServerKind::Local {
                Probe::Answered { version: env!("CARGO_PKG_VERSION").into(), min_app: None }
            } else {
                probe_with(&client, &e.url).await
            }
        }
    }))
    .await
}

/// After a server window's page loads: asks the server its version, and
/// when it and this app don't fit, shows the banner in the page. Local never
/// needs it (the same version as the app).
pub fn check_window(app: &AppHandle, label: &str) {
    let Some(id) = windows::server_id_of(label) else { return };
    // Top-level windows only; a popped-out tab doesn't repeat it.
    if label.contains(':') {
        return;
    }
    let state = app.state::<crate::AppState>();
    let Some(entry) = state.servers.get(id, state.local.port()) else { return };
    if entry.kind == ServerKind::Local {
        return;
    }
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let probe = probe(&entry.url).await;
        let version = app.package_info().version.to_string();
        let Some(text) = banner_text(&version, &entry.name, &probe) else { return };
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.eval(banner_script(&text));
        }
    });
}

fn banner_script(text: &str) -> String {
    let text = serde_json::to_string(text).unwrap();
    format!(
        r#"(function () {{
  if (document.getElementById("perch-compat-banner")) return;
  var b = document.createElement("div");
  b.id = "perch-compat-banner";
  b.setAttribute("role", "status");
  b.style.cssText = "position:fixed;top:calc(12px + var(--titlebar-bottom, 40px));left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:flex-start;gap:10px;max-width:min(640px,calc(100vw - 24px));padding:8px 12px;background:var(--panel-bg,#22262c);color:var(--fg,#d6dae0);border:1px solid #d9a33a;border-radius:6px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)";
  var t = document.createElement("span");
  t.textContent = "⚠ " + {text};
  var x = document.createElement("button");
  x.textContent = "×";
  x.setAttribute("aria-label", "Dismiss");
  x.style.cssText = "background:none;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px";
  x.onclick = function () {{ b.remove(); }};
  b.append(t, x);
  document.body.appendChild(b);
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(version: &str, min_app: Option<&str>) -> Probe {
        Probe::Answered { version: version.into(), min_app: min_app.map(Into::into) }
    }

    #[test]
    fn fits_within_both_ranges() {
        assert_eq!(verdict("0.2.0", &answered("0.2.0", Some("0.1.0"))), Verdict::Ok);
        assert_eq!(verdict("0.2.0", &answered("0.5.0", None)), Verdict::Ok);
    }

    #[test]
    fn a_server_below_the_minimum_is_too_old() {
        assert_eq!(verdict("0.2.0", &answered("0.0.9", Some("0.1.0"))), Verdict::ServerTooOld);
        // A pre-release sorts before its release (SemVer).
        assert_eq!(verdict("0.2.0", &answered("0.1.0-rc.1", None)), Verdict::ServerTooOld);
        assert_eq!(verdict("0.2.0", &answered("nonsense", None)), Verdict::ServerTooOld);
    }

    #[test]
    fn a_server_without_versions_is_too_old() {
        assert_eq!(verdict("0.2.0", &Probe::Missing), Verdict::ServerTooOld);
        assert!(banner_text("0.2.0", "box", &Probe::Missing).unwrap().contains("older than this app supports"));
    }

    #[test]
    fn an_app_below_the_servers_minimum_is_too_old() {
        assert_eq!(verdict("0.2.0", &answered("0.3.0", Some("0.3.0"))), Verdict::AppTooOld);
        let text = banner_text("0.2.0", "box", &answered("0.3.0", Some("0.3.0"))).unwrap();
        assert!(text.contains("0.3.0") && text.contains("this is 0.2.0"), "{text}");
    }

    #[test]
    fn unreachable_says_nothing() {
        assert_eq!(verdict("0.2.0", &Probe::Unreachable), Verdict::Unknown);
        assert_eq!(banner_text("0.2.0", "box", &Probe::Unreachable), None);
        assert_eq!(note(&Probe::Unreachable), None);
    }
}
