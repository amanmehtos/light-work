// Light Week desktop shell.
//
// Deliberately thin. The web app is already local-first, so there is no data
// layer to duplicate here — this process owns the window and nothing else.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start Light Week");
}
