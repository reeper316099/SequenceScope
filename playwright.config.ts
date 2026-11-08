import { defineConfig } from '@playwright/test';

// e2e drives the built Electron app (npm run build first); one worker because the app uses a single-instance lock.
export default defineConfig({ testDir: 'tests/e2e', timeout: 60_000, workers: 1, reporter: 'list' });
