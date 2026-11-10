// "How unusual is this score?": seeded shuffle test in a worker, with progress, Cancel, a Chart.js histogram,
// z-score and empirical p-value, and clear caveats. States are a discriminated union (JobState).
import { createShuffleWorker } from '../backend';
import type { JobWorker } from '../backend';
import { BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip } from 'chart.js';
import type { AlignMode, JobState, ScoringSpec, ShuffleRequest, ShuffleSummary, WorkerReply } from '../shared/types';
import type { Alphabet } from '../shared/types';
import { callout } from './cards';
import { clear, el } from './dom';
import { histogram } from './histogram';
import { onThemeChange, token } from './theme';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export const MAX_SHUFFLE_WORK = 2_000_000_000; // shuffles x cells: keeps one run to roughly 20 s at most
export const DEFAULT_SEED = 20260001;

export interface ShuffleContext {
  a: string;
  b: string;
  alphabet: Alphabet;
  mode: AlignMode;
  scoring: ScoringSpec;
}

export interface SignificancePanel {
  root: HTMLElement;
  /** Tell the panel what the current inputs are (null = no valid alignment). Stale results are flagged. */
  setContext(c: ShuffleContext | null): void;
  getParams(): { seed: number; shuffles: number };
  setParams(p: { seed: number; shuffles: number }): void;
  onParamsChange(fn: () => void): void;
}

/** Builds the panel. */
export function createSignificancePanel(): SignificancePanel {
  const root = el('div', 'signif');
  const seedIn = el('input', undefined, undefined, { type: 'number', min: 0, max: 4294967295, step: 1, value: DEFAULT_SEED, 'aria-label': 'Random seed' });
  const countIn = el('input', undefined, undefined, { type: 'number', min: 1, max: 5000, step: 1, value: 200, 'aria-label': 'Number of shuffles' });
  const newSeed = el('button', 'btn btn-small', 'New seed', { type: 'button', title: 'Pick a seed from the clock; it is shown and saved so the run can be reproduced.' });
  const run = el('button', 'btn btn-primary', 'Run shuffle test', { type: 'button' });
  const cancel = el('button', 'btn', 'Cancel', { type: 'button' });
  const progress = el('progress', undefined, undefined, { max: 1, value: 0, 'aria-label': 'Shuffle test progress' });
  const status = el('div', 'signif-status', undefined, { 'aria-live': 'polite' });
  const chartBox = el('div', 'chart-box');
  const canvas = el('canvas', undefined, undefined, { role: 'img', 'aria-label': 'Histogram of shuffled alignment scores with the real score marked' });
  chartBox.append(canvas);
  const results = el('div', 'signif-results');
  const caveat = callout('info', 'This is a rough heuristic, not a database search statistic. It shuffles sequence B (keeping its composition) and re-scores, so it asks "is this score high compared with scrambled versions?". Local-alignment scores follow an extreme-value distribution, so the z-score is only a guide: trust the empirical p-value more. p = (1 + number of shuffles scoring at least as high) / (shuffles + 1), so it is never 0. It does not replace BLAST E-values.');

  const f1 = el('label', 'field narrow'); f1.append(el('span', 'field-label', 'Shuffles (max 5000)'), countIn);
  const f2 = el('label', 'field narrow'); f2.append(el('span', 'field-label', 'Seed'), seedIn);
  const controls = el('div', 'row'); controls.append(f1, f2, newSeed, run, cancel);
  root.append(controls, progress, status, results, chartBox, caveat);

  let ctx: ShuffleContext | null = null;
  let state: JobState<ShuffleSummary> = { status: 'idle' };
  let worker: JobWorker<ShuffleSummary> | null = null;
  let ranWith: string | null = null;
  let chart: Chart | null = null;
  let change: () => void = () => undefined;

  const signature = (c: ShuffleContext): string => JSON.stringify([c.a, c.b, c.alphabet, c.mode, c.scoring]);

  const drawChart = (r: ShuffleSummary): void => {
    chart?.destroy();
    const h = histogram(r.scores, r.realScore);
    const primary = token('--primary'); const accent = token('--accent'); const text = token('--text'); const border = token('--border');
    chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: h.labels, datasets: [{ label: 'Shuffled scores (count)', data: h.counts, backgroundColor: h.counts.map((_, k) => (k === h.realBin ? accent : primary)), borderColor: h.counts.map((_, k) => (k === h.realBin ? text : primary)), borderWidth: h.counts.map((_, k) => (k === h.realBin ? 2 : 0)) }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => `score ${items[0]?.label ?? ''}${items[0]?.dataIndex === h.realBin ? '  ← contains the REAL score' : ''}` } } },
        scales: {
          x: { title: { display: true, text: `Alignment score of shuffled sequence B (amber bar contains the real score ${r.realScore})`, color: text }, ticks: { color: text, maxRotation: 60, autoSkip: true }, grid: { color: border } },
          y: { title: { display: true, text: 'Number of shuffles', color: text }, ticks: { color: text, precision: 0 }, grid: { color: border }, beginAtZero: true },
        },
      },
    });
  };

  const render = (): void => {
    const busy = state.status === 'running';
    run.disabled = busy || ctx === null;
    cancel.hidden = !busy;
    progress.hidden = !busy;
    countIn.disabled = seedIn.disabled = newSeed.disabled = busy;
    clear(results);
    chartBox.hidden = state.status !== 'done';
    if (ctx === null) { status.textContent = 'Enter two valid sequences to enable the shuffle test.'; return; }
    if (state.status === 'idle') status.textContent = 'Not run yet. Pick the number of shuffles and a seed, then run.';
    else if (state.status === 'running') { status.textContent = `Running… ${Math.round(state.progress * 100)} %`; progress.value = state.progress; }
    else if (state.status === 'cancelled') status.textContent = 'Cancelled. No result was kept; run again to get one.';
    else if (state.status === 'error') { status.textContent = ''; results.append(callout('error', state.message)); const retry = el('button', 'btn btn-small', 'Retry', { type: 'button' }); retry.addEventListener('click', start); results.append(retry); }
    else {
      const r = state.result;
      const stale = ranWith !== null && ranWith !== signature(ctx);
      status.textContent = stale ? 'These results are from earlier inputs or scoring. Run again to update.' : '';
      const grid = el('div', 'stats');
      const tile = (l: string, v: string, d: string): HTMLElement => { const t = el('div', 'stat'); t.append(el('div', 'stat-label', l), el('div', 'stat-value', v), el('div', 'stat-detail', d)); return t; };
      grid.append(
        tile('Real score', String(r.realScore), `shuffled mean ${r.mean.toFixed(1)}, SD ${r.sd.toFixed(1)}`),
        tile('z-score', r.z === null ? 'undefined' : r.z.toFixed(2), r.z === null ? 'all shuffles scored the same' : 'rough guide only (scores are not normal)'),
        tile('Empirical p-value', r.pValue < 0.001 ? r.pValue.toExponential(2) : r.pValue.toFixed(4), `${r.atLeastAsGood} of ${r.shuffles} shuffles scored ≥ real; smallest possible is ${(1 / (r.shuffles + 1)).toPrecision(2)}`),
        tile('Seed', String(r.seed), `${r.shuffles} shuffles; same seed gives the same result`),
      );
      results.append(grid);
      if (!stale) drawChart(r);
    }
  };

  const start = (): void => {
    if (!ctx) return;
    const shuffles = Number(countIn.value);
    const seed = Number(seedIn.value);
    if (!Number.isInteger(shuffles) || shuffles < 1 || shuffles > 5000) { state = { status: 'error', message: 'The number of shuffles must be a whole number from 1 to 5000.' }; render(); return; }
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { state = { status: 'error', message: 'The seed must be a whole number from 0 to 4294967295.' }; render(); return; }
    const work = shuffles * (ctx.a.length + 1) * (ctx.b.length + 1);
    if (work > MAX_SHUFFLE_WORK) {
      state = { status: 'error', message: `Too large: ${shuffles} shuffles of ${ctx.a.length} × ${ctx.b.length} residues is about ${(work / 1e9).toFixed(1)} billion cell updates (limit ${MAX_SHUFFLE_WORK / 1e9} billion, roughly 20 seconds). Use fewer shuffles or shorter sequences.` };
      render(); return;
    }
    worker?.terminate();
    worker = createShuffleWorker();
    ranWith = signature(ctx);
    state = { status: 'running', progress: 0 };
    worker.onmessage = (e: { data: WorkerReply<ShuffleSummary> }) => {
      const m = e.data;
      if (m.type === 'progress') state = { status: 'running', progress: m.fraction };
      else if (m.type === 'result') { state = { status: 'done', result: m.value }; worker?.terminate(); worker = null; }
      else { state = { status: 'error', message: m.message }; worker?.terminate(); worker = null; }
      render();
    };
    worker.onerror = (e) => { state = { status: 'error', message: `The shuffle worker failed: ${e.message}` }; worker = null; render(); };
    const req: ShuffleRequest = { type: 'shuffle', a: ctx.a, b: ctx.b, alphabet: ctx.alphabet, mode: ctx.mode, scoring: ctx.scoring, shuffles, seed };
    worker.postMessage(req);
    render();
  };

  run.addEventListener('click', start);
  cancel.addEventListener('click', () => { worker?.terminate(); worker = null; state = { status: 'cancelled' }; render(); });
  newSeed.addEventListener('click', () => { seedIn.value = String((Date.now() ^ (performance.now() * 1000)) >>> 0); change(); });
  seedIn.addEventListener('input', () => change());
  countIn.addEventListener('input', () => change());
  onThemeChange(() => { if (state.status === 'done') drawChart(state.result); });
  render();

  return {
    root,
    setContext(c) {
      ctx = c;
      if (state.status === 'running' && c === null) { worker?.terminate(); worker = null; state = { status: 'idle' }; }
      render();
    },
    getParams: () => ({ seed: Number(seedIn.value), shuffles: Number(countIn.value) }),
    setParams(p) { seedIn.value = String(p.seed); countIn.value = String(p.shuffles); },
    onParamsChange(fn) { change = fn; },
  };
}
