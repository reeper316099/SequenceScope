// Checkpoint 4 part of the in-window parity run: distance matrices and the column bootstrap, TypeScript backend (Web Worker in
// WKWebView / JavaScriptCore) versus Rust backend (Tauri commands), on the app's own example data; plus the real Distances and
// Trees views driven under both backends, and cancellation.
//
// FLOAT POLICY (measured, see the Checkpoint 4 report): models that use a logarithm (Jukes-Cantor, Poisson) are computed in
// Rust with V8's logarithm (bit-identical to Node/V8 on Apple Silicon). JavaScriptCore, which runs the TypeScript backend here,
// uses the C library's log, which differs from V8's by at most 1 ulp. So for those models this run allows 2 ulps on distance
// values and 1e-12 relative on tree branch lengths, and requires everything else (statuses, compared sites, split counts,
// supports, topology, names) to be exactly equal. The p-distance model uses no logarithm and must be exactly equal.
import { invoke } from '@tauri-apps/api/core';
import { createBootstrapWorker, createDistancesWorker } from '../backend';
import type { BackendName, JobWorker } from '../backend';
import type { BootstrapResult } from '../bio/bootstrap';
import { modelsFor } from '../bio/distance';
import { parseFasta } from '../bio/fasta';
import type { Alphabet, DistanceMatrix, GapPolicy, WorkerReply } from '../shared/types';
import type { BootstrapRequest, DistancesRequest } from '../workers/protocol';
import { alignmentRows, DNA, dnaScoring } from './inputs';
import { addCheck, sleep, waitFor } from './util';
import type { Check } from './util';

const MAX_MATRIX_ULPS = 2;
const TREE_REL_TOL = 1e-12;

const dv = new DataView(new ArrayBuffer(16));
/** Distance in units in the last place between two non-negative doubles (Infinity if the signs differ). */
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  if (Math.sign(a) !== Math.sign(b)) return Infinity;
  dv.setFloat64(0, Math.abs(a)); dv.setFloat64(8, Math.abs(b));
  const d = dv.getBigUint64(0) - dv.getBigUint64(8);
  return Number(d < 0n ? -d : d);
}

interface Example { id: string; molecule: Alphabet; names: string[]; rows: string[]; unalignedSeqs: { id: string; description: string; alphabet: Alphabet; residues: string }[] }

/** Loads one example set (aligned copy and unaligned sequences) from the app's bundled examples. */
async function loadExample(id: string, molecule: 'dna' | 'protein'): Promise<Example> {
  const aligned = parseFasta(await (await fetch(`/examples/${id}/aligned.fasta`)).text(), { allowGaps: true, alphabet: molecule });
  const raw = parseFasta(await (await fetch(`/examples/${id}/sequences.fasta`)).text(), { alphabet: molecule });
  return { id, molecule, names: aligned.records.map((r) => r.id), rows: aligned.records.map((r) => r.residues), unalignedSeqs: raw.records.map((r) => ({ id: r.id, description: '', alphabet: molecule, residues: r.residues })) };
}

/** Runs a job on a worker and resolves with its final reply (progress messages are collected). */
function run<R>(worker: JobWorker<R>, request: unknown): Promise<{ reply: WorkerReply<R>; progress: number }> {
  return new Promise((resolve) => {
    let progress = 0;
    worker.onmessage = (ev) => { if (ev.data.type === 'progress') { progress++; return; } worker.terminate(); resolve({ reply: ev.data, progress }); };
    worker.onerror = (ev) => { worker.terminate(); resolve({ reply: { type: 'error', message: ev.message, code: 'worker-error' }, progress }); };
    worker.postMessage(request);
  });
}

/** Compares two matrices: statuses and compared counts exactly; values within `maxUlps`. Returns max ulps seen, or a problem text. */
function compareMatrices(ts: DistanceMatrix, rust: DistanceMatrix, maxUlps: number): { maxUlp: number; exact: number; total: number; problem: string | null } {
  if (ts.n !== rust.n || ts.names.join('\u0001') !== rust.names.join('\u0001') || ts.model !== rust.model || ts.gapPolicy !== rust.gapPolicy) return { maxUlp: 0, exact: 0, total: 0, problem: 'shape differs' };
  let maxUlp = 0; let exact = 0;
  for (let k = 0; k < ts.n * ts.n; k++) {
    if (ts.status[k] !== rust.status[k]) return { maxUlp, exact, total: k, problem: `status differs at ${k}` };
    if (ts.compared[k] !== rust.compared[k]) return { maxUlp, exact, total: k, problem: `compared differs at ${k}` };
    const u = ulps(ts.values[k] as number, rust.values[k] as number);
    if (u === 0) exact++;
    maxUlp = Math.max(maxUlp, u);
    if (u > maxUlps) return { maxUlp, exact, total: k, problem: `value differs by ${u} ulps at ${k}: ${ts.values[k]} vs ${rust.values[k]}` };
  }
  return { maxUlp, exact, total: ts.n * ts.n, problem: null };
}

/** Compares two JSON-like values; numbers within `relTol` (0 = exact). Returns the path of the first difference, or null. */
function closeJson(a: unknown, b: unknown, relTol: number, path = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return null;
    return Math.abs(a - b) <= relTol * Math.max(Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = closeJson(a[i], b[i], relTol, `${path}[${i}]`); if (d !== null) return d; }
    return null;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) { const d = closeJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], relTol, `${path}.${k}`); if (d !== null) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

/** Distance matrices (aligned and pairwise-aligned) for every example set, both backends. */
async function distancesParity(checks: Check[], examples: Example[]): Promise<void> {
  const problems: string[] = [];
  let exactRuns = 0; let lnRuns = 0; let worst = 0; let cells = 0; let exactCells = 0; let lnCells = 0; let lnExactCells = 0;
  const policies: GapPolicy[] = ['pairwise-deletion', 'gaps-as-differences'];
  for (const ex of examples) {
    for (const model of modelsFor(ex.molecule)) for (const gapPolicy of policies) {
      const req: DistancesRequest = { type: 'distances', mode: 'aligned', names: ex.names, rows: ex.rows, alphabet: ex.molecule, model, gapPolicy };
      const ts = (await run(createDistancesWorker('ts'), req)).reply;
      const rust = (await run(createDistancesWorker('rust'), req)).reply;
      if (ts.type !== 'result' || rust.type !== 'result') { problems.push(`${ex.id} ${model} ${gapPolicy}: ts ${ts.type}${ts.type === 'error' ? ' ' + ts.message : ''}, rust ${rust.type}${rust.type === 'error' ? ' ' + rust.message : ''}`); continue; }
      const c = compareMatrices(ts.value, rust.value, model === 'p' ? 0 : MAX_MATRIX_ULPS);
      if (c.problem !== null) problems.push(`${ex.id} ${model} ${gapPolicy}: ${c.problem}`);
      if (model === 'p') { exactRuns++; cells += ts.value.n * ts.value.n; exactCells += c.exact; } else { lnRuns++; lnCells += ts.value.n * ts.value.n; lnExactCells += c.exact; worst = Math.max(worst, c.maxUlp); }
    }
  }
  addCheck(checks, `distances (aligned): ${exactRuns} p-distance matrices exactly equal; ${lnRuns} logarithm-model matrices within ${MAX_MATRIX_ULPS} ulps (largest difference seen: ${worst} ulp; ${lnExactCells} of ${lnCells} cells bit-identical)`, problems.length === 0, problems.slice(0, 3).join(' | ') || `p cells exactly equal: ${exactCells}/${cells}`);

  // every pair aligned (unaligned input): only the smaller example sets, one model each
  const small = examples.map((e) => ({ ...e, unalignedSeqs: e.unalignedSeqs.slice(0, 7) })); // the first 7 sequences of each set keep this quick
  const pairProblems: string[] = [];
  for (const ex of small) {
    const scoring = ex.molecule === 'protein' ? ({ substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: { kind: 'affine', open: 11, extend: 1 } } as const) : dnaScoring({ kind: 'affine', open: 5, extend: 1 });
    for (const model of modelsFor(ex.molecule)) {
      const req: DistancesRequest = { type: 'distances', mode: 'unaligned', seqs: ex.unalignedSeqs, alphabet: ex.molecule, model, gapPolicy: 'pairwise-deletion', scoring };
      const ts = (await run(createDistancesWorker('ts'), req)).reply;
      const rust = await run(createDistancesWorker('rust'), req);
      if (ts.type !== 'result' || rust.reply.type !== 'result') { pairProblems.push(`${ex.id} ${model}: ts ${ts.type}, rust ${rust.reply.type}`); continue; }
      const c = compareMatrices(ts.value, rust.reply.value, model === 'p' ? 0 : MAX_MATRIX_ULPS);
      if (c.problem !== null) pairProblems.push(`${ex.id} ${model}: ${c.problem}`);
      if (rust.progress === 0) pairProblems.push(`${ex.id} ${model}: no progress messages reached the page`);
    }
  }
  addCheck(checks, `distances (every pair aligned): ${small.length} example sets x 2 models identical (p exact, logarithm models within ${MAX_MATRIX_ULPS} ulps), progress arrives`, pairProblems.length === 0 && small.length > 0, pairProblems.slice(0, 3).join(' | '));
}

/** Column bootstrap for every example set, both methods, both a p and a logarithm model. */
async function bootstrapParity(checks: Check[], examples: Example[]): Promise<void> {
  const problems: string[] = [];
  let runs = 0; let exactTrees = 0;
  for (const ex of examples) {
    for (const model of modelsFor(ex.molecule)) for (const method of ['nj', 'upgma'] as const) {
      const req: BootstrapRequest = { type: 'bootstrap', input: { names: ex.names, rows: ex.rows, alphabet: ex.molecule, model, gapPolicy: 'pairwise-deletion', method, replicates: 60, seed: 2026 } };
      const ts = (await run(createBootstrapWorker('ts'), req)).reply;
      const rust = (await run(createBootstrapWorker('rust'), req)).reply;
      runs++;
      if (ts.type !== 'result' || rust.type !== 'result') { problems.push(`${ex.id} ${model} ${method}: ts ${ts.type}${ts.type === 'error' ? ' ' + ts.message : ''}, rust ${rust.type}${rust.type === 'error' ? ' ' + rust.message : ''}`); continue; }
      const tol = model === 'p' ? 0 : TREE_REL_TOL;
      const a: BootstrapResult = ts.value; const b: BootstrapResult = rust.value;
      // counts, supports, topology, names, failed replicates, settings: exact; branch lengths: within the policy tolerance
      const supportsDiff = closeJson(a.supports, b.supports, 0, 'supports');
      const treeDiff = closeJson(a.referenceTree, b.referenceTree, tol, 'referenceTree');
      const restDiff = closeJson({ r: a.replicates, s: a.seed, f: a.failedReplicates, m: a.method, mo: a.model, g: a.gapPolicy }, { r: b.replicates, s: b.seed, f: b.failedReplicates, m: b.method, mo: b.model, g: b.gapPolicy }, 0);
      const d = supportsDiff ?? treeDiff ?? restDiff;
      if (d !== null) problems.push(`${ex.id} ${model} ${method}: ${d}`);
      else if (closeJson(a.referenceTree, b.referenceTree, 0) === null) exactTrees++;
    }
  }
  addCheck(checks, `bootstrap: ${runs} runs (${examples.length} example sets x models x NJ/UPGMA, 60 replicates) have identical split counts, supports and topology; ${exactTrees} of ${runs} reference trees are bit-identical, the rest within ${TREE_REL_TOL} relative`, problems.length === 0, problems.slice(0, 3).join(' | '));
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

/** Cancels a long distance job and a long bootstrap on both backends: they stop, say nothing more, and the next job works. */
async function cancellation(checks: Check[]): Promise<void> {
  for (const backend of ['rust', 'ts'] as BackendName[]) {
    const seqs = alignmentRows(71, 60, 700, DNA).map((r, i) => ({ id: `c${i}`, description: '', alphabet: 'dna' as const, residues: r }));
    const dreq: DistancesRequest = { type: 'distances', mode: 'unaligned', seqs, alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }) };
    const breq: BootstrapRequest = { type: 'bootstrap', input: { names: Array.from({ length: 50 }, (_, i) => `t${i}`), rows: alignmentRows(72, 50, 3000, DNA), alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 1000, seed: 5 } };
    for (const [what, worker, req] of [['distance job', createDistancesWorker(backend) as JobWorker<unknown>, dreq], ['bootstrap', createBootstrapWorker(backend) as JobWorker<unknown>, breq]] as const) {
      let progressed = 0; let late = 0; let stopped = false;
      worker.onmessage = (ev) => { if (stopped) late++; else if (ev.data.type === 'progress') progressed++; };
      worker.postMessage(req);
      const started = await waitFor(() => progressed >= 2, 30_000);
      stopped = true;
      const seen = progressed;
      worker.terminate();
      const drained = backend === 'rust' ? await drainTime(4000) : 0;
      await sleep(1000);
      addCheck(checks, `${backend}: cancelling a long ${what} (after ${seen} progress updates) stops it cleanly`, started && late === 0 && drained !== null, `${late} late messages${backend === 'rust' ? `; Rust job registry empty after ${drained} ms` : ''}`);
    }
    const again = await run(createBootstrapWorker(backend), { type: 'bootstrap', input: { names: ['A', 'B', 'C'], rows: ['AACCGGTT', 'AACCGGTA', 'ACCCGGTT'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 5, seed: 1 } });
    addCheck(checks, `${backend}: a new bootstrap runs normally after the cancels`, again.reply.type === 'result');
  }
}

// ------------------------------------------------------------------------------------------------ the real views

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
const rail = (n: number, name: string): void => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => normalize(x.textContent ?? '') === `${n} ${name}`);
  b?.click();
};
const setBackend = (b: BackendName): void => { (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = b; };
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, v: string): void => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

/** Loads FASTA text into the Distances view under the given backend and returns what the table and heatmap show. */
async function uiDistances(backend: BackendName, text: string): Promise<string | null> {
  setBackend(backend);
  rail(2, 'Distances');
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sequence set (FASTA)"]');
  if (area === null) return null;
  typeInto(area, '');
  if (!(await waitFor(() => document.querySelector('.view-distances .dist-table') === null, 8000))) return null;
  typeInto(area, text);
  if (!(await waitFor(() => document.querySelector('.view-distances .dist-table') !== null, 60_000))) return null;
  let last = '';
  for (;;) {
    await sleep(500);
    const now = normalize(document.querySelector<HTMLElement>('.view-distances .dist-table')?.innerText ?? '');
    if (now === last && now !== '') return `${now} | canvas ${document.querySelector<HTMLCanvasElement>('.view-distances canvas')?.width ?? 0}`;
    last = now;
  }
}

/** Runs the bootstrap from the Trees view under the given backend and returns the status and result table text. */
async function uiBootstrap(backend: BackendName): Promise<string | null> {
  setBackend(backend);
  rail(3, 'Trees');
  await sleep(300);
  const rep = document.querySelector<HTMLInputElement>('input[aria-label="Number of bootstrap replicates"]');
  const seed = document.querySelector<HTMLInputElement>('input[aria-label="Bootstrap random seed"]');
  const run = [...document.querySelectorAll<HTMLButtonElement>('.view-trees button')].find((b) => b.textContent === 'Run bootstrap');
  if (rep === null || seed === null || run === undefined) return null;
  typeInto(rep, '80'); typeInto(seed, '2026');
  run.click();
  const done = await waitFor(() => /Done:/.test(normalize(document.querySelector('.view-trees .boot-result')?.parentElement?.querySelector('.status-host')?.textContent ?? '')), 120_000);
  if (!done) return null;
  await sleep(300);
  return normalize(document.querySelector<HTMLElement>('.view-trees .boot-controls')?.parentElement?.innerText ?? '');
}

/** Drives the Distances and Trees views under both backends and compares what is shown. */
async function uiParity(checks: Check[], ex: Example): Promise<void> {
  const text = ex.names.map((n, i) => `>${n}\n${ex.rows[i] ?? ''}`).join('\n');
  const ts = await uiDistances('ts', text);
  const rust = await uiDistances('rust', text);
  addCheck(checks, 'UI: the Distances view shows the identical distance table and heatmap size under both backends', ts !== null && ts === rust, ts === null || rust === null ? `a run never finished (ts ${ts === null ? 'timeout' : 'ok'}, rust ${rust === null ? 'timeout' : 'ok'})` : ts === rust ? `${ts.length} characters compared` : `ts: ${ts.slice(0, 120)} | rust: ${rust.slice(0, 120)}`);
  const bTs = await uiBootstrap('ts');
  const bRust = await uiBootstrap('rust');
  addCheck(checks, 'UI: the bootstrap (80 replicates, seed 2026) shows the identical support table under both backends', bTs !== null && bTs === bRust, bTs === null || bRust === null ? 'a run never finished' : bTs === bRust ? `${bTs.length} characters compared` : `ts: ${bTs.slice(0, 160)} | rust: ${bRust.slice(0, 160)}`);
}

/** The Checkpoint 4 checks. */
export async function runTreesParity(checks: Check[]): Promise<void> {
  const index = (await (await fetch('/examples/index.json')).json()) as { sets: { id: string; molecule: 'dna' | 'protein'; records: number; aligned: boolean }[] };
  const sets = index.sets.filter((s) => s.aligned && s.records >= 3);
  const examples: Example[] = [];
  for (const s of sets) examples.push(await loadExample(s.id, s.molecule));
  addCheck(checks, `example sets with an aligned copy, loaded from the bundle: ${examples.map((e) => `${e.id} (${e.names.length} x ${e.rows[0]?.length ?? 0})`).join(', ')}`, examples.length >= 2);
  await distancesParity(checks, examples);
  await bootstrapParity(checks, examples);
  await cancellation(checks);
  const smallest = examples.slice().sort((a, b) => a.names.length * (a.rows[0]?.length ?? 0) - b.names.length * (b.rows[0]?.length ?? 0))[0];
  if (smallest !== undefined) await uiParity(checks, smallest);
}
