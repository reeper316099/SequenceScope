// Smoke test of a PACKAGED app (not the dev build): launches, aligns an example pair, builds a tree, exports Newick.
// Skipped unless PACKAGED_APP points to the executable (e.g. release/mac-arm64/SequenceScope.app/Contents/MacOS/SequenceScope).
import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXE = process.env['PACKAGED_APP'];
test.skip(EXE === undefined, 'set PACKAGED_APP to the packaged executable to run this test');

test('packaged app: launches, aligns an example pair, builds a tree, exports a Newick file', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(path.join(tmpdir(), 'sscope-packaged-'));
  const app = await electron.launch({ executablePath: EXE as string, args: [`--user-data-dir=${userData}`], env: { ...(process.env as Record<string, string>), SEQUENCESCOPE_E2E: '1' } }); // safe: process.env values are strings
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  expect(await page.title()).toBe('SequenceScope');
  const info = await page.evaluate(() => (window as unknown as { sequenceScope: { getAppInfo(): Promise<{ version: string; name: string }> } }).sequenceScope.getAppInfo());
  expect(info).toMatchObject({ name: 'SequenceScope', version: '0.1.0' });
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
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f }); }, file);
  await page.locator('.view-trees button', { hasText: 'Export Newick' }).first().click();
  await expect.poll(() => existsSync(file)).toBe(true);
  const nwk = readFileSync(file, 'utf8').trim();
  expect(nwk.endsWith(';')).toBe(true);
  expect(nwk.match(/HBA_/g)?.length).toBe(13);
  expect(errors.filter((e) => !e.includes('Content Security Policy'))).toEqual([]);
  await app.close();
});
