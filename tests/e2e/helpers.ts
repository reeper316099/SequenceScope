// Shared e2e helpers: launch the BUILT app hidden (no focus stealing) with a throw-away user-data directory.
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  consoleErrors: string[];
  requests: string[];
}

/** Starts the app (CI adds --no-sandbox because GitHub's Ubuntu runners restrict user namespaces; the app itself still sets sandbox: true); pass `userData` to reuse a profile (e.g. to test persistence across restarts). */
export async function launch(userData = mkdtempSync(path.join(tmpdir(), 'sscope-e2e-'))): Promise<Launched> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'ELECTRON_RENDERER_URL' && v !== undefined)) as Record<string, string>; // safe: undefined values are filtered out
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, ...(process.env['CI'] ? ['--no-sandbox'] : [])], env: { ...env, SEQUENCESCOPE_E2E: '1' } });
  const page = await app.firstWindow();
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.waitForSelector('.view-align');
  return { app, page, userData, consoleErrors, requests };
}

/** Types sequences into the two boxes and waits for the worker result. */
export async function enterPair(page: Page, a: string, b: string): Promise<void> {
  await page.getByLabel('Sequence A: paste residues or FASTA').fill(a);
  await page.getByLabel('Sequence B: paste residues or FASTA').fill(b);
  await page.waitForSelector('.stats .stat-value');
}
