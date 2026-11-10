//! SequenceScope desktop shell (Tauri). A thin layer: it opens one locked-down window around the existing web UI
//! and offers a handful of validated native commands. All validation logic lives in small modules with unit tests.

mod allowlist;
mod commands;
mod fileio;
mod results;
mod smoke;
mod validate;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Builds the one main window: fixed minimum size, blocks navigation away from the app, unfocused in smoke mode.
fn create_main_window(app: &tauri::App, smoke_mode: bool) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("SequenceScope")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1100.0, 720.0)
        .on_navigation(allowlist::is_app_url);
    if smoke_mode {
        // Tried and failed on macOS: hidden, off-screen, and always-on-bottom windows (WebKit suspends the page, so the
        // self-check never runs). What works: a normal visible window that is NOT focused, in an app with no Dock icon.
        // It is on screen for a couple of seconds but never takes keyboard focus from what you are doing.
        builder = builder
            .visible(true)
            .focused(false)
            // Tells the page to run its self-check and report back (see src/tauri/smoke.ts).
            .initialization_script("window.__SEQUENCESCOPE_SMOKE__ = true;");
    }
    builder.build()?;
    Ok(())
}

/// Starts the app. Returns only when the app quits; a startup failure is printed and exits with code 1.
pub fn run() {
    let smoke_mode = smoke::enabled();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::open_external,
            commands::get_app_info,
            commands::copy_text,
            smoke::smoke_report
        ])
        .setup(move |app| {
            if smoke_mode {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon, no focus stealing
                smoke::start_watchdog(app.handle().clone());
            }
            create_main_window(app, smoke_mode)?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("SequenceScope failed to start: {e}");
        std::process::exit(1);
    }
}
