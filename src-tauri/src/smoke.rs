//! Smoke-test mode. When `SEQUENCESCOPE_SMOKE=1` the app opens a short-lived UNFOCUSED window (and hides its Dock icon),
//! the page runs a self-check (src/tauri/smoke.ts), reports the result here, and the process exits with 0 or 1.
//! Nothing here does anything in a normal run: the report command refuses unless the variable is set.

use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

/// Seconds before a smoke run gives up and exits with code 2 (so a hung page can never leave a process behind).
const WATCHDOG_SECONDS: u64 = 60;

/// True when the app was started in smoke-test mode.
pub fn enabled() -> bool {
    std::env::var("SEQUENCESCOPE_SMOKE").is_ok_and(|v| v == "1")
}

/// Starts the watchdog thread that ends a hung smoke run.
pub fn start_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(WATCHDOG_SECONDS));
        eprintln!("SMOKE_TIMEOUT: the page never reported");
        app.exit(2);
    });
}

/// Receives the page's self-check report, prints it, and exits (0 = all checks passed). Refused outside smoke mode.
#[tauri::command]
pub fn smoke_report(app: AppHandle, report: Value) -> Result<(), String> {
    if !enabled() {
        return Err("smoke mode is off".to_string());
    }
    println!("SMOKE_REPORT {report}");
    let passed = report.get("ok").and_then(Value::as_bool).unwrap_or(false);
    app.exit(if passed { 0 } else { 1 });
    Ok(())
}
