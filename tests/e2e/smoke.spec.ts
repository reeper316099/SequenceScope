// Phase 2 e2e: launch the BUILT Electron app and verify the shell, bridge, worker, example loading, and security.
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'ELECTRON_RENDERER_URL' && v !== undefined)) as Record<string, string>; // safe: undefined values filtered out
  app = await electron.launch({ args: ['.'], env: { ...env, SEQUENCESCOPE_E2E: '1' } });
  page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.waitForSelector('[data-check="network"].pass, [data-check="network"].fail');
});
test.afterAll(async () => { await app.close(); });

test('window title and all self-checks pass', async () => {
  expect(await page.title()).toBe('SequenceScope');
  for (const id of ['bridge', 'worker', 'example', 'sandbox', 'network']) {
    await expect(page.locator(`[data-check="${id}"]`)).toHaveClass('pass');
  }
});

test('security: only 4 bridge functions, no require, app:// traversal is blocked', async () => {
  const keys = await page.evaluate(() => Object.keys((window as unknown as { sequenceScope: object }).sequenceScope).sort());
  expect(keys).toEqual(['getAppInfo', 'openExternal', 'openFile', 'saveFile']);
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  const statuses = await page.evaluate(async () => {
    const out: number[] = [];
    for (const u of ['/examples/../package.json', '/examples/%2e%2e/package.json', '/..%2fpackage.json']) {
      try { out.push((await fetch(u)).status); } catch { out.push(-1); }
    }
    return out;
  });
  for (const s of statuses) expect([403, 404]).toContain(s);
  const ext = await page.evaluate(() => (window as unknown as { sequenceScope: { openExternal(u: string): Promise<{ ok: boolean }> } }).sequenceScope.openExternal('https://evil.example/'));
  expect(ext.ok).toBe(false);
  const pkg = await page.evaluate(async () => (await fetch('/package.json')).status);
  expect(pkg).toBe(404);
});

test('webPreferences are locked down and the page logged no unexpected errors', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences exists at runtime but is not in Electron's type definitions, so it is typed by hand here.
    const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as { getLastWebPreferences(): { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean } } | undefined;
    const wp = wc?.getLastWebPreferences();
    return { ctx: wp?.contextIsolation, node: wp?.nodeIntegration, sandbox: wp?.sandbox };
  });
  expect(prefs).toEqual({ ctx: true, node: false, sandbox: true });
  // The deliberate network probe is blocked by the CSP and logs a CSP error; nothing else may log an error.
  expect(consoleErrors.filter((m) => !m.includes('Content Security Policy') && !m.includes('Failed to load resource'))).toEqual([]);
});
