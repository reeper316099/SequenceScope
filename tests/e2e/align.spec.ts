// Milestone A end-to-end tests against the BUILT Electron app (hidden window, throw-away profile).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { align } from '../../src/bio/pairwise';
import { compileScoring } from '../../src/bio/scoring';
import { enterPair, launch } from './helpers';
import type { Launched } from './helpers';

const scoreTile = (page: Page) => page.locator('.stat', { hasText: 'Score' }).first().locator('.stat-value');
const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'sscope-files-'));

/** Sets the simple DNA scoring fields (match, mismatch, linear gap). */
async function setLinearDna(page: Page, match: number, mismatch: number, gap: number): Promise<void> {
  await page.locator('.view-align').getByLabel('Substitution scoring').selectOption('simple');
  await page.locator('.view-align').getByLabel('Gap model').selectOption('linear');
  await page.locator('.view-align').getByLabel('Match score', { exact: true }).fill(String(match));
  await page.locator('.view-align').getByLabel('Mismatch score', { exact: true }).fill(String(mismatch));
  await page.locator('.view-align').getByLabel('Linear gap penalty').fill(String(gap));
}

let ctx: Launched;
test.beforeEach(async () => { ctx = await launch(); });
test.afterEach(async () => { await ctx.app.close(); });

test('launches with the right title, no console errors, and no outbound requests during a click-through', async () => {
  const { page } = ctx;
  expect(await page.title()).toBe('SequenceScope');
  await enterPair(page, 'GCATGCG', 'GATTACA');
  for (const name of ['2  Distances', '3  Trees', '4  MSA', '5  Examples', '6  Learn', '7  About']) await page.getByRole('button', { name, exact: true }).click();
  await page.waitForSelector('.view-about .card');
  await page.getByRole('button', { name: '1  Align', exact: true }).click();
  expect(ctx.consoleErrors).toEqual([]);
  const external = ctx.requests.filter((u) => !/^(app|data|blob|devtools):/.test(u));
  expect(external).toEqual([]);
});

test('numbers match the unit-tested aligner (textbook Needleman–Wunsch example: score 0)', async () => {
  const { page } = ctx;
  await enterPair(page, 'GCATGCG', 'GATTACA');
  await setLinearDna(page, 1, -1, 1);
  await expect(scoreTile(page)).toHaveText('0');
  const sc = compileScoring({ substitution: { kind: 'simple', match: 1, mismatch: -1 }, gaps: { kind: 'linear', gap: 1 } }, 'dna');
  const direct = align('GCATGCG', 'GATTACA', 'global', sc);
  const rows = await page.locator('.aln-body .aln-line').allInnerTexts();
  const letters = rows.map((r) => r.replace(/^[AB]\s+\d+\s+/, '').replace(/\s+\d+$/, '').trim()).filter((r) => /^[ACGT-]+$/.test(r));
  expect(letters).toEqual([direct.rowA, direct.rowB]);
  await expect(page.locator('.stat', { hasText: 'Identity' }).locator('.stat-detail')).toContainText('alignment columns');
});

test('step-through works with the keyboard and ends at the direct result; reduced path shown at the end', async () => {
  const { page } = ctx;
  await enterPair(page, 'GCATGCG', 'GATTACA');
  await setLinearDna(page, 1, -1, 1);
  await expect(scoreTile(page)).toHaveText('0');
  const finalRows = await page.locator('.aln-body').innerText();
  await page.locator('.view-align .stepper').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.view-align .stepper-status')).toContainText('Ready');
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.view-align .stepper-status')).toContainText('cell 3 of 49');
  await expect(page.locator('.details')).toContainText('Cell (i = 1, j = 3)');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.view-align .stepper-status')).toContainText('cell 2 of 49');
  await page.keyboard.press('End');
  await expect(page.locator('.view-align .stepper-status')).toContainText('Done');
  expect(await page.locator('.aln-body').innerText()).toBe(finalRows);
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight'); // 10 steps
  await expect(page.locator('.view-align .stepper-status')).toContainText('cell 10 of 49');
});

test('changing scoring updates results; affine and linear differ on a known example', async () => {
  const { page } = ctx;
  const a = 'AAAAGGGGTTTT'; const b = 'AAAATTTT';
  await enterPair(page, a, b);
  await setLinearDna(page, 2, -3, 4);
  const lin = align(a, b, 'global', compileScoring({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'linear', gap: 4 } }, 'dna')).score;
  await expect(scoreTile(page)).toHaveText(String(lin));
  await page.locator('.view-align').getByLabel('Gap model').selectOption('affine');
  await page.locator('.view-align').getByLabel('Affine gap opening penalty').fill('5');
  await page.locator('.view-align').getByLabel('Affine gap extension penalty').fill('1');
  const aff = align(a, b, 'global', compileScoring({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 1 } }, 'dna')).score;
  expect(aff).not.toBe(lin);
  await expect(scoreTile(page)).toHaveText(String(aff));
  await page.locator('.view-align').getByLabel('Alignment mode').selectOption('local');
  await expect(page.locator('.stat', { hasText: 'Aligned region' })).toContainText('A ');
});

test('shuffle test: fixed seed reproduces exactly; Cancel works mid-run', async () => {
  const { page } = ctx;
  const a = 'ACGTTGCAAGGCTTAACGGATCCATGCAAGTCCGATTAGC'.repeat(3);
  const b = 'TTGACCGGATAACGTCAGGCTAATCGGACTTAGCCATGAA'.repeat(3);
  await enterPair(page, a, b);
  await page.locator('.view-align').getByLabel('Number of shuffles').fill('60');
  await page.locator('.view-align').getByLabel('Random seed', { exact: true }).fill('777');
  const run = async (): Promise<string> => {
    await page.getByRole('button', { name: 'Run shuffle test' }).click();
    await page.waitForSelector('.signif-results .stat');
    return page.locator('.signif-results').innerText();
  };
  const first = await run();
  const second = await run();
  expect(second).toBe(first);
  expect(first.toLowerCase()).toContain('seed');
  expect(first).toContain('777');
  // Cancel test: a job that is long on ANY machine (400 x 400 residues x 5000 shuffles is roughly 800 million cell updates),
  // so the Cancel button is still there when we click it, even on a fast CI runner.
  const big = (s: string): string => s.slice(0, 40).repeat(10);
  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill(big(a));
  await page.locator('.view-align').getByLabel('Sequence B: paste residues or FASTA').fill(big(b));
  await expect(page.locator('.view-align .stat', { hasText: 'Alignment length' }).locator('.stat-value')).toHaveText(/^[4-9]\d\d$/, { timeout: 30_000 });
  await page.locator('.view-align').getByLabel('Number of shuffles').fill('5000');
  await page.getByRole('button', { name: 'Run shuffle test' }).click();
  await expect(page.locator('.signif-status')).toContainText('Running');
  await page.locator('.view-align .signif').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.signif-status')).toContainText('Cancelled');
});

test('bad input is reported with positions and nothing is silently dropped; too-large input is refused clearly', async () => {
  const { page } = ctx;
  await page.locator('.view-align').getByLabel('Sequence B: paste residues or FASTA').fill('ACGTACGTACGTACGT');
  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill('ACGTACGTAC!GTACGT');
  await page.locator('.view-align').getByLabel('Alphabet').selectOption('dna');
  await expect(page.locator('.seq-messages').first()).toContainText('! at 11');
  await expect(page.locator('.view-align .status-host')).toContainText('Fix the problems');
  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill('AC GT 12 acgt');
  await expect(page.locator('.seq-messages').first()).toContainText('Removed 2 digit');
  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill('A'.repeat(6000));
  await page.locator('.view-align').getByLabel('Sequence B: paste residues or FASTA').fill('C'.repeat(6000));
  await expect(page.locator('.view-align .status-host')).toContainText('limit is 25,010,001');
});

test('project save, reopen, corrupted and wrong-version files', async () => {
  const { page, app } = ctx;
  const dir = tmp();
  const file = path.join(dir, 'p.json');
  await enterPair(page, 'GCATGCG', 'GATTACA');
  await setLinearDna(page, 3, -2, 5);
  await page.locator('.view-align').getByLabel('Random seed', { exact: true }).fill('4242');
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f }); }, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect.poll(() => existsSync(file)).toBe(true);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { align: { seed: number; scoring: { gaps: { gap: number } } } };
  expect(saved.align.seed).toBe(4242);
  expect(saved.align.scoring.gaps.gap).toBe(5);

  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill('TTTTTTTT');
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA')).toHaveValue('GCATGCG');
  await expect(page.locator('.view-align').getByLabel('Random seed', { exact: true })).toHaveValue('4242');
  await expect(page.locator('.view-align').getByLabel('Linear gap penalty')).toHaveValue('5');

  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{"app":"SequenceScope","formatVersion":1,"align":');
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, bad);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.locator('#toast')).toContainText('not valid JSON');
  const newer = path.join(dir, 'newer.json');
  writeFileSync(newer, JSON.stringify({ app: 'SequenceScope', formatVersion: 99 }));
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, newer);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.locator('#toast')).toContainText('newer version');
  await expect(page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA')).toHaveValue('GCATGCG'); // unchanged by the failed opens
});

test('exports (FASTA, CLUSTAL-style, CSV, PNG) go through the native save path', async () => {
  const { page, app } = ctx;
  const dir = tmp();
  await enterPair(page, 'GCATGCG', 'GATTACA');
  const exportAs = async (label: string, file: string): Promise<string> => {
    const target = path.join(dir, file);
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f }); }, target);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'export' })));
    await page.getByRole('button', { name: label }).click();
    await expect.poll(() => existsSync(target)).toBe(true);
    return target;
  };
  expect(readFileSync(await exportAs('Alignment as FASTA (.fasta)', 'a.fasta'), 'utf8')).toMatch(/^>.+\n[ACGT-]+\n>.+\n[ACGT-]+\n$/);
  expect(readFileSync(await exportAs('Alignment as CLUSTAL-style text (.aln)', 'a.aln'), 'utf8')).toContain('CLUSTAL-style');
  const csv = readFileSync(await exportAs('Score matrix as CSV (.csv)', 'm.csv'), 'utf8').trim().split('\n');
  expect(csv).toHaveLength(9); // header + border row + 7 residues of A
  expect(csv[0]).toBe(',,G,A,T,T,A,C,A');
  for (const [label, f] of [['Score matrix as PNG (.png)', 'm.png'], ['Alignment as PNG (.png)', 'a.png']] as const) {
    const png = readFileSync(await exportAs(label, f));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

test('security: only the 5 bridge functions, no require, traversal blocked, openExternal allowlist, strict webPreferences', async () => {
  const { page, app } = ctx;
  expect(await page.evaluate(() => Object.keys((window as unknown as { sequenceScope: object }).sequenceScope).sort())).toEqual(['copyText', 'getAppInfo', 'openExternal', 'openFile', 'saveFile']);
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  const statuses = await page.evaluate(async () => {
    const out: number[] = [];
    for (const u of ['/examples/../package.json', '/examples/%2e%2e/package.json', '/package.json']) { try { out.push((await fetch(u)).status); } catch { out.push(-1); } }
    return out;
  });
  for (const s of statuses) expect([403, 404]).toContain(s);
  const bridge = (u: string) => page.evaluate((url) => (window as unknown as { sequenceScope: { openExternal(u: string): Promise<{ ok: boolean }> } }).sequenceScope.openExternal(url), u);
  expect((await bridge('https://evil.example/')).ok).toBe(false);
  expect((await bridge('http://github.com/x')).ok).toBe(false);
  expect((await bridge('javascript:alert(1)')).ok).toBe(false);
  const netBlocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return false; } catch { return true; } });
  expect(netBlocked).toBe(true);
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences exists at runtime but is missing from Electron's type definitions.
    const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as { getLastWebPreferences(): { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean } } | undefined;
    const wp = wc?.getLastWebPreferences();
    return { ctx: wp?.contextIsolation, node: wp?.nodeIntegration, sandbox: wp?.sandbox };
  });
  expect(prefs).toEqual({ ctx: true, node: false, sandbox: true });
  // openFile argument validation in the main process: an unknown kind is rejected without opening a dialog.
  const r = await page.evaluate(() => (window as unknown as { sequenceScope: { openFile(k: string): Promise<{ ok: boolean; reason?: string }> } }).sequenceScope.openFile('exe'));
  expect(r).toMatchObject({ ok: false, reason: 'invalid-request' });
});

test('openFile enforces the size cap in the main process', async () => {
  const { page, app } = ctx;
  const big = path.join(tmp(), 'big.fasta');
  writeFileSync(big, '>x\n' + 'A'.repeat(11 * 1024 * 1024));
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, big);
  const r = await page.evaluate(() => (window as unknown as { sequenceScope: { openFile(k: string): Promise<{ ok: boolean; reason?: string; message?: string }> } }).sequenceScope.openFile('fasta'));
  expect(r).toMatchObject({ ok: false, reason: 'too-large' });
});

test('Learn view renders MathML; examples load into the Align view; About lists sources', async () => {
  const { page } = ctx;
  await page.getByRole('button', { name: '6  Learn', exact: true }).click();
  await page.waitForSelector('.view-learn math');
  const box = await page.locator('.view-learn math').first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(10);
  await page.getByRole('button', { name: '5  Examples', exact: true }).click();
  await page.waitForSelector('.view-examples .card');
  await page.locator('.view-examples .card', { hasText: 'unrelated' }).getByRole('button', { name: /Align this pair/ }).click();
  await page.waitForSelector('.stats .stat-value');
  await expect(page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA')).toHaveValue(/HBA_HUMAN|P69905/);
  await expect(page.locator('.view-align').getByLabel('Substitution scoring')).toHaveValue('BLOSUM62'); // protein input switches to the protein preset
  await page.getByRole('button', { name: '7  About', exact: true }).click();
  await expect(page.locator('.view-about')).toContainText('CC BY 4.0');
});

test('dark mode works and persists across restarts', async () => {
  const { page, userData, app } = ctx;
  const before = await page.evaluate(() => document.documentElement.dataset['theme']);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'toggle-dark' })));
  const after = await page.evaluate(() => document.documentElement.dataset['theme']);
  expect(after).not.toBe(before);
  await app.close();
  const again = await launch(userData);
  expect(await again.page.evaluate(() => document.documentElement.dataset['theme'])).toBe(after);
  await again.app.close();
  ctx = await launch(); // so afterEach has something to close
});
