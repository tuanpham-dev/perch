// perch:// links (plans/desktop-app.md T18):
//
//   perch://open?server=<id or name>&path=<path>&line=<n>&action=editor|preview
//
// `server` defaults to the bundled local server; with no `path` the link
// just opens that server's window. `perch-desktop` (cli.rs) builds the same
// links, so both go through `handle`.
use tauri::{AppHandle, Manager, Url};

use crate::servers::LOCAL_ID;
use crate::{windows, AppState};

#[derive(Debug, PartialEq)]
pub struct OpenRequest {
    pub server: Option<String>,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub action: Option<String>,
}

pub fn parse(link: &str) -> Result<OpenRequest, String> {
    let url = Url::parse(link).map_err(|_| format!("Not a perch:// link: {link}"))?;
    if url.scheme() != "perch" {
        return Err(format!("Not a perch:// link: {link}"));
    }
    let verb = url.host_str().unwrap_or_else(|| url.path().trim_matches('/'));
    if verb != "open" {
        return Err(format!("perch://{verb} isn't something Perch can do. Use perch://open?path=..."));
    }
    let mut req = OpenRequest { server: None, path: None, line: None, action: None };
    for (key, value) in url.query_pairs() {
        let value = value.into_owned();
        if value.is_empty() {
            continue;
        }
        match key.as_ref() {
            "server" => req.server = Some(value),
            "path" => req.path = Some(value),
            "line" => req.line = Some(value.parse().map_err(|_| format!("line must be a number, not \"{value}\""))?),
            "action" if value == "editor" || value == "preview" => req.action = Some(value),
            "action" => return Err(format!("action must be editor or preview, not \"{value}\"")),
            _ => {}
        }
    }
    Ok(req)
}

/// Builds the link `perch-desktop` hands to the app.
pub fn build(server: Option<&str>, path: Option<&str>, line: Option<u32>, action: Option<&str>) -> String {
    let mut url = Url::parse("perch://open").unwrap();
    {
        let mut q = url.query_pairs_mut();
        if let Some(s) = server {
            q.append_pair("server", s);
        }
        if let Some(p) = path {
            q.append_pair("path", p);
        }
        if let Some(l) = line {
            q.append_pair("line", &l.to_string());
        }
        if let Some(a) = action {
            q.append_pair("action", a);
        }
    }
    url.to_string()
}

pub fn handle(app: &AppHandle, link: &str) {
    let req = match parse(link) {
        Ok(req) => req,
        Err(message) => return windows::report_error(app, message),
    };
    let state = app.state::<AppState>();
    let wanted = req.server.as_deref().unwrap_or(LOCAL_ID);
    let Some(server) = state.servers.find(wanted, state.local.port()) else {
        return windows::report_error(app, format!("No server named \"{wanted}\" in the list."));
    };
    let script = req.path.as_ref().map(|path| {
        format!(
            "window.__perchDesktop.openPath({}, {}, {});",
            serde_json::to_string(path).unwrap(),
            req.line.map(|l| l.to_string()).unwrap_or_else(|| "undefined".into()),
            req.action.as_ref().map(|a| serde_json::to_string(a).unwrap()).unwrap_or_else(|| "undefined".into()),
        )
    });
    windows::open_server_then(app, &server.id, script);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_links() {
        assert_eq!(
            parse("perch://open?server=build%20box&path=%2Fsrv%2Fapp%2Fmain.rs&line=42&action=editor").unwrap(),
            OpenRequest {
                server: Some("build box".into()),
                path: Some("/srv/app/main.rs".into()),
                line: Some(42),
                action: Some("editor".into()),
            }
        );
        assert_eq!(
            parse("perch://open").unwrap(),
            OpenRequest { server: None, path: None, line: None, action: None }
        );
        assert!(parse("perch://delete?path=/").is_err());
        assert!(parse("https://open?path=/").is_err());
        assert!(parse("perch://open?line=x").is_err());
        assert!(parse("perch://open?action=run").is_err());
    }

    #[test]
    fn builds_what_it_parses() {
        let link = build(Some("Local"), Some("/home/me/a b.txt"), Some(3), None);
        assert_eq!(
            parse(&link).unwrap(),
            OpenRequest { server: Some("Local".into()), path: Some("/home/me/a b.txt".into()), line: Some(3), action: None }
        );
    }
}
