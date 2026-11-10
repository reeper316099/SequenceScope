// Parity run (SEQUENCESCOPE_SMOKE_MODE=parity). Inside the real Tauri window it runs the SAME inputs through the TypeScript
// backend (Web Worker, JavaScriptCore) and the Rust backend (Tauri commands, binary transfer) and demands identical
// results, then drives the real UI under both backends and compares what the user would see. Also checks cancellation.
import { invoke } from '@tauri-apps/api/core';
import { createPairwiseWorker, createShuffleWorker } from '../backend';
import { rustAlign } from '../backend/rust';
import type { BackendName, JobWorker } from '../backend';
import { createRng } from '../bio/rng';
import type { AlignMode, AlignRequest, AlignResult, GapModel, PairwiseAlignment, ScoringSpec, ShuffleRequest, ShuffleSummary, WorkerReply } from '../shared/types';
import { alignRequest, blosum62, dnaScoring, DNA, PROTEIN, randomSeq } from './inputs';
import { addCheck, sleep, waitFor } from './util';
import type { Check } from './util';

/** What a finished job looked like: its final reply plus every progress fraction seen. */
interface Run<R> {
  reply: WorkerReply<R>;
  progress: number[];
}

/** Runs one request on a worker and resolves with the final (non-progress) reply. */
function runJob<R>(worker: JobWorker<R>, request: unknown, timeoutMs = 120_000): Promise<Run<R>> {
  return new Promise((resolve) => {
    const progress: number[] = [];
    const timer = setTimeout(() => { worker.terminate(); resolve({ reply: { type: 'error', message: 'timeout', code: 'timeout' }, progress }); }, timeoutMs);
    worker.onmessage = (ev) => {
      if (ev.data.type === 'progress') { progress.push(ev.data.fraction); return; }
      clearTimeout(timer);
      worker.terminate();
      resolve({ reply: ev.data, progress });
    };
    worker.onerror = (ev) => { clearTimeout(timer); worker.terminate(); resolve({ reply: { type: 'error', message: ev.message, code: 'worker-error' }, progress }); };
    worker.postMessage(request);
  });
}

const sameAlignment = (a: PairwiseAlignment, b: PairwiseAlignment): boolean =>
  a.mode === b.mode && a.score === b.score && a.rowA === b.rowA && a.rowB === b.rowB && a.startA === b.startA && a.endA === b.endA && a.startB === b.startB && a.endB === b.endB;

type Table = Int32Array | Uint8Array | Uint16Array;
/** Element-by-element equality of two typed arrays of the same type. */
function sameTable(a: Table | undefined, b: Table | undefined): boolean {
  if (a === undefined || b === undefined || a.constructor !== b.constructor || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compares two alignment results completely (alignment, enumeration, DP metadata, and every table cell); null = identical. */
function diffAlign(ts: AlignResult, rust: AlignResult): string | null {
  if (!sameAlignment(ts.alignment, rust.alignment)) return 'alignment differs';
  if (ts.capped !== rust.capped) return 'capped flag differs';
  if (ts.all.length !== rust.all.length || ts.all.some((x, i) => !sameAlignment(x, rust.all[i] as PairwiseAlignment))) return 'enumerated alignments differ';
  const [a, b] = [ts.dp, rust.dp];
  if (a.kind !== b.kind || a.mode !== b.mode || a.rows !== b.rows || a.cols !== b.cols || a.score !== b.score) return 'dp metadata differs';
  if (a.ends.length !== b.ends.length || a.ends.some((e, i) => e !== b.ends[i])) return 'dp ends differ';
  if (a.kind === 'linear' && b.kind === 'linear') return sameTable(a.H, b.H) && sameTable(a.P, b.P) ? null : 'linear tables differ';
  if (a.kind === 'affine' && b.kind === 'affine') return sameTable(a.M, b.M) && sameTable(a.X, b.X) && sameTable(a.Y, b.Y) && sameTable(a.P, b.P) ? null : 'affine tables differ';
  return 'dp kind differs';
}

const between = (r: ReturnType<typeof createRng>, lo: number, hi: number): number => lo + r.nextInt(hi - lo + 1);

/** The in-window pairwise input set: random DNA and protein, tie-heavy binary pairs, edge cases, and typed-error cases. */
function pairwiseRequests(): { label: string; req: AlignRequest }[] {
  const r = createRng(20260404);
  const out: { label: string; req: AlignRequest }[] = [];
  const gaps = (): GapModel => (r.nextInt(3) === 0 ? { kind: 'linear', gap: between(r, 1, 8) } : { kind: 'affine', open: between(r, 2, 12), extend: between(r, 0, 4) });
  const mode = (): AlignMode => (r.nextInt(2) === 0 ? 'global' : 'local');
  let seed = 1000;
  for (let k = 0; k < 200; k++) {
    const a = randomSeq(seed++, between(r, 0, 60), DNA);
    const b = r.nextInt(2) === 0 ? randomSeq(seed++, between(r, 0, 60), DNA) : a.slice(0, a.length >> 1) + randomSeq(seed++, 5, DNA) + a.slice(a.length >> 1);
    out.push({ label: `dna#${k}`, req: alignRequest(a, b, 'dna', mode(), dnaScoring(gaps()), r.nextInt(4) === 0 ? 3 : 1000) });
  }
  for (let k = 0; k < 120; k++) {
    const a = randomSeq(seed++, between(r, 0, 60), PROTEIN);
    const b = r.nextInt(2) === 0 ? randomSeq(seed++, between(r, 0, 60), PROTEIN) : a.slice(2) + randomSeq(seed++, 3, PROTEIN);
    out.push({ label: `protein#${k}`, req: alignRequest(a, b, 'protein', mode(), blosum62(gaps())) });
  }
  for (let k = 0; k < 100; k++) {
    out.push({ label: `ties#${k}`, req: alignRequest(randomSeq(seed++, between(r, 0, 10), 'AC'), randomSeq(seed++, between(r, 0, 10), 'AC'), 'dna', mode(), dnaScoring(gaps()), r.nextInt(2) === 0 ? 5 : 1000) });
  }
  out.push({ label: 'medium protein 1200x1100', req: alignRequest(randomSeq(7001, 1200, PROTEIN), randomSeq(7002, 1100, PROTEIN), 'protein', 'global', blosum62({ kind: 'affine', open: 11, extend: 1 })) });
  out.push({ label: 'medium dna linear local 2000x1500', req: alignRequest(randomSeq(7003, 2000, DNA), randomSeq(7004, 1500, DNA), 'dna', 'local', dnaScoring({ kind: 'linear', gap: 4 })) });
  const lin: GapModel = { kind: 'linear', gap: 1 };
  out.push(
    { label: 'error: invalid residue', req: alignRequest('ACGT', 'AC#T', 'dna', 'global', dnaScoring(lin)) },
    { label: 'error: U in DNA', req: alignRequest('ACGU', 'ACGT', 'dna', 'global', dnaScoring(lin)) },
    { label: 'error: matrix with DNA', req: alignRequest('ACGT', 'ACGT', 'dna', 'global', blosum62(lin)) },
    { label: 'error: unknown matrix', req: alignRequest('ACDE', 'ACDE', 'protein', 'global', { substitution: { kind: 'matrix', name: 'PAM250' }, gaps: lin }) },
    { label: 'error: negative gap', req: alignRequest('AC', 'AC', 'dna', 'global', dnaScoring({ kind: 'linear', gap: -1 })) },
    { label: 'error: too large', req: alignRequest('A'.repeat(5001), 'A'.repeat(5001), 'dna', 'global', dnaScoring(lin)) },
    { label: 'error: cap 0', req: alignRequest('AC', 'AC', 'dna', 'global', dnaScoring(lin), 0) },
    { label: 'empty vs empty', req: alignRequest('', '', 'dna', 'global', dnaScoring(lin)) },
    { label: 'empty local', req: alignRequest('', 'ACG', 'dna', 'local', dnaScoring(lin)) },
  );
  return out;
}

/** Compares TypeScript and Rust on every pairwise input; pushes one summary check. */
async function pairwiseParity(checks: Check[]): Promise<void> {
  const cases = pairwiseRequests();
  const diffs: string[] = [];
  let errors = 0;
  let cells = 0;
  const started = performance.now();
  for (const { label, req } of cases) {
    const ts = (await runJob(createPairwiseWorker('ts'), req)).reply;
    const rust = (await runJob(createPairwiseWorker('rust'), req)).reply;
    if (ts.type === 'result' && rust.type === 'result') {
      const d = diffAlign(ts.value, rust.value);
      cells += ts.value.dp.rows * ts.value.dp.cols;
      if (d !== null) diffs.push(`${label}: ${d}`);
    } else if (ts.type === 'error' && rust.type === 'error') {
      errors++;
      if (ts.code !== rust.code || ts.message !== rust.message) diffs.push(`${label}: error differs (ts ${ts.code}: ${ts.message} | rust ${rust.code}: ${rust.message})`);
    } else {
      diffs.push(`${label}: one backend failed and the other did not (ts ${ts.type}, rust ${rust.type})`);
    }
  }
  addCheck(checks, `pairwise: ${cases.length} inputs identical on both backends (${errors} typed errors, ${cells.toLocaleString('en-US')} DP cells compared one by one)`, diffs.length === 0, `${diffs.length} mismatches in ${Math.round(performance.now() - started)} ms${diffs.length > 0 ? '; first: ' + diffs.slice(0, 3).join(' | ') : ''}`);
}

/** The shuffle summaries must be bit-identical (every score, mean, sd, z, p-value). */
async function shuffleParity(checks: Check[]): Promise<void> {
  const r = createRng(20260505);
  const diffs: string[] = [];
  let n = 0;
  for (let k = 0; k < 12; k++) {
    const protein = k % 4 === 3;
    const letters = protein ? PROTEIN : DNA;
    const scoring: ScoringSpec = protein ? blosum62({ kind: 'affine', open: 11, extend: 1 }) : dnaScoring(k % 2 === 0 ? { kind: 'linear', gap: 4 } : { kind: 'affine', open: 5, extend: 2 });
    const req: ShuffleRequest = { type: 'shuffle', a: randomSeq(300 + k, between(r, 20, 90), letters), b: randomSeq(400 + k, between(r, 20, 90), letters), alphabet: protein ? 'protein' : 'dna', mode: k % 3 === 0 ? 'global' : 'local', scoring, shuffles: between(r, 5, 80), seed: r.nextUint32() };
    const ts = (await runJob(createShuffleWorker('ts'), req)).reply;
    const rust = (await runJob(createShuffleWorker('rust'), req)).reply;
    n++;
    if (ts.type !== 'result' || rust.type !== 'result') { diffs.push(`#${k}: ts ${ts.type}, rust ${rust.type}`); continue; }
    const [a, b]: [ShuffleSummary, ShuffleSummary] = [ts.value, rust.value];
    const same = a.seed === b.seed && a.shuffles === b.shuffles && a.realScore === b.realScore && a.mean === b.mean && a.sd === b.sd && a.z === b.z && a.atLeastAsGood === b.atLeastAsGood && a.pValue === b.pValue && a.scores.length === b.scores.length && a.scores.every((s, i) => s === b.scores[i]);
    if (!same) diffs.push(`#${k}: summaries differ`);
  }
  addCheck(checks, `shuffle test: ${n} inputs, every score/mean/sd/z/p-value identical on both backends`, diffs.length === 0, diffs.slice(0, 3).join(' | '));
  const bad = (await runJob(createShuffleWorker('rust'), { type: 'shuffle', a: 'ACGT', b: 'ACGT', alphabet: 'dna', mode: 'local', scoring: dnaScoring({ kind: 'linear', gap: 1 }), shuffles: 0, seed: 1 })).reply;
  const badTs = (await runJob(createShuffleWorker('ts'), { type: 'shuffle', a: 'ACGT', b: 'ACGT', alphabet: 'dna', mode: 'local', scoring: dnaScoring({ kind: 'linear', gap: 1 }), shuffles: 0, seed: 1 })).reply;
  addCheck(checks, 'shuffle test: invalid count gives the same typed error on both backends', bad.type === 'error' && badTs.type === 'error' && bad.code === badTs.code && bad.message === badTs.message, bad.type === 'error' ? `${bad.code}: ${bad.message}` : bad.type);
}

/** Polls the Rust job registry until it is empty; returns how long that took in ms (or null if it never emptied). */
async function drainTime(limitMs: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < limitMs) {
    if ((await invoke<number>('smoke_active_jobs')) === 0) return Math.round(performance.now() - t0);
    await sleep(10);
  }
  return null;
}

/** Cancels a long alignment and a long shuffle test in both backends and checks they stop and say nothing more. */
async function cancellation(checks: Check[]): Promise<void> {
  for (const backend of ['rust', 'ts'] as BackendName[]) {
    // Long alignment: 5000 x 5000 protein affine takes about a second or more, so cancel as soon as it is running.
    const big = alignRequest(randomSeq(9001, 5000, PROTEIN), randomSeq(9002, 5000, PROTEIN), 'protein', 'global', blosum62({ kind: 'affine', open: 11, extend: 1 }));
    if (backend === 'rust') {
      // (a) Command level: progress arrives, cancel_job stops the job, the promise rejects with code "cancelled".
      const jobId = 987_654;
      let fractions = 0;
      let outcome = 'finished normally';
      const job = rustAlign(big, (f) => { fractions++; if (f > 0.02 && outcome === 'finished normally') { outcome = 'cancel sent'; void invoke('cancel_job', { jobId }); } }, jobId).then(
        () => 'finished',
        (e: unknown) => (typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'rejected'),
      );
      const code = await job;
      const drainedA = await drainTime(3000);
      addCheck(checks, 'rust: cancel_job stops a running alignment (progress arrived first) and the job reports "cancelled"', code === 'cancelled' && fractions > 0 && drainedA !== null, `result ${code}; ${fractions} progress updates; registry empty after ${drainedA} ms`);
    }
    const w = createPairwiseWorker(backend);
    let afterTerminate = 0;
    let terminated = false;
    w.onmessage = () => { if (terminated) afterTerminate++; };
    w.postMessage(big);
    await sleep(backend === 'ts' ? 50 : 150);
    terminated = true;
    w.terminate();
    const drained = backend === 'rust' ? await drainTime(3000) : 0;
    await sleep(1500); // a finished-late reply would show up here
    addCheck(checks, `${backend}: terminating a running alignment (the Cancel path the UI uses) stops it and delivers nothing afterwards`, afterTerminate === 0 && drained !== null, `${afterTerminate} late messages; ${backend === 'rust' ? `Rust job registry empty after ${drained} ms` : 'worker terminated'}`);

    // Long shuffle test: cancel mid-run, then make sure a NEW job still works.
    const shuffle: ShuffleRequest = { type: 'shuffle', a: randomSeq(9003, 500, DNA), b: randomSeq(9004, 500, DNA), alphabet: 'dna', mode: 'local', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }), shuffles: 5000, seed: 3 };
    const sw = createShuffleWorker(backend);
    let progressed = 0;
    let lateAfter = 0;
    let stopped = false;
    sw.onmessage = (ev) => { if (stopped) lateAfter++; else if (ev.data.type === 'progress') progressed++; };
    sw.postMessage(shuffle);
    const sawProgress = await waitFor(() => progressed >= 2, 20_000);
    stopped = true;
    const seen = progressed;
    sw.terminate();
    const drained2 = backend === 'rust' ? await drainTime(3000) : 0;
    await sleep(1000);
    addCheck(checks, `${backend}: cancelling a shuffle test mid-run (after ${seen} progress updates) stops it cleanly`, sawProgress && lateAfter === 0 && drained2 !== null, `${lateAfter} late messages${backend === 'rust' ? `; registry empty after ${drained2} ms` : ''}`);
    const again = (await runJob(createPairwiseWorker(backend), alignRequest('ACGT', 'ACGT', 'dna', 'global', dnaScoring({ kind: 'linear', gap: 1 })))).reply;
    addCheck(checks, `${backend}: a new job runs normally after a cancel`, again.type === 'result' && again.value.alignment.score === 8);
  }
}

/** What the user sees in the Align view, as plain strings (so two backends can be compared). */
interface UiSnapshot {
  stats: string;
  alignment: string;
  stepStart: string;
  stepAfter3: string;
  detailsAfter3: string;
  stepEnd: string;
  alignmentAfterEnd: string;
  matrix: string;
}

const root = (): HTMLElement => document.querySelector<HTMLElement>('.view-align') as HTMLElement;
const text = (sel: string): string => root().querySelector<HTMLElement>(sel)?.innerText.replace(/\s+/g, ' ').trim() ?? '';
const area = (label: string): HTMLTextAreaElement => root().querySelector<HTMLTextAreaElement>(`textarea[aria-label="Sequence ${label}: paste residues or FASTA"]`) as HTMLTextAreaElement;

/** Types text into a field the way a user would (value + input event). */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Presses a key on the stepper (it handles keydown itself). */
function press(key: string): void {
  (root().querySelector('.stepper') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/** Waits until the alignment text differs from `before` and then stays unchanged for 400 ms. */
async function settle(before: string): Promise<boolean> {
  if (!(await waitFor(() => text('.aln-body') !== before && text('.aln-body') !== '', 15_000))) return false;
  let last = text('.aln-body');
  for (;;) {
    await sleep(400);
    const now = text('.aln-body');
    if (now === last) return true;
    last = now;
  }
}

/** Page errors seen during the UI part (an exception inside a handler would otherwise be invisible). */
const pageErrors: string[] = [];
window.addEventListener('error', (e) => pageErrors.push(`${e.message} @ ${e.filename.split('/').pop() ?? ''}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => pageErrors.push(`unhandled rejection: ${String(e.reason)}`));

/** What the page shows when a run does not finish: the status line and any page errors. */
const stuckInfo = (): string => `status "${document.querySelector('.status-host')?.textContent ?? ''}"; page errors: ${pageErrors.slice(0, 2).join(' | ') || 'none'}`;

/** Enters a pair under the given backend, lets it finish, and reads the screen. */
async function uiPair(backend: BackendName, a: string, b: string): Promise<UiSnapshot | null> {
  (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = backend;
  // Enter a throw-away pair of the same kind first, so the target pair always produces a fresh run under THIS backend.
  const protein = /[DEFHIKLMPQRSVWY]/.test(a + b);
  type(area('A'), protein ? 'MMMM' : 'TTTT');
  type(area('B'), protein ? 'WWWW' : 'GGGG');
  if (!(await settle(text('.aln-body') === '' ? '\u0000' : text('.aln-body')))) return null;
  const before = text('.aln-body');
  type(area('A'), a);
  type(area('B'), b);
  if (!(await settle(before))) return null;
  const snapshot: UiSnapshot = { stats: text('.stats'), alignment: text('.aln-body'), stepStart: '', stepAfter3: '', detailsAfter3: '', stepEnd: '', alignmentAfterEnd: '', matrix: '' };
  press('Home');
  await sleep(100);
  snapshot.stepStart = text('.stepper-status');
  for (let k = 0; k < 3; k++) press('ArrowRight');
  await sleep(100);
  snapshot.stepAfter3 = text('.stepper-status');
  snapshot.detailsAfter3 = document.querySelector<HTMLElement>('.details')?.innerText.replace(/\s+/g, ' ').trim() ?? '';
  press('End');
  await sleep(100);
  snapshot.stepEnd = text('.stepper-status');
  snapshot.alignmentAfterEnd = text('.aln-body');
  const canvas = root().querySelector<HTMLCanvasElement>('canvas');
  snapshot.matrix = canvas === null ? 'no canvas' : `${canvas.width}x${canvas.height}`;
  return snapshot;
}

/** Runs the shuffle test through the visible panel; returns the result tiles' text (or the status text). */
async function uiShuffle(backend: BackendName, shuffles: number, seed: number): Promise<string> {
  (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = backend;
  type(root().querySelector<HTMLInputElement>('input[aria-label="Number of shuffles"]') as HTMLInputElement, String(shuffles));
  type(root().querySelector<HTMLInputElement>('input[aria-label="Random seed"]') as HTMLInputElement, String(seed));
  const run = [...root().querySelectorAll<HTMLButtonElement>('.signif button')].find((b) => b.textContent === 'Run shuffle test') as HTMLButtonElement;
  run.click();
  const done = await waitFor(() => (root().querySelector('.signif .stats') !== null && !(root().querySelector('.signif-status')?.textContent ?? '').startsWith('Running')), 120_000);
  return done ? `${text('.signif .stats')} | ${text('.signif-status')}` : 'timeout';
}

/** Clicks Cancel while a shuffle test runs and reports the visible state afterwards and a second later. */
async function uiCancel(backend: BackendName): Promise<string> {
  (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = backend;
  type(root().querySelector<HTMLInputElement>('input[aria-label="Number of shuffles"]') as HTMLInputElement, '5000');
  const run = [...root().querySelectorAll<HTMLButtonElement>('.signif button')].find((b) => b.textContent === 'Run shuffle test') as HTMLButtonElement;
  run.click();
  const running = await waitFor(() => /Running… [1-9]/.test(root().querySelector('.signif-status')?.textContent ?? ''), 60_000);
  const cancel = [...root().querySelectorAll<HTMLButtonElement>('.signif button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
  cancel.click();
  const now = root().querySelector('.signif-status')?.textContent ?? '';
  await sleep(1200);
  const later = root().querySelector('.signif-status')?.textContent ?? '';
  return `${running ? 'was running' : 'never started'} | ${now} | ${later} | tiles after cancel: ${root().querySelector('.signif .stats') === null ? 'none' : 'present'}`;
}

/** Drives the real Align view under both backends and compares everything the user can see. */
async function uiParity(checks: Check[]): Promise<void> {
  const pairs: [string, string][] = [
    ['GCATGCG', 'GATTACA'],
    ['MKVLAAGIVGLLLAGCT', 'MKVLSAGIVGLLAGCA'],
    [randomSeq(61, 60, DNA), randomSeq(61, 30, DNA) + 'TT' + randomSeq(62, 30, DNA)],
    ['AAAAAAAA', 'AAAA'],
    ['ACGTACGTAC', 'GTACGTACGT'],
  ];
  const diffs: string[] = [];
  for (const [i, [a, b]] of pairs.entries()) {
    const ts = await uiPair('ts', a, b);
    const rust = await uiPair('rust', a, b);
    if (ts === null || rust === null) { diffs.push(`pair ${i}: the view never finished (ts ${ts === null ? 'timeout' : 'ok'}, rust ${rust === null ? 'timeout' : 'ok'}); ${stuckInfo()}`); continue; }
    for (const k of Object.keys(ts) as (keyof UiSnapshot)[]) if (ts[k] !== rust[k]) diffs.push(`pair ${i} ${k}: ts "${ts[k].slice(0, 80)}" vs rust "${rust[k].slice(0, 80)}"`);
  }
  addCheck(checks, `UI: ${pairs.length} pairs show identical stats, alignment, matrix size and step-through (Home, 3 steps, End) under both backends`, diffs.length === 0, diffs.slice(0, 3).join(' | '));

  await uiPair('ts', 'ACGTACGTACGTAGCTAGCTAGCATCGATCGATCGA', 'ACGTTCGTACGAAGCTAGGTAGCATCGATTGATCGA');
  const tsShuffle = await uiShuffle('ts', 200, 4242);
  const rustShuffle = await uiShuffle('rust', 200, 4243); // a different seed first, then the SAME seed again below
  const rustSame = await uiShuffle('rust', 200, 4242);
  addCheck(checks, 'UI: the shuffle test (seed 4242, 200 shuffles) shows identical result tiles under both backends', tsShuffle === rustSame && tsShuffle !== 'timeout' && tsShuffle !== rustShuffle, `ts: ${tsShuffle.slice(0, 160)} | rust: ${rustSame.slice(0, 160)}`);

  await uiPair('ts', randomSeq(71, 600, DNA), randomSeq(72, 600, DNA));
  const tsCancel = await uiCancel('ts');
  const rustCancel = await uiCancel('rust');
  addCheck(checks, 'UI: Cancel during a long shuffle test shows the same state under both backends and no late result', tsCancel === rustCancel && tsCancel.startsWith('was running'), `ts: ${tsCancel} || rust: ${rustCancel}`);
  const drained = await drainTime(3000);
  addCheck(checks, 'UI: after Cancel the Rust job registry is empty (the job really stopped)', drained !== null, drained === null ? 'still running' : `${drained} ms`);
}

/** The whole parity run; returns the checks for the smoke report. */
export async function runParity(): Promise<Check[]> {
  const checks: Check[] = [];
  await waitFor(() => document.querySelector('.view-align') !== null, 15_000);
  await pairwiseParity(checks);
  await shuffleParity(checks);
  await cancellation(checks);
  await uiParity(checks);
  await (await import('./parityTrees')).runTreesParity(checks);
  await (await import('./parityMsa')).runMsaParity(checks);
  return checks;
}
