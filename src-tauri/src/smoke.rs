//! Smoke-test mode. When `SEQUENCESCOPE_SMOKE=1` the app opens a short-lived UNFOCUSED window (and hides its Dock icon),
//! the page runs a self-check (src/tauri/smoke.ts), reports the result here, and the process exits with 0 or 1.
//! Nothing here does anything in a normal run: the report command refuses unless the variable is set.

use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

/// Seconds a basic smoke run may take before it is ended with exit code 2 (so a hung page never leaves a process behind).
/// A benchmark run does much more work and gets a longer limit.
fn watchdog_seconds() -> u64 {
    match mode() {
        "bench" => 1500,
        _ => 60,
    }
}

/// True when the app was started in smoke-test mode.
pub fn enabled() -> bool {
    std::env::var("SEQUENCESCOPE_SMOKE").is_ok_and(|v| v == "1")
}

/// What the smoke run should do: "basic" (security + wiring checks) or "bench" (timings). Only these literals ever reach the page, whatever the environment variable holds.
pub fn mode() -> &'static str {
    match std::env::var("SEQUENCESCOPE_SMOKE_MODE").as_deref() {
        Ok("bench") => "bench",
        _ => "basic",
    }
}

/// Optional benchmark filter: run only one scenario (so peak memory can be attributed to it). Only known names get through.
pub fn bench_only() -> Option<&'static str> {
    const NAMES: [&str; 10] = [
        "small",
        "medium",
        "largestDnaLinear",
        "largestProteinAffine",
        "shuffle",
        "distancesUnaligned",
        "bootstrapSmall",
        "bootstrapLarge",
        "msaSmall",
        "msaLarge",
    ];
    let wanted = std::env::var("SEQUENCESCOPE_BENCH_ONLY").ok()?;
    NAMES.into_iter().find(|n| *n == wanted)
}

/// The JavaScript that runs before the page's own scripts: it passes the smoke-test settings in.
pub fn init_script(smoke_mode: bool) -> String {
    let mut script = String::new();
    if let (true, Some(only)) = (smoke_mode, bench_only()) {
        script.push_str(&format!("window.__SEQUENCESCOPE_BENCH_ONLY__ = \"{only}\";"));
    }
    if smoke_mode {
        script.push_str(&format!(
            "window.__SEQUENCESCOPE_SMOKE__ = true; window.__SEQUENCESCOPE_SMOKE_MODE__ = \"{}\";",
            mode()
        ));
    }
    script
}

/// Starts the watchdog thread that ends a hung smoke run.
pub fn start_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(watchdog_seconds()));
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

/// True when a menu item (at any depth) has this id.
fn menu_has(items: &[tauri::menu::MenuItemKind<tauri::Wry>], id: &str) -> bool {
    items.iter().any(|kind| match kind {
        tauri::menu::MenuItemKind::Submenu(sub) => sub.items().is_ok_and(|inner| menu_has(&inner, id)),
        other => other.id().as_ref() == id,
    })
}

/// Smoke tests only: optionally "clicks" a menu item (as if the user chose it), then lists the commands the menu is MISSING
/// (empty = every command is reachable from the menu). Refuses outside smoke mode.
#[tauri::command]
pub fn smoke_menu(app: AppHandle, click: Option<String>) -> Result<Vec<String>, String> {
    if !enabled() {
        return Err("smoke mode is off".to_string());
    }
    if let Some(id) = click {
        crate::menu::on_event(
            &app,
            &tauri::menu::MenuEvent {
                id: tauri::menu::MenuId::new(id),
            },
        );
    }
    let menu = app.menu().ok_or("the app has no menu")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    Ok(crate::menu::all_actions()
        .into_iter()
        .filter(|a| !menu_has(&items, a))
        .map(str::to_string)
        .collect())
}
