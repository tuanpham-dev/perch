// Debug builds only: lets a headless QA run drive the app's windows. Any
// `<window label>.js` dropped in PERCH_DESKTOP_QA_DIR is evaluated in that
// window once and deleted; a script reports back by setting document.title,
// which becomes the window title (readable with xdotool getwindowname).
use tauri::{AppHandle, Manager};

pub fn watch(app: &AppHandle) {
    let Ok(dir) = std::env::var("PERCH_DESKTOP_QA_DIR") else { return };
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("js") {
                continue;
            }
            let label = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            let Ok(code) = std::fs::read_to_string(&path) else { continue };
            let _ = std::fs::remove_file(&path);
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.eval(format!(
                    "(async () => {{ try {{ {code} }} catch (e) {{ document.title = 'QA-ERROR ' + (e && e.message); }} }})();"
                ));
            }
        }
    });
}
