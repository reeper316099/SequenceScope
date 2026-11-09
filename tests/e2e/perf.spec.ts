// Performance runs INSIDE the Electron app: wall time, main-thread long tasks (the UI must stay responsive), and peak memory of all
// app processes. Skipped unless PERF=1. Writes docs/validation/perf.json.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRng } from '../../src/bio/rng';
import { launch } from './helpers';
import type { Launched } from './helpers';

test.skip(process.env['PERF'] !== '1', 'set PERF=1 to run the performance measurements');
test.setTimeout(600_000);

interface Row { scenario: string; seconds: number; longTasks: number; longestTaskMs: number; peakMemoryMB: number; note?: string }
const results: Row[] = [];

/** Runs `go` while sampling memory (all app processes) and counting main-thread long tasks (> 50 ms). */
async function measure(ctx: Launched, scenario: string, go: () => Promise<void>, note?: string): Promise<void> {
  const { page, app } = ctx;
  await page.evaluate(() => { const w = window as unknown as { __lt: number[] }; w.__lt = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({ entryTypes: ['longtask'] }); });
  let peak = 0; let stop = false;
  const sampler = (async () => { while (!stop) { const kb = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0)); peak = Math.max(peak, kb); await new Promise((r) => setTimeout(r, 200)); } })();
  const t0 = Date.now();
  await go();
  const seconds = (Date.now() - t0) / 1000;
  await page.waitForTimeout(400); // let any post-result rendering finish so its long tasks are counted
  stop = true; await sampler;
  const lt = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
  results.push({ scenario, seconds: Number(seconds.toFixed(2)), longTasks: lt.length, longestTaskMs: Math.round(Math.max(0, ...lt)), peakMemoryMB: Math.round(peak / 1024), ...(note ? { note } : {}) });
}

const protein = (rng: ReturnType<typeof createRng>, n: number): string => Array.from({ length: n }, () => 'ACDEFGHIKLMNPQRSTVWY'.charAt(rng.nextInt(20))).join('');
const mutate = (rng: ReturnType<typeof createRng>, s: string, k: number): string => { let t = s; for (let i = 0; i < k; i++) { const p = rng.nextInt(t.length - 5); t = t.slice(0, p) + 'ACDEFGHIKLMNPQRSTVWY'.charAt(rng.nextInt(20)) + t.slice(p + 1 + rng.nextInt(2)); } return t; };
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();

test('performance and responsiveness at the limits', async () => {
  const ctx = await launch();
  const { page } = ctx;
  const rng = createRng(2026);
  const A = page.locator('.view-align');

  // 1. largest allowed pairwise alignment: 5000 x 5000 protein, affine gaps (BLOSUM62, 11/1), with traceback and matrix overview
  const a = protein(rng, 5000); const b = mutate(rng, a, 600).slice(0, 5000);
  await A.getByLabel('Sequence A: paste residues or FASTA').fill(a);
  await measure(ctx, 'pairwise alignment 5000 x 5000 protein, affine (largest allowed)', async () => {
    await A.getByLabel('Sequence B: paste residues or FASTA').fill(b);
    await expect(A.locator('.stat', { hasText: 'Alignment length' }).locator('.stat-value')).toHaveText(/^\d{4,}$/, { timeout: 120_000 });
  });

  // 2. shuffle test: 1000 shuffles of a 300 x 300 DNA local affine alignment
  const d1 = Array.from({ length: 300 }, () => 'ACGT'.charAt(rng.nextInt(4))).join(''); const d2 = Array.from({ length: 300 }, () => 'ACGT'.charAt(rng.nextInt(4))).join('');
  await A.getByLabel('Sequence A: paste residues or FASTA').fill(d1);
  await A.getByLabel('Sequence B: paste residues or FASTA').fill(d2);
  await A.getByLabel('Alignment mode').selectOption('local');
  await expect(A.locator('.stat', { hasText: 'Alignment length' }).locator('.stat-value')).not.toHaveText(/^\d{4,}$/, { timeout: 30_000 }); // the NEW 300-residue result (a short local alignment), not the earlier 5000-column one
  await A.getByLabel('Number of shuffles').fill('1000');
  await measure(ctx, 'shuffle test, 1000 shuffles of 300 x 300 DNA (local, affine)', async () => {
    await A.getByRole('button', { name: 'Run shuffle test' }).click();
    await page.waitForSelector('.signif-results .stat', { timeout: 120_000 });
  });

  // 3. bootstrap: the MAFFT-aligned CYTB set (10 x 1144) and a larger synthetic alignment (50 x 3000), 100 replicates each
  await nav(page, '2  Distances');
  await page.getByLabel('Is the input aligned?').selectOption('aligned');
  await page.getByLabel('Sequence set (FASTA)').fill(readFileSync('examples/mito_cytb_mammals/aligned.fasta', 'utf8'));
  await expect(page.locator('.view-distances .status-host').last()).toContainText('10 sequences, 45 pairs', { timeout: 20_000 });
  await nav(page, '3  Trees');
  await page.getByLabel('Bootstrap random seed').fill('1');
  await measure(ctx, 'bootstrap, 100 replicates, 10 x 1144 DNA alignment (NJ)', async () => {
    await page.locator('.view-trees button', { hasText: 'Run bootstrap' }).first().click();
    await expect(page.locator('.boot-result table')).toBeVisible({ timeout: 120_000 });
  });
  const root = Array.from({ length: 3000 }, () => 'ACGT'.charAt(rng.nextInt(4))).join('');
  const seqs = [root]; for (let i = 1; i < 50; i++) { const par = seqs[rng.nextInt(seqs.length)] as string; seqs.push([...par].map((c) => (rng.nextFloat() < 0.05 ? 'ACGT'.charAt(rng.nextInt(4)) : c)).join('')); }
  await nav(page, '2  Distances');
  await page.getByLabel('Sequence set (FASTA)').fill(seqs.map((s, k) => `>t${k}\n${s}`).join('\n'));
  await expect(page.locator('.view-distances .status-host').last()).toContainText('50 sequences, 1225 pairs', { timeout: 60_000 }); // the NEW matrix, not the CYTB one
  await nav(page, '3  Trees');
  await page.getByLabel('Bootstrap random seed').fill('2');
  await measure(ctx, 'bootstrap, 100 replicates, 50 x 3000 DNA alignment (NJ)', async () => {
    await page.locator('.view-trees button', { hasText: 'Run bootstrap' }).first().click();
    await expect(page.locator('.boot-body')).toContainText('seed 2,', { timeout: 300_000 }); // the NEW result (seed 2), not the earlier seed-1 one
  });

  // 4. largest practical MSA: 50 sequences x 1000 residues (the pairwise-work cap makes ~1100 the limit for 50 sequences)
  const base = protein(rng, 1000);
  const fasta = Array.from({ length: 50 }, (_, k) => `>seq${k}\n${mutate(rng, base, 40)}`).join('\n');
  await nav(page, '4  MSA');
  await page.getByLabel('Sequences to align (FASTA)').fill(fasta);
  await measure(ctx, 'progressive MSA, 50 sequences x 1000 residues (protein, affine)', async () => {
    await page.locator('.view-msa').getByRole('button', { name: 'Align', exact: true }).click();
    await expect(page.locator('.view-msa .msa-summary .stat').first()).toBeVisible({ timeout: 300_000 });
  });

  mkdirSync('docs/validation', { recursive: true });
  writeFileSync('docs/validation/perf.json', JSON.stringify({ measuredOn: new Date().toISOString().slice(0, 10), platform: process.platform, arch: process.arch, results }, null, 2) + '\n');
  console.log('PERF ' + JSON.stringify(results));
  await ctx.app.close();
});
