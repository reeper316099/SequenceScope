import { defineConfig } from '@playwright/test';

// Browser tests against the REAL Rust core. Chromium loads the Tauri build of the UI from the dev-only test bridge
// (src-tauri/src/bin/test_bridge.rs), which answers the UI's calculation requests with the same Rust functions the app uses.
// Run `npm run test:bridge` (it builds the UI and the bridge first). Native dialogs are test doubles (tests/bridge/helpers.ts).
const PORT = process.env['BRIDGE_PORT'] ?? '4175';
export default defineConfig({
  testDir: 'tests/bridge',
  testIgnore: process.env['SCREENSHOTS'] === '1' ? [] : ['**/screenshots.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { channel: 'chrome', headless: true },
  webServer: { command: 'node tools/run-bridge.mjs', url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false, timeout: 30_000 },
});
