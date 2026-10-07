// `perch-desktop` (plans/desktop-app.md T19): the app's own executable,
// reached through a small launcher script the app menu installs.
//
//   perch-desktop [path[:line]] [editor|preview] [--server <name>]
//   perch-desktop start | stop | status
//
// Opening goes to the running app (single instance) as a perch:// link;
// start/stop/status run right here, with no window, so they also work over
// SSH.
use std::path::{Path, PathBuf};

use crate::deeplink;
use crate::local_server::{LocalServer, Status};

pub const USAGE: &str = "Usage: perch-desktop [path[:line]] [editor|preview] [--server <name>]
       perch-desktop start | stop | status

Opens a folder as a project, or a file in the editor, in the Perch desktop
app - in its bundled local server unless --server names another one from
the app's server list. With no arguments, opens the app.

  path[:line]      Folder or file to open; a trailing :N jumps a file to
                   that line (e.g. src/index.ts:42)
  editor|preview   Force a file into the editor or its preview viewer
  --server <name>  Open it in that server's window (a path there is a path
                   on that server's machine)

  start            Start the bundled local server
  stop             Stop the bundled local server (its terminals keep running)
  status           Show whether the bundled local server is running";

#[derive(Debug, PartialEq)]
pub enum Parsed {
    // Open the app, then this perch:// link if there is one.
    Gui(Option<String>),
    Start,
    Stop,
    Status,
    Help,
    Error(String),
}

pub fn parse(args: &[String], cwd: &Path) -> Parsed {
    // macOS adds a process serial number when Finder launches an app.
    let args: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with("-psn_")).collect();
    match args.as_slice() {
        [] => return Parsed::Gui(None),
        [link] if link.starts_with("perch://") => return Parsed::Gui(Some(link.to_string())),
        ["start"] => return Parsed::Start,
        ["stop"] => return Parsed::Stop,
        ["status"] => return Parsed::Status,
        _ => {}
    }
    let mut server: Option<&str> = None;
    let mut target: Option<&str> = None;
    let mut action: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "--help" | "-h" => return Parsed::Help,
            "--server" => {
                i += 1;
                match args.get(i) {
                    Some(name) => server = Some(name),
                    None => return Parsed::Error("--server needs a server name".into()),
                }
            }
            a if a.starts_with("--server=") => server = Some(&a["--server=".len()..]),
            a @ ("editor" | "preview") if action.is_none() => action = Some(a),
            a if a.starts_with('-') => return Parsed::Error(format!("unknown flag: {a}")),
            a if target.is_none() => target = Some(a),
            a => return Parsed::Error(format!("unexpected argument: {a}")),
        }
        i += 1;
    }
    let local = server.is_none_or(|s| s.eq_ignore_ascii_case("local"));
    let (path, line) = match target {
        None => (None, None),
        // A path on this machine: made absolute here, where the shell's
        // working directory is known. Like `perch open`, a trailing :N is a
        // line only when the literal path doesn't exist.
        Some(t) if local => match resolve_local(t, cwd) {
            Some((p, l)) => (Some(p), l),
            None => return Parsed::Error(format!("no such file or directory: {t}")),
        },
        // A path on another server's machine: passed along as given.
        Some(t) => (Some(t.to_string()), None),
    };
    Parsed::Gui(Some(deeplink::build(server, path.as_deref(), line, action)))
}

fn resolve_local(target: &str, cwd: &Path) -> Option<(String, Option<u32>)> {
    // The path as the shell sees it, symlinks kept: resolving them would
    // name a folder the Perch window already has open by another path, and
    // it would open as a second project.
    let abs = |p: &str| {
        let p = crate::paths::expand_home(p);
        let p = normalize(&if p.is_absolute() { p } else { cwd.join(p) });
        p.exists().then_some(p)
    };
    if let Some(p) = abs(target) {
        return Some((display(&p), None));
    }
    let (path, line) = target.rsplit_once(':')?;
    let line: u32 = line.parse().ok()?;
    abs(path).map(|p| (display(&p), Some(line)))
}

fn display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Drops `.` and folds `..` into its parent, the way a shell's `cd` does,
/// without touching the filesystem (so symlinks stay as written).
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in p.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The working directory as the shell sees it: $PWD keeps the symlinks a
/// user cd'ed through, where the OS's own answer has them resolved. Only
/// trusted while it still names the same directory.
pub fn shell_cwd() -> PathBuf {
    let real = std::env::current_dir().unwrap_or_default();
    match std::env::var_os("PWD").map(PathBuf::from) {
        Some(pwd) if pwd.is_absolute() && same_dir(&pwd, &real) => pwd,
        _ => real,
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Runs a command that needs no window. Returns the exit code.
pub fn run_headless(parsed: &Parsed, local: &LocalServer) -> i32 {
    attach_console();
    match parsed {
        Parsed::Help => {
            println!("{USAGE}");
            0
        }
        Parsed::Error(message) => {
            eprintln!("perch-desktop: {message}\n\n{USAGE}");
            2
        }
        Parsed::Status => match local.status() {
            Status::Running { port } => {
                println!("running on http://127.0.0.1:{port}");
                0
            }
            Status::Missing => {
                println!("not available: this build has no bundled server");
                1
            }
            _ => {
                println!("stopped");
                1
            }
        },
        Parsed::Start => match local.ensure_running() {
            Ok(port) => {
                println!("running on http://127.0.0.1:{port}");
                0
            }
            Err(Status::Failed { message, log_tail }) => {
                eprintln!("perch-desktop: {message}\n{log_tail}");
                1
            }
            Err(_) => {
                eprintln!("perch-desktop: this build has no bundled server");
                1
            }
        },
        Parsed::Stop => match local.stop() {
            Ok(()) => {
                println!("stopped (terminals keep running; `perch-desktop start` brings them back)");
                0
            }
            Err(e) => {
                eprintln!("perch-desktop: {e}");
                1
            }
        },
        Parsed::Gui(_) => 0,
    }
}

// A release build on Windows has no console of its own; borrow the one of
// the shell that ran it, so printed output shows up there.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}

// ---- Installing the command ------------------------------------------------

fn command_dir() -> PathBuf {
    if cfg!(windows) {
        dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Perch").join("bin")
    } else {
        dirs::home_dir().unwrap_or_default().join(".local").join("bin")
    }
}

fn command_path() -> PathBuf {
    command_dir().join(if cfg!(windows) { "perch-desktop.cmd" } else { "perch-desktop" })
}

// A marker line, so removal only ever deletes a file this app wrote.
const MARKER: &str = "perch-desktop launcher, written by the Perch desktop app";

pub fn command_installed() -> bool {
    std::fs::read_to_string(command_path()).is_ok_and(|t| t.contains(MARKER))
}

/// The executable the launcher should run: the AppImage itself when running
/// from one (its mount point changes every run).
pub fn app_executable() -> Result<PathBuf, String> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        return Ok(PathBuf::from(appimage));
    }
    std::env::current_exe().map_err(|e| e.to_string())
}

/// Started from a terminal to open a window: run the app on in the
/// background and give the shell its prompt back, rather than tying the app
/// to the terminal (closing it, or Ctrl-C, would quit the app). Returns
/// whether it did, in which case this process should exit.
#[cfg(all(unix, not(debug_assertions)))]
pub fn detach_from_terminal(args: &[String]) -> bool {
    use std::io::IsTerminal;
    const DETACHED: &str = "PERCH_DESKTOP_DETACHED";
    if std::env::var_os(DETACHED).is_some() || !std::io::stdin().is_terminal() {
        return false;
    }
    let Ok(exe) = app_executable() else { return false };
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args)
        .env(DETACHED, "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::local_server::detach(&mut cmd);
    cmd.spawn().is_ok()
}

/// The Windows launcher. A batch file waits for whatever it runs, a window
/// included, so opening one goes through `start` and gives the prompt back;
/// the headless commands run in place, for their output and exit code.
fn windows_script(exe: &str) -> String {
    let headless = ["start", "stop", "status", "--help", "-h"]
        .iter()
        .map(|arg| format!("if /i \"%~1\"==\"{arg}\" goto wait\r\n"))
        .collect::<String>();
    format!("@echo off\r\nrem {MARKER}\r\n{headless}start \"\" \"{exe}\" %*\r\nexit /b\r\n:wait\r\n\"{exe}\" %*\r\n")
}

/// Writes the launcher script. Returns a note for the user when its folder
/// isn't on PATH yet.
pub fn install_command() -> Result<Option<String>, String> {
    let path = command_path();
    if path.exists() && !command_installed() {
        return Err(format!("{} already exists and wasn't written by Perch; leaving it alone.", path.display()));
    }
    let exe = app_executable()?;
    std::fs::create_dir_all(command_dir()).map_err(|e| e.to_string())?;
    if cfg!(windows) {
        std::fs::write(&path, windows_script(&exe.display().to_string())).map_err(|e| e.to_string())?;
        add_to_user_path(&command_dir())?;
        return Ok(Some("Open a new terminal to use perch-desktop.".into()));
    }
    // A script rather than a symlink: macOS resolves the app's resources from
    // the path it was started by, which a symlink would change.
    let quoted = exe.display().to_string().replace('\'', r"'\''");
    std::fs::write(&path, format!("#!/bin/sh\n# {MARKER}\nexec '{quoted}' \"$@\"\n")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let on_path = std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d == command_dir()));
    Ok((!on_path).then(|| {
        format!(
            "Installed to {}, which isn't on your PATH. Add this to your shell's startup file:\n\n  export PATH=\"$HOME/.local/bin:$PATH\"",
            path.display()
        )
    }))
}

pub fn remove_command() -> Result<(), String> {
    if !command_installed() {
        return Ok(());
    }
    std::fs::remove_file(command_path()).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn add_to_user_path(dir: &Path) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    let env = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?;
    let current: String = env.get_value("Path").unwrap_or_default();
    let dir = dir.display().to_string();
    if current.split(';').any(|p| p.eq_ignore_ascii_case(&dir)) {
        return Ok(());
    }
    let updated = if current.is_empty() { dir } else { format!("{current};{dir}") };
    env.set_value("Path", &updated).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn add_to_user_path(_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn windows_script_starts_windows_and_waits_for_commands() {
        let script = windows_script(r"C:\Program Files\Perch\Perch.exe");
        assert!(script.contains(&format!("rem {MARKER}")));
        assert!(script.contains("if /i \"%~1\"==\"status\" goto wait\r\n"));
        assert!(script.contains("start \"\" \"C:\\Program Files\\Perch\\Perch.exe\" %*\r\nexit /b"));
        assert!(script.ends_with(":wait\r\n\"C:\\Program Files\\Perch\\Perch.exe\" %*\r\n"));
    }

    #[test]
    fn parses_commands() {
        let cwd = std::env::temp_dir();
        assert_eq!(parse(&args(&[]), &cwd), Parsed::Gui(None));
        assert_eq!(parse(&args(&["-psn_0_1234"]), &cwd), Parsed::Gui(None));
        assert_eq!(parse(&args(&["status"]), &cwd), Parsed::Status);
        assert_eq!(parse(&args(&["start"]), &cwd), Parsed::Start);
        assert_eq!(parse(&args(&["--help"]), &cwd), Parsed::Help);
        assert_eq!(parse(&args(&["perch://open?path=/x"]), &cwd), Parsed::Gui(Some("perch://open?path=/x".into())));
        assert!(matches!(parse(&args(&["--bogus"]), &cwd), Parsed::Error(_)));
        assert!(matches!(parse(&args(&["--server"]), &cwd), Parsed::Error(_)));
    }

    #[test]
    fn resolves_local_paths_and_lines() {
        let dir = std::env::temp_dir().join(format!("perch-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let expect = |p: Option<&str>, line: Option<u32>, action: Option<&str>| {
            Parsed::Gui(Some(deeplink::build(None, p, line, action)))
        };
        let file = display(&dir.join("a.txt"));
        assert_eq!(parse(&args(&["a.txt:12", "editor"]), &dir), expect(Some(&file), Some(12), Some("editor")));
        assert_eq!(parse(&args(&["."]), &dir), expect(Some(&display(&dir)), None, None));
        assert_eq!(parse(&args(&["./sub/../a.txt"]), &dir), expect(Some(&file), None, None));
        assert!(matches!(parse(&args(&["nope.txt"]), &dir), Parsed::Error(_)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    // A folder reached through a symlink keeps that path, so it matches the
    // project the window opened by the same path.
    #[cfg(unix)]
    #[test]
    fn keeps_symlinked_paths() {
        let root = std::env::temp_dir().join(format!("perch-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("real/src")).unwrap();
        std::fs::write(root.join("real/src/main.rs"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let link = root.join("link");
        assert_eq!(
            parse(&args(&["src/main.rs:3"]), &link),
            Parsed::Gui(Some(deeplink::build(None, Some(&display(&link.join("src/main.rs"))), Some(3), None)))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn passes_remote_paths_through() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            parse(&args(&["--server", "build box", "/srv/app"]), &cwd),
            Parsed::Gui(Some(deeplink::build(Some("build box"), Some("/srv/app"), None, None)))
        );
        assert_eq!(
            parse(&args(&["--server=build"]), &cwd),
            Parsed::Gui(Some(deeplink::build(Some("build"), None, None, None)))
        );
    }
}
