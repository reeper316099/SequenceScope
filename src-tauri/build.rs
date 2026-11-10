// Build script: tells Tauri exactly which app commands exist so each one gets its own permission.
// Anything not listed here cannot be called from the web page at all.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "open_file",
            "save_file",
            "open_external",
            "get_app_info",
            "copy_text",
            "smoke_report",
        ])),
    )
    .expect("tauri build script failed"); // build scripts have no caller to return an error to; failing the build is the intent
}
