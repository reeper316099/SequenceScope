import { defineConfig } from 'vitest/config';

// Unit tests for the UI-side code. Anything that needs a real calculation talks to the Rust test bridge (tests/helpers/bridgeGlobal.ts).
// Browser tests (Playwright) live in tests/bridge and tests/tauri-ui and are run separately.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: ['tests/helpers/bridgeGlobal.ts'],
    setupFiles: ['tests/helpers/bridgeSetup.ts'],
    coverage: { provider: 'v8', include: ['src/io/**', 'src/ui/**'] },
  },
});
