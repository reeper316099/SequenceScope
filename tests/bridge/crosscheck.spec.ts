// Ported from tests/e2e/crosscheck.spec.ts: fresh cross-check driver. Runs newly generated cases through the real UI (Rust core via the test bridge)
// and saves the EXPORTED files for tools/crosscheck_fresh.py. Skipped unless CROSSCHECK_DIR is set (see tools/crosscheck_fresh.py).
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, readFasta, saveTo as pick } from './helpers';

const DIR = process.env['CROSSCHECK_DIR'];
test.skip(DIR === undefined, 'set CROSSCHECK_DIR to run the fresh cross-check driver');

interface Case { id: string; alphabet: string; mode: 'global' | 'local'; substitution: { kind: string; match?: number; mismatch?: number; name?: string }; gaps: { kind: string; gap?: number; open?: number; extend?: number }; a: string; b: string }

test('drive the app on fresh cases and keep its exported files', async () => {
  test.setTimeout(240_000);
  const dir = DIR as string; // safe: skipped when undefined
  const cases = (JSON.parse(readFileSync(path.join(dir, 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
  const { app, page } = await launch();
  const saveTo = (f: string): Promise<void> => pick(app, f);
  const alignments: { id: string; score: number; rowA: string; rowB: string }[] = [];
  const A = page.locator('.view-align');
  for (const c of cases) {
    await A.getByLabel('Sequence A: paste residues or FASTA').fill(c.a);
    await A.getByLabel('Sequence B: paste residues or FASTA').fill(c.b);
    await A.getByLabel('Alphabet').selectOption(c.alphabet);
    await A.getByLabel('Alignment mode').selectOption(c.mode);
    await A.getByLabel('Substitution scoring').selectOption(c.substitution.kind === 'simple' ? 'simple' : (c.substitution.name ?? ''));
    if (c.substitution.kind === 'simple') {
      await A.getByLabel('Match score', { exact: true }).fill(String(c.substitution.match));
      await A.getByLabel('Mismatch score', { exact: true }).fill(String(c.substitution.mismatch));
    }
    await A.getByLabel('Gap model').selectOption(c.gaps.kind);
    if (c.gaps.kind === 'linear') await A.getByLabel('Linear gap penalty').fill(String(c.gaps.gap));
    else { await A.getByLabel('Affine gap opening penalty').fill(String(c.gaps.open)); await A.getByLabel('Affine gap extension penalty').fill(String(c.gaps.extend)); }
    await page.waitForTimeout(700); // debounce + worker
    await expect(A.locator('.stat', { hasText: 'Alignment length' })).toBeVisible();
    const score = Number((await A.locator('.stat', { hasText: 'Score' }).first().locator('.stat-value').innerText()).replace('−', '-'));
    const file = path.join(dir, `${c.id}.fasta`);
    await saveTo(file);
    await A.getByRole('button', { name: 'Export…' }).click();
    await page.getByRole('button', { name: 'Alignment as FASTA (.fasta)' }).click();
    await expect.poll(() => existsSync(file)).toBe(true);
    const rows = readFasta(readFileSync(file, 'utf8'));
    alignments.push({ id: c.id, score, rowA: rows[0]?.residues ?? '', rowB: rows[1]?.residues ?? '' });
  }
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ alignments }, null, 1));
  // trees: aligned gap-free sets, p-distance, NJ and UPGMA exported as Newick
  for (const [id, n] of [['set0', 6], ['set1', 8], ['set2', 10]] as const) {
    await page.getByRole('button', { name: '2  Distances', exact: true }).click();
    await page.getByLabel('Is the input aligned?').selectOption('aligned');
    await page.getByLabel('Sequence set (FASTA)').fill(readFileSync(path.join(dir, 'trees', `${id}.fasta`), 'utf8'));
    await expect(page.locator('.view-distances .status-host').last()).toContainText(`${n} sequences, ${(n * (n - 1)) / 2} pairs`, { timeout: 15_000 });
    await page.getByRole('button', { name: '3  Trees', exact: true }).click();
    for (const [method, ext] of [['nj', 'nj'], ['upgma', 'upgma']] as const) {
      await page.getByLabel('Tree-building method').selectOption(method);
      const f = path.join(dir, 'trees', `${id}.${ext}.nwk`);
      await saveTo(f);
      await page.locator('.view-trees button', { hasText: 'Export Newick' }).first().click();
      await expect.poll(() => existsSync(f)).toBe(true);
    }
  }
  await app.close();
});
