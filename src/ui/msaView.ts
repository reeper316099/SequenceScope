// MSA view (Milestone C): load a set, choose a guide-tree method and scoring, run the progressive aligner in a worker, view the
// alignment with conservation, select columns, export, and build a tree (with bootstrap) from the app's own alignment.
import type { MsaResult } from '../shared/results';
import { conservationCsvAsync, limits, writeFastaAsync, writeNewickAsync } from '../backend/api';
import { createMsaWorker } from '../backend';
import type { JobWorker } from '../backend';
import { msaToClustal, msaToFasta } from '../io/export';
import type { Alphabet, AlphabetChoice, ScoringSpec } from '../shared/types';
import { MAX_OPEN_FILE_BYTES } from '../shared/types';
import type { MsaRequest } from '../shared/results';
import { callout, card, statTile, toast } from './cards';
import { clear, debounce, el } from './dom';
import { loadExampleIndex, loadExampleText } from './examples';
import { defaultPreset, describeScoring } from './model';
import { createMsaCanvas } from './msaCanvas';
import type { Metric } from './msaCanvas';
import { createScoringPanel } from './scoringPanel';
import { analyzeSet, uniquifyNames } from './sequenceSet';
import { createTreeViewer } from './treeView';
import type { AppView } from './view';

export interface MsaProjectState {
  text: string;
  alphabet: AlphabetChoice;
  guide: 'upgma' | 'nj';
  scoring: ScoringSpec;
}

/** Builds the MSA view. `toTrees(alignedFasta, method)` sends the alignment to the Distances/Trees views. */
export function createMsaView(toTrees: (alignedFasta: string, method: 'upgma' | 'nj') => void): AppView & { getState(): MsaProjectState; setState(s: MsaProjectState): void; loadText(t: string): void } {
  const root = el('div', 'view view-msa');
  let text = '';
  let alphabetChoice: AlphabetChoice = 'auto';
  let guide: 'upgma' | 'nj' = 'upgma';
  let scoring: ScoringSpec = defaultPreset('protein').scoring;
  let result: MsaResult | null = null;
  let resultAlphabet: Alphabet = 'protein';
  let worker: JobWorker<MsaResult> | null = null;
  let lastKind: 'protein' | 'nucleotide' | null = null;
  let state: { kind: 'idle' | 'running' | 'error' | 'cancelled' | 'done'; progress?: number; message?: string } = { kind: 'idle' };

  // ---- input card ----
  const inCard = card('1 · Sequences', 'Unaligned sequences (FASTA). Up to 50 sequences of up to 3,000 residues; every name must be unique.');
  const exampleSel = el('select', undefined, undefined, { 'aria-label': 'Load an example set to align' });
  exampleSel.append(el('option', undefined, 'Load an example set…', { value: '' }));
  const openBtn = el('button', 'btn btn-small', 'Open file…', { type: 'button' });
  const alphaSel = el('select', undefined, undefined, { 'aria-label': 'Alphabet of the sequences to align' });
  for (const [v, t] of [['auto', 'Alphabet: detect automatically'], ['dna', 'DNA'], ['rna', 'RNA'], ['protein', 'Protein']] as const) alphaSel.append(el('option', undefined, t, { value: v }));
  const fixNames = el('button', 'btn btn-small', 'Make names unique', { type: 'button' });
  const bar = el('div', 'row'); bar.append(exampleSel, openBtn, alphaSel, fixNames);
  const area = el('textarea', 'seq-area', undefined, { rows: 7, 'aria-label': 'Sequences to align (FASTA)', spellcheck: false, placeholder: '>name1\nACGT…\n>name2\nACGT…' });
  const badge = el('span', 'badge', 'empty');
  const msgs = el('div', 'seq-messages', undefined, { 'aria-live': 'polite' });
  inCard.body.append(bar, area, badge, msgs);
  for (const ev of ['dragenter', 'dragover'] as const) area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('drop'); });
  for (const ev of ['dragleave', 'drop'] as const) area.addEventListener(ev, () => area.classList.remove('drop'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (f.size > MAX_OPEN_FILE_BYTES) { toast(`${f.name} is larger than the ${MAX_OPEN_FILE_BYTES / 1048576} MB limit.`); return; }
    void f.text().then((t) => { setText(t); toast(`Loaded ${f.name}.`); });
  });

  // ---- options card ----
  const optCard = card('2 · Method and scoring', 'A guide tree decides the order in which sequences are merged; then groups are aligned to groups.');
  const guideSel = el('select', undefined, undefined, { 'aria-label': 'Guide-tree method' });
  guideSel.append(el('option', undefined, 'UPGMA guide tree', { value: 'upgma' }), el('option', undefined, 'Neighbor-joining guide tree (rooted at its midpoint)', { value: 'nj' }));
  const gl = el('label', 'field'); gl.append(el('span', 'field-label', 'Guide tree'), guideSel);
  const panel = createScoringPanel({ mode: 'global', scoring }, (s) => { scoring = s.scoring; schedule(); }, { hideMode: true });
  optCard.body.append(gl, panel.root, callout('info', 'Progressive alignment is a heuristic: it is not guaranteed to find the best possible alignment, and once two groups are aligned their gaps are frozen (“once a gap, always a gap”), so an early mistake cannot be repaired later.'));

  // ---- run card ----
  const runCard = card('3 · Alignment', 'Runs in the background; you can cancel it.');
  const statusHost = el('div', 'status-host', undefined, { 'aria-live': 'polite' });
  const progress = el('progress', undefined, undefined, { max: 1, value: 0 });
  const cancelBtn = el('button', 'btn btn-small', 'Cancel', { type: 'button' });
  const runBtn = el('button', 'btn btn-primary', 'Align', { type: 'button' });
  const runRow = el('div', 'row'); runRow.append(runBtn, progress, cancelBtn);
  const summary = el('div', 'msa-summary');
  const guideHost = el('div', 'guide-host');
  runCard.body.append(runRow, statusHost, summary, guideHost);

  // ---- viewer card ----
  const viewCard = card('4 · Alignment viewer', 'Names stay on the left, the ruler, conservation bars and consensus stay on top. Drag across columns to select a range.');
  const canvas = createMsaCanvas();
  const metricSel = el('select', undefined, undefined, { 'aria-label': 'Conservation metric' });
  for (const [v, t] of [['identity', 'Bars: identity (fraction of sequences with the most common residue)'], ['conservation', 'Bars: conservation (1 − entropy/max, scaled by non-gaps)'], ['entropy', 'Bars: low entropy (tall = conserved)']] as const) metricSel.append(el('option', undefined, t, { value: v }));
  const widthSel = el('select', undefined, undefined, { 'aria-label': 'Column width' });
  for (const [v, t] of [['6', 'Narrow columns (overview)'], ['12', 'Medium columns'], ['18', 'Wide columns']] as const) widthSel.append(el('option', undefined, t, { value: v }));
  widthSel.value = '12';
  const fromIn = el('input', undefined, undefined, { type: 'number', min: 1, step: 1, 'aria-label': 'Select columns from' });
  const toIn = el('input', undefined, undefined, { type: 'number', min: 1, step: 1, 'aria-label': 'Select columns to' });
  const selBtn = el('button', 'btn btn-small', 'Select range', { type: 'button' });
  const clrBtn = el('button', 'btn btn-small', 'Clear', { type: 'button' });
  const textBox = el('input', undefined, undefined, { type: 'checkbox' });
  const textLab = el('label', 'check'); textLab.append(textBox, document.createTextNode(' Text version'));
  const f1 = el('label', 'field narrow'); f1.append(el('span', 'field-label', 'From column'), fromIn);
  const f2 = el('label', 'field narrow'); f2.append(el('span', 'field-label', 'To column'), toIn);
  const vbar = el('div', 'row'); vbar.append(metricSel, widthSel, f1, f2, selBtn, clrBtn, textLab);
  const selInfo = el('p', 'hint', 'No columns selected.', { 'aria-live': 'polite' });
  const textView = el('pre', 'msa-text mono'); textView.hidden = true;
  const caveat = callout('warn', 'Alignment errors propagate: distances, trees and bootstrap values computed from this alignment inherit any mistakes the heuristic made.');
  viewCard.body.append(vbar, canvas.root, selInfo, textView, caveat);

  // ---- export / tree card ----
  const outCard = card('5 · Export and trees', 'Save the alignment, or build a tree from it. Bootstrap then uses this alignment’s own columns.');
  const b = (t: string): HTMLButtonElement => el('button', 'btn btn-small', t, { type: 'button' });
  const fastaBtn = b('Aligned FASTA'); const clustalBtn = b('CLUSTAL-style text'); const csvBtn = b('Conservation CSV'); const pngBtn = b('PNG image'); const nwkBtn = b('Guide tree (Newick)');
  const nj = el('button', 'btn btn-primary', 'Build neighbor-joining tree + bootstrap →', { type: 'button' });
  const up = el('button', 'btn btn-primary', 'Build UPGMA tree + bootstrap →', { type: 'button' });
  const r1 = el('div', 'row'); r1.append(fastaBtn, clustalBtn, csvBtn, pngBtn, nwkBtn);
  const r2 = el('div', 'row'); r2.append(nj, up);
  outCard.body.append(r1, r2);
  root.append(inCard.root, optCard.root, runCard.root, viewCard.root, outCard.root);

  // ---- logic ----
  const analysis = (): ReturnType<typeof analyzeSet> => analyzeSet(text, alphabetChoice, 'unaligned');
  let refreshSeq = 0;
  const refreshInput = async (): Promise<void> => {
    const mine = ++refreshSeq;
    const a = await analysis();
    if (mine !== refreshSeq) return; // a newer refresh is already on its way
    badge.textContent = a.records.length === 0 ? 'empty' : `${a.records.length} sequences · ${a.alphabet}`;
    clear(msgs);
    for (const i of a.issues) msgs.append(callout(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : 'info', i.message));
    if (a.blocking !== null) msgs.append(callout(a.records.length === 0 && text.trim() === '' ? 'info' : 'error', a.blocking));
    if (a.blocking === null && a.records.length > limits().maxMsaSeqs) msgs.append(callout('error', `At most ${limits().maxMsaSeqs} sequences.`));
    if (a.duplicateNames) msgs.append(callout('error', 'Every sequence needs a unique name before it can be aligned. Use “Make names unique”.'));
    fixNames.hidden = !a.duplicateNames;
    const ok = a.blocking === null && a.alphabet !== 'unknown' && !a.duplicateNames && a.records.length >= 1;
    runBtn.disabled = !ok || state.kind === 'running';
    cancelBtn.hidden = progress.hidden = state.kind !== 'running';
    // switch to the matching scoring preset only when the molecule type CHANGES (so manual edits are never overwritten)
    if (a.alphabet !== 'unknown' && a.records.length > 0) {
      const kind = a.alphabet === 'protein' ? 'protein' : 'nucleotide';
      if (lastKind !== kind) { if (lastKind !== null || kind === 'protein' || scoring.substitution.kind === 'matrix') scoring = defaultPreset(a.alphabet).scoring; lastKind = kind; }
      panel.setState({ mode: 'global', scoring }, a.alphabet);
    }
  };
  const schedule = debounce(() => void refreshInput(), 200);

  function setText(t: string): void { text = t; area.value = t; void refreshInput(); }

  const showStatus = (): void => {
    clear(statusHost);
    progress.value = state.progress ?? 0;
    cancelBtn.hidden = progress.hidden = state.kind !== 'running';
    runBtn.disabled = state.kind === 'running' || runBtn.disabled;
    if (state.kind === 'running') statusHost.append(callout('info', `Aligning… ${Math.round((state.progress ?? 0) * 100)} % (first all pairs for the guide tree, then the merges)`));
    else if (state.kind === 'error') statusHost.append(callout('error', state.message ?? 'The alignment failed.'));
    else if (state.kind === 'cancelled') statusHost.append(callout('info', 'Cancelled. No partial alignment was kept.'));
  };

  const showSelection = (sel: { from: number; to: number } | null): void => {
    const c = canvas.getConservation();
    if (sel) { fromIn.value = String(sel.from); toIn.value = String(sel.to); }
    if (!sel || !c) { selInfo.textContent = 'No columns selected.'; return; }
    const cols = c.columns.slice(sel.from - 1, sel.to);
    const mean = cols.reduce((s, x) => s + x.identity, 0) / cols.length;
    const full = cols.filter((x) => x.gaps === 0 && x.identity === 1).length;
    selInfo.textContent = `Columns ${sel.from}–${sel.to} (${cols.length} columns): mean identity ${(mean * 100).toFixed(1)} %, ${full} fully conserved, consensus ${c.consensus.slice(sel.from - 1, sel.to)}`;
  };
  canvas.onSelection(showSelection);

  const renderTextView = (): void => {
    if (!result) { textView.textContent = ''; return; }
    const w = Math.max(...result.ids.map((i) => i.length), 4) + 2;
    const len = result.rows[0]?.length ?? 0;
    const out: string[] = [];
    for (let i = 0; i < len; i += 60) { result.ids.forEach((id, k) => out.push(id.padEnd(w, ' ') + (result?.rows[k] ?? '').slice(i, i + 60))); out.push(''); }
    textView.textContent = out.join('\n');
  };

  const showResult = async (r: MsaResult | null): Promise<void> => {
    result = r;
    clear(summary); clear(guideHost);
    const have = r !== null;
    for (const x of [fastaBtn, clustalBtn, csvBtn, pngBtn, nwkBtn, nj, up]) x.disabled = !have;
    nj.disabled = up.disabled = !have || r.rows.length < 3;
    await canvas.setData(r?.ids ?? null, r?.rows ?? null, resultAlphabet);
    if (result !== r) return; // another result replaced this one while the statistics were computed
    renderTextView();
    showSelection(null);
    if (!r) return;
    const c = canvas.getConservation();
    const tiles = el('div', 'stats');
    tiles.append(
      statTile('Sum-of-pairs score', String(r.sumOfPairs), `all ${(r.rows.length * (r.rows.length - 1)) / 2} pairs; ${describeScoring(scoring)}`),
      statTile('Alignment columns', String(r.rows[0]?.length ?? 0), `${r.rows.length} sequences`),
      statTile('Mean identity', c ? `${(c.meanIdentity * 100).toFixed(1)} %` : '—', `${c?.fullyConserved ?? 0} fully conserved columns`),
      statTile('Guide tree', r.guide === 'upgma' ? 'UPGMA' : 'NJ (midpoint-rooted)', `${r.steps.length} profile merges`),
    );
    summary.append(tiles);
    if (r.rows.length >= 2) {
      guideHost.append(el('h3', undefined, 'Guide tree used'), el('p', 'hint', 'Sequences were merged from the leaves toward the root. Closely related sequences are aligned first.'));
      const v = createTreeViewer('Guide tree');
      v.setTree(r.guideTree);
      guideHost.append(v.root);
    }
  };

  const run = async (): Promise<void> => {
    const a = await analysis();
    if (a.blocking !== null || a.alphabet === 'unknown' || a.duplicateNames) { void refreshInput(); return; }
    worker?.terminate();
    const alphabet: Alphabet = a.alphabet;
    resultAlphabet = alphabet;
    worker = createMsaWorker();
    state = { kind: 'running', progress: 0 }; showStatus();
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { state = { kind: 'running', progress: m.fraction }; showStatus(); return; }
      worker?.terminate(); worker = null;
      if (m.type === 'error') { state = { kind: 'error', message: m.message }; showStatus(); void refreshInput(); return; }
      state = { kind: 'done' }; showStatus(); void refreshInput();
      void showResult(m.value);
    };
    worker.onerror = (e) => { state = { kind: 'error', message: `The alignment worker failed: ${e.message}` }; worker = null; showStatus(); };
    const req: MsaRequest = { type: 'msa', seqs: a.records, alphabet, scoring, guide };
    worker.postMessage(req);
  };

  // ---- events ----
  area.addEventListener('input', () => { text = area.value; schedule(); });
  alphaSel.addEventListener('change', () => { alphabetChoice = alphaSel.value as AlphabetChoice; void refreshInput(); }); // safe: the select only offers AlphabetChoice values
  guideSel.addEventListener('change', () => { guide = guideSel.value === 'nj' ? 'nj' : 'upgma'; });
  runBtn.addEventListener('click', () => void run());
  cancelBtn.addEventListener('click', () => { worker?.terminate(); worker = null; state = { kind: 'cancelled' }; showStatus(); void refreshInput(); });
  fixNames.addEventListener('click', () => { void analysis().then(async (a) => { setText(await writeFastaAsync(uniquifyNames(a.records), 1_000_000)); toast('Renamed duplicate names by adding _2, _3, …'); }); });
  openBtn.addEventListener('click', () => { void window.sequenceScope.openFile('fasta').then((r) => { if (r.ok) { setText(r.text); toast(`Loaded ${r.name}.`); } else if (r.reason !== 'cancelled') toast(r.message); }); });
  metricSel.addEventListener('change', () => canvas.setMetric(metricSel.value as Metric)); // safe: the select only offers Metric values
  widthSel.addEventListener('change', () => canvas.setCellWidth(Number(widthSel.value)));
  selBtn.addEventListener('click', () => {
    const from = Number(fromIn.value); const to = Number(toIn.value); const len = result?.rows[0]?.length ?? 0;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > len || to > len) { toast(`Enter whole column numbers between 1 and ${len}.`); return; }
    canvas.setSelection({ from, to }); showSelection(canvas.getSelection());
  });
  clrBtn.addEventListener('click', () => { canvas.setSelection(null); showSelection(null); });
  textBox.addEventListener('change', () => { textView.hidden = !textBox.checked; });
  const save = async (name: string, ext: string, content: string, enc: 'utf8' | 'base64' = 'utf8'): Promise<void> => {
    const r = await window.sequenceScope.saveFile({ suggestedName: name, extensions: [ext], content, encoding: enc });
    if (r.ok) toast(`Saved ${r.path}`); else if (r.reason !== 'cancelled') toast(r.message);
  };
  fastaBtn.addEventListener('click', () => { if (result) void save('alignment.fasta', 'fasta', msaToFasta(result.ids, result.rows)); });
  clustalBtn.addEventListener('click', () => { if (result) void save('alignment.aln', 'aln', msaToClustal(result.ids, result.rows)); });
  csvBtn.addEventListener('click', () => { if (result) void conservationCsvAsync(result.rows, resultAlphabet).then((text) => save('conservation.csv', 'csv', text)); });
  pngBtn.addEventListener('click', () => { const u = canvas.toPng(); if (u) void save('alignment.png', 'png', u.split(',')[1] ?? '', 'base64'); else toast('This alignment is too large to export as one PNG; export FASTA instead or select fewer columns.'); });
  nwkBtn.addEventListener('click', () => { if (result) void writeNewickAsync(result.guideTree).then((text) => save('guide-tree.nwk', 'nwk', text + '\n')); });
  nj.addEventListener('click', () => { if (result) toTrees(msaToFasta(result.ids, result.rows), 'nj'); });
  up.addEventListener('click', () => { if (result) toTrees(msaToFasta(result.ids, result.rows), 'upgma'); });

  // example list: every bundled set with at least 2 sequences
  const examples: { id: string; label: string }[] = [];
  void loadExampleIndex().then((idx) => { for (const s of idx.sets) if (s.records >= 2) { examples.push({ id: s.id, label: s.title }); exampleSel.append(el('option', undefined, s.title, { value: String(examples.length - 1) })); } }).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not load the example list.'));
  exampleSel.addEventListener('change', () => {
    const it = examples[Number(exampleSel.value)];
    exampleSel.value = '';
    if (it) void loadExampleText(it.id, false).then((t) => { setText(t); }).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not load the example.'));
  });

  void showResult(null);
  void refreshInput();
  return {
    id: 'msa', title: 'MSA', root,
    loadText: setText,
    getState: () => ({ text, alphabet: alphabetChoice, guide, scoring }),
    setState(s) { text = s.text; alphabetChoice = s.alphabet; guide = s.guide; scoring = s.scoring; area.value = s.text; alphaSel.value = s.alphabet; guideSel.value = s.guide; panel.setState({ mode: 'global', scoring }, 'unknown'); void refreshInput(); },
    handleAction(a) { if (a === 'open-fasta') { openBtn.click(); return true; } if (a === 'export' && result) { fastaBtn.click(); return true; } return false; },
  };
}
