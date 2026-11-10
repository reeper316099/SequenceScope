// Runs the TAURI build of the UI (out/tauri-renderer, served by `vite preview`) in headless Chrome. The native bridge
// (window.sequenceScope) is replaced by an in-memory test double, so this checks the UI contract and the Tauri bundle
// (module workers, bundled examples) without needing a Tauri window. Real Rust commands are tested by `cargo test`.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Installs the in-memory bridge before any page script runs; records every call so tests can inspect it. */
async function installDouble(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['__saved'] = null;
    w['__nextOpen'] = null;
    w['sequenceScope'] = {
      openFile: () => Promise.resolve(w['__nextOpen'] ?? { ok: false, reason: 'cancelled' }),
      saveFile: (r: { suggestedName: string }) => { w['__saved'] = r; return Promise.resolve({ ok: true, path: `/virtual/${r.suggestedName}` }); },
      openExternal: () => Promise.resolve({ ok: true }),
      getAppInfo: () => Promise.resolve({ name: 'SequenceScope', version: '0.1.0', electron: 'Tauri test double', chrome: 'headless', platform: 'test' }),
      copyText: () => Promise.resolve({ ok: true }),
    };
  });
}

const seqA = (page: Page) => page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA');
const seqB = (page: Page) => page.locator('.view-align').getByLabel('Sequence B: paste residues or FASTA');

test('the Tauri bundle renders, aligns in a module worker, and makes no outside requests', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); }); // Chrome asks for /favicon.ico; the Tauri window does not
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  await installDouble(page);
  await page.goto('/');
  expect(await page.title()).toBe('SequenceScope');
  await seqA(page).fill('GCATGCG');
  await seqB(page).fill('GATTACA');
  await page.waitForSelector('.stats .stat-value');
  await expect(page.locator('.stat', { hasText: 'Score' }).first().locator('.stat-value')).not.toHaveText('');
  for (const name of ['2  Distances', '3  Trees', '4  MSA', '5  Examples', '6  Learn', '7  About']) await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.view-about')).toContainText('Tauri test double / headless');
  expect(errors).toEqual([]);
  expect(requests.filter((u) => !u.startsWith(`${baseURL}/`) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
});

test('bundled example sequences load from the Tauri bundle', async ({ page }) => {
  await installDouble(page);
  await page.goto('/');
  const status = await page.evaluate(async () => (await fetch('/examples/index.json')).status);
  expect(status).toBe(200);
  expect(await page.evaluate(async () => ((await (await fetch('/examples/index.json')).json()) as { sets: unknown[] }).sets.length)).toBeGreaterThan(0);
});

test('save then open round-trips a project through the bridge contract', async ({ page }) => {
  await installDouble(page);
  await page.goto('/');
  await seqA(page).fill('GCATGCG');
  await seqB(page).fill('GATTACA');
  await page.waitForSelector('.stats .stat-value');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect(page.locator('#toast')).toContainText('Saved /virtual/sequencescope-project.json');
  const saved = await page.evaluate(() => (window as unknown as { __saved: { content: string; encoding: string; extensions: string[] } }).__saved);
  expect(saved.encoding).toBe('utf8');
  expect(saved.extensions).toEqual(['json']);
  await seqA(page).fill('TTTTTTTT');
  await page.evaluate((text) => { (window as unknown as Record<string, unknown>)['__nextOpen'] = { ok: true, name: 'p.json', text }; }, saved.content);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(seqA(page)).toHaveValue('GCATGCG');
});
