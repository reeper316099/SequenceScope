// Ported from tests/e2e/packaged.spec.ts: the packaged-app smoke flow (example pair, distances + tree from a bundled set, Newick export) on the
// Tauri build of the UI with the Rust core behind the test bridge. The part that needs a real packaged executable (it starts, finds its bundled
// files, the window opens) is the Tauri in-window smoke test (see docs/rust-migration/CHECKPOINT-6B.md).
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launch, outsideRequests, saveTo } from './helpers';

test('bundled app: launches, aligns an example pair, builds a tree, exports a Newick file', async () => {
  test.setTimeout(120_000);
  const { app, page, userData, consoleErrors: errors, requests } = await launch();
  expect(await page.title()).toBe('SequenceScope');
  const info = await page.evaluate(() => (window as unknown as { sequenceScope: { getAppInfo(): Promise<{ version: string; name: string; electron: string }> } }).sequenceScope.getAppInfo());
  expect(info).toMatchObject({ name: 'SequenceScope', version: '0.1.0' });
  expect(info.electron).toContain('rust backend'); // the About page names the backend in use
  // example pair (bundled examples are served from the app's resources folder)
  const sel = page.locator('.view-align').getByLabel('Load an example pair', { exact: true });
  await expect.poll(async () => (await sel.locator('option').allInnerTexts()).some((t) => t.includes('unrelated'))).toBe(true);
  await sel.selectOption(await sel.locator('option', { hasText: 'unrelated' }).first().getAttribute('value') ?? '');
  await expect(page.locator('.view-align .stat', { hasText: 'Score' }).first().locator('.stat-value')).toHaveText(/^-?\d+$/, { timeout: 30_000 });
  // distances + tree from a bundled set
  await page.getByRole('button', { name: '2  Distances', exact: true }).click();
  const ex = page.getByLabel('Load an example set', { exact: true });
  await expect.poll(async () => (await ex.locator('option').allInnerTexts()).some((t) => t.includes('MAFFT-aligned'))).toBe(true);
  await ex.selectOption(await ex.locator('option', { hasText: 'Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy' }).first().getAttribute('value') ?? '');
  await expect(page.locator('.view-distances .status-host').last()).toContainText('13 sequences, 78 pairs', { timeout: 30_000 });
  await page.getByRole('button', { name: '3  Trees', exact: true }).click();
  await expect(page.locator('.view-trees .tree-svg g[data-index]').first()).toBeVisible();
  const file = path.join(userData, 'packaged.nwk');
  await saveTo(app, file);
  await page.locator('.view-trees button', { hasText: 'Export Newick' }).first().click();
  await expect.poll(() => existsSync(file)).toBe(true);
  const nwk = readFileSync(file, 'utf8').trim();
  expect(nwk.endsWith(';')).toBe(true);
  expect(nwk.match(/HBA_/g)?.length).toBe(13);
  expect(errors).toEqual([]);
  expect(outsideRequests(requests)).toEqual([]);
  await app.close();
});
