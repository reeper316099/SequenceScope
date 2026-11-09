// Screenshots of every main view in light and dark (docs/screenshots). Run with: npm run screenshots
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launch } from './helpers';

const OUT = 'docs/screenshots';
const views: [string, string][] = [['align', '1  Align'], ['distances', '2  Distances'], ['trees', '3  Trees'], ['msa', '4  MSA'], ['examples', '5  Examples'], ['learn', '6  Learn'], ['about', '7  About']];

/** Sets the theme through the same path the menu uses. */
async function theme(page: Page, want: 'light' | 'dark'): Promise<void> {
  const now = await page.evaluate(() => document.documentElement.dataset['theme']);
  if (now !== want) await page.evaluate(() => window.dispatchEvent(new CustomEvent('menu-action', { detail: 'toggle-dark' })));
}

test('screenshots', async () => {
  test.setTimeout(180_000);
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByLabel('Sequence A: paste residues or FASTA').fill('>HBA_HUMAN-like\nMVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHG');
  await page.getByLabel('Sequence B: paste residues or FASTA').fill('>HBB_HUMAN-like\nMVHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFFESFGDLSTPDAVMGNPKV');
  await page.waitForSelector('.stats .stat-value');
  // Milestone B data: the MAFFT-aligned alpha-globins, with a bootstrap run so support values appear on the tree.
  await page.getByRole('button', { name: '2  Distances', exact: true }).click();
  await page.getByLabel('Is the input aligned?').selectOption('aligned');
  await page.getByLabel('Sequence set (FASTA)').fill(readFileSync('examples/globin_alpha_vertebrates/aligned.fasta', 'utf8'));
  await page.waitForSelector('.view-distances .dist-table');
  await page.getByRole('button', { name: '3  Trees', exact: true }).click();
  await page.locator('.view-trees button', { hasText: 'Run bootstrap' }).first().click();
  await page.waitForSelector('.boot-result table', { timeout: 30000 });
  // Milestone C: align the same family with the app's own progressive aligner so the MSA view has data.
  await page.getByRole('button', { name: '4  MSA', exact: true }).click();
  await page.getByLabel('Sequences to align (FASTA)').fill(readFileSync('examples/globin_alpha_vertebrates/sequences.fasta', 'utf8'));
  await page.locator('.view-msa').getByRole('button', { name: 'Align', exact: true }).click();
  await page.waitForSelector('.view-msa .msa-summary .stat', { timeout: 60000 });
  for (const mode of ['light', 'dark'] as const) {
    await theme(page, mode);
    for (const [id, label] of views) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 1400, height: id === 'align' || id === 'trees' || id === 'distances' || id === 'msa' ? 2900 : 1000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${id}-${mode}.png` });
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  }
  await app.close();
});
