// Ported from tests/e2e/trees.spec.ts: distances, trees, bootstrap, Newick and comparison in Chromium against the REAL Rust core.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch, openFrom, outsideRequests, saveTo } from './helpers';
import { leaves, longestPath, maxDepth, parseLite, robinsonFoulds, splits } from './newick';
import type { Launched } from './helpers';

let ctx: Launched;
test.beforeEach(async () => { ctx = await launch(); });
test.afterEach(async () => { await ctx.app.close(); });

const dir = mkdtempSync(path.join(tmpdir(), 'sscope-trees-'));
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
/** Finds a Trees-view button by its visible text (their accessible names are longer aria-labels). */
const tbtn = (page: Page, text: string) => page.locator('.view-trees button', { hasText: text }).first();

/** Opens Distances and loads FASTA text; waits until the matrix is computed. */
async function loadSet(page: Page, fasta: string, mode: 'aligned' | 'unaligned' | 'auto' = 'auto'): Promise<void> {
  await nav(page, '2  Distances');
  await page.getByLabel('Is the input aligned?').selectOption(mode);
  await page.getByLabel('Sequence set (FASTA)').fill(fasta);
  await expect(page.locator('.view-distances .status-host').last()).toContainText(/pairs|no usable distance/, { timeout: 15_000 });
}
/** Chooses a bundled example by its visible text. */
async function loadExample(page: Page, labelPart: string): Promise<void> {
  await nav(page, '2  Distances');
  const sel = page.getByLabel('Load an example set', { exact: true });
  await expect.poll(async () => (await sel.locator('option').allInnerTexts()).some((t) => t.includes(labelPart))).toBe(true);
  const value = await sel.locator('option', { hasText: labelPart }).first().getAttribute('value');
  await sel.selectOption(value ?? '');
  await expect(page.locator('.view-distances .status-host').last()).toContainText('pairs', { timeout: 20_000 });
}

test('distances: heatmap and sortable table render for an example; saturated pairs are flagged and block trees', async () => {
  const { page } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates');
  await expect(page.locator('.heatmap-canvas')).toBeVisible();
  await expect(page.locator('.dist-table tr')).toHaveCount(14);
  const before = await page.locator('.dist-table tr th').nth(15).innerText();
  await page.locator('.dist-table th .th-btn').nth(1).click();
  await page.locator('.dist-table th .th-btn').nth(1).click();
  expect(await page.locator('.dist-table tr th').nth(15).innerText()).not.toBe('');
  expect(before).not.toBe('');
  // saturated: JC on two completely different sequences
  await page.getByLabel('Sequence set (FASTA)').fill('>a\nAAAAAAAAAAAA\n>b\nCCCCCCCCCCCC\n>c\nAAAAAAAACCCC');
  await page.locator('.view-distances').getByLabel('Alphabet').selectOption('dna');
  await page.getByLabel('Is the input aligned?').selectOption('aligned');
  await page.getByLabel('Distance model').selectOption('jc');
  await expect(page.locator('.dist-table td.unusable').first()).toHaveText('saturated');
  await expect(page.locator('.view-distances .status-host').last()).toContainText('no usable distance');
  await nav(page, '3  Trees');
  await expect(page.locator('.view-trees .status-host').first()).toContainText(/no usable distance|saturated/i);
});

test('trees: UPGMA and NJ on an example; step-through reaches the final tree; Newick export then import round-trips', async () => {
  const { page, app } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy');
  await nav(page, '3  Trees');
  await expect(page.locator('.tree-svg g[data-index]').first()).toBeVisible();
  for (const m of ['upgma', 'nj']) {
    await page.getByLabel('Tree-building method').selectOption(m);
    await expect(page.locator('.tstepper .stepper-status')).toContainText('the tree is complete');
    await page.locator('.tstepper').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.tstepper .stepper-status')).toContainText(/Step 1\d of 1\d|Step \d+ of/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tstepper .stepper-status')).toContainText('the tree is complete');
    expect(await page.locator('.tstep-formulas').innerText()).toContain('=');
  }
  const f1 = path.join(dir, 'a.nwk'); const f2 = path.join(dir, 'b.nwk');
  await saveTo(app, f1);
  await tbtn(page, 'Export Newick').click();
  await expect.poll(() => existsSync(f1)).toBe(true);
  const text1 = readFileSync(f1, 'utf8').trim();
  expect(leaves(parseLite(text1))).toHaveLength(13);
  await page.getByLabel('Paste a Newick tree').fill(text1);
  await tbtn(page, 'Load pasted Newick').click();
  await expect(page.locator('.view-trees .tree-svg g[data-index]').first()).toBeVisible();
  await saveTo(app, f2);
  await tbtn(page, 'Export Newick').click();
  await expect.poll(() => existsSync(f2)).toBe(true);
  expect(readFileSync(f2, 'utf8').trim()).toBe(text1);
});

test('trees: re-root and midpoint root keep the unrooted splits; midpoint puts the root in the middle of the longest path', async () => {
  const { page, app } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy');
  await nav(page, '3  Trees');
  const exportNow = async (name: string): Promise<string> => { const f = path.join(dir, name); await saveTo(app, f); await tbtn(page, 'Export Newick').click(); await expect.poll(() => existsSync(f)).toBe(true); return readFileSync(f, 'utf8').trim(); };
  const base = parseLite(await exportNow('base.nwk'));
  await page.locator('.view-trees .tree-svg').first().focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await tbtn(page, 'Re-root here').click();
  await expect(page.locator('.view-trees .hint').filter({ hasText: 'rooted form' }).first()).toBeVisible();
  const rerooted = parseLite(await exportNow('reroot.nwk'));
  expect(robinsonFoulds(base, rerooted)).toBe(0);
  await tbtn(page, 'Midpoint root').click();
  const mid = parseLite(await exportNow('mid.nwk'));
  expect(robinsonFoulds(base, mid)).toBe(0);
  expect(maxDepth(mid)).toBeCloseTo(longestPath(base) / 2, 5);
});

test('compare: two imported trees give the expected Robinson–Foulds distance and mark the disagreeing branches', async () => {
  const { page } = ctx;
  await nav(page, '3  Trees');
  for (const t of ['((A,B),(C,D),(E,F));', '((A,B),(C,E),(D,F));']) {
    await page.getByLabel('Paste a Newick tree').fill(t);
    await tbtn(page, 'Load pasted Newick').click();
  }
  await page.getByLabel('First tree', { exact: true }).selectOption({ index: 0 });
  await page.getByLabel('Second tree', { exact: true }).selectOption({ index: 1 });
  await expect(page.locator('.compare-summary')).toContainText('Robinson–Foulds distance 4');
  await expect(page.locator('.compare-summary')).toContainText('1 splits are shared');
  const reds = await page.locator('.compare-summary').locator('xpath=ancestor::section').locator('svg path[stroke="#b3261e"], svg path[stroke="#ff8a80"]').count();
  expect(reds).toBeGreaterThan(0);
  await page.getByLabel('Second tree', { exact: true }).selectOption({ index: 0 });
  await expect(page.locator('.compare-summary')).toContainText('Robinson–Foulds distance 0');
});

test('Newick errors are explained with a position; negative branches are flagged, never hidden', async () => {
  const { page } = ctx;
  await nav(page, '3  Trees');
  await page.getByLabel('Paste a Newick tree').fill('(A,B,\n(C,D),\n:);');
  await tbtn(page, 'Load pasted Newick').click();
  await expect(page.locator('.newick-msg')).toContainText('line 3, column 1');
  await page.getByLabel('Paste a Newick tree').fill('(A:-0.5,B:1,C:1);');
  await tbtn(page, 'Load pasted Newick').click();
  await expect(page.locator('.view-trees .callout-warn', { hasText: 'negative' }).first()).toBeVisible();
  expect(await page.locator('.view-trees .tree-svg text', { hasText: '⚠' }).count()).toBeGreaterThan(0);
});

test('bootstrap: aligned input completes, shows support, same seed gives identical supports; unaligned input explains why it is unavailable', async () => {
  const { page } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates');
  await nav(page, '3  Trees');
  await expect(page.locator('.boot-body')).toContainText('not aligned');
  await expect(page.locator('.boot-controls')).toBeHidden();
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy');
  await nav(page, '3  Trees');
  await expect(page.locator('.boot-controls')).toBeVisible();
  await page.getByLabel('Number of bootstrap replicates').fill('30');
  await page.getByLabel('Bootstrap random seed').fill('5');
  const run = async (): Promise<string> => {
    await page.getByRole('button', { name: 'Run bootstrap' }).click();
    await expect(page.locator('.boot-result table')).toBeVisible({ timeout: 30_000 });
    return page.locator('.boot-result').innerText();
  };
  const first = await run();
  expect(first).toContain('/ 30');
  await expect(page.locator('.view-trees')).toContainText('NOT the probability');
  await expect(page.locator('.boot-body')).toContainText('seed 5');
  expect(await run()).toBe(first);
  expect(await page.locator('.view-trees .tree-svg text', { hasText: /^\d+\*?$/ }).count()).toBeGreaterThan(0); // support values drawn on the tree
});

test('project save and reopen restores the sequence set, settings, and tree method', async () => {
  const { page, app } = ctx;
  const file = path.join(dir, 'proj.json');
  await loadSet(page, '>a\nACGTACGTAC\n>b\nACGTACGTAA\n>c\nACGAACGTAC\n>d\nTCGTACGTAC', 'aligned');
  await page.getByLabel('Distance model').selectOption('jc');
  await nav(page, '3  Trees');
  await page.getByLabel('Tree-building method').selectOption('upgma');
  await saveTo(app, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect.poll(() => existsSync(file)).toBe(true);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { trees: { method: string; model: string; text: string } };
  expect(saved.trees).toMatchObject({ method: 'upgma', model: 'jc' });
  await nav(page, '2  Distances');
  await page.getByLabel('Sequence set (FASTA)').fill('>x\nAAAA');
  await openFrom(app, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.getByLabel('Sequence set (FASTA)')).toHaveValue(saved.trees.text);
  await expect(page.getByLabel('Distance model')).toHaveValue('jc');
  await nav(page, '3  Trees');
  await expect(page.getByLabel('Tree-building method')).toHaveValue('upgma');
});

test('Learn view: corrections plot and the clock example (UPGMA is wrong, neighbor-joining is right)', async () => {
  const { page } = ctx;
  await nav(page, '6  Learn');
  await page.waitForSelector('.curve-box svg');
  await page.locator('.curve-box input[type="range"]').fill('80');
  await expect(page.locator('.curve-box .mono')).toContainText('JC d = saturated');
  await page.locator('.curve-box input[type="range"]').fill('50');
  await expect(page.locator('.curve-box .mono')).toContainText('JC d = 0.8240');
  await expect(page.locator('.clock-example')).toContainText('Robinson–Foulds distance to the truth: 2');
  await expect(page.locator('.clock-example')).toContainText('Robinson–Foulds distance to the truth: 0');
  expect(ctx.consoleErrors.filter((m) => !m.includes('Content Security Policy'))).toEqual([]);
});

test('no outbound requests and no console errors across a full Milestone B click-through', async () => {
  const { page } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy');
  await nav(page, '3  Trees');
  await page.getByLabel('Tree layout').selectOption('radial');
  await page.getByLabel('Tree layout').selectOption('rect-clado');
  await page.getByLabel('Tree layout').selectOption('rect-phylo');
  await page.getByLabel('Search for a taxon').fill('HUMAN');
  await expect(page.locator('.view-trees').getByText(/\d+ match/)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Text outline' }).check();
  await expect(page.locator('.tree-outline')).toBeVisible();
  expect(ctx.consoleErrors).toEqual([]);
  expect(outsideRequests(ctx.requests)).toEqual([]);
});

test('the test oracle itself: splits and Robinson–Foulds on a tiny tree', () => {
  const t = parseLite('((A:1,B:1):1,C:1,D:1);');
  expect(splits(t).size).toBe(1);
  expect(robinsonFoulds(t, parseLite('((A:1,C:1):1,B:1,D:1);'))).toBe(2);
  expect(longestPath(t)).toBe(3);
});
