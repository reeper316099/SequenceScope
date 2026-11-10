// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point: all logic lives in lib.rs so it can be unit-tested.
fn main() {
    sequencescope_lib::run();
}
