// The Align view (Milestone A): ties inputs, scoring, worker, matrix, stepper, alignment, stats, significance together.
import { alignmentStats } from '../bio/alignstats';
import { assertWithinCap, dpFromSnapshot, MAX_ENUMERATED_ALIGNMENTS } from '../bio/pairwise';
import type { Dp } from '../bio/pairwise';
import { compileScoring } from '../bio/scoring';
import type { CompiledScoring } from '../bio/scoring';
import { alignmentToClustal, alignmentToFasta, matrixToCsv } from '../io/export';
import type { ProjectFile } from '../io/project';
import { createPairwiseWorker } from '../backend';
import type { JobWorker } from '../backend';
import type { AlignRequest, AlignResult, AlphabetChoice, AlignMode, MenuAction, PairwiseAlignment, ScoringSpec, WorkerReply, Alphabet } from '../shared/types';
import { callout, card, toast } from './cards';
import { createDetailsPanel } from './detailsPanel';
import type { DetailsPanel } from './detailsPanel';
import { debounce, el, isTextEntry, clear } from './dom';
import { EXTRA_PAIRS, loadExampleIndex, loadExampleSet, recordText, shortName } from './examples';
import type { ExamplePair } from './examples';
import { createAlignmentView } from './alignmentView';
import { History } from './history';
import { createMatrixCanvas, INTERACTIVE_CELL_CAP } from './matrixCanvas';
import { pathCells } from './matrixGeometry';
import { analyzeSequenceText, checkPair, defaultPreset, describeScoring } from './model';
import type { AnalyzedSequence } from './model';
import { createScoringPanel } from './scoringPanel';
import type { ScoringState } from './scoringPanel';
import { createSequenceInput } from './sequenceInput';
import { createSignificancePanel, DEFAULT_SEED } from './significancePanel';
import { createStepper } from './stepper';
import type { StepState } from './stepper';
import { renderStats } from './statsCards';
import type { AppView } from './view';

interface Inputs {
  textA: string;
  textB: string;
  alphabet: AlphabetChoice;
  mode: AlignMode;
  scoring: ScoringSpec;
  seed: number;
  shuffles: number;
}

type RunState =
  | { status: 'empty'; message: string }
  | { status: 'running' }
  | { status: 'too-large'; message: string }
  | { status: 'error'; message: string }
  | { status: 'done' };

/** Builds the Align view. The shared details panel is passed in so the router can place it on the right. */
export function createAlignView(details: DetailsPanel = createDetailsPanel()): AppView & { loadTexts(a: string, b: string): void; getContext(): { scoring: ScoringSpec; mode: AlignMode }; getInputs(): ProjectFile['align']; setInputs(i: ProjectFile['align']): void } {
  const root = el('div', 'view view-align');
  const defaults = defaultPreset('dna');
  let inputs: Inputs = { textA: '', textB: '', alphabet: 'auto', mode: 'global', scoring: defaults.scoring, seed: DEFAULT_SEED, shuffles: 200 };
  const history = new History<Inputs>(inputs);
  let analysisA: AnalyzedSequence = analyzeSequenceText('', 'auto');
  let analysisB: AnalyzedSequence = analyzeSequenceText('', 'auto');
  let lastKind: 'nucleotide' | 'protein' | null = null;
  let keepScoringOnce = false; // set when a project was just opened: its scoring must not be replaced by a preset
  let runId = 0;
  let worker: JobWorker<AlignResult> | null = null;
  let dp: Dp | null = null;
  let current: PairwiseAlignment | null = null;
  let runState: RunState = { status: 'empty', message: 'Enter or open two sequences to align.' };

  // ---- components ----
  const inputA = createSequenceInput('A', (t) => { inputs = { ...inputs, textA: t }; schedule(); });
  const inputB = createSequenceInput('B', (t) => { inputs = { ...inputs, textB: t }; schedule(); });
  const scoringPanel = createScoringPanel({ mode: inputs.mode, scoring: inputs.scoring }, (s: ScoringState) => { inputs = { ...inputs, mode: s.mode, scoring: s.scoring }; schedule(); });
  const matrix = createMatrixCanvas((cell) => showDetails(cell, undefined));
  const stepper = createStepper((s) => onStep(s));
  const alnView = createAlignmentView((aln) => { current = aln; refreshPath(); });
  const signif = createSignificancePanel();
  const statsHost = el('div', 'stats-host');
  const statusHost = el('div', 'status-host', undefined, { 'aria-live': 'polite' });

  // ---- layout ----
  const seqCard = card('1 · Sequences', 'Paste residues or FASTA, drop a file, or open one. Nothing is changed silently: cleanups are listed under each box.');
  const alphaSel = el('select', undefined, undefined, { 'aria-label': 'Alphabet' });
  for (const [v, t] of [['auto', 'Alphabet: detect automatically'], ['dna', 'DNA'], ['rna', 'RNA'], ['protein', 'Protein']] as const) alphaSel.append(el('option', undefined, t, { value: v }));
  const exampleSel = el('select', undefined, undefined, { 'aria-label': 'Load an example pair' });
  exampleSel.append(el('option', undefined, 'Load an example pair…', { value: '' }));
  const swapBtn = el('button', 'btn btn-small', 'Swap A ⇄ B', { type: 'button' });
  const bar = el('div', 'row'); bar.append(alphaSel, exampleSel, swapBtn);
  const pair = el('div', 'pair'); pair.append(inputA.root, inputB.root);
  seqCard.body.append(bar, pair);

  const scoreCard = card('2 · Scoring', 'Choose how residues are scored and how gaps are charged.');
  scoreCard.body.append(scoringPanel.root);

  const alnCard = card('3 · Alignment', 'The best alignment under your scoring, with statistics.');
  const exportBtn = el('button', 'btn btn-small', 'Export…', { type: 'button' });
  const alnTools = el('div', 'row'); alnTools.append(exportBtn);
  alnCard.body.append(statusHost, statsHost, alnView.root, alnTools);

  const matCard = card('4 · Score matrix and traceback', 'Each cell holds the best score of aligning the first i residues of A with the first j residues of B. Step through to watch it fill, then see the traceback.');
  matCard.body.append(matrix.root, stepper.root);

  const sigCard = card('5 · How unusual is this score?', 'A seeded shuffle test (reproducible).');
  sigCard.body.append(signif.root);

  root.append(seqCard.root, scoreCard.root, alnCard.root, matCard.root, sigCard.root);

  // ---- export dialog ----
  const dialog = el('dialog', 'export-dialog', undefined, { 'aria-label': 'Export' });
  const dlgTitle = el('h2', undefined, 'Export');
  const dlgList = el('div', 'dlg-list');
  const dlgClose = el('button', 'btn', 'Close', { type: 'button' });
  dialog.append(dlgTitle, dlgList, dlgClose);
  root.append(dialog);
  dlgClose.addEventListener('click', () => dialog.close());

  /** Saves text or base64 through the native dialog and reports the outcome. */
  const save = async (name: string, ext: string, content: string, encoding: 'utf8' | 'base64'): Promise<void> => {
    const r = await window.sequenceScope.saveFile({ suggestedName: name, extensions: [ext], content, encoding });
    if (r.ok) toast(`Saved ${r.path}`); else if (r.reason !== 'cancelled') toast(r.message);
  };
  const exportItems: { label: string; run: () => void; ok: () => boolean }[] = [
    { label: 'Alignment as FASTA (.fasta)', ok: () => current !== null && current.rowA.length > 0, run: () => { if (current) void save('alignment.fasta', 'fasta', alignmentToFasta(current, analysisA.id || 'A', analysisB.id || 'B'), 'utf8'); } },
    { label: 'Alignment as CLUSTAL-style text (.aln)', ok: () => current !== null && current.rowA.length > 0, run: () => { if (current) void save('alignment.aln', 'aln', alignmentToClustal(current, analysisA.id || 'A', analysisB.id || 'B'), 'utf8'); } },
    { label: 'Score matrix as CSV (.csv)', ok: () => dp !== null && dp.rows * dp.cols <= 4_000_000, run: () => { if (dp) void save('score-matrix.csv', 'csv', matrixToCsv(dp.strA, dp.strB, (i, j) => matrix.valueAt(i, j) ?? 0), 'utf8'); } },
    { label: 'Score matrix as PNG (.png)', ok: () => dp !== null, run: () => { const u = matrix.toPng(); if (u) void save('score-matrix.png', 'png', u.split(',')[1] ?? '', 'base64'); } },
    { label: 'Alignment as PNG (.png)', ok: () => current !== null && current.rowA.length > 0, run: () => { const u = alnView.toPng(); if (u) void save('alignment.png', 'png', u.split(',')[1] ?? '', 'base64'); } },
  ];
  const openExport = (): void => {
    clear(dlgList);
    for (const item of exportItems) {
      const b = el('button', 'btn', item.label, { type: 'button' });
      b.disabled = !item.ok();
      b.addEventListener('click', () => { dialog.close(); item.run(); });
      dlgList.append(b);
    }
    dialog.showModal();
  };
  exportBtn.addEventListener('click', openExport);

  // ---- example pairs ----
  const pairs: { pair: ExamplePair; textA: string; textB: string }[] = [];
  void (async () => {
    try {
      const index = await loadExampleIndex();
      const sets = new Map<string, Awaited<ReturnType<typeof loadExampleSet>>>();
      for (const s of index.sets) sets.set(s.id, await loadExampleSet(s.id));
      const add = (setId: string, a: number, b: number): void => {
        const set = sets.get(setId); const ra = set?.records[a]; const rb = set?.records[b];
        if (!set || !ra || !rb) return;
        pairs.push({ pair: { label: `${set.meta.title}: ${shortName(ra)} vs ${shortName(rb)}`, setId, a, b }, textA: recordText(ra), textB: recordText(rb) });
      };
      for (const s of index.sets) if (s.records === 2) add(s.id, 0, 1);
      for (const e of EXTRA_PAIRS) add(e.setId, e.a, e.b);
      pairs.forEach((p, k) => exampleSel.append(el('option', undefined, p.pair.label, { value: String(k) })));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the bundled examples.');
    }
  })();
  exampleSel.addEventListener('change', () => {
    const p = pairs[Number(exampleSel.value)];
    exampleSel.value = '';
    if (p) loadTexts(p.textA, p.textB);
  });

  // ---- logic ----
  const commitHistory = debounce(() => history.push(inputs), 600);
  const schedule = (): void => { commitHistory(); run(); };
  const run = debounce(() => execute(), 250);

  /** Shows the details panel for a cell (selected by the user or the stepper). */
  const showDetails = (cell: { i: number; j: number } | null, context: string | undefined): void => details.show(dp, cell, context);

  /** Recomputes the highlighted traceback path for the currently displayed alignment. */
  const refreshPath = (): void => {
    if (!dp || !current) return;
    matrix.setDp(dp, current.rowA.length === 0 ? [] : pathCells(current));
    const pathLen = current.rowA.length === 0 ? 0 : pathCells(current).length;
    stepper.configure((dp.rows - 1) * (dp.cols - 1), pathLen, dp.rows * dp.cols > INTERACTIVE_CELL_CAP ? `Step-through is available for matrices up to ${INTERACTIVE_CELL_CAP.toLocaleString('en-US')} cells (about 500 × 500). This matrix has ${(dp.rows * dp.cols).toLocaleString('en-US')} cells, so it is shown as a zoomable overview.` : undefined);
    stepper.jumpToEnd();
  };

  /** Applies a stepper position to the matrix and the details panel. */
  const onStep = (s: StepState): void => {
    if (!dp || !current) return;
    if (s.phase === 'done' || (s.phase === 'start' && s.total === 0)) { matrix.setProgress(null); return; }
    const w = dp.cols - 1;
    let cur: { i: number; j: number } | null = null;
    let context = '';
    if (s.pathShown === 0 && s.filled > 0) {
      const idx = s.filled - 1; cur = { i: Math.floor(idx / w) + 1, j: (idx % w) + 1 };
      context = 'Filling the matrix: this cell was just computed from its three neighbours.';
    } else if (s.pathShown > 0) {
      const path = pathCells(current); const c = path[path.length - s.pathShown];
      if (c) cur = { i: c[0], j: c[1] };
      context = 'Traceback: starting at the best cell and following the stored choices back to the start.';
    }
    matrix.setProgress({ filled: s.filled, pathShown: s.pathShown, current: cur });
    if (cur) showDetails(cur, context);
  };

  const showStatus = (): void => {
    clear(statusHost);
    if (runState.status === 'empty') statusHost.append(callout('info', runState.message));
    else if (runState.status === 'running') statusHost.append(callout('info', 'Aligning…'));
    else if (runState.status === 'too-large') statusHost.append(callout('error', runState.message));
    else if (runState.status === 'error') { statusHost.append(callout('error', runState.message)); const r = el('button', 'btn btn-small', 'Retry', { type: 'button' }); r.addEventListener('click', () => execute()); statusHost.append(r); }
  };

  /** Clears all result displays (used when inputs are not alignable). */
  const clearResults = (): void => {
    dp = null; current = null;
    matrix.setDp(null, []); stepper.configure(0, 0, 'Nothing to step through yet.');
    renderStats(statsHost, null); alnView.setData(null); signif.setContext(null); details.show(null, null);
  };

  /** Validates inputs, picks scoring defaults when the alphabet kind changes, and runs the aligner in a worker. */
  const execute = (): void => {
    analysisA = analyzeSequenceText(inputs.textA, inputs.alphabet);
    analysisB = analyzeSequenceText(inputs.textB, inputs.alphabet);
    inputA.showAnalysis(analysisA); inputB.showAnalysis(analysisB);
    const check = checkPair(analysisA, analysisB, inputs.alphabet);
    worker?.terminate(); worker = null;
    if (!check.ok) { runState = { status: 'empty', message: check.message }; clearResults(); showStatus(); return; }
    const kind = check.alphabet === 'protein' ? 'protein' : 'nucleotide';
    const incompatible = inputs.scoring.substitution.kind === 'matrix' && kind === 'nucleotide';
    // The app starts on the DNA preset, so a first protein input (lastKind === null) also switches to the protein preset.
    const kindChanged = lastKind === null ? kind === 'protein' : lastKind !== kind;
    if (incompatible || (kindChanged && !keepScoringOnce)) {
      const p = defaultPreset(check.alphabet);
      inputs = { ...inputs, scoring: p.scoring };
      toast(`Switched to the ${kind} preset: ${p.label}.`);
    }
    lastKind = kind;
    keepScoringOnce = false;
    scoringPanel.setState({ mode: inputs.mode, scoring: inputs.scoring }, check.alphabet);
    let sc: CompiledScoring;
    try {
      sc = compileScoring(inputs.scoring, check.alphabet);
      assertWithinCap(analysisA.residues.length, analysisB.residues.length, sc.affine);
    } catch (e) {
      const code = (e as { code?: string }).code;
      runState = { status: code === 'too-large' ? 'too-large' : 'error', message: e instanceof Error ? e.message : 'Invalid settings.' };
      clearResults(); showStatus(); return;
    }
    const myRun = ++runId;
    runState = { status: 'running' }; showStatus();
    const a = analysisA.residues; const b = analysisB.residues;
    worker = createPairwiseWorker();
    worker.onmessage = (ev: { data: WorkerReply<AlignResult> }) => {
      if (myRun !== runId) return;
      const m = ev.data;
      worker?.terminate(); worker = null;
      if (m.type === 'error') { runState = { status: m.code === 'too-large' ? 'too-large' : 'error', message: m.message }; clearResults(); showStatus(); return; }
      if (m.type !== 'result') return;
      applyResult(a, b, check.alphabet, sc, m.value);
    };
    worker.onerror = (ev) => { if (myRun === runId) { runState = { status: 'error', message: `The alignment worker failed: ${ev.message}` }; clearResults(); showStatus(); } };
    const req: AlignRequest = { type: 'align', a, b, alphabet: check.alphabet, mode: inputs.mode, scoring: inputs.scoring, enumerateCap: MAX_ENUMERATED_ALIGNMENTS };
    worker.postMessage(req);
  };

  /** Shows a finished alignment everywhere. */
  const applyResult = (a: string, b: string, alphabet: Alphabet, sc: CompiledScoring, result: AlignResult): void => {
    runState = { status: 'done' }; showStatus();
    dp = dpFromSnapshot(result.dp, a, b, sc);
    current = result.alignment;
    const usesMatrix = sc.spec.substitution.kind === 'matrix';
    renderStats(statsHost, { aln: current, stats: alignmentStats(current, sc), usesMatrix, lenA: a.length, lenB: b.length, scoringText: `${inputs.mode}; ${describeScoring(sc.spec)}` });
    alnView.setData({ all: result.all, capped: result.capped, scoring: sc, alphabet, idA: analysisA.id || 'A', idB: analysisB.id || 'B' });
    refreshPath();
    details.show(null, null);
    signif.setContext({ a, b, alphabet, mode: inputs.mode, scoring: inputs.scoring });
  };

  // ---- inputs <-> UI sync ----
  /** Pushes `inputs` into every control (used by undo/redo, examples, and project open). */
  const syncUi = (): void => {
    inputA.setText(inputs.textA); inputB.setText(inputs.textB);
    alphaSel.value = inputs.alphabet;
    scoringPanel.setState({ mode: inputs.mode, scoring: inputs.scoring }, 'unknown');
    signif.setParams({ seed: inputs.seed, shuffles: inputs.shuffles });
  };
  function loadTexts(a: string, b: string): void {
    inputs = { ...inputs, textA: a, textB: b };
    syncUi(); history.push(inputs); execute();
  }
  alphaSel.addEventListener('change', () => { inputs = { ...inputs, alphabet: alphaSel.value as AlphabetChoice }; schedule(); }); // safe: the select only offers AlphabetChoice values
  swapBtn.addEventListener('click', () => { inputs = { ...inputs, textA: inputs.textB, textB: inputs.textA }; syncUi(); history.push(inputs); execute(); });
  signif.onParamsChange(() => { const p = signif.getParams(); inputs = { ...inputs, seed: Number.isFinite(p.seed) ? Math.trunc(p.seed) : inputs.seed, shuffles: Number.isFinite(p.shuffles) ? Math.trunc(p.shuffles) : inputs.shuffles }; commitHistory(); });

  // ---- files, shortcuts ----
  const openFasta = async (): Promise<void> => {
    const r = await window.sequenceScope.openFile('fasta');
    if (!r.ok) { if (r.reason !== 'cancelled') toast(r.message); return; }
    const records = r.text.split(/\r?\n(?=>)/); // each FASTA record starts with ">" at a line start
    if (records.length >= 2 && r.text.trimStart().startsWith('>')) loadTexts(records[0] ?? '', records[1] ?? '');
    else if (inputs.textA.trim() === '') loadTexts(r.text, inputs.textB);
    else loadTexts(inputs.textA, r.text);
    toast(`Loaded ${r.name}.`);
  };
  const restore = (s: Inputs | null): void => { if (s) { inputs = s; syncUi(); execute(); } };

  document.addEventListener('keydown', (e) => {
    if (root.hidden || !root.isConnected || isTextEntry(e.target)) return;
    const t = e.target as HTMLElement | null;
    if (t && (stepper.root.contains(t) || t.tagName === 'CANVAS' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY')) return; // those elements handle their own keys
    if (e.key === ' ') { e.preventDefault(); stepper.toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepper.stepBy(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepper.stepBy(-1); }
  });

  syncUi();
  showStatus();
  stepper.configure(0, 0, 'Nothing to step through yet.');

  return {
    id: 'align', title: 'Align', root,
    loadTexts,
    getContext: () => ({ scoring: inputs.scoring, mode: inputs.mode }),
    getInputs: () => ({ ...inputs }),
    setInputs(i) { inputs = { ...i }; keepScoringOnce = true; syncUi(); history.push(inputs); execute(); },
    handleAction(a: MenuAction): boolean {
      if (a === 'open-fasta') { void openFasta(); return true; }
      if (a === 'export') { openExport(); return true; }
      if (a === 'undo') { restore(history.undo()); return true; }
      if (a === 'redo') { restore(history.redo()); return true; }
      return false;
    },
  };
}
