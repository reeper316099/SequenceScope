// Milestone C end-to-end tests: progressive MSA, viewer, exports, tree-from-MSA with bootstrap, cancel, project state, Learn lessons.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFasta } from '../../src/bio/fasta';
import { createRng } from '../../src/bio/rng';
import { launch } from './helpers';
import type { Launched } from './helpers';

let ctx: Launched;
test.beforeEach(async () => { ctx = await launch(); });
test.afterEach(async () => { await ctx.app.close(); });

const dir = mkdtempSync(path.join(tmpdir(), 'sscope-msa-'));
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const alignBtn = (page: Page) => page.locator('.view-msa').getByRole('button', { name: 'Align', exact: true });
const saveTo = async (app: Launched['app'], file: string): Promise<void> => { await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f }); }, file); };
const mbtn = (page: Page, text: string) => page.locator('.view-msa button', { hasText: text }).first();

async function loadExample(page: Page, titlePart: string): Promise<void> {
  await nav(page, '4  MSA');
  const sel = page.getByLabel('Load an example set to align');
  await expect.poll(async () => (await sel.locator('option').allInnerTexts()).some((t) => t.includes(titlePart))).toBe(true);
  await sel.selectOption(await sel.locator('option', { hasText: titlePart }).first().getAttribute('value') ?? '');
  await expect(page.getByLabel('Sequences to align (FASTA)')).not.toHaveValue('');
}
async function runAlign(page: Page): Promise<void> {
  await alignBtn(page).click();
  await expect(page.locator('.view-msa .msa-summary .stat').first()).toBeVisible({ timeout: 60_000 });
}

test('aligns an example set; gap-stripped rows equal the originals; exports work; viewer text matches', async () => {
  const { page, app } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates');
  await runAlign(page);
  await expect(page.locator('.view-msa .msa-summary')).toContainText('Sum-of-pairs score');
  await expect(page.locator('.view-msa .msa-summary')).toContainText('13 sequences');
  const f = path.join(dir, 'aln.fasta');
  await saveTo(app, f);
  await mbtn(page, 'Aligned FASTA').click();
  await expect.poll(() => existsSync(f)).toBe(true);
  const aligned = parseFasta(readFileSync(f, 'utf8'), { allowGaps: true, alphabet: 'protein' }).records;
  const original = parseFasta(readFileSync('examples/globin_alpha_vertebrates/sequences.fasta', 'utf8'), { alphabet: 'protein' }).records;
  expect(aligned.map((r) => r.id)).toEqual(original.map((r) => r.id));
  expect(aligned.map((r) => r.residues.replace(/-/g, ''))).toEqual(original.map((r) => r.residues));
  expect(new Set(aligned.map((r) => r.residues.length)).size).toBe(1);
  const len = aligned[0]?.residues.length ?? 0;
  for (let c = 0; c < len; c++) expect(aligned.some((r) => r.residues[c] !== '-')).toBe(true); // no all-gap column
  // other exports
  const aln = path.join(dir, 'a.aln'); await saveTo(app, aln); await mbtn(page, 'CLUSTAL-style text').click(); await expect.poll(() => existsSync(aln)).toBe(true);
  expect(readFileSync(aln, 'utf8')).toContain('own progressive aligner');
  const csv = path.join(dir, 'c.csv'); await saveTo(app, csv); await mbtn(page, 'Conservation CSV').click(); await expect.poll(() => existsSync(csv)).toBe(true);
  const lines = readFileSync(csv, 'utf8').trim().split('\n');
  expect(lines[0]).toBe('column,consensus,identity,entropy_bits,conservation,gaps');
  expect(lines).toHaveLength(len + 1);
  const png = path.join(dir, 'a.png'); await saveTo(app, png); await mbtn(page, 'PNG image').click(); await expect.poll(() => existsSync(png)).toBe(true);
  expect([...readFileSync(png).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // text version shows the same rows
  await page.getByRole('checkbox', { name: 'Text version' }).check();
  const text = await page.locator('.msa-text').innerText();
  for (const r of aligned.slice(0, 3)) expect(text.replace(/\s+/g, '')).toContain(r.residues.slice(0, 30));
  // column selection through the number fields
  await page.getByLabel('Select columns from').fill('10');
  await page.getByLabel('Select columns to').fill('40');
  await mbtn(page, 'Select range').click();
  await expect(page.locator('.view-msa').getByText(/Columns 10–40 \(31 columns\): mean identity/)).toBeVisible();
  expect(ctx.consoleErrors).toEqual([]);
});

test('tree from MSA: one click sends the alignment to the Trees view where bootstrap is available and reproducible', async () => {
  const { page } = ctx;
  await loadExample(page, 'Hemoglobin subunit alpha across 13 vertebrates');
  await runAlign(page);
  await mbtn(page, 'Build neighbor-joining tree + bootstrap').click();
  await expect(page.locator('.view-trees')).toBeVisible();
  await expect(page.locator('.view-trees')).toContainText('own progressive aligner');
  await expect(page.locator('.view-trees .tree-svg g[data-index]').first()).toBeVisible();
  await expect(page.locator('.boot-controls')).toBeVisible();
  await page.getByLabel('Number of bootstrap replicates').fill('20');
  await page.getByLabel('Bootstrap random seed').fill('11');
  const run = async (): Promise<string> => { await page.locator('.view-trees button', { hasText: 'Run bootstrap' }).first().click(); await expect(page.locator('.boot-result table')).toBeVisible({ timeout: 30_000 }); return page.locator('.boot-result').innerText(); };
  const a = await run();
  expect(a).toContain('/ 20');
  expect(await run()).toBe(a);
});

test('cancellation works mid-run on a larger set', async () => {
  const { page } = ctx;
  const rng = createRng(5);
  const P = 'ACDEFGHIKLMNPQRSTVWY';
  const base = Array.from({ length: 900 }, () => P.charAt(rng.nextInt(20))).join('');
  const fasta = Array.from({ length: 28 }, (_, k) => { let s = base; for (let e = 0; e < 30; e++) { const p = rng.nextInt(s.length - 5); s = s.slice(0, p) + P.charAt(rng.nextInt(20)) + s.slice(p + 1 + rng.nextInt(2)); } return `>seq${k}\n${s}`; }).join('\n');
  await nav(page, '4  MSA');
  await page.getByLabel('Sequences to align (FASTA)').fill(fasta);
  await alignBtn(page).click();
  await expect(page.locator('.view-msa .status-host')).toContainText('Aligning', { timeout: 10_000 });
  await mbtn(page, 'Cancel').click();
  await expect(page.locator('.view-msa .status-host')).toContainText('Cancelled');
  await expect(page.locator('.view-msa .msa-summary .stat')).toHaveCount(0);
});

test('bad input: duplicate names are explained and can be fixed explicitly; alignment is blocked until then', async () => {
  const { page } = ctx;
  await nav(page, '4  MSA');
  await page.getByLabel('Sequences to align (FASTA)').fill('>x\nACGTACGTACGTACGTACGT\n>x\nACGTACGAACGTACGTACGT\n>y\nACGTACGTACGAACGTACGT');
  await expect(page.locator('.view-msa .seq-messages')).toContainText('unique name');
  await expect(alignBtn(page)).toBeDisabled();
  await mbtn(page, 'Make names unique').click();
  await expect(page.getByLabel('Sequences to align (FASTA)')).toHaveValue(/>x_2/);
  await expect(alignBtn(page)).toBeEnabled();
  await runAlign(page);
  await expect(page.locator('.view-msa .msa-summary')).toContainText('3 sequences');
});

test('project save and reopen restores the MSA inputs', async () => {
  const { page, app } = ctx;
  const file = path.join(dir, 'p.json');
  await nav(page, '4  MSA');
  await page.getByLabel('Sequences to align (FASTA)').fill('>a\nACGTACGTAC\n>b\nACGTACGAAC\n>c\nACGAACGTAC');
  await page.getByLabel('Guide-tree method').selectOption('nj');
  await saveTo(app, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect.poll(() => existsSync(file)).toBe(true);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { msa: { guide: string; text: string } };
  expect(saved.msa.guide).toBe('nj');
  await page.getByLabel('Sequences to align (FASTA)').fill('>q\nAAA');
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.getByLabel('Sequences to align (FASTA)')).toHaveValue(saved.msa.text);
  await expect(page.getByLabel('Guide-tree method')).toHaveValue('nj');
});

test('Learn view: progressive alignment lessons with a live example where the heuristic misses the optimum', async () => {
  const { page } = ctx;
  await nav(page, '6  Learn');
  await page.waitForSelector('text=How progressive alignment works');
  await expect(page.locator('.view-learn')).toContainText('Progressive alignment: score -14');
  await expect(page.locator('.view-learn')).toContainText('score -10');
  await expect(page.locator('.view-learn')).toContainText('Once a gap, always a gap'.replace('O', '“O').replace('ys a gap', 'ys a gap”').replace('“Once', '“Once'), { ignoreCase: true });
  expect(ctx.consoleErrors.filter((m) => !m.includes('Content Security Policy'))).toEqual([]);
});

test('no outbound requests across the MSA click-through', async () => {
  const { page } = ctx;
  await loadExample(page, 'Mitochondrial CYTB');
  await runAlign(page);
  await page.getByLabel('Conservation metric').selectOption('entropy');
  await page.getByLabel('Column width').selectOption('6');
  expect(ctx.requests.filter((u) => !/^(app|data|blob|devtools):/.test(u))).toEqual([]);
  expect(ctx.consoleErrors).toEqual([]);
});
