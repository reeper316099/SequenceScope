//! SequenceScope desktop shell (Tauri). A thin layer: it opens one locked-down window around the existing web UI
//! and offers a handful of validated native commands. All validation logic lives in small modules with unit tests.

mod allowlist;
mod commands;
mod compute;
mod dto;
mod fileio;
mod frame;
mod jobs;
#[cfg(test)]
mod lockdown_tests;
mod menu;
mod ops;
mod ops_msa;
mod ops_tree;
mod results;
mod smoke;
mod validate;

/// Dev-only surface for the localhost test bridge (feature `test-bridge`): the plain functions behind the commands, no window needed.
#[cfg(feature = "test-bridge")]
pub mod bridge_api {
    pub use crate::compute::{run_align, run_bootstrap, run_distances, run_msa, run_shuffle};
    pub use crate::dto::{
        AlignRequestDto, BootstrapRequestDto, DistancesRequestDto, MsaRequestDto, ShuffleRequestDto, parse_request,
    };
    pub use crate::jobs::{JobError, Jobs};
    pub use crate::ops::{OpRequest, run_op};
}

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Builds the one main window: fixed minimum size, blocks navigation away from the app, unfocused in smoke mode.
fn create_main_window(app: &tauri::App, smoke_mode: bool) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("SequenceScope")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1100.0, 720.0)
        .initialization_script(smoke::init_script(smoke_mode))
        .on_navigation(allowlist::is_app_url);
    if smoke_mode {
        // Tried and failed on macOS: hidden, off-screen, and always-on-bottom windows (WebKit suspends the page, so the
        // self-check never runs). What works: a normal visible window that is NOT focused, in an app with no Dock icon.
        // It is on screen for a couple of seconds but never takes keyboard focus from what you are doing.
        builder = builder.visible(true).focused(false);
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
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, &event))
        .manage(jobs::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::open_external,
            commands::get_app_info,
            commands::copy_text,
            compute::align_pair,
            compute::shuffle_test,
            compute::distance_matrix,
            compute::bootstrap_job,
            compute::msa_job,
            compute::bio_op,
            compute::cancel_job,
            compute::smoke_active_jobs,
            smoke::smoke_report,
            smoke::smoke_menu
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
