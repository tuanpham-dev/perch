// The Perch server bundled with the app (plans/desktop-app.md T15). It runs
// as a detached process so it outlives the app, the same way Perch's
// terminals outlive a browser tab; a state file remembers which process and
// port, and which bundle it was started from, so the next launch reattaches
// or, after an app update, restarts it (terminals survive a server restart:
// they belong to the terminal daemon, not the server).
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::paths;
use crate::probe;

pub const DEFAULT_PORT: u16 = 3101;
const LAST_PORT: u16 = 3199;
const START_TIMEOUT: Duration = Duration::from_secs(20);
// A Unix socket path longer than this fails to bind on macOS (104 bytes,
// including the terminator) - see plans/desktop-app.spike.md.
const MAX_SOCKET_PATH: usize = 100;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Running { port: u16 },
    Stopped,
    // The app was built without a server bundle (a development build with no
    // PERCH_DESKTOP_BUNDLE).
    Missing,
    Failed { message: String, log_tail: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct StateFile {
    pid: u32,
    port: u16,
    commit: String,
}

#[derive(Deserialize, Clone, Debug)]
struct BundleInfo {
    #[allow(dead_code)]
    version: String,
    commit: String,
}

pub struct LocalServer {
    bundle: Option<PathBuf>,
    data: PathBuf,
}

impl LocalServer {
    pub fn new(resource_dir: Option<PathBuf>) -> Self {
        Self { bundle: paths::server_bundle_dir(resource_dir), data: paths::data_dir().join("perch") }
    }

    fn state_path(&self) -> PathBuf {
        self.data.join("local-server.json")
    }

    pub fn log_path(&self) -> PathBuf {
        self.data.join("server.log")
    }

    fn read_state(&self) -> Option<StateFile> {
        serde_json::from_str(&std::fs::read_to_string(self.state_path()).ok()?).ok()
    }

    fn write_state(&self, state: &StateFile) -> Result<(), String> {
        std::fs::create_dir_all(&self.data).map_err(|e| e.to_string())?;
        std::fs::write(self.state_path(), serde_json::to_string(state).unwrap()).map_err(|e| e.to_string())
    }

    fn bundle_info(&self) -> Option<(PathBuf, BundleInfo)> {
        let dir = self.bundle.clone()?;
        let info = serde_json::from_str(&std::fs::read_to_string(dir.join("server-bundle.json")).ok()?).ok()?;
        Some((dir, info))
    }

    /// The port it's answering on, if it is.
    pub fn port(&self) -> Option<u16> {
        let state = self.read_state()?;
        probe::is_perch(state.port).then_some(state.port)
    }

    pub fn status(&self) -> Status {
        if let Some(port) = self.port() {
            return Status::Running { port };
        }
        if self.bundle_info().is_none() {
            return Status::Missing;
        }
        Status::Stopped
    }

    /// Makes sure the bundled server is running this bundle's version, and
    /// returns its port. Blocks while it starts, so call it off the main
    /// thread.
    pub fn ensure_running(&self) -> Result<u16, Status> {
        let (shipped, bundle) = self.bundle_info().ok_or(Status::Missing)?;
        if let Some(state) = self.read_state() {
            if probe::is_perch(state.port) {
                if state.commit == bundle.commit {
                    return Ok(state.port);
                }
                // An app update brought a different server: restart it.
                let _ = self.stop();
            }
        }
        let dir = self
            .runtime_copy(&shipped, &bundle)
            .map_err(|message| Status::Failed { message, log_tail: String::new() })?;
        self.start(&dir, &bundle)
    }

    /// The bundle copied out of the app into the data dir, once per version.
    /// The server runs from there, and so does the terminal daemon it
    /// starts, which outlives both server and app: files it holds open must
    /// not be the app's own, or an update (Windows refuses to replace a file
    /// in use) or a rebuild would fail. The two most recent other copies are
    /// kept, for daemons still running from them.
    fn runtime_copy(&self, shipped: &Path, bundle: &BundleInfo) -> Result<PathBuf, String> {
        let root = self.data.join("runtime");
        let dir = root.join(&bundle.commit);
        if dir.join(".complete").exists() {
            return Ok(dir);
        }
        let partial = root.join(format!("{}.partial", bundle.commit));
        let _ = std::fs::remove_dir_all(&partial);
        copy_dir(shipped, &partial).map_err(|e| format!("Couldn't copy the bundled server: {e}"))?;
        std::fs::write(partial.join(".complete"), "").map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&partial, &dir).map_err(|e| e.to_string())?;
        prune_runtimes(&root, &bundle.commit);
        Ok(dir)
    }

    fn start(&self, dir: &Path, bundle: &BundleInfo) -> Result<u16, Status> {
        let fail = |message: String| Status::Failed { message, log_tail: self.log_tail() };
        let preferred = self.read_state().map(|s| s.port).unwrap_or(DEFAULT_PORT);
        let port = free_port(preferred).ok_or_else(|| fail(format!("No free port between {DEFAULT_PORT} and {LAST_PORT}.")))?;
        let config_dir = self.data.join("config");
        let state_dir = state_dir_for(&self.data.join("state"));
        std::fs::create_dir_all(&config_dir).map_err(|e| fail(e.to_string()))?;
        std::fs::create_dir_all(&state_dir).map_err(|e| fail(e.to_string()))?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
            .map_err(|e| fail(e.to_string()))?;

        let mut cmd = Command::new(node_binary(dir));
        cmd.arg(dir.join("node_modules").join("tsx").join("dist").join("cli.mjs"))
            .arg(dir.join("server").join("src").join("index.ts"))
            .current_dir(dir.join("server"))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| fail(e.to_string()))?))
            .stderr(Stdio::from(log));
        // Whatever launched the app (a Perch terminal, say) may have left its
        // own Perch settings in the environment; the bundled server's shells
        // must report to it, not to that one.
        for (key, _) in std::env::vars() {
            if key.starts_with("PERCH_") || key.starts_with("TMUX_SERVER_") || key == "BROWSER" || key == "AUTH_TOKEN" {
                cmd.env_remove(key);
            }
        }
        cmd.env("PORT", port.to_string())
            .env("PERCH_CONFIG_DIR", &config_dir)
            .env("PERCH_STATE_DIR", &state_dir)
            .env("PERCH_LAUNCHER", "desktop");
        detach(&mut cmd);
        let child = cmd.spawn().map_err(|e| fail(format!("Couldn't start the bundled server: {e}")))?;
        let pid = child.id();
        // Not waited on: it runs on after the app quits.
        drop(child);
        self.write_state(&StateFile { pid, port, commit: bundle.commit.clone() })
            .map_err(fail)?;

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if probe::is_perch(port) {
                return Ok(port);
            }
            if !pid_alive(pid) {
                return Err(fail("The bundled server exited while starting.".into()));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(fail(format!("The bundled server didn't answer on port {port} within {}s.", START_TIMEOUT.as_secs())))
    }

    /// Stops the server (not the terminal daemon, which keeps every terminal
    /// for the next start).
    pub fn stop(&self) -> Result<(), String> {
        let Some(state) = self.read_state() else { return Ok(()) };
        if !probe::is_perch(state.port) && !pid_alive(state.pid) {
            return Ok(());
        }
        terminate(state.pid)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && probe::is_perch(state.port) {
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// The last lines of the server's log, for a failed start.
    pub fn log_tail(&self) -> String {
        let text = std::fs::read_to_string(self.log_path()).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(20)..].join("\n")
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// Keeps the current copy and the two newest others.
fn prune_runtimes(root: &Path, current: &str) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut others: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy() != current)
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    others.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in others.into_iter().skip(2) {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn node_binary(bundle: &Path) -> PathBuf {
    if cfg!(windows) {
        bundle.join("node").join("node.exe")
    } else {
        bundle.join("node").join("bin").join("node")
    }
}

fn free_port(preferred: u16) -> Option<u16> {
    std::iter::once(preferred)
        .chain(DEFAULT_PORT..=LAST_PORT)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

/// The state dir, unless the terminal daemon's socket inside it would be too
/// long a path; then a short one (Windows uses named pipes, no limit).
fn state_dir_for(preferred: &Path) -> PathBuf {
    if cfg!(windows) || preferred.join("daemon.sock").as_os_str().len() <= MAX_SOCKET_PATH {
        return preferred.to_path_buf();
    }
    short_state_dir()
}

#[cfg(unix)]
fn short_state_dir() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    if cfg!(target_os = "linux") {
        if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
            let dir = PathBuf::from(runtime).join("perch-desktop");
            if dir.join("daemon.sock").as_os_str().len() <= MAX_SOCKET_PATH {
                return dir;
            }
        }
    }
    PathBuf::from(format!("/tmp/perch-desktop-{uid}"))
}

#[cfg(not(unix))]
fn short_state_dir() -> PathBuf {
    std::env::temp_dir().join("perch-desktop")
}

#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(unix)]
fn terminate(pid: u32) -> Result<(), String> {
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } == 0 {
        Ok(())
    } else {
        Err(format!("Couldn't stop process {pid}."))
    }
}

#[cfg(windows)]
fn terminate(pid: u32) -> Result<(), String> {
    let ok = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok { Ok(()) } else { Err(format!("Couldn't stop process {pid}.")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_short_state_dir() {
        let short = PathBuf::from("/home/me/.local/share/dev.perch.desktop/perch/state");
        assert_eq!(state_dir_for(&short), short);
    }

    #[cfg(unix)]
    #[test]
    fn swaps_a_long_state_dir_for_a_short_one() {
        let long = PathBuf::from(format!("/home/{}/state", "x".repeat(120)));
        let dir = state_dir_for(&long);
        assert_ne!(dir, long);
        assert!(dir.join("daemon.sock").as_os_str().len() <= MAX_SOCKET_PATH);
    }

    #[test]
    fn copies_and_prunes_runtimes() {
        let root = std::env::temp_dir().join(format!("perch-runtime-{}", uuid::Uuid::new_v4()));
        let shipped = root.join("shipped");
        std::fs::create_dir_all(shipped.join("node").join("bin")).unwrap();
        std::fs::write(shipped.join("node").join("bin").join("node"), "bin").unwrap();
        std::fs::write(shipped.join("server-bundle.json"), r#"{"version":"0.1.0","commit":"c4"}"#).unwrap();
        let server = LocalServer { bundle: Some(shipped.clone()), data: root.join("data") };
        for old in ["c1", "c2", "c3"] {
            std::fs::create_dir_all(root.join("data").join("runtime").join(old)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (dir, info) = server.bundle_info().unwrap();
        let copy = server.runtime_copy(&dir, &info).unwrap();
        assert_eq!(std::fs::read_to_string(copy.join("node").join("bin").join("node")).unwrap(), "bin");
        let mut left: Vec<String> = std::fs::read_dir(root.join("data").join("runtime"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["c2", "c3", "c4"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_a_free_port() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let found = free_port(port).unwrap();
        assert_ne!(found, port);
        assert!((DEFAULT_PORT..=LAST_PORT).contains(&found));
    }
}
