// Checkpoint 5 part of the in-window parity run: the progressive multiple alignment, TypeScript backend (Web Worker in
// WKWebView / JavaScriptCore) versus Rust backend (Tauri command), on the app's example sequences plus seeded synthetic sets;
// error replies; cancellation; and the real MSA view driven under both backends. The MSA uses no logarithm, so every number
// (rows, merge scores, guide-tree branch lengths, sum of pairs) must be EXACTLY equal.
import { invoke } from '@tauri-apps/api/core';
import { createMsaWorker } from '../backend';
import type { BackendName, JobWorker } from '../backend';
import type { MsaResult } from '../bio/msa';
import { parseFasta } from '../bio/fasta';
import type { Alphabet, ScoringSpec, WorkerReply } from '../shared/types';
import type { MsaRequest } from '../workers/protocol';
import { alignmentRows, blosum62, DNA, dnaScoring, PROTEIN } from './inputs';
import { addCheck, fnv1a32, sleep, waitFor } from './util';
import type { Check } from './util';

interface MsaSet { id: string; alphabet: Alphabet; seqs: { id: string; description: string; alphabet: Alphabet; residues: string }[] }

const dnaSc = (): ScoringSpec => dnaScoring({ kind: 'affine', open: 5, extend: 1 });
const protSc = (): ScoringSpec => blosum62({ kind: 'affine', open: 11, extend: 1 });
const scoringFor = (a: Alphabet): ScoringSpec => (a === 'protein' ? protSc() : dnaSc());

/** JSON with sorted keys, so two objects with the same content compare equal whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Path and values of the first difference between two JSON-like values (for failure messages). */
function firstDiff(a: unknown, b: unknown, path: string): string {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? 'none' : `${path}: ${String(a)} vs ${String(b)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d !== 'none') return d;
  }
  return 'none';
}

/** Runs a job on a worker and resolves with its final reply (progress messages are counted). */
function run<R>(worker: JobWorker<R>, request: unknown): Promise<{ reply: WorkerReply<R>; progress: number }> {
  return new Promise((resolve) => {
    let progress = 0;
    worker.onmessage = (ev) => { if (ev.data.type === 'progress') { progress++; return; } worker.terminate(); resolve({ reply: ev.data, progress }); };
    worker.onerror = (ev) => { worker.terminate(); resolve({ reply: { type: 'error', message: ev.message, code: 'worker-error' }, progress }); };
    worker.postMessage(request);
  });
}

const msaRequest = (set: MsaSet, guide: 'upgma' | 'nj', scoring: ScoringSpec = scoringFor(set.alphabet)): MsaRequest => ({ type: 'msa', seqs: set.seqs, alphabet: set.alphabet, scoring, guide });

/** The example sets (unaligned sequences) and two seeded synthetic sets. */
async function loadSets(): Promise<MsaSet[]> {
  const index = (await (await fetch('/examples/index.json')).json()) as { sets: { id: string; molecule: 'dna' | 'protein'; records: number }[] };
  const sets: MsaSet[] = [];
  for (const s of index.sets.filter((x) => x.records >= 2)) {
    const parsed = parseFasta(await (await fetch(`/examples/${s.id}/sequences.fasta`)).text(), { alphabet: s.molecule });
    sets.push({ id: s.id, alphabet: s.molecule, seqs: parsed.records.map((r) => ({ id: r.id, description: '', alphabet: s.molecule, residues: r.residues })) });
  }
  sets.push({ id: 'synthetic DNA 12 x 250', alphabet: 'dna', seqs: alignmentRows(81, 12, 250, DNA).map((r, i) => ({ id: `d${i}`, description: '', alphabet: 'dna' as const, residues: r.slice(i % 5) })) });
  sets.push({ id: 'synthetic protein 8 x 150', alphabet: 'protein', seqs: alignmentRows(82, 8, 150, PROTEIN).map((r, i) => ({ id: `p${i}`, description: '', alphabet: 'protein' as const, residues: r.slice(0, r.length - (i % 7)) })) });
  return sets;
}

/** Progressive alignment for every set and both guide trees: TypeScript and Rust must agree on everything, exactly. */
async function alignmentParity(checks: Check[], sets: MsaSet[]): Promise<void> {
  const problems: string[] = [];
  let runs = 0; let steps = 0; let progressMsgs = 0;
  const viewScoring = (a: Alphabet): ScoringSpec => (a === 'protein' ? blosum62({ kind: 'linear', gap: 4 }) : dnaScoring({ kind: 'linear', gap: 4 }));
  for (const set of sets) for (const guide of ['upgma', 'nj'] as const) for (const which of ['affine', 'linear'] as const) {
    const req = msaRequest(set, guide, which === 'affine' ? scoringFor(set.alphabet) : viewScoring(set.alphabet));
    const ts = await run(createMsaWorker('ts'), req);
    const rust = await run(createMsaWorker('rust'), req);
    runs++;
    if (ts.reply.type !== 'result' || rust.reply.type !== 'result') { problems.push(`${set.id} ${guide}: ts ${ts.reply.type}${ts.reply.type === 'error' ? ' ' + ts.reply.message : ''}, rust ${rust.reply.type}${rust.reply.type === 'error' ? ' ' + rust.reply.message : ''}`); continue; }
    const a: MsaResult = ts.reply.value; const b: MsaResult = rust.reply.value;
    steps += b.steps.length; progressMsgs += rust.progress;
    if (canonical(a) !== canonical(b)) {
      const field = (Object.keys(a) as (keyof MsaResult)[]).find((k) => canonical(a[k]) !== canonical(b[k]));
      problems.push(`${set.id} ${guide} ${which}: differs in ${String(field)} at ${firstDiff(field === undefined ? a : a[field], field === undefined ? b : b[field], String(field))}`);
    }
  }
  addCheck(checks, `MSA: ${runs} runs (${sets.length} sets x UPGMA/NJ guide trees), ${steps} merge steps: rows, merge scores, guide tree and sum of pairs are exactly equal under both backends; Rust sent ${progressMsgs} progress updates`, problems.length === 0 && runs > 0, problems.slice(0, 3).join(' | '));
}

/** The same typed errors with the same messages from both backends. */
async function errorParity(checks: Check[]): Promise<void> {
  const seq = (id: string, residues: string): MsaSet['seqs'][number] => ({ id, description: '', alphabet: 'dna', residues });
  const cases: [string, MsaSet][] = [
    ['duplicate names', { id: 'x', alphabet: 'dna', seqs: [seq('a', 'ACGT'), seq('a', 'ACGA')] }],
    ['empty sequence', { id: 'x', alphabet: 'dna', seqs: [seq('a', ''), seq('b', 'ACGA')] }],
    ['invalid letter', { id: 'x', alphabet: 'dna', seqs: [seq('a', 'ACXT'), seq('b', 'ACGA')] }],
    ['no sequences', { id: 'x', alphabet: 'dna', seqs: [] }],
    ['too many sequences', { id: 'x', alphabet: 'dna', seqs: Array.from({ length: 51 }, (_, i) => seq(`s${i}`, 'ACGT')) }],
    ['too much pairwise work', { id: 'x', alphabet: 'dna', seqs: Array.from({ length: 50 }, (_, i) => seq(`w${i}`, 'ACGT'.repeat(300))) }],
  ];
  const problems: string[] = [];
  for (const [what, set] of cases) {
    const ts = (await run(createMsaWorker('ts'), msaRequest(set, 'upgma'))).reply;
    const rust = (await run(createMsaWorker('rust'), msaRequest(set, 'upgma'))).reply;
    if (ts.type !== 'error' || rust.type !== 'error') problems.push(`${what}: expected two errors, got ts ${ts.type}, rust ${rust.type}`);
    else if (ts.code !== rust.code || ts.message !== rust.message) problems.push(`${what}: ts "${ts.code}: ${ts.message}" vs rust "${rust.code}: ${rust.message}"`);
  }
  addCheck(checks, `MSA: ${cases.length} kinds of bad input give the same error code and message under both backends`, problems.length === 0, problems.slice(0, 3).join(' | '));
}

/** Polls the Rust job registry until it is empty; returns how long that took in ms (or null). */
async function drainTime(limitMs: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < limitMs) {
    if ((await invoke<number>('smoke_active_jobs')) === 0) return Math.round(performance.now() - t0);
    await sleep(10);
  }
  return null;
}

/** Cancels a long alignment on both backends: it stops, says nothing more, and the next job works. */
async function cancellation(checks: Check[]): Promise<void> {
  for (const backend of ['rust', 'ts'] as BackendName[]) {
    const seqs = alignmentRows(91, 50, 1100, DNA).map((r, i) => ({ id: `c${i}`, description: '', alphabet: 'dna' as const, residues: r }));
    const worker = createMsaWorker(backend) as JobWorker<unknown>;
    let progressed = 0; let late = 0; let stopped = false;
    worker.onmessage = (ev) => { if (stopped) late++; else if (ev.data.type === 'progress') progressed++; };
    worker.postMessage(msaRequest({ id: 'long', alphabet: 'dna', seqs }, 'upgma'));
    const started = await waitFor(() => progressed >= 2, 60_000);
    stopped = true;
    const seen = progressed;
    worker.terminate();
    const drained = backend === 'rust' ? await drainTime(4000) : 0;
    await sleep(1000);
    addCheck(checks, `${backend}: cancelling a long alignment (50 sequences x 1100, after ${seen} progress updates) stops it cleanly`, started && late === 0 && drained !== null, `${late} late messages${backend === 'rust' ? `; Rust job registry empty after ${drained} ms` : ''}`);
    const again = await run(createMsaWorker(backend), msaRequest({ id: 'tiny', alphabet: 'dna', seqs: [{ id: 'a', description: '', alphabet: 'dna', residues: 'ACGTACGT' }, { id: 'b', description: '', alphabet: 'dna', residues: 'ACGAACGT' }, { id: 'c', description: '', alphabet: 'dna', residues: 'ACGTACCT' }] }, 'nj'));
    addCheck(checks, `${backend}: a new alignment runs normally after the cancel`, again.reply.type === 'result');
  }
}

// ------------------------------------------------------------------------------------------------ the real view

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
const setBackend = (b: BackendName): void => { (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = b; };
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, v: string): void => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

const lastSvg: Record<string, string> = {};

/** Where the last two guide-tree drawings first differ, with a little context. */
function svgContext(): string {
  const a = lastSvg['ts'] ?? ''; const b = lastSvg['rust'] ?? '';
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return ` | drawing (${a.length} vs ${b.length} chars) first differs at ${i}: ts [${a.slice(Math.max(0, i - 40), i + 60)}] rust [${b.slice(Math.max(0, i - 40), i + 60)}]`;
}

/** Runs the real MSA view under one backend; returns what the user sees (tiles, text alignment, guide-tree drawing), or null. */
async function uiMsa(backend: BackendName, set: MsaSet, guide: 'upgma' | 'nj'): Promise<string | null> {
  setBackend(backend);
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => normalize(x.textContent ?? '') === '4 MSA')?.click();
  await sleep(300);
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sequences to align (FASTA)"]');
  const sel = document.querySelector<HTMLSelectElement>('select[aria-label="Guide-tree method"]');
  const align = [...document.querySelectorAll<HTMLButtonElement>('.view-msa button')].find((b) => b.textContent === 'Align');
  if (area === null || sel === null || align === undefined) return null;
  typeInto(area, set.seqs.map((s) => `>${s.id}\n${s.residues}`).join('\n'));
  sel.value = guide; sel.dispatchEvent(new Event('change', { bubbles: true }));
  if (!(await waitFor(() => !align.disabled, 10_000))) return null;
  align.click();
  const status = (): string => normalize(document.querySelector('.view-msa .status-host')?.textContent ?? '');
  if (!(await waitFor(() => status() !== '' || document.querySelector('.view-msa .stats') !== null, 5000))) return null;
  if (!(await waitFor(() => !status().startsWith('Aligning') && document.querySelector('.view-msa .stats') !== null, 120_000))) return null;
  // The page redraws the guide tree a little after the result arrives (an unfocused window throttles redraws), so wait until
  // the tiles say the requested guide tree AND the drawing has stopped changing.
  const snapshot = (): { tiles: string; text: string; svg: string } => ({
    tiles: normalize(document.querySelector<HTMLElement>('.view-msa .stats')?.innerText ?? ''),
    text: document.querySelector<HTMLElement>('.view-msa pre.msa-text')?.textContent ?? '',
    svg: document.querySelector('.view-msa .guide-host svg')?.outerHTML ?? '',
  });
  let before = snapshot();
  for (let settled = 0; settled < 2;) {
    await sleep(400);
    const now = snapshot();
    const right = now.tiles.includes(guide === 'upgma' ? 'UPGMA' : 'NJ (midpoint-rooted)');
    settled = right && now.svg === before.svg && now.tiles === before.tiles ? settled + 1 : 0;
    before = now;
  }
  const { tiles, text, svg } = before;
  lastSvg[backend] = svg;
  return `${tiles} | ${text.length} text chars #${fnv1a32(new TextEncoder().encode(text))} | guide drawing #${fnv1a32(new TextEncoder().encode(svg))}`;
}

/** Drives the real MSA view under both backends and compares what is shown. */
async function uiParity(checks: Check[], sets: MsaSet[]): Promise<void> {
  const set = sets.find((s) => s.id === 'mito_cytb_mammals') ?? sets[0];
  if (set === undefined) return;
  const results: string[] = [];
  for (const guide of ['upgma', 'nj'] as const) {
    const ts = await uiMsa('ts', set, guide);
    const rust = await uiMsa('rust', set, guide);
    let repeat = '';
    if (ts !== rust) {
      // Diagnostics: run each backend a second time. If a backend disagrees with ITSELF the drawing is not deterministic.
      const hs = (svg: string): string => [...svg.matchAll(/ H ([0-9.]+)/g)].map((m) => Number(m[1]).toFixed(1)).slice(0, 14).join(',');
      const [t1, r1] = [lastSvg['ts'] ?? '', lastSvg['rust'] ?? ''];
      const ts2 = await uiMsa('ts', set, guide);
      const t2 = lastSvg['ts'] ?? '';
      const rust2 = await uiMsa('rust', set, guide);
      const r2 = lastSvg['rust'] ?? '';
      repeat = ` | repeat runs: ts#2 ${ts2 === ts ? 'same as' : 'DIFFERENT from'} ts#1, rust#2 ${rust2 === rust ? 'same as' : 'DIFFERENT from'} rust#1; H positions ts1 [${hs(t1)}] rust1 [${hs(r1)}] ts2 [${hs(t2)}] rust2 [${hs(r2)}]`;
    }
    results.push(ts !== null && ts === rust ? 'ok' : ts === null || rust === null ? `${guide}: a run never finished (ts ${ts === null ? 'timeout' : 'ok'}, rust ${rust === null ? 'timeout' : 'ok'})` : `${guide}: differs in ` + ts.split(" | ").map((p, k) => (p === rust.split(" | ")[k] ? null : `[${p.slice(0, 90)}] vs [${(rust.split(" | ")[k] ?? "").slice(0, 90)}]`)).filter((x) => x !== null).join("; ") + svgContext() + repeat);
  }
  addCheck(checks, `UI: the MSA view (${set.id}, ${set.seqs.length} sequences) shows identical tiles, alignment text and guide-tree drawing under both backends, for UPGMA and NJ`, results.every((r) => r === 'ok'), results.filter((r) => r !== 'ok').join(' | '));
}

/** The Checkpoint 5 checks. */
export async function runMsaParity(checks: Check[]): Promise<void> {
  const sets = await loadSets();
  addCheck(checks, `MSA input sets: ${sets.map((s) => `${s.id} (${s.seqs.length})`).join(', ')}`, sets.length >= 4);
  await alignmentParity(checks, sets);
  await errorParity(checks);
  await cancellation(checks);
  await uiParity(checks, sets);
}
