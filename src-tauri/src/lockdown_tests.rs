//! Tests of the app's lock-down configuration (these replace the Electron checks of `webPreferences`: there is no Node in the page
//! here, so what matters is the permission file, the content policy and the plugin list). They read the files the app is built from.

use serde_json::Value;
use std::path::PathBuf;

/// Reads a file of this package (path relative to src-tauri).
fn read(rel: &str) -> String {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), rel].iter().collect();
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The command names listed in build.rs (the only commands that exist).
fn build_commands() -> Vec<String> {
    let src = read("build.rs");
    let start = src.find("commands(&[").expect("command list in build.rs");
    let end = src[start..].find("])").expect("end of list") + start;
    src[start..end]
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

/// The command names registered with the page in lib.rs (`tauri::generate_handler![...]`).
fn handler_commands() -> Vec<String> {
    let src = read("src/lib.rs");
    let start = src.find("generate_handler![").expect("handler list in lib.rs") + "generate_handler![".len();
    let end = src[start..].find(']').expect("end of list") + start;
    src[start..end]
        .split(',')
        .map(|s| s.trim().rsplit("::").next().unwrap_or("").to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[test]
fn registered_commands_are_exactly_the_declared_commands() {
    let (mut declared, mut registered) = (build_commands(), handler_commands());
    declared.sort();
    registered.sort();
    assert_eq!(declared, registered);
}

#[test]
fn the_page_may_use_exactly_one_permission_per_app_command_and_nothing_else() {
    let cap: Value = serde_json::from_str(&read("capabilities/main-window.json")).expect("capability file is JSON");
    assert_eq!(cap["windows"], serde_json::json!(["main"]), "only the main window");
    assert!(cap.get("remote").is_none(), "no remote (web) origins");
    let mut granted: Vec<String> = cap["permissions"]
        .as_array()
        .expect("permission list")
        .iter()
        .map(|p| p.as_str().expect("string").to_string())
        .collect();
    let mut wanted: Vec<String> = build_commands()
        .iter()
        .map(|c| format!("allow-{}", c.replace('_', "-")))
        .collect();
    granted.sort();
    wanted.sort();
    assert_eq!(
        granted, wanted,
        "the granted permissions are exactly allow-<command> for the declared commands (no core:*, no plugin permissions)"
    );
}

#[test]
fn only_one_capability_file_exists() {
    let dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "capabilities"].iter().collect();
    let files: Vec<_> = std::fs::read_dir(dir)
        .expect("capabilities folder")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, vec!["main-window.json".to_string()]);
}

#[test]
fn content_policy_is_strict() {
    let conf: Value = serde_json::from_str(&read("tauri.conf.json")).expect("tauri.conf.json");
    assert_eq!(
        conf["app"]["withGlobalTauri"],
        Value::Bool(false),
        "no global Tauri object for scripts to find"
    );
    let csp = conf["app"]["security"]["csp"].as_str().expect("csp");
    for forbidden in [
        "'unsafe-eval'",
        "'unsafe-inline'",
        "http://*",
        "https://*",
        "data: ",
        "blob:",
    ] {
        assert!(
            !csp.split(';')
                .filter(|d| d.trim_start().starts_with("script-src"))
                .any(|d| d.contains(forbidden)),
            "script-src must not contain {forbidden}"
        );
    }
    for needed in [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ] {
        assert!(csp.contains(needed), "csp lacks {needed}");
    }
    let connect = csp
        .split(';')
        .find(|d| d.trim_start().starts_with("connect-src"))
        .expect("connect-src");
    assert!(
        !connect.contains("https:") && !connect.contains("ws:") && !connect.contains('*'),
        "connect-src is the app itself and the IPC channel only: {connect}"
    );
    assert_eq!(
        conf["app"]["windows"],
        serde_json::json!([]),
        "no window is declared in the config; the one window is built in code"
    );
}

#[test]
fn no_filesystem_shell_http_or_process_plugin_is_linked() {
    let manifest = read("Cargo.toml");
    for banned in [
        "tauri-plugin-fs",
        "tauri-plugin-shell",
        "tauri-plugin-http",
        "tauri-plugin-process",
        "tauri-plugin-websocket",
        "tauri-plugin-updater",
    ] {
        assert!(!manifest.contains(banned), "{banned} must not be a dependency");
    }
}
