// Perch as a desktop app (plans/desktop-app.md): a launcher, one window per
// Perch server (the one bundled with the app, an installed one, remote
// ones), a tray, OS notifications, perch:// links and `perch-desktop`.
mod alerts;
mod bridge;
mod cli;
mod deeplink;
mod launcher;
mod local_server;
mod paths;
mod probe;
#[cfg(debug_assertions)]
mod qa;
mod servers;
#[cfg(debug_assertions)]
mod spike;
mod tray;
mod windows;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

pub struct AppState {
    pub servers: servers::Servers,
    pub local: local_server::LocalServer,
    pub alerts: alerts::Alerts,
    // Set by Quit; otherwise closing the last window leaves the app in the
    // tray.
    quitting: AtomicBool,
    // Server windows whose page has finished loading.
    pub loaded: Mutex<HashSet<String>>,
    // Scripts waiting for a window's page to load (perch:// opens,
    // notification clicks).
    pub pending_scripts: Mutex<HashMap<String, Vec<String>>>,
    pub child_counter: AtomicU32,
}

pub fn quit(app: &AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    // The bundled server keeps running: its terminals outlive the app.
    app.exit(0);
}

pub fn run() {
    let context = tauri::generate_context!();
    let resource_dir = tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default()).ok();
    let local = local_server::LocalServer::new(resource_dir);

    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("PERCH_DESKTOP_SPIKE_URL") {
        return spike::run(context, url);
    }

    let cwd = std::env::current_dir().unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let link = match cli::parse(&args, &cwd) {
        cli::Parsed::Gui(link) => link,
        other => std::process::exit(cli::run_headless(&other, &local)),
    };

    let state = AppState {
        servers: servers::Servers::load(paths::config_dir().join("servers.json")),
        local,
        alerts: alerts::Alerts::default(),
        quitting: AtomicBool::new(false),
        loaded: Mutex::new(HashSet::new()),
        pending_scripts: Mutex::new(HashMap::new()),
        child_counter: AtomicU32::new(1),
    };

    let app = tauri::Builder::default()
        // First, so a second launch hands over and exits before anything
        // else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            // perch:// links arrive through the deep-link plugin instead.
            if args.first().is_some_and(|a| a.starts_with("perch://")) {
                return;
            }
            match cli::parse(&args, std::path::Path::new(&cwd)) {
                cli::Parsed::Gui(Some(link)) => deeplink::handle(app, &link),
                _ => windows::show_launcher(app),
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[windows::LAUNCHER]).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            bridge::window_minimize,
            bridge::window_toggle_maximize,
            bridge::window_close,
            bridge::window_is_maximized,
            bridge::window_start_dragging,
            bridge::window_set_decorations,
            bridge::show_notification,
            bridge::open_external,
            bridge::reveal_path,
            bridge::open_with_default,
            bridge::pick_folder,
            launcher::list_servers,
            launcher::add_server,
            launcher::update_server,
            launcher::remove_server,
            launcher::open_server,
            launcher::start_local,
            launcher::stop_local,
            launcher::detect_installed,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::create(&handle)?;
            // An AppImage or a development build has no installer to tell
            // the OS about perch://; register it at run time there.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            let _ = app.deep_link().register_all();
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    deeplink::handle(&links, url.as_str());
                }
            });
            alerts::sync(&handle);
            // `perch instances` can take a second: off the startup path.
            let detect = handle.clone();
            std::thread::spawn(move || {
                let state = detect.state::<AppState>();
                if state.servers.detect_installed(state.local.port()) {
                    alerts::sync(&detect);
                    tray::refresh(&detect);
                    let _ = tauri::Emitter::emit_to(&detect, windows::LAUNCHER, "servers-changed", ());
                }
            });
            #[cfg(debug_assertions)]
            qa::watch(&handle);
            match &link {
                Some(link) => deeplink::handle(&handle, link),
                None => windows::show_launcher(&handle),
            }
            Ok(())
        })
        .build(context)
        .expect("error while building Perch");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { code, api, .. } = event {
            // Closing the last window isn't quitting: the tray stays, and
            // alerts keep arriving.
            if code.is_none() && !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}
