// The Linux webview spike (plans/desktop-app.md Phase 1): one frameless
// window on a running Perch, a JS probe of the features the app depends on,
// and results printed as `SPIKE <name> <ok> <note>` lines for spike.sh.
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Runs the spike instead of the app: `PERCH_DESKTOP_SPIKE_URL` set, debug
/// builds only (desktop/scripts/spike.sh).
pub fn run(context: tauri::Context, url: String) {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![spike_report])
        .setup(move |app| {
            open(app.handle(), &url)?;
            Ok(())
        })
        .run(context)
        .expect("error while running the spike");
}

#[tauri::command]
pub fn spike_report(name: String, ok: bool, note: String) {
    println!("SPIKE {name} {ok} {note}");
}

const PROBE: &str = r#"
(async () => {
  const r = (n, ok, note) => window.__TAURI_INTERNALS__.invoke("spike_report", { name: n, ok: !!ok, note: String(note ?? "") });
  try {
    await r("ipc", true, "remote origin can invoke");
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    await r("webgl2", gl, gl ? gl.getParameter(gl.VERSION) : "no context");
    await r("serviceWorker", "serviceWorker" in navigator, navigator.serviceWorker ? "present" : "missing");
    let reg = null;
    try { reg = navigator.serviceWorker && await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 5000))]); } catch (e) { reg = null; }
    await r("serviceWorkerActive", reg && reg.active, reg ? reg.scope : "not ready in 5s");
    await r("clipboard", navigator.clipboard && navigator.clipboard.writeText, navigator.clipboard ? "api present" : "missing");
    await r("Notification", "Notification" in window, window.Notification ? Notification.permission : "missing");
    await r("PushManager", "PushManager" in window, "");
    await r("EventSource", "EventSource" in window, "");
    await r("userAgent", true, navigator.userAgent);
    const term = document.querySelector(".xterm");
    await r("xtermMounted", !!term, term ? (term.querySelector("canvas") ? "canvas renderer present" : "dom renderer") : "no terminal yet");
  } catch (e) {
    await r("probeError", false, e && e.message);
  }
})();
"#;

fn open(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let parsed: tauri::Url = url.parse().expect("PERCH_DESKTOP_SPIKE_URL is not a URL");
    let origin = parsed.origin().ascii_serialization();
    app.add_capability(
        CapabilityBuilder::new("spike")
            .window("spike")
            .remote(format!("{origin}/*"))
            .permission("allow-spike-report")
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize"),
    )?;
    let data_dir = std::env::var("PERCH_DESKTOP_SPIKE_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| app.path().app_data_dir().unwrap().join("spike-profile"));
    let probe_origin = origin.clone();
    WebviewWindowBuilder::new(app, "spike", WebviewUrl::External(parsed.clone()))
        .title("Perch spike")
        .inner_size(1400.0, 900.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .data_directory(data_dir)
        .on_navigation(move |u| {
            let same = u.origin().ascii_serialization() == probe_origin;
            println!("SPIKE navigation {same} {u}");
            same
        })
        .on_new_window(|u, _features| {
            println!("SPIKE on_new_window true {u}");
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let wv = webview.clone();
                let page = payload.url().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let _ = wv.eval(PROBE);
                    match wv.cookies_for_url(page.clone()) {
                        Ok(cookies) => {
                            let names: Vec<String> = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect();
                            println!("SPIKE cookies_for_url true {}", names.join(","));
                        }
                        Err(e) => println!("SPIKE cookies_for_url false {e}"),
                    }
                });
            }
        })
        .build()?;
    watch_eval_dir(app);
    Ok(())
}

// Lets spike.sh run JS in the window: any *.js file dropped in
// PERCH_DESKTOP_SPIKE_EVAL_DIR is evaluated once and deleted. Results come
// back through spike_report.
fn watch_eval_dir(app: &AppHandle) {
    let Ok(dir) = std::env::var("PERCH_DESKTOP_SPIKE_EVAL_DIR") else { return };
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("js") {
                continue;
            }
            if let Ok(code) = std::fs::read_to_string(&path) {
                let _ = std::fs::remove_file(&path);
                if let Some(w) = app.get_webview_window("spike") {
                    let wrapped = format!(
                        "(async () => {{ const r = (n, ok, note) => window.__TAURI_INTERNALS__.invoke('spike_report', {{ name: n, ok: !!ok, note: String(note ?? '') }}); try {{ {code} }} catch (e) {{ await r('evalError', false, e && e.message); }} }})();"
                    );
                    let _ = w.eval(&wrapped);
                }
            }
        }
    });
}
