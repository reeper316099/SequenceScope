// Distances view (Milestone B): load a sequence set, choose a distance model and gap policy, see a heatmap and a sortable table.
import type { Alphabet, AlphabetChoice, DistanceMatrix, DistanceModel, GapPolicy, WorkerReply } from '../shared/types';
import { DIST_OK, DIST_SATURATED } from '../shared/types';
import { modelsFor, toDistanceCsv, toPhylip, unusablePairs } from '../bio/distance';
import { callout, card, toast } from './cards';
import type { DataStore } from './dataStore';
import { createHeatmap } from './distanceHeatmap';
import { clear, debounce, el } from './dom';
import { loadExampleIndex, loadExampleText } from './examples';
import { defaultPreset, PRESETS } from './model';
import { analyzeSet, sortOrder, uniquifyNames } from './sequenceSet';
import type { SetMode } from './sequenceSet';
import type { AppView } from './view';
import { MAX_OPEN_FILE_BYTES } from '../shared/types';
import type { DistancesRequest } from '../workers/protocol';
import { writeFasta } from '../bio/fasta';

const MODEL_TEXT: Record<DistanceModel, { label: string; text: string }> = {
  p: { label: 'p-distance (raw proportion of differing sites)', text: 'The fraction of compared sites that differ. Simple and always defined, but it underestimates real change between distant sequences, because several substitutions at one site look like one.' },
  jc: { label: 'Jukes–Cantor (DNA/RNA correction)', text: 'Corrects p for hidden repeated substitutions, assuming all four bases are equally common and change equally often: d = −¾ ln(1 − 4p/3). Undefined (“saturated”) when p ≥ 75 %: by then the sequences look as different as random ones.' },
  poisson: { label: 'Poisson correction (protein)', text: 'Corrects p for hidden repeated substitutions in proteins: d = −ln(1 − p). Undefined (“saturated”) when p = 100 %.' },
};
const POLICY_TEXT: Record<GapPolicy, { label: string; text: string }> = {
  'pairwise-deletion': { label: 'Pairwise deletion (default): skip columns with a gap', text: 'For each pair, columns where either sequence has a gap are ignored; the distance uses only the remaining sites. Gaps are not treated as evidence of difference.' },
  'gaps-as-differences': { label: 'Count gaps as differences', text: 'A gap against a residue counts as one difference. This makes insertions/deletions raise the distance, but one long gap counts many times.' },
};

/** Builds the Distances view around the shared data store. */
export function createDistancesView(store: DataStore, goToTrees: () => void): AppView & { loadText(text: string, mode: SetMode | 'auto', fromMsa?: boolean): void } {
  const root = el('div', 'view view-distances');
  const heatmap = createHeatmap();
  let worker: Worker | null = null;
  let sortKey: { by: 'name' } | { by: 'column'; col: number } = { by: 'name' };
  let sortDir: 'asc' | 'desc' = 'asc';
  let status: { kind: 'idle' | 'running' | 'error' | 'done'; progress?: number; message?: string } = { kind: 'idle' };

  // ---- set loader ----
  const loadCard = card('1 · Sequence set', 'Paste FASTA, drop or open a file, or pick a bundled example. Nothing is changed silently.');
  const exampleSel = el('select', undefined, undefined, { 'aria-label': 'Load an example set' });
  exampleSel.append(el('option', undefined, 'Load an example set…', { value: '' }));
  const openBtn = el('button', 'btn btn-small', 'Open file…', { type: 'button' });
  const alphaSel = el('select', undefined, undefined, { 'aria-label': 'Alphabet' });
  for (const [v, t] of [['auto', 'Alphabet: detect automatically'], ['dna', 'DNA'], ['rna', 'RNA'], ['protein', 'Protein']] as const) alphaSel.append(el('option', undefined, t, { value: v }));
  const modeSel = el('select', undefined, undefined, { 'aria-label': 'Is the input aligned?' });
  for (const [v, t] of [['auto', 'Aligned? decide automatically'], ['aligned', 'Already aligned (all rows the same length)'], ['unaligned', 'Not aligned (align every pair)']] as const) modeSel.append(el('option', undefined, t, { value: v }));
  const fixNames = el('button', 'btn btn-small', 'Make names unique', { type: 'button' });
  const bar = el('div', 'row'); bar.append(exampleSel, openBtn, alphaSel, modeSel, fixNames);
  const area = el('textarea', 'seq-area', undefined, { 'aria-label': 'Sequence set (FASTA)', rows: 8, spellcheck: false, placeholder: '>name1\nACGT…\n>name2\nACGT…' });
  const badge = el('span', 'badge', 'empty');
  const messages = el('div', 'seq-messages', undefined, { 'aria-live': 'polite' });
  loadCard.body.append(bar, area, badge, messages);
  for (const ev of ['dragenter', 'dragover'] as const) area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('drop'); });
  for (const ev of ['dragleave', 'drop'] as const) area.addEventListener(ev, () => area.classList.remove('drop'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (f.size > MAX_OPEN_FILE_BYTES) { toast(`${f.name} is larger than the ${MAX_OPEN_FILE_BYTES / 1048576} MB limit.`); return; }
    void f.text().then((t) => { loadText(t, 'auto'); toast(`Loaded ${f.name}.`); });
  });

  // ---- model ----
  const modelCard = card('2 · Distance model', 'How differences between two sequences are turned into a distance.');
  const modelSel = el('select', undefined, undefined, { 'aria-label': 'Distance model' });
  const modelNote = el('p', 'hint');
  const policySel = el('select', undefined, undefined, { 'aria-label': 'Gap policy' });
  for (const p of Object.keys(POLICY_TEXT) as GapPolicy[]) policySel.append(el('option', undefined, POLICY_TEXT[p].label, { value: p }));
  const policyNote = el('p', 'hint');
  const presetSel = el('select', undefined, undefined, { 'aria-label': 'Alignment scoring for pairwise alignment' });
  for (const p of PRESETS) presetSel.append(el('option', undefined, p.label, { value: p.id }));
  const presetNote = el('p', 'hint');
  const lab = (t: string, c: HTMLElement): HTMLElement => { const l = el('label', 'field'); l.append(el('span', 'field-label', t), c); return l; };
  modelCard.body.append(lab('Model', modelSel), modelNote, lab('Gap policy', policySel), policyNote, lab('Scoring used to align each pair', presetSel), presetNote);

  // ---- results ----
  const resCard = card('3 · Distance matrix', 'Symmetric, with zeros on the diagonal.');
  const statusHost = el('div', 'status-host', undefined, { 'aria-live': 'polite' });
  const progress = el('progress', undefined, undefined, { max: 1, value: 0 });
  const cancelBtn = el('button', 'btn btn-small', 'Cancel', { type: 'button' });
  const runRow = el('div', 'row'); runRow.append(progress, cancelBtn);
  const tableWrap = el('div', 'matrix-table-wrap dist-table-wrap');
  const exportRow = el('div', 'row');
  const csvBtn = el('button', 'btn btn-small', 'Export CSV', { type: 'button' });
  const phyBtn = el('button', 'btn btn-small', 'Export PHYLIP', { type: 'button' });
  const treeBtn = el('button', 'btn btn-primary', 'Build trees →', { type: 'button' });
  exportRow.append(csvBtn, phyBtn, treeBtn);
  const honesty = callout('warn', 'Distances computed by aligning each pair on its own (the “not aligned” route) are less reliable for trees than distances from a good multiple alignment, because every pair is aligned in isolation. Milestone C adds a multiple aligner; until then you can load an already-aligned FASTA.');
  resCard.body.append(honesty, statusHost, runRow, heatmap.root, tableWrap, exportRow);
  root.append(loadCard.root, modelCard.root, resCard.root);

  // ---- logic ----
  /** Re-analyses the text and decides which controls apply. */
  const analyze = (): void => {
    const s = store.state;
    const a = analyzeSet(s.text, s.alphabetChoice, s.modeChoice);
    store.update({ analysis: a });
    badge.textContent = a.records.length === 0 ? 'empty' : `${a.records.length} sequences · ${a.alphabet} · ${a.mode}${s.modeChoice === 'auto' ? ' (auto)' : ''}`;
    clear(messages);
    for (const i of a.issues) messages.append(callout(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : 'info', i.message));
    if (a.blocking !== null) messages.append(callout(a.records.length === 0 && s.text.trim() === '' ? 'info' : 'error', a.blocking));
    for (const n of a.notes) messages.append(callout('warn', n));
    fixNames.hidden = !a.duplicateNames;
    // Models that fit the alphabet.
    const alphabet = a.alphabet === 'unknown' ? 'dna' : a.alphabet;
    const models = modelsFor(alphabet);
    const model = models.includes(s.model) ? s.model : (models[0] ?? 'p');
    if (model !== s.model) store.update({ model });
    clear(modelSel);
    for (const m of models) modelSel.append(el('option', undefined, MODEL_TEXT[m].label, { value: m }));
    modelSel.value = model;
    modelNote.textContent = MODEL_TEXT[model].text;
    policySel.value = s.gapPolicy;
    policyNote.textContent = a.mode === 'aligned' ? POLICY_TEXT[s.gapPolicy].text : `${POLICY_TEXT[s.gapPolicy].text} (Here the gaps come from each pair’s own alignment.)`;
    const unaligned = a.mode === 'unaligned';
    presetSel.closest('label')?.toggleAttribute('hidden', !unaligned);
    presetNote.hidden = !unaligned;
    honesty.hidden = !unaligned;
    const molecule = alphabet === 'protein' ? 'protein' : 'nucleotide';
    for (const o of Array.from(presetSel.options)) o.disabled = PRESETS.find((p) => p.id === o.value)?.molecules !== molecule;
    if (PRESETS.find((p) => p.id === s.presetId)?.molecules !== molecule) { const p = PRESETS.find((x) => x.molecules === molecule && x.id.includes('affine')); if (p) store.update({ presetId: p.id }); }
    presetSel.value = store.state.presetId;
    presetNote.textContent = PRESETS.find((p) => p.id === store.state.presetId)?.description ?? '';
    modeSel.value = s.modeChoice;
    alphaSel.value = s.alphabetChoice;
    if (area.value !== s.text) area.value = s.text;
    compute();
  };

  const renderTable = (m: DistanceMatrix | null): void => {
    clear(tableWrap);
    if (!m) return;
    const order = sortOrder(m, sortKey, sortDir);
    const table = el('table', 'matrix-table dist-table', undefined, { 'aria-label': 'Distance matrix (sortable)' });
    const head = el('tr');
    const nameTh = el('th'); const nameBtn = el('button', 'th-btn', `Name${sortKey.by === 'name' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}`, { type: 'button', 'aria-label': 'Sort rows by name' });
    nameBtn.addEventListener('click', () => { sortDir = sortKey.by === 'name' && sortDir === 'asc' ? 'desc' : 'asc'; sortKey = { by: 'name' }; renderTable(m); });
    nameTh.append(nameBtn); head.append(nameTh);
    for (let j = 0; j < m.n; j++) {
      const th = el('th'); const arrow = sortKey.by === 'column' && sortKey.col === j ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const b = el('button', 'th-btn', `${(m.names[j] ?? '').slice(0, 12)}${arrow}`, { type: 'button', title: `Sort rows by distance to ${m.names[j] ?? ''}`, 'aria-label': `Sort rows by distance to ${m.names[j] ?? ''}` });
      b.addEventListener('click', () => { sortDir = sortKey.by === 'column' && sortKey.col === j && sortDir === 'asc' ? 'desc' : 'asc'; sortKey = { by: 'column', col: j }; renderTable(m); });
      th.append(b); head.append(th);
    }
    table.append(head);
    for (const i of order) {
      const tr = el('tr'); tr.append(el('th', undefined, m.names[i] ?? ''));
      for (let j = 0; j < m.n; j++) {
        const st = m.status[i * m.n + j];
        const td = st === DIST_OK ? el('td', undefined, (m.values[i * m.n + j] as number).toFixed(4)) : el('td', 'unusable', st === DIST_SATURATED ? 'saturated' : 'undefined', { title: st === DIST_SATURATED ? 'Correction undefined: the sequences are too different to correct (saturation).' : 'No comparable sites for this pair.' });
        tr.append(td);
      }
      table.append(tr);
    }
    tableWrap.append(table);
  };

  const showStatus = (): void => {
    clear(statusHost);
    const a = store.state.analysis;
    runRow.hidden = status.kind !== 'running';
    progress.value = status.progress ?? 0;
    if (a?.blocking) { if (a.records.length === 0 || a.blocking) statusHost.append(callout('info', 'No matrix yet: see the messages in step 1.')); }
    else if (status.kind === 'running') statusHost.append(callout('info', `Computing distances… ${Math.round((status.progress ?? 0) * 100)} %`));
    else if (status.kind === 'error') statusHost.append(callout('error', status.message ?? 'Failed.'));
    const m = store.state.matrix;
    if (m && status.kind === 'done') {
      const bad = unusablePairs(m);
      if (bad.length > 0) statusHost.append(callout('warn', `${bad.length} pair(s) have no usable distance (saturated or no comparable sites, marked in the heatmap and table). Trees cannot be built until these are resolved: try the p-distance or remove the most divergent sequences.`));
      else statusHost.append(callout('info', `${m.n} sequences, ${(m.n * (m.n - 1)) / 2} pairs, model: ${m.model}, gap policy: ${m.gapPolicy}.`));
    }
    csvBtn.disabled = phyBtn.disabled = !m;
    treeBtn.disabled = !m;
  };

  const compute = debounce(() => {
    const s = store.state;
    const a = s.analysis;
    worker?.terminate(); worker = null;
    if (!a || a.blocking !== null || a.alphabet === 'unknown') { store.update({ matrix: null, alignedRows: null, alphabet: null }); heatmap.setMatrix(null); renderTable(null); status = { kind: 'idle' }; showStatus(); return; }
    const alphabet: Alphabet = a.alphabet;
    const req: DistancesRequest = a.mode === 'aligned'
      ? { type: 'distances', mode: 'aligned', names: a.records.map((r) => r.id), rows: a.records.map((r) => r.residues), alphabet, model: s.model, gapPolicy: s.gapPolicy }
      : { type: 'distances', mode: 'unaligned', seqs: a.records, alphabet, model: s.model, gapPolicy: s.gapPolicy, scoring: (PRESETS.find((p) => p.id === s.presetId)?.scoring ?? defaultPreset(alphabet).scoring) };
    status = { kind: 'running', progress: 0 }; showStatus();
    worker = new Worker(new URL('../workers/distances.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerReply<DistanceMatrix>>) => {
      const m = ev.data;
      if (m.type === 'progress') { status = { kind: 'running', progress: m.fraction }; showStatus(); return; }
      worker?.terminate(); worker = null;
      if (m.type === 'error') { status = { kind: 'error', message: m.message }; store.update({ matrix: null, alignedRows: null, alphabet: null }); heatmap.setMatrix(null); renderTable(null); showStatus(); return; }
      status = { kind: 'done' };
      store.update({ matrix: m.value, alphabet, alignedRows: a.mode === 'aligned' ? a.records.map((r) => r.residues) : null });
      heatmap.setMatrix(m.value); renderTable(m.value); showStatus();
    };
    worker.onerror = (e) => { status = { kind: 'error', message: `The distance worker failed: ${e.message}` }; worker = null; showStatus(); };
    worker.postMessage(req);
  }, 250);

  function loadText(text: string, mode: SetMode | 'auto', fromMsa = false): void {
    store.update({ text, modeChoice: mode, fromMsa });
    area.value = text;
    analyze();
  }

  // ---- events ----
  area.addEventListener('input', () => { store.update({ text: area.value }); analyze(); });
  alphaSel.addEventListener('change', () => { store.update({ alphabetChoice: alphaSel.value as AlphabetChoice }); analyze(); }); // safe: the select only offers AlphabetChoice values
  modeSel.addEventListener('change', () => { store.update({ modeChoice: modeSel.value as SetMode | 'auto' }); analyze(); }); // safe: the select only offers these values
  modelSel.addEventListener('change', () => { store.update({ model: modelSel.value as DistanceModel }); analyze(); }); // safe: the select only offers DistanceModel values
  policySel.addEventListener('change', () => { store.update({ gapPolicy: policySel.value as GapPolicy }); analyze(); }); // safe: the select only offers GapPolicy values
  presetSel.addEventListener('change', () => { store.update({ presetId: presetSel.value }); analyze(); });
  fixNames.addEventListener('click', () => { const a = store.state.analysis; if (a) { loadText(writeFasta(uniquifyNames(a.records), 1_000_000), store.state.modeChoice); toast('Renamed duplicate names by adding _2, _3, … (shown in the box).'); } });
  cancelBtn.addEventListener('click', () => { worker?.terminate(); worker = null; status = { kind: 'idle' }; store.update({ matrix: null }); showStatus(); toast('Cancelled.'); });
  treeBtn.addEventListener('click', goToTrees);
  openBtn.addEventListener('click', () => {
    void window.sequenceScope.openFile('fasta').then((r) => {
      if (r.ok) { loadText(r.text, 'auto'); toast(`Loaded ${r.name}.`); } else if (r.reason !== 'cancelled') toast(r.message);
    });
  });
  const save = async (name: string, ext: string, content: string): Promise<void> => {
    const r = await window.sequenceScope.saveFile({ suggestedName: name, extensions: [ext], content, encoding: 'utf8' });
    if (r.ok) toast(`Saved ${r.path}`); else if (r.reason !== 'cancelled') toast(r.message);
  };
  csvBtn.addEventListener('click', () => { const m = store.state.matrix; if (m) void save('distances.csv', 'csv', toDistanceCsv(m)); });
  phyBtn.addEventListener('click', () => { const m = store.state.matrix; if (m) { try { void save('distances.phy', 'phy', toPhylip(m)); } catch (e) { toast(e instanceof Error ? e.message : 'Cannot export: some distances are unusable.'); } } });

  // Example list (each set; sets with a MAFFT-aligned copy also appear as "aligned").
  const exampleItems: { label: string; id: string; aligned: boolean }[] = [];
  void loadExampleIndex().then((idx) => {
    for (const s of idx.sets) {
      if (s.records < 3) continue;
      exampleItems.push({ label: `${s.title}`, id: s.id, aligned: false });
      if (s.aligned) exampleItems.push({ label: `${s.title} — MAFFT-aligned copy`, id: s.id, aligned: true });
    }
    exampleItems.forEach((it, k) => exampleSel.append(el('option', undefined, it.label, { value: String(k) })));
  }).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not load the example list.'));
  exampleSel.addEventListener('change', () => {
    const it = exampleItems[Number(exampleSel.value)];
    exampleSel.value = '';
    if (!it) return;
    void loadExampleText(it.id, it.aligned).then((t) => loadText(t, it.aligned ? 'aligned' : 'unaligned')).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not load the example.'));
  });

  analyze();
  return { id: 'distances', title: 'Distances', root, loadText, handleAction(a) { if (a === 'open-fasta') { openBtn.click(); return true; } return false; } };
}
