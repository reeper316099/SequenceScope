// Shared helpers for the bridge tests: open the UI in Chromium against the Rust test bridge, with test doubles for the native
// dialogs (the real dialog and file code is Rust and is covered by `cargo test`; see docs/rust-migration/CHECKPOINT-6B.md).
import { chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pageShim } from './shim';

export const BASE = `http://127.0.0.1:${process.env['BRIDGE_PORT'] ?? '4175'}`;

/** The stand-in for the native side: what the next Save / Open dialog will "pick", and the links the page tried to open. */
export interface BridgeApp {
  /** Path the next Save dialog returns (null = the user cancels). */
  nextSave: string | null;
  /** Path the next Open dialog returns (null = the user cancels). */
  nextOpen: string | null;
  externals: string[];
  close(): Promise<void>;
}

export interface Launched {
  app: BridgeApp;
  page: Page;
  context: BrowserContext;
  userData: string;
  consoleErrors: string[];
  requests: string[];
}

/** Opens the UI (a fresh Chrome profile, or `userData` to keep one across a "restart"). */
export async function launch(userData = mkdtempSync(path.join(tmpdir(), 'sscope-bridge-'))): Promise<Launched> {
  const context = await chromium.launchPersistentContext(userData, { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 } });
  const app: BridgeApp = { nextSave: null, nextOpen: null, externals: [], close: () => context.close() };
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  await context.exposeFunction('__native', (cmd: string, args: Record<string, unknown>): unknown => {
    switch (cmd) {
      case 'get_app_info': return { name: 'SequenceScope', version, runtime: 'Tauri (bridge test)', webview: 'Chrome', platform: process.platform };
      case 'copy_text': return { ok: true };
      case 'open_external': app.externals.push(String(args['url'])); return { ok: true };
      case 'save_file': {
        const r = args['request'] as { content: string; encoding: 'utf8' | 'base64' };
        const file = app.nextSave;
        if (file === null) return { ok: false, reason: 'cancelled' };
        app.nextSave = null;
        writeFileSync(file, r.encoding === 'base64' ? Buffer.from(r.content, 'base64') : r.content);
        return { ok: true, path: file };
      }
      case 'open_file': {
        const file = app.nextOpen;
        if (file === null) return { ok: false, reason: 'cancelled' };
        app.nextOpen = null;
        return { ok: true, name: path.basename(file), text: readFileSync(file, 'utf8') };
      }
      default: throw new Error(`unknown native command ${cmd}`);
    }
  });
  await context.addInitScript(pageShim);
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.view-align');
  return { app, page, context, userData, consoleErrors, requests };
}

/** Requests that left the app: anything but the bridge itself (the stand-in for the app's own origin) and inline data. */
export const outsideRequests = (requests: readonly string[]): string[] => requests.filter((u) => !u.startsWith(`${BASE}/`) && !/^(data|blob):/.test(u));

/** The next Save dialog "picks" `file`. */
export function saveTo(app: BridgeApp, file: string): Promise<void> { app.nextSave = file; return Promise.resolve(); }
/** The next Open dialog "picks" `file`. */
export function openFrom(app: BridgeApp, file: string): Promise<void> { app.nextOpen = file; return Promise.resolve(); }

/** Types sequences into the two boxes and waits for the result. */
export async function enterPair(page: Page, a: string, b: string): Promise<void> {
  await page.getByLabel('Sequence A: paste residues or FASTA').fill(a);
  await page.getByLabel('Sequence B: paste residues or FASTA').fill(b);
  await page.waitForSelector('.stats .stat-value');
}

/** Reads a FASTA file into id / residues records (a small independent reader, so the tests do not depend on the app's own parser). */
export function readFasta(text: string): { id: string; residues: string }[] {
  const out: { id: string; residues: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('>')) out.push({ id: line.slice(1).trim().split(/\s+/)[0] ?? '', residues: '' });
    else if (line.trim() !== '' && out.length > 0) (out[out.length - 1] as { residues: string }).residues += line.trim();
  }
  return out;
}

/** A small deterministic generator for test data (mulberry32), so the tests need nothing from the app's own code. */
export function rng(seed: number): { next(): number; int(n: number): number } {
  let s = seed >>> 0;
  const next = (): number => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n) };
}
