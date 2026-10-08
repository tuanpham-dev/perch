// The servers the launcher lists (plans/desktop-app.md T9): Local (the
// bundled server, always there), Installed (a Perch already running on this
// machine, while it answers) and the remote servers the user saved. Only
// the remotes and the two notify switches are stored, in servers.json.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub const LOCAL_ID: &str = "local";
pub const INSTALLED_ID: &str = "installed";
// The port an installed Perch's service uses by default.
pub const INSTALLED_DEFAULT_PORT: u16 = 3001;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    Local,
    Installed,
    Remote,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub id: String,
    pub name: String,
    // Origin plus "/", e.g. "https://perch.example.com/". Empty for Local
    // until its server has a port.
    pub url: String,
    pub kind: ServerKind,
    pub notify: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    remotes: Vec<ServerEntry>,
    #[serde(default = "yes")]
    notify_local: bool,
    #[serde(default = "yes")]
    notify_installed: bool,
}

fn yes() -> bool {
    true
}

pub struct Servers {
    path: PathBuf,
    stored: Mutex<Stored>,
    // The port an installed Perch answered on at the last check.
    installed_port: Mutex<Option<u16>>,
}

impl Servers {
    pub fn load(path: PathBuf) -> Self {
        let stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Stored>(&text).ok())
            .unwrap_or(Stored { remotes: Vec::new(), notify_local: true, notify_installed: true });
        Self { path, stored: Mutex::new(stored), installed_port: Mutex::new(None) }
    }

    fn save(&self, stored: &Stored) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    /// Every server, in launcher order. `local_port` is the bundled server's
    /// port when it has one.
    pub fn list(&self, local_port: Option<u16>) -> Vec<ServerEntry> {
        let stored = self.stored.lock().unwrap();
        let mut out = vec![ServerEntry {
            id: LOCAL_ID.into(),
            name: "Local".into(),
            url: local_port.map(|p| format!("http://127.0.0.1:{p}/")).unwrap_or_default(),
            kind: ServerKind::Local,
            notify: stored.notify_local,
        }];
        if let Some(port) = *self.installed_port.lock().unwrap() {
            out.push(ServerEntry {
                id: INSTALLED_ID.into(),
                name: "Installed".into(),
                url: format!("http://127.0.0.1:{port}/"),
                kind: ServerKind::Installed,
                notify: stored.notify_installed,
            });
        }
        out.extend(stored.remotes.iter().cloned());
        out
    }

    pub fn get(&self, id: &str, local_port: Option<u16>) -> Option<ServerEntry> {
        self.list(local_port).into_iter().find(|s| s.id == id)
    }

    /// A server by id, or by name ignoring case (for perch:// links and
    /// `perch-desktop --server`).
    pub fn find(&self, id_or_name: &str, local_port: Option<u16>) -> Option<ServerEntry> {
        let all = self.list(local_port);
        all.iter()
            .find(|s| s.id == id_or_name)
            .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(id_or_name)))
            .cloned()
    }

    pub fn add(&self, name: &str, url: &str) -> Result<ServerEntry, String> {
        let url = normalize_url(url)?;
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the server a name.".into());
        }
        let mut stored = self.stored.lock().unwrap();
        check_unique(&stored, None, Some(name), Some(&url))?;
        let entry = ServerEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            url,
            kind: ServerKind::Remote,
            notify: false,
        };
        stored.remotes.push(entry.clone());
        self.save(&stored)?;
        Ok(entry)
    }

    pub fn update(&self, id: &str, name: Option<&str>, url: Option<&str>, notify: Option<bool>) -> Result<(), String> {
        let mut stored = self.stored.lock().unwrap();
        match id {
            LOCAL_ID | INSTALLED_ID => {
                if name.is_some() || url.is_some() {
                    return Err("This server's name and address are fixed.".into());
                }
                if let Some(on) = notify {
                    if id == LOCAL_ID {
                        stored.notify_local = on;
                    } else {
                        stored.notify_installed = on;
                    }
                }
            }
            _ => {
                let url = url.map(normalize_url).transpose()?;
                check_unique(&stored, Some(id), name.map(str::trim), url.as_deref())?;
                let entry = stored.remotes.iter_mut().find(|s| s.id == id).ok_or("No such server.")?;
                if let Some(name) = name {
                    let name = name.trim();
                    if name.is_empty() {
                        return Err("Give the server a name.".into());
                    }
                    entry.name = name.into();
                }
                if let Some(url) = url {
                    entry.url = url;
                }
                if let Some(on) = notify {
                    entry.notify = on;
                }
            }
        }
        self.save(&stored)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut stored = self.stored.lock().unwrap();
        let before = stored.remotes.len();
        stored.remotes.retain(|s| s.id != id);
        if stored.remotes.len() == before {
            return Err("Only a server you added can be removed.".into());
        }
        self.save(&stored)
    }

    /// Looks for an installed Perch: the default port, plus whatever
    /// `perch instances` lists, minus the bundled server's own port.
    /// Returns whether the answer changed.
    pub fn detect_installed(&self, local_port: Option<u16>) -> bool {
        let mut candidates = vec![INSTALLED_DEFAULT_PORT];
        candidates.extend(perch_instance_ports());
        let found = candidates
            .into_iter()
            .filter(|p| Some(*p) != local_port)
            .find(|p| crate::probe::is_perch(*p));
        let mut current = self.installed_port.lock().unwrap();
        let changed = *current != found;
        *current = found;
        changed
    }
}

/// A server's name picks it in perch:// links and `perch-desktop --server`,
/// and its address is what its window and sign-in belong to, so neither may
/// repeat another server's. `except` is the server being edited.
fn check_unique(stored: &Stored, except: Option<&str>, name: Option<&str>, url: Option<&str>) -> Result<(), String> {
    let others = || stored.remotes.iter().filter(|s| Some(s.id.as_str()) != except);
    if let Some(name) = name {
        let fixed = ["Local", "Installed"].iter().any(|n| n.eq_ignore_ascii_case(name));
        if fixed || others().any(|s| s.name.eq_ignore_ascii_case(name)) {
            return Err(format!("There's already a server named \"{name}\"."));
        }
    }
    if let Some(url) = url {
        if let Some(s) = others().find(|s| s.url == url) {
            return Err(format!("\"{}\" already has that address.", s.name));
        }
    }
    Ok(())
}

/// An http(s) URL reduced to its origin plus "/".
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    // No scheme: https, except for an IP address or localhost, which a Perch
    // serves over plain http unless something is in front of it.
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        let host = url::Url::parse(&format!("http://{raw}")).ok().and_then(|u| u.host().map(|h| h.to_owned()));
        let plain = matches!(host, Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)))
            || matches!(&host, Some(url::Host::Domain(d)) if d == "localhost");
        format!("{}://{raw}", if plain { "http" } else { "https" })
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| format!("\"{raw}\" isn't a web address."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Use an http:// or https:// address.".into());
    }
    if url.host_str().is_none() {
        return Err(format!("\"{raw}\" has no host."));
    }
    Ok(format!("{}/", url.origin().ascii_serialization()))
}

// The PORT column of `perch instances`, when the installed CLI is on PATH.
fn perch_instance_ports() -> Vec<u16> {
    let Ok(out) = perch_instances_output() else {
        return Vec::new();
    };
    parse_instance_ports(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
fn perch_instances_output() -> std::io::Result<std::process::Output> {
    std::process::Command::new("perch").arg("instances").output()
}

// The installed CLI is bin\perch.cmd, a batch file: CreateProcess can't run
// it by name, only cmd.exe can.
#[cfg(windows)]
fn perch_instances_output() -> std::io::Result<std::process::Output> {
    crate::local_server::hidden_command("cmd").args(["/C", "perch", "instances"]).output()
}

fn parse_instance_ports(text: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    let mut port_col = None;
    for line in text.lines() {
        let clean = strip_ansi(line);
        let cols: Vec<&str> = clean.split_whitespace().collect();
        match port_col {
            None => port_col = cols.iter().position(|c| *c == "PORT"),
            Some(i) => {
                if let Some(port) = cols.get(i).and_then(|c| c.parse::<u16>().ok()) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Servers, PathBuf) {
        let dir = std::env::temp_dir().join(format!("perch-servers-{}", uuid::Uuid::new_v4()));
        let path = dir.join("servers.json");
        (Servers::load(path.clone()), dir)
    }

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("https://perch.example.com/some/path?x=1").unwrap(), "https://perch.example.com/");
        assert_eq!(normalize_url("perch.example.com").unwrap(), "https://perch.example.com/");
        assert_eq!(normalize_url("http://10.0.0.7:3001").unwrap(), "http://10.0.0.7:3001/");
        assert_eq!(normalize_url("10.0.0.7:3001").unwrap(), "http://10.0.0.7:3001/");
        assert_eq!(normalize_url("localhost:3001").unwrap(), "http://localhost:3001/");
        assert_eq!(normalize_url("https://10.0.0.7").unwrap(), "https://10.0.0.7/");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn adds_updates_removes_and_persists() {
        let (servers, dir) = temp_store();
        assert_eq!(servers.list(None).len(), 1, "Local is always listed");
        let added = servers.add("build box", "https://build.example.com/x").unwrap();
        assert_eq!(added.url, "https://build.example.com/");
        assert!(!added.notify);
        servers.update(&added.id, Some("builder"), None, Some(true)).unwrap();
        servers.update(LOCAL_ID, None, None, Some(false)).unwrap();

        let reloaded = Servers::load(dir.join("servers.json"));
        let list = reloaded.list(Some(3101));
        assert_eq!(list[0].url, "http://127.0.0.1:3101/");
        assert!(!list[0].notify);
        assert_eq!(list[1].name, "builder");
        assert!(list[1].notify);
        assert_eq!(reloaded.find("BUILDER", None).unwrap().id, added.id);

        assert!(reloaded.update(LOCAL_ID, Some("x"), None, None).is_err());
        assert!(reloaded.remove(LOCAL_ID).is_err());
        reloaded.remove(&added.id).unwrap();
        assert_eq!(Servers::load(dir.join("servers.json")).list(None).len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_repeated_names_and_addresses() {
        let (servers, dir) = temp_store();
        let a = servers.add("build box", "https://build.example.com").unwrap();
        let b = servers.add("other", "https://other.example.com").unwrap();
        assert!(servers.add("Build Box", "https://new.example.com").is_err());
        assert!(servers.add("local", "https://new.example.com").is_err());
        assert!(servers.add("new", "https://build.example.com/path").is_err());
        assert!(servers.update(&b.id, Some("BUILD BOX"), None, None).is_err());
        assert!(servers.update(&b.id, None, Some("build.example.com"), None).is_err());
        // Saving a server under its own name and address is no conflict.
        servers.update(&a.id, Some("build box"), Some("https://build.example.com"), None).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_instance_ports() {
        let text = "\x1b[1mPID      PORT   APP_NAME               MANAGED BY STATUS\x1b[0m\n1234     3001   perch                  service    \x1b[32mresponding\x1b[0m\n99       3003   perch-dev              external   not responding\n";
        assert_eq!(parse_instance_ports(text), vec![3001, 3003]);
        assert!(parse_instance_ports("no running instances found").is_empty());
    }
}
