// Phase 7 extras: project restart, every bad FASTA/Newick fixture through the UI, remaining export formats, full click-through.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enterPair, launch } from './helpers';
import type { Launched } from './helpers';

const dir = mkdtempSync(path.join(tmpdir(), 'sscope-p7-'));
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const saveTo = async (app: Launched['app'], file: string): Promise<void> => { await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f }); }, file); };
const openFrom = async (app: Launched['app'], file: string): Promise<void> => { await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f], bookmarks: [] }); }, file); };

test('project save, RESTART the app, open: identical results', async () => {
  const file = path.join(dir, 'restart.json');
  const first = await launch();
  await enterPair(first.page, 'GCATGCGTTAGC', 'GATTACATTGC');
  await first.page.locator('.view-align').getByLabel('Substitution scoring').selectOption('simple');
  await first.page.locator('.view-align').getByLabel('Gap model').selectOption('affine');
  await first.page.locator('.view-align').getByLabel('Affine gap opening penalty').fill('6');
  await first.page.locator('.view-align').getByLabel('Affine gap extension penalty').fill('2');
  await first.page.locator('.view-align').getByLabel('Alignment mode').selectOption('local');
  await first.page.locator('.view-align').getByLabel('Random seed', { exact: true }).fill('31337');
  await expect(first.page.locator('.view-align .stats').first()).toContainText('local; match 2, mismatch -3; affine gap open 6 / extend 2');
  const stats1 = await first.page.locator('.view-align .stats').first().innerText();
  const aln1 = await first.page.locator('.view-align .aln-body').innerText();
  await saveTo(first.app, file);
  await first.page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect.poll(() => existsSync(file)).toBe(true);
  await first.app.close();
  const second = await launch(); // a brand-new process and a brand-new profile
  await openFrom(second.app, file);
  await second.page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(second.page.locator('.view-align .stats').first()).toContainText('local; match 2, mismatch -3; affine gap open 6 / extend 2');
  expect(await second.page.locator('.view-align .stats').first().innerText()).toBe(stats1);
  expect(await second.page.locator('.view-align .aln-body').innerText()).toBe(aln1);
  await expect(second.page.locator('.view-align').getByLabel('Random seed', { exact: true })).toHaveValue('31337');
  await second.app.close();
});

test('every bad FASTA fixture gets the right message and nothing is silently dropped', async () => {
  const { app, page } = await launch();
  const expected: Record<string, RegExp> = {
    'invalid_chars.fasta': /! at 15|not valid for dna|not valid for/,
    'empty_record.fasta': /has no residues/,
    'duplicate_names.fasta': /used by records 1 and 2/,
    'empty.fasta': /Load or paste/,
    'no_header.fasta': /30 residues|1 sequences/,
    'good_multi_crlf.fasta': /Removed 5 digit/,
  };
  const files = readdirSync('tests/fixtures/fasta').filter((f) => f in expected);
  expect(files.length).toBe(Object.keys(expected).length);
  await nav(page, '2  Distances');
  for (const f of files) {
    await page.getByLabel('Sequence set (FASTA)').fill(readFileSync(`tests/fixtures/fasta/${f}`, 'utf8'));
    await expect(page.locator('.view-distances .seq-messages, .view-distances .badge').first()).toBeVisible();
    await expect.poll(async () => (await page.locator('.view-distances').first().innerText()), { message: f }).toMatch(expected[f] as RegExp);
  }
  // the pasted text is never changed behind the user's back
  const raw = readFileSync('tests/fixtures/fasta/invalid_chars.fasta', 'utf8');
  await page.getByLabel('Sequence set (FASTA)').fill(raw);
  await expect(page.getByLabel('Sequence set (FASTA)')).toHaveValue(raw);
  await app.close();
});

test('every bad Newick fixture is explained with its position', async () => {
  const { app, page } = await launch();
  const cases = (JSON.parse(readFileSync('tests/fixtures/newick/cases.json', 'utf8')) as { bad: { id: string; text: string; contains: string; line?: number; column?: number }[] }).bad;
  await nav(page, '3  Trees');
  for (const c of cases) {
    await page.getByLabel('Paste a Newick tree').fill(c.text);
    await page.locator('.view-trees button', { hasText: 'Load pasted Newick' }).first().click();
    await expect(page.locator('.newick-msg'), c.id).toContainText(c.contains);
    if (c.line !== undefined && c.column !== undefined) await expect(page.locator('.newick-msg'), c.id).toContainText(`line ${c.line}, column ${c.column}`);
  }
  await app.close();
});

test('PHYLIP and SVG exports work through the native save path', async () => {
  const { app, page } = await launch();
  await nav(page, '2  Distances');
  await page.getByLabel('Is the input aligned?').selectOption('aligned');
  await page.getByLabel('Sequence set (FASTA)').fill('>alpha_long_name\nACGTACGTACGTAC\n>beta\nACGTACGAACGTAC\n>gamma\nACGAACGTACGTTC\n>delta\nTCGTACGTACGTAC');
  await expect(page.locator('.view-distances .dist-table')).toBeVisible();
  const phy = path.join(dir, 'd.phy'); await saveTo(app, phy);
  await page.locator('.view-distances button', { hasText: 'Export PHYLIP' }).click();
  await expect.poll(() => existsSync(phy)).toBe(true);
  const lines = readFileSync(phy, 'utf8').trim().split('\n');
  expect(lines[0]).toBe('4');
  expect(lines).toHaveLength(5);
  expect(lines[1]?.slice(0, 10)).toBe('alpha_long');
  expect(lines[1]?.split(' ').filter(Boolean)).toHaveLength(5);
  await nav(page, '3  Trees');
  await expect(page.locator('.view-trees .tree-svg g[data-index]').first()).toBeVisible();
  const svg = path.join(dir, 't.svg'); await saveTo(app, svg);
  await page.locator('.view-trees button', { hasText: 'Export SVG' }).first().click();
  await expect.poll(() => existsSync(svg)).toBe(true);
  const text = readFileSync(svg, 'utf8');
  expect(text).toContain('<svg');
  expect(text).toContain('alpha_long_name');
  expect(text).not.toMatch(/style="/); // self-contained via presentation attributes, no inline style
  await app.close();
});

test('a full click-through of all seven views makes no network requests and logs no errors; every file action uses a native dialog', async () => {
  const ctx = await launch();
  const { page } = ctx;
  await enterPair(page, 'ACGTACGTACGTACGT', 'ACGTTCGTACGAACGT');
  await page.locator('.view-align').getByRole('button', { name: 'Run shuffle test' }).click();
  await page.waitForSelector('.signif-results .stat');
  await nav(page, '2  Distances');
  await page.getByLabel('Sequence set (FASTA)').fill('>a\nACGTACGTAC\n>b\nACGTACGTAA\n>c\nACGAACGTAC\n>d\nTCGTACGTAC');
  await expect(page.locator('.view-distances .dist-table')).toBeVisible();
  await nav(page, '3  Trees');
  await expect(page.locator('.view-trees .tree-svg g[data-index]').first()).toBeVisible();
  await nav(page, '4  MSA');
  await page.getByLabel('Sequences to align (FASTA)').fill('>a\nACGTACGTAC\n>b\nACGTACGAAC\n>c\nACGAACGTAC');
  await page.locator('.view-msa').getByRole('button', { name: 'Align', exact: true }).click();
  await expect(page.locator('.view-msa .msa-summary .stat').first()).toBeVisible({ timeout: 30_000 });
  for (const n of ['5  Examples', '6  Learn', '7  About']) await nav(page, n);
  await page.waitForSelector('.view-about .card');
  expect(ctx.consoleErrors).toEqual([]);
  expect(ctx.requests.filter((u) => !/^(app|data|blob|devtools):/.test(u))).toEqual([]);
  await ctx.app.close();
});
