// The tray icon (menu bar on macOS) and, on macOS, the same items in the app
// menu (plans/desktop-app.md T16). Rebuilt whenever the local server's state
// or the server list changes.
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::local_server::Status;
use crate::{cli, windows, AppState};

const TRAY_ID: &str = "perch";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    // Built first with the local server taken as stopped; refresh() finds
    // out off the main thread, where a slow answer can't freeze the app.
    let menu = build_menu(app, &Status::Stopped)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Perch")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    #[cfg(target_os = "macos")]
    set_app_menu(app, &Status::Stopped)?;
    refresh(app);
    Ok(())
}

/// Rebuilds the menus from the current state. Asking the local server how
/// it is takes a network round trip, so that happens on a thread of its own
/// and only the rebuild runs on the main thread. Call it freely.
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let status = app.state::<AppState>().local.status();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let (Some(tray), Ok(menu)) = (app2.tray_by_id(TRAY_ID), build_menu(&app2, &status)) {
                let _ = tray.set_menu(Some(menu));
            }
            #[cfg(target_os = "macos")]
            let _ = set_app_menu(&app2, &status);
        });
    });
}

fn local_status_line(status: &Status) -> String {
    match status {
        Status::Running { port } => format!("Local server: running on :{port}"),
        Status::Missing => "Local server: not in this build".into(),
        _ => "Local server: stopped".into(),
    }
}

fn build_menu(app: &AppHandle, status: &Status) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let running = matches!(status, Status::Running { .. });
    let mut servers = SubmenuBuilder::new(app, "Open Server");
    // Names and ids only: the local server's port doesn't matter here.
    for s in state.servers.list(None) {
        servers = servers.item(&MenuItemBuilder::with_id(format!("open:{}", s.id), &s.name).build(app)?);
    }
    let local_toggle = if running {
        MenuItemBuilder::with_id("stop-local", "Stop Local Server").build(app)?
    } else {
        MenuItemBuilder::with_id("start-local", "Start Local Server").build(app)?
    };
    let command_item = if cli::command_installed() {
        MenuItemBuilder::with_id("remove-cli", "Remove perch-desktop Command").build(app)?
    } else {
        MenuItemBuilder::with_id("install-cli", "Install perch-desktop Command").build(app)?
    };
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("status", local_status_line(status)).enabled(false).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("launcher", "Open Launcher").build(app)?)
        .item(&servers.build()?)
        .separator()
        .item(&local_toggle)
        .item(&command_item)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit Perch").build(app)?)
        .build()
}

// macOS: the standard app menu (Edit carries copy and paste for the
// webview), plus a Perch menu with the tray's items.
#[cfg(target_os = "macos")]
fn set_app_menu(app: &AppHandle, status: &Status) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    // The standard menu's Close Window takes Cmd+W, which closed the whole
    // server window - every tab in it - where a Mac user reaches for it to
    // close a tab. The page closes a tab on Cmd+W instead (tab.close's
    // macDesktop binding), and closing the window moves to Shift+Cmd+W.
    for item in menu.items()? {
        let Some(sub) = item.as_submenu() else { continue };
        let entries = sub.items()?;
        for (i, entry) in entries.iter().enumerate().rev() {
            let Some(predefined) = entry.as_predefined_menuitem() else { continue };
            if predefined.text()? != "Close Window" {
                continue;
            }
            sub.remove_at(i)?;
            let close = MenuItemBuilder::with_id("close-window", "Close Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?;
            sub.insert(&close, i)?;
        }
    }
    let perch = SubmenuBuilder::new(app, "Server").build()?;
    for item in build_menu(app, status)?.items()? {
        if let Some(i) = item.as_menuitem() {
            if i.id().as_ref() == "quit" {
                continue; // the app menu already has Quit
            }
        }
        perch.append(&item)?;
    }
    menu.append(&perch)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "launcher" => windows::show_launcher(app),
        "start-local" => windows::open_server(app, crate::servers::LOCAL_ID),
        "stop-local" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = app.state::<AppState>().local.stop() {
                    windows::report_error(&app, e);
                }
                refresh(&app);
                let _ = app.emit_to(windows::LAUNCHER, "servers-changed", ());
            });
        }
        "install-cli" => {
            match cli::install_command() {
                Ok(Some(note)) => message(app, &note, MessageDialogKind::Info),
                Ok(None) => message(app, "Installed. Run perch-desktop --help in a new terminal.", MessageDialogKind::Info),
                Err(e) => message(app, &e, MessageDialogKind::Error),
            }
            refresh(app);
        }
        "remove-cli" => {
            if let Err(e) = cli::remove_command() {
                message(app, &e, MessageDialogKind::Error);
            }
            refresh(app);
        }
        "quit" => crate::quit(app),
        "close-window" => {
            if let Some(w) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                let _ = w.close();
            }
        }
        other => {
            if let Some(server) = other.strip_prefix("open:") {
                windows::open_server(app, server);
            }
        }
    }
}

fn message(app: &AppHandle, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title("Perch").kind(kind).show(|_| {});
}
