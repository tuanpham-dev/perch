// Hides the console window a release build would otherwise open on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    perch_desktop_lib::run()
}
