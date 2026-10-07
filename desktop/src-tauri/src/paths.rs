// Where the app keeps things. Computed without a running Tauri app, so the
// headless `perch-desktop start|stop|status` (cli.rs) finds the same files
// the GUI does.
use std::path::PathBuf;

pub const IDENTIFIER: &str = "dev.perch.desktop";

/// The app's data dir: the same one Tauri's `app_data_dir()` resolves to
/// (`~/.local/share/dev.perch.desktop` on Linux, `~/Library/Application
/// Support/dev.perch.desktop` on macOS, `%APPDATA%\dev.perch.desktop` on
/// Windows).
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(IDENTIFIER)
}

/// The app's config dir, for servers.json.
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(IDENTIFIER)
}

/// A server window's own browser profile (cookies, storage), so each server
/// keeps its own sign-in.
pub fn profile_dir(server_id: &str) -> PathBuf {
    data_dir().join("profiles").join(server_id)
}

/// The staged Perch server the app ships (desktop/scripts/stage-server.mjs).
/// `PERCH_DESKTOP_BUNDLE` points elsewhere, for development.
pub fn server_bundle_dir(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PERCH_DESKTOP_BUNDLE") {
        return Some(PathBuf::from(dir));
    }
    resource_dir.map(|dir| dir.join("perch"))
}

/// The home dir, for expanding a leading `~` in a path a page hands over.
pub fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/code/a.txt"), home.join("code/a.txt"));
        assert_eq!(expand_home("/tmp/x"), PathBuf::from("/tmp/x"));
        assert_eq!(expand_home("~user/x"), PathBuf::from("~user/x"));
    }
}
