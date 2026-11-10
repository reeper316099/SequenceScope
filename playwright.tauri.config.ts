import { defineConfig } from '@playwright/test';

// Tests the TAURI build of the UI (out/tauri-renderer) in headless Chrome with a test double for the native bridge.
// It proves the UI contract (window.sequenceScope) and the Tauri bundle; the real Rust commands are covered by `cargo test`
// and the hidden-window smoke test. Run `npm run test:tauri-ui` (it builds first).
export default defineConfig({
  testDir: 'tests/tauri-ui',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { channel: 'chrome', headless: true, baseURL: 'http://127.0.0.1:4174' },
  webServer: { command: 'npx vite preview --config vite.tauri.config.ts --host 127.0.0.1 --port 4174 --strictPort', url: 'http://127.0.0.1:4174', reuseExistingServer: false, timeout: 30_000 },
});
