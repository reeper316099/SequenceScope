import { defineConfig } from 'vitest/config';

// Unit + property tests only; Playwright e2e lives in tests/e2e and is run separately.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/bio/**', 'src/io/**', 'electron/appPath.ts', 'electron/allowlist.ts'] },
  },
});
