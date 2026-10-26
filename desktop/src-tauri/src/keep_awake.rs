// Keeps this computer from going to sleep on its own while a server's page
// asks for it (the Keep Awake extension, which decides when: always, or
// while agents work). A browser can only keep its screen on, and only while
// the tab is in front; the app holds the OS's own lock, window in front or
// not. The screen may still turn off; only the system stays up.
//
// Every window asks for itself, and the computer stays up while any one
// does. A window that closes or loads another page stops asking.
//
// How: caffeinate on macOS, systemd-inhibit on Linux, SetThreadExecutionState
// on Windows. The helper processes watch this app's pid, so a crash can't
// leave the computer unable to sleep.
use std::collections::HashSet;
use std::sync::Mutex;
#[cfg(all(unix, not(target_os = "macos")))]
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview};

use crate::AppState;

#[derive(Default)]
pub struct KeepAwake {
    // The webviews asking, by label.
    wanted: Mutex<HashSet<String>>,
    hold: Mutex<Option<Hold>>,
}

impl KeepAwake {
    fn set(&self, label: &str, on: bool) -> Result<(), String> {
        let want = {
            let mut wanted = self.wanted.lock().unwrap();
            if on {
                wanted.insert(label.to_string());
            } else {
                wanted.remove(label);
            }
            !wanted.is_empty()
        };
        let mut hold = self.hold.lock().unwrap();
        if want && hold.is_none() {
            match Hold::take() {
                Ok(h) => *hold = Some(h),
                Err(e) => {
                    self.wanted.lock().unwrap().remove(label);
                    return Err(e);
                }
            }
        } else if !want {
            *hold = None; // dropping it lets go
        }
        Ok(())
    }

    /// A window closed or left the page that asked.
    pub fn forget(&self, label: &str) {
        let _ = self.set(label, false);
    }
}

// ---- Holding the computer awake ---------------------------------------------

/// While this lives, the computer doesn't sleep on its own.
struct Hold {
    #[cfg(not(windows))]
    child: std::process::Child,
}

impl Hold {
    #[cfg(target_os = "macos")]
    fn take() -> Result<Self, String> {
        // -i: no idle system sleep; -w: until this app exits, however it does.
        let child = std::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn()
            .map_err(|e| format!("Couldn't run caffeinate: {e}"))?;
        Ok(Self { child })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn take() -> Result<Self, String> {
        // The inhibitor lasts as long as the command it runs: a loop that
        // ends when this app or systemd-inhibit itself is gone.
        let watch = format!("while kill -0 $PPID 2>/dev/null && kill -0 {} 2>/dev/null; do sleep 15; done", std::process::id());
        // Blocking sleep needs a desktop session's say-so (polkit); outside
        // one it's refused, and blocking idle alone is what's left.
        // --no-ask-password: refused at once rather than waiting on a
        // password prompt nobody sees.
        for what in ["--what=sleep:idle", "--what=idle"] {
            let mut child = std::process::Command::new("systemd-inhibit")
                .args(["--no-ask-password", what, "--who=Perch", "--why=Keep Awake is on in Perch", "--mode=block", "sh", "-c", &watch])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("Couldn't run systemd-inhibit (it comes with systemd): {e}"))?;
            // Refused: it exits at once.
            std::thread::sleep(Duration::from_millis(300));
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(Self { child });
            }
        }
        Err("systemd-inhibit refused to keep the computer awake".into())
    }

    #[cfg(windows)]
    fn take() -> Result<Self, String> {
        windows_power::set(true);
        Ok(Self {})
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        #[cfg(windows)]
        windows_power::set(false);
    }
}

// SetThreadExecutionState holds only while the thread that called it lives,
// and is undone from that same thread: one thread, kept for the purpose.
#[cfg(windows)]
mod windows_power {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

    static WORKER: OnceLock<Mutex<Sender<bool>>> = OnceLock::new();

    pub fn set(on: bool) {
        let worker = WORKER.get_or_init(|| {
            let (tx, rx) = channel::<bool>();
            std::thread::spawn(move || {
                for on in rx {
                    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
                    unsafe { SetThreadExecutionState(flags) };
                }
            });
            Mutex::new(tx)
        });
        let _ = worker.lock().unwrap().send(on);
    }
}

// ---- Command (a server's page: the Keep Awake extension) ---------------------

#[tauri::command]
pub async fn keep_awake(app: AppHandle, webview: Webview, on: bool) -> Result<(), String> {
    let label = webview.label().to_string();
    // Taking a hold waits on a helper process: off the async runtime.
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().keep_awake.set(&label, on))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letting_go_of_what_was_never_held_is_fine() {
        let k = KeepAwake::default();
        k.forget("server-a");
        assert!(k.hold.lock().unwrap().is_none());
    }
}
