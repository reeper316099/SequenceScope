// Ported from tests/e2e/align.spec.ts: the same checks, run in Chromium against the REAL Rust core through the test bridge.
// Expected numbers that the Electron version took from the TypeScript aligner are now fixed values (computed once with the
// TypeScript reference at the tag ts-reference-v0.1.0 and also proven equal to Rust by the parity fixtures).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BASE, enterPair, launch, openFrom, outsideRequests, saveTo } from './helpers';
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

/** Asks the test bridge for one of its counters (effective_cancels, active_jobs). */
const ask = (page: Page, command: string): Promise<string> => page.evaluate(async (c) => { const r = await fetch(`/invoke/${c}`, { method: 'POST', body: '{"args":{}}' }); return new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).subarray(5)); }, command);

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
  expect(outsideRequests(ctx.requests)).toEqual([]);
  // the numbers really came from Rust: the page asked the bridge, and no Web Worker was started for the alignment
  expect(ctx.requests.some((u) => u.endsWith('/invoke/align_pair'))).toBe(true);
});

test('numbers match the reference aligner (textbook Needleman–Wunsch example: score 0)', async () => {
  const { page } = ctx;
  await enterPair(page, 'GCATGCG', 'GATTACA');
  await setLinearDna(page, 1, -1, 1);
  await expect(scoreTile(page)).toHaveText('0');
  const rows = await page.locator('.aln-body .aln-line').allInnerTexts();
  const letters = rows.map((r) => r.replace(/^[AB]\s+\d+\s+/, '').replace(/\s+\d+$/, '').trim()).filter((r) => /^[ACGT-]+$/.test(r));
  expect(letters).toEqual(['GCA-TGCG', 'G-ATTACA']); // from the TypeScript reference (first optimal alignment)
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
  await enterPair(page, 'AAAAGGGGTTTT', 'AAAATTTT');
  await setLinearDna(page, 2, -3, 4);
  await expect(scoreTile(page)).toHaveText('0'); // linear: 2/-3, gap 4 (TypeScript reference)
  await page.locator('.view-align').getByLabel('Gap model').selectOption('affine');
  await page.locator('.view-align').getByLabel('Affine gap opening penalty').fill('5');
  await page.locator('.view-align').getByLabel('Affine gap extension penalty').fill('1');
  await expect(scoreTile(page)).toHaveText('8'); // affine: open 5, extend 1 (TypeScript reference)
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
  // Cancel test: the bridge holds the next job "running" until it is cancelled, so Cancel is clicked on a job that is certain to still be
  // running however fast the machine is (the largest run the app allows, 600 x 600 x 5000, takes only about 1.7 s in Rust).
  const big = (s: string): string => s.slice(0, 40).repeat(15);
  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill(big(a));
  await page.locator('.view-align').getByLabel('Sequence B: paste residues or FASTA').fill(big(b));
  await expect(page.locator('.view-align .stat', { hasText: 'Alignment length' }).locator('.stat-value')).toHaveText(/^([6-9]\d\d|\d{4})$/, { timeout: 30_000 }); // the NEW 600-residue result, not the earlier 120-residue one
  await expect.poll(() => ask(page, 'active_jobs')).toBe('0'); // nothing else is running when the hold starts
  await page.locator('.view-align').getByLabel('Number of shuffles').fill('5000');
  const cancelsBefore = Number(await ask(page, 'effective_cancels'));
  await ask(page, 'hold_jobs');
  await page.getByRole('button', { name: 'Run shuffle test' }).click();
  await expect(page.locator('.signif-status')).toContainText('Running');
  await page.locator('.view-align .signif').getByRole('button', { name: 'Cancel' }).evaluate((b: HTMLElement) => b.click());
  await expect(page.locator('.signif-status')).toContainText('Cancelled');
  // and the click reached a RUNNING job in Rust, which then stopped (the Electron version could only check the button)
  await expect.poll(async () => Number(await ask(page, 'effective_cancels')), { timeout: 3_000 }).toBe(cancelsBefore + 1); // the cancel request travels after the button turns to 'Cancelled'
  await expect.poll(() => ask(page, 'active_jobs'), { timeout: 3_000 }).toBe('0');
  await ask(page, 'release_jobs');
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
  await saveTo(app, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'save-project' })));
  await expect.poll(() => existsSync(file)).toBe(true);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { align: { seed: number; scoring: { gaps: { gap: number } } } };
  expect(saved.align.seed).toBe(4242);
  expect(saved.align.scoring.gaps.gap).toBe(5);

  await page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA').fill('TTTTTTTT');
  await openFrom(app, file);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.locator('.view-align').getByLabel('Sequence A: paste residues or FASTA')).toHaveValue('GCATGCG');
  await expect(page.locator('.view-align').getByLabel('Random seed', { exact: true })).toHaveValue('4242');
  await expect(page.locator('.view-align').getByLabel('Linear gap penalty')).toHaveValue('5');

  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{"app":"SequenceScope","formatVersion":1,"align":');
  await openFrom(app, bad);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'open-project' })));
  await expect(page.locator('#toast')).toContainText('not valid JSON');
  const newer = path.join(dir, 'newer.json');
  writeFileSync(newer, JSON.stringify({ app: 'SequenceScope', formatVersion: 99 }));
  await openFrom(app, newer);
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
    await saveTo(app, target);
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

/** Sends a raw HTTP request line to the bridge (a browser would tidy `..` away before sending). */
function rawGet(rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const r = request({ host: u.hostname, port: u.port, method: 'GET', path: rawPath }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject);
    r.end();
  });
}

test('security: the page gets only the 5 bridge functions, the production CSP blocks outside connections, the bridge refuses path traversal', async () => {
  const { page } = ctx;
  expect(await page.evaluate(() => Object.keys((window as unknown as { sequenceScope: object }).sequenceScope).sort())).toEqual(['copyText', 'getAppInfo', 'openExternal', 'openFile', 'saveFile']);
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  // the production Content-Security-Policy (read from tauri.conf.json by the bridge) is what stops a connection to another site
  expect(await page.evaluate(async () => { try { await fetch('https://example.com/'); return false; } catch { return true; } })).toBe(true);
  const violation = await page.evaluate(() => new Promise<string>((resolve) => {
    document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), { once: true });
    void fetch('https://example.com/').catch(() => undefined);
  }));
  expect(violation).toBe('connect-src');
  // these only prove the TEST BRIDGE is not an open door; the app itself serves files through Tauri's own protocol
  for (const p of ['/examples/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/examples/%2e%2e/%2e%2e/package.json', '/package.json']) expect([400, 403, 404], p).toContain(await rawGet(p));
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
  const again = await launch(userData); // the same Chrome profile, a new browser process
  expect(await again.page.evaluate(() => document.documentElement.dataset['theme'])).toBe(after);
  await again.app.close();
  ctx = await launch(); // so afterEach has something to close
});
