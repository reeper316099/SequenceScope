//! The five commands the web page may call (plus the test-only smoke report). Each one validates its input,
//! does the native work, and returns a result shaped like the TypeScript types in `src/shared/types.ts`.
//! The page never gets raw access to the file system, clipboard, dialogs, or the system browser.

use crate::allowlist::is_allowed_external_url;
use crate::fileio::{self, ReadError};
use crate::results::{AppInfo, OpenFileResult, SaveFileResult, SimpleResult};
use crate::validate::{self, MAX_OPEN_FILE_BYTES, OpenKind};
use serde_json::Value;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Shows the native "open" dialog for one kind of file, then reads the pick with type and size limits enforced here.
#[tauri::command]
pub async fn open_file(app: AppHandle, window: WebviewWindow, kind: Value) -> OpenFileResult {
    let Some(kind) = OpenKind::parse(&kind) else {
        return OpenFileResult::failed("invalid-request", "Unknown file kind.");
    };
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter(kind.label(), kind.extensions())
        .blocking_pick_file();
    let Some(picked) = picked else {
        return OpenFileResult::cancelled();
    };
    let Ok(path) = picked.into_path() else {
        return OpenFileResult::failed("read-error", "That location is not a file on this computer.");
    };
    match fileio::open_picked_file(&path, kind) {
        Ok((name, text)) => OpenFileResult::opened(name, text),
        Err(ReadError::TooLarge(size)) => OpenFileResult::failed(
            "too-large",
            format!(
                "File is {} MB; the limit is {} MB.",
                fileio::megabytes(size),
                MAX_OPEN_FILE_BYTES / 1_048_576
            ),
        ),
        Err(ReadError::WrongType) => {
            OpenFileResult::failed("invalid-request", format!("That is not a {} file.", kind.label()))
        }
        Err(ReadError::Io(message)) => OpenFileResult::failed("read-error", message),
    }
}

/// Validates a save request, shows the native "save" dialog, and writes ONLY to the path the user chose.
#[tauri::command]
pub async fn save_file(app: AppHandle, window: WebviewWindow, request: Value) -> SaveFileResult {
    let req = match validate::parse_save_request(&request) {
        Ok(req) => req,
        Err(message) => return SaveFileResult::failed("invalid-request", message),
    };
    let ext_refs: Vec<&str> = req.extensions.iter().map(String::as_str).collect();
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(req.suggested_name.clone())
        .add_filter("File", &ext_refs)
        .blocking_save_file();
    let Some(picked) = picked else {
        return SaveFileResult::cancelled();
    };
    let Ok(path) = picked.into_path() else {
        return SaveFileResult::failed("write-error", "That location is not a file on this computer.");
    };
    match fileio::write_save(&path, &req) {
        Ok(()) => SaveFileResult::saved(path.to_string_lossy().into_owned()),
        Err(message) => SaveFileResult::failed("write-error", message),
    }
}

/// Opens a link in the system browser only if it is an allowlisted https URL.
#[tauri::command]
pub fn open_external(app: AppHandle, url: Value) -> SimpleResult {
    let Some(url) = validate::parse_external_url(&url).filter(|u| is_allowed_external_url(u)) else {
        return SimpleResult::failed("That link is not on the allowlist.");
    };
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => SimpleResult::done(),
        Err(e) => SimpleResult::failed(format!("Could not open the link: {e}")),
    }
}

/// Reports app facts for the About page. The old Electron field names carry the Tauri and web view versions.
#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let platform = match std::env::consts::OS {
        "macos" => "darwin", // the UI shows Node-style platform names
        "windows" => "win32",
        other => other,
    };
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        electron: format!("Tauri {}", tauri::VERSION),
        chrome: tauri::webview_version().unwrap_or_else(|_| "unknown web view".to_string()),
        platform: platform.to_string(),
    }
}

/// Copies validated text (at most 5 MB) to the system clipboard; the page has no clipboard permission of its own.
#[tauri::command]
pub fn copy_text(app: AppHandle, text: Value) -> SimpleResult {
    let Some(text) = validate::parse_copy_text(&text) else {
        return SimpleResult::failed("Nothing to copy, or the text is larger than 5 MB.");
    };
    match app.clipboard().write_text(text) {
        Ok(()) => SimpleResult::done(),
        Err(e) => SimpleResult::failed(format!("Could not copy: {e}")),
    }
}
