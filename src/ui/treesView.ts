// Trees view (Milestone B): build UPGMA / neighbor-joining trees from the Distances view, step through every merge,
// view and edit the tree, import/export Newick, bootstrap (aligned input only), and compare trees.
import type { BootstrapResult } from '../bio/bootstrap';
import { MAX_REPLICATES } from '../bio/bootstrap';
import { BioError } from '../bio/errors';
import { neighborJoining } from '../bio/nj';
import { parseNewick, writeNewick, NewickError } from '../bio/newick';
import { assertValidLeaves, hasNegativeBranches, isLeaf, leafNames, midpointRoot, preorder, rerootAbove, rerootAtLeaf, rotateNode, totalLength } from '../bio/tree';
import { upgma } from '../bio/upgma';
import type { Tree, WorkerReply } from '../shared/types';
import type { BootstrapRequest } from '../workers/protocol';
import { callout, card, toast } from './cards';
import { createCompareView } from './compareView';
import type { NamedTree } from './compareView';
import type { DataStore } from './dataStore';
import { clear, el } from './dom';
import { createTreeStepper } from './treeStepper';
import type { StepResult } from './treeStepper';
import { createTreeViewer, HIGHLIGHT_COLORS, LOW_SUPPORT_THRESHOLD } from './treeView';
import type { LayoutKind } from './treeView';
import type { AppView } from './view';

export const DEFAULT_BOOT_SEED = 20260002;
const HONESTY = 'Distance-based trees are quick approximations. Trees from pairwise-alignment distances are less reliable than trees from a good multiple alignment. Bootstrap values measure stability, not truth. Not a replacement for research phylogenetics software (for example IQ-TREE, RAxML, MrBayes).';
const BOOT_EXPLAIN = `A bootstrap value is the percentage of resampled datasets that reproduce a branch. Each resample draws alignment columns with replacement (same number of columns) and rebuilds the tree. It measures how stable the result is under resampling, NOT the probability that the branch is true. Values below ${LOW_SUPPORT_THRESHOLD} % are marked with *.`;

export interface TreesProjectState {
  method: 'upgma' | 'nj';
  seed: number;
  replicates: number;
  importedNewick: string | null;
}

/** Builds the Trees view around the shared data store. */
export function createTreesView(store: DataStore): AppView & { getState(): TreesProjectState; setState(s: TreesProjectState): void; importNewickText(text: string, label?: string): boolean; setMethod(m: 'upgma' | 'nj'): void } {
  const root = el('div', 'view view-trees');
  root.append(callout('warn', HONESTY));
  root.firstElementChild?.classList.add('honesty-banner');

  let method: 'upgma' | 'nj' = 'nj';
  const built: { upgma?: StepResult; nj?: StepResult } = {};
  let buildError: string | null = null;
  const imported: { label: string; tree: Tree }[] = []; // every imported tree stays available for comparison
  let bootTree: { label: string; tree: Tree } | null = null;
  let original: Tree | null = null; // the tree before viewer edits, for "reset root"
  let bootWorker: Worker | null = null;
  let boot: { status: 'idle' | 'running' | 'done' | 'cancelled' | 'error'; progress?: number; message?: string; result?: BootstrapResult } = { status: 'idle' };

  // ---- source card ----
  const srcCard = card('1 · Build a tree', 'Uses the distance matrix from the Distances view.');
  const srcStatus = el('div', 'status-host', undefined, { 'aria-live': 'polite' });
  const methodSel = el('select', undefined, undefined, { 'aria-label': 'Tree-building method' });
  methodSel.append(el('option', undefined, 'Neighbor-joining (does not assume a molecular clock)', { value: 'nj' }), el('option', undefined, 'UPGMA (assumes a constant rate: a molecular clock)', { value: 'upgma' }));
  const methodNote = el('p', 'hint');
  const lab = (t: string, c: HTMLElement): HTMLElement => { const l = el('label', 'field'); l.append(el('span', 'field-label', t), c); return l; };
  srcCard.body.append(srcStatus, lab('Method', methodSel), methodNote);

  // ---- stepper card ----
  const stepCard = card('2 · Step through the algorithm', 'Watch each merge: the matrix, the formulas with the real numbers, and the tree growing.');
  const stepper = createTreeStepper();
  stepCard.body.append(stepper.root);

  // ---- viewer card ----
  const viewCard = card('3 · Tree viewer', 'Click a node to select it; use the arrow keys when the tree is focused. Collapse, rotate, re-root, highlight, and search.');
  const selInfo = el('div', 'tree-selinfo', undefined, { 'aria-live': 'polite' });
  const viewer = createTreeViewer('Phylogenetic tree', (n) => showSelection(n), () => undefined);
  const layoutSel = el('select', undefined, undefined, { 'aria-label': 'Tree layout' });
  for (const [v, t] of [['rect-phylo', 'Rectangular phylogram (branch lengths)'], ['rect-clado', 'Rectangular cladogram (topology only)'], ['radial', 'Radial (equal-angle, unrooted)']] as const) layoutSel.append(el('option', undefined, t, { value: v }));
  const b = (t: string, aria: string): HTMLButtonElement => el('button', 'btn btn-small', t, { type: 'button', 'aria-label': aria, title: aria });
  const collapseBtn = b('Collapse / expand', 'Collapse or expand the selected clade');
  const expandAllBtn = b('Expand all', 'Expand all clades');
  const rotateBtn = b('Rotate', 'Rotate (swap) the children of the selected node');
  const rerootBtn = b('Re-root here', 'Re-root the tree on the branch above the selected node');
  const outgroupBtn = b('Outgroup root', 'Root on the branch leading to the selected taxon');
  const midpointBtn = b('Midpoint root', 'Root at the midpoint of the longest path');
  const resetBtn = b('Reset root', 'Go back to the tree as built');
  const colorSel = el('select', undefined, undefined, { 'aria-label': 'Highlight colour' });
  HIGHLIGHT_COLORS.forEach((c, i) => colorSel.append(el('option', undefined, ['orange', 'sky blue', 'green', 'vermillion', 'pink', 'blue'][i] ?? c, { value: c })));
  const hlBtn = b('Highlight clade', 'Highlight the selected clade in the chosen colour');
  const hlClear = b('Clear highlights', 'Remove all highlights');
  const search = el('input', undefined, undefined, { type: 'text', placeholder: 'Find a taxon…', 'aria-label': 'Search for a taxon' });
  const searchCount = el('span', 'hint');
  const zIn = b('+', 'Zoom in'); const zOut = b('−', 'Zoom out'); const zFit = b('Fit', 'Fit the tree to the window');
  const supportBox = el('input', undefined, undefined, { type: 'checkbox', checked: true });
  const supportLab = el('label', 'check'); supportLab.append(supportBox, document.createTextNode(' Show support values'));
  const outlineBox = el('input', undefined, undefined, { type: 'checkbox' });
  const outlineLab = el('label', 'check'); outlineLab.append(outlineBox, document.createTextNode(' Text outline'));
  const bar1 = el('div', 'row'); bar1.append(layoutSel, collapseBtn, expandAllBtn, rotateBtn, rerootBtn, outgroupBtn, midpointBtn, resetBtn);
  const bar2 = el('div', 'row'); bar2.append(colorSel, hlBtn, hlClear, search, searchCount, zOut, zIn, zFit, supportLab, outlineLab);
  const outline = el('div', 'tree-outline'); outline.hidden = true;
  const treeInfo = el('p', 'hint');
  // newick bar
  const importBtn = b('Import Newick…', 'Open a Newick file');
  const pasteArea = el('textarea', 'seq-area', undefined, { rows: 3, 'aria-label': 'Paste a Newick tree', placeholder: '(A:0.1,B:0.2,(C:0.3,D:0.4):0.5);', spellcheck: false });
  const pasteBtn = b('Load pasted Newick', 'Load the pasted Newick tree');
  const exportNwk = b('Export Newick', 'Save the tree as a Newick file');
  const copyNwk = b('Copy Newick', 'Copy the tree as Newick text');
  const exportSvg = b('Export SVG', 'Save the tree picture as SVG');
  const exportPng = b('Export PNG', 'Save the tree picture as PNG');
  const bar3 = el('div', 'row'); bar3.append(importBtn, exportNwk, copyNwk, exportSvg, exportPng);
  const bar4 = el('div', 'row'); bar4.append(pasteArea, pasteBtn);
  const newickMsg = el('div', 'status-host newick-msg', undefined, { 'aria-live': 'polite' });
  const negNote = callout('warn', 'Some branch lengths are negative. Neighbor-joining can produce these when distances are not perfectly tree-like. They are shown as computed (dashed, with ⚠), never clamped to zero: treat them as a sign of noisy distances.');
  negNote.hidden = true;
  viewCard.body.append(bar1, bar2, negNote, selInfo, viewer.root, outline, treeInfo, bar3, bar4, newickMsg);

  // ---- bootstrap card ----
  const bootCard = card('4 · Bootstrap support', 'How stable is each branch when the alignment columns are resampled?');
  bootCard.body.append(callout('info', BOOT_EXPLAIN));
  const bootBody = el('div', 'boot-body');
  bootCard.body.append(bootBody);

  // ---- compare card ----
  const compare = createCompareView();

  root.append(srcCard.root, stepCard.root, viewCard.root, bootCard.root, compare.root);

  // ---- logic ----
  /** The tree list used by the compare view. */
  const library = (): NamedTree[] => {
    const out: NamedTree[] = [];
    if (built.upgma) out.push({ id: 'upgma', label: 'UPGMA', tree: built.upgma.tree });
    if (built.nj) out.push({ id: 'nj', label: 'Neighbor-joining', tree: built.nj.tree });
    if (bootTree) out.push({ id: 'boot', label: bootTree.label, tree: bootTree.tree });
    imported.forEach((t, k) => out.push({ id: `imported-${k}`, label: `${t.label} (#${k + 1})`, tree: t.tree }));
    const cur = viewer.getTree();
    if (cur) out.push({ id: 'viewer', label: 'Tree in the viewer (as edited)', tree: cur });
    return out;
  };
  const refreshCompare = (): void => compare.setTrees(library());

  /** Shows `t` in the viewer and refreshes dependent displays. */
  const showTree = (t: Tree | null, isOriginal: boolean): void => {
    viewer.setTree(t);
    if (isOriginal) original = t;
    negNote.hidden = !(t && hasNegativeBranches(t));
    treeInfo.textContent = t ? `${leafNames(t).length} taxa · total branch length ${Number(totalLength(t).toFixed(6))} · ${t.root.children.length === 2 ? 'rooted form (two children at the root)' : 'unrooted form (root with three or more children)'}` : '';
    buildOutline();
    for (const x of [exportNwk, copyNwk, exportSvg, exportPng, rotateBtn, rerootBtn, outgroupBtn, midpointBtn, resetBtn, collapseBtn, expandAllBtn, hlBtn, hlClear]) x.disabled = t === null;
    refreshCompare();
  };

  /** Rebuilds the keyboard-accessible text outline of the current tree. */
  const buildOutline = (): void => {
    clear(outline);
    const t = viewer.getTree();
    if (!t) return;
    const nodes = preorder(t);
    const idxOf = new Map(nodes.map((n, i) => [n, i] as const));
    const ul = (n: Tree['root']): HTMLElement => {
      const list = el('ul', undefined, undefined, { role: 'group' });
      for (const c of n.children) {
        const li = el('li', undefined, undefined, { role: 'treeitem' });
        const len = c.length !== undefined ? ` (${c.length})` : '';
        const sup = c.support !== undefined ? ` [support ${Math.round(c.support)}%]` : '';
        const btn = el('button', 'outline-btn', isLeaf(c) ? `${c.name ?? ''}${len}` : `${c.label ?? 'clade'} · ${leafNames(c).length} taxa${len}${sup}`, { type: 'button' });
        btn.addEventListener('click', () => viewer.select(idxOf.get(c) ?? null));
        li.append(btn);
        if (!isLeaf(c)) li.append(ul(c));
        list.append(li);
      }
      return list;
    };
    const top = el('div', 'outline-root', 'Root'); top.append(ul(t.root));
    outline.append(top);
  };

  const showSelection = (n: ReturnType<typeof viewer.getSelected>): void => {
    clear(selInfo);
    const enable = n !== null;
    rotateBtn.disabled = !enable || n.isLeaf; rerootBtn.disabled = !enable || n.parent === null; outgroupBtn.disabled = !enable || !n.isLeaf;
    collapseBtn.disabled = !enable || n.isLeaf || n.parent === null; hlBtn.disabled = !enable || n.isLeaf;
    if (!n) { selInfo.append(el('p', 'hint', 'Nothing selected.')); return; }
    const parts = [n.isLeaf ? `Taxon ${n.label}` : n.collapsed ? `Collapsed clade of ${n.taxa} taxa` : `Internal node (${n.taxa} taxa)`];
    if (n.node.length !== undefined) parts.push(`branch length ${n.node.length}`);
    if (n.node.support !== undefined) parts.push(`support ${Math.round(n.node.support)} %${n.node.support < LOW_SUPPORT_THRESHOLD ? ' (low)' : ''}`);
    selInfo.append(el('p', undefined, parts.join(' · ')));
    if (n.negative) selInfo.append(callout('warn', 'This branch has a negative length. Real branches cannot be negative: it comes from noisy, non-additive distances and is shown as computed.'));
  };

  /** Recomputes both trees from the matrix (cheap) and shows the chosen one. */
  const rebuild = (): void => {
    const s = store.state;
    clear(srcStatus);
    built.upgma = undefined; built.nj = undefined; buildError = null;
    const a = s.analysis;
    if (!s.matrix || !a) {
      srcStatus.append(callout('info', a?.blocking ?? 'Load a sequence set in the Distances view first (or import a Newick tree below to view and compare it).'));
      stepper.setResult(null);
      if (imported.length === 0 && !bootTree) showTree(null, true);
      renderBoot(); refreshCompare(); return;
    }
    try {
      built.upgma = { method: 'upgma', ...upgma(s.matrix) };
      built.nj = { method: 'nj', ...neighborJoining(s.matrix) };
    } catch (e) {
      buildError = e instanceof BioError ? e.message : 'The tree could not be built.';
      srcStatus.append(callout('error', buildError));
      stepper.setResult(null);
      showTree(imported.at(-1)?.tree ?? null, false); renderBoot(); return;
    }
    if (s.fromMsa) srcStatus.append(callout('warn', 'This alignment was made by SequenceScope’s own progressive aligner, which is a heuristic and not guaranteed optimal: an early alignment mistake is frozen in and propagates into the distances, the tree, and the bootstrap values.'));
    const via = a.mode === 'unaligned' ? ' Distances came from aligning each pair on its own: such trees are less reliable than trees from a good multiple alignment.' : '';
    srcStatus.append(callout('info', `${s.matrix.n} taxa, ${s.matrix.model} distances.${via}`));
    pick();
    renderBoot();
  };

  /** Shows the tree for the chosen method (replaces whatever was in the viewer). */
  const pick = (): void => {
    const r = built[method];
    methodSel.value = method;
    methodNote.textContent = method === 'upgma'
      ? 'UPGMA joins the closest clusters and gives every leaf the same distance from the root. It is correct only if all lineages evolved at the same rate; otherwise fast-evolving taxa pull it toward wrong groupings.'
      : 'Neighbor-joining gives each branch its own length and does not need a constant rate. It is exact when distances are perfectly tree-like and usually more reliable than UPGMA, but it can produce negative branch lengths and returns an unrooted tree.';
    if (!r) { stepper.setResult(null); return; }
    stepper.setResult(r);
    bootTree = null;
    showTree(r.tree, true);
  };
  methodSel.addEventListener('change', () => { method = methodSel.value === 'upgma' ? 'upgma' : 'nj'; pick(); renderBoot(); });
  store.subscribe((st) => { if (st.matrix !== lastMatrix) { lastMatrix = st.matrix; rebuild(); } });
  let lastMatrix: typeof store.state.matrix = null;

  // viewer toolbar
  layoutSel.addEventListener('change', () => {
    const v = layoutSel.value;
    viewer.setCladogram(v === 'rect-clado');
    const kind: LayoutKind = v === 'radial' ? 'radial' : 'rect';
    viewer.setLayoutKind(kind);
  });
  const edit = (fn: (t: Tree) => Tree): void => {
    const t = viewer.getTree();
    if (!t) return;
    try { const next = fn(t); showTree(next, false); } catch (e) { toast(e instanceof BioError ? e.message : 'That edit is not possible here.'); }
  };
  rotateBtn.addEventListener('click', () => { const n = viewer.getSelected(); if (n) edit((t) => rotateNode(t, n.index)); });
  rerootBtn.addEventListener('click', () => { const n = viewer.getSelected(); if (n) edit((t) => rerootAbove(t, n.index, 0.5)); });
  outgroupBtn.addEventListener('click', () => { const n = viewer.getSelected(); if (n?.isLeaf) edit((t) => rerootAtLeaf(t, n.label)); });
  midpointBtn.addEventListener('click', () => edit((t) => midpointRoot(t)));
  resetBtn.addEventListener('click', () => { if (original) showTree(original, false); });
  collapseBtn.addEventListener('click', () => viewer.toggleCollapseSelected());
  expandAllBtn.addEventListener('click', () => viewer.expandAll());
  hlBtn.addEventListener('click', () => { const n = viewer.getSelected(); if (n && !n.isLeaf) viewer.setHighlight(n.key, colorSel.value); });
  hlClear.addEventListener('click', () => viewer.clearHighlights());
  search.addEventListener('input', () => { const c = viewer.setSearch(search.value); searchCount.textContent = search.value.trim() === '' ? '' : `${c} match${c === 1 ? '' : 'es'}`; });
  zIn.addEventListener('click', () => viewer.zoom(1.25)); zOut.addEventListener('click', () => viewer.zoom(0.8)); zFit.addEventListener('click', () => viewer.fit());
  supportBox.addEventListener('change', () => viewer.setShowSupport(supportBox.checked));
  outlineBox.addEventListener('change', () => { outline.hidden = !outlineBox.checked; });

  // newick import / export
  const save = async (name: string, ext: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> => {
    const r = await window.sequenceScope.saveFile({ suggestedName: name, extensions: [ext], content, encoding });
    if (r.ok) toast(`Saved ${r.path}`); else if (r.reason !== 'cancelled') toast(r.message);
  };
  /** Parses and shows a Newick tree; returns false (and explains why) if it is malformed. */
  function importNewickText(text: string, label = 'Imported tree'): boolean {
    clear(newickMsg);
    try {
      const p = parseNewick(text);
      assertValidLeaves(p.tree);
      imported.push({ label, tree: p.tree });
      showTree(p.tree, true);
      if (p.extraTrees > 0) newickMsg.append(callout('warn', `The input contains ${p.extraTrees + 1} trees; only the first is shown.`));
      newickMsg.append(callout('info', `Imported ${leafNames(p.tree).length} taxa. Support values (numeric internal labels) are shown on the branches.`));
      return true;
    } catch (e) {
      newickMsg.append(callout('error', e instanceof NewickError || e instanceof BioError ? e.message : 'Could not read that Newick tree.'));
      return false;
    }
  }
  importBtn.addEventListener('click', () => { void window.sequenceScope.openFile('newick').then((r) => { if (r.ok) importNewickText(r.text, `Imported: ${r.name}`); else if (r.reason !== 'cancelled') toast(r.message); }); });
  pasteBtn.addEventListener('click', () => { importNewickText(pasteArea.value); });
  exportNwk.addEventListener('click', () => { const t = viewer.getTree(); if (t) void save('tree.nwk', 'nwk', writeNewick(t) + '\n'); });
  copyNwk.addEventListener('click', () => { const t = viewer.getTree(); if (t) void window.sequenceScope.copyText(writeNewick(t)).then((r) => toast(r.ok ? 'Newick copied to the clipboard.' : r.message)); });
  exportSvg.addEventListener('click', () => { const s = viewer.toSvg(); if (s) void save('tree.svg', 'svg', s); });
  exportPng.addEventListener('click', () => { void viewer.toPng().then((u) => { if (u) void save('tree.png', 'png', u.split(',')[1] ?? '', 'base64'); }).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not export the PNG.')); });

  // ---- bootstrap ----
  const repIn = el('input', undefined, undefined, { type: 'number', min: 1, max: MAX_REPLICATES, step: 1, value: 100, 'aria-label': 'Number of bootstrap replicates' });
  const seedIn = el('input', undefined, undefined, { type: 'number', min: 0, max: 4294967295, step: 1, value: DEFAULT_BOOT_SEED, 'aria-label': 'Bootstrap random seed' });
  const newSeed = b('New seed', 'Pick a seed from the clock'); newSeed.addEventListener('click', () => { seedIn.value = String((Date.now() ^ (performance.now() * 1000)) >>> 0); });
  const runBtn = el('button', 'btn btn-primary', 'Run bootstrap', { type: 'button' });
  const cancelBoot = el('button', 'btn', 'Cancel', { type: 'button' });
  const bootProgress = el('progress', undefined, undefined, { max: 1, value: 0 });
  const bootStatus = el('div', 'status-host', undefined, { 'aria-live': 'polite' });
  const bootResult = el('div', 'boot-result');
  const f1 = el('label', 'field narrow'); f1.append(el('span', 'field-label', `Replicates (max ${MAX_REPLICATES})`), repIn);
  const f2 = el('label', 'field narrow'); f2.append(el('span', 'field-label', 'Seed'), seedIn);
  const bootRow = el('div', 'row'); bootRow.append(f1, f2, newSeed, runBtn, cancelBoot);
  const bootControls = el('div', 'boot-controls'); bootControls.append(bootRow, bootProgress);
  bootBody.append(bootStatus, bootControls, bootResult);

  /** Shows either the bootstrap controls or the reason bootstrap is unavailable. */
  function renderBoot(): void {
    clear(bootStatus); clear(bootResult);
    const s = store.state;
    const a = s.analysis;
    const aligned = s.alignedRows !== null && a !== null && a.mode === 'aligned' && s.matrix !== null;
    bootControls.hidden = !aligned;
    if (!aligned) {
      bootStatus.append(callout('info', a && a.mode === 'unaligned' && s.matrix
        ? 'Bootstrap is unavailable for this input because the sequences are not aligned. Bootstrap resamples alignment COLUMNS, and pairwise distances alone have no columns to resample. Load an already-aligned FASTA in the Distances view (for example a MAFFT-aligned example). The multiple aligner arriving in Milestone C will let you align your own sequences here.'
        : 'Load an already-aligned FASTA in the Distances view to enable bootstrap.'));
      return;
    }
    if (a && a.records.length < 3) { bootControls.hidden = true; bootStatus.append(callout('info', 'Bootstrap needs at least 3 sequences.')); return; }
    if (buildError) { bootControls.hidden = true; bootStatus.append(callout('error', buildError)); return; }
    runBtn.disabled = boot.status === 'running'; cancelBoot.hidden = boot.status !== 'running'; bootProgress.hidden = boot.status !== 'running';
    bootProgress.value = boot.progress ?? 0;
    if (boot.status === 'running') bootStatus.append(callout('info', `Running… ${Math.round((boot.progress ?? 0) * 100)} %`));
    else if (boot.status === 'cancelled') bootStatus.append(callout('info', 'Cancelled. No partial result was kept.'));
    else if (boot.status === 'error') bootStatus.append(callout('error', boot.message ?? 'Bootstrap failed.'));
    else if (boot.status === 'done' && boot.result) {
      const r = boot.result;
      bootStatus.append(callout('info', `Done: ${r.replicates} replicates, seed ${r.seed}, method ${r.method === 'nj' ? 'neighbor-joining' : 'UPGMA'}, model ${r.model}, gap policy ${r.gapPolicy}.${r.failedReplicates > 0 ? ` ${r.failedReplicates} replicate(s) could not build a tree (saturated distances) and count as NOT supporting any split.` : ''} Support values are now drawn on the tree above.`));
      const t = el('table', 'matrix-table', undefined, { 'aria-label': 'Bootstrap support per split' });
      const h = el('tr'); for (const x of ['Support %', 'Replicates', 'Taxa on one side of the split']) h.append(el('th', undefined, x)); t.append(h);
      for (const sp of [...r.supports].sort((p, q) => q.percent - p.percent)) {
        const tr = el('tr'); tr.append(el('td', sp.percent < LOW_SUPPORT_THRESHOLD ? 'unusable' : undefined, `${sp.percent.toFixed(1)}${sp.percent < LOW_SUPPORT_THRESHOLD ? ' *' : ''}`), el('td', undefined, `${sp.count} / ${r.replicates}`), el('td', 'mono', sp.leaves.join(', ')));
        t.append(tr);
      }
      const w = el('div', 'matrix-table-wrap'); w.append(t); bootResult.append(w);
    }
  }
  runBtn.addEventListener('click', () => {
    const s = store.state;
    const a = s.analysis;
    if (!s.alignedRows || !a || !s.matrix || a.alphabet === 'unknown') return;
    const replicates = Number(repIn.value); const seed = Number(seedIn.value);
    if (!Number.isInteger(replicates) || replicates < 1 || replicates > MAX_REPLICATES) { boot = { status: 'error', message: `The number of replicates must be a whole number from 1 to ${MAX_REPLICATES}.` }; renderBoot(); return; }
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { boot = { status: 'error', message: 'The seed must be a whole number from 0 to 4294967295.' }; renderBoot(); return; }
    bootWorker?.terminate();
    bootWorker = new Worker(new URL('../workers/bootstrap.worker.ts', import.meta.url), { type: 'module' });
    boot = { status: 'running', progress: 0 }; renderBoot();
    bootWorker.onmessage = (ev: MessageEvent<WorkerReply<BootstrapResult>>) => {
      const m = ev.data;
      if (m.type === 'progress') { boot = { status: 'running', progress: m.fraction }; renderBoot(); return; }
      bootWorker?.terminate(); bootWorker = null;
      if (m.type === 'error') { boot = { status: 'error', message: m.message }; renderBoot(); return; }
      boot = { status: 'done', result: m.value };
      bootTree = { label: `Bootstrap tree (${m.value.replicates} replicates, seed ${m.value.seed})`, tree: m.value.referenceTree };
      showTree(m.value.referenceTree, true);
      renderBoot();
    };
    bootWorker.onerror = (e) => { boot = { status: 'error', message: `The bootstrap worker failed: ${e.message}` }; bootWorker = null; renderBoot(); };
    const req: BootstrapRequest = { type: 'bootstrap', input: { names: s.matrix.names, rows: s.alignedRows, alphabet: a.alphabet, model: s.model, gapPolicy: s.gapPolicy, method, replicates, seed } };
    bootWorker.postMessage(req);
  });
  cancelBoot.addEventListener('click', () => { bootWorker?.terminate(); bootWorker = null; boot = { status: 'cancelled' }; renderBoot(); });

  rebuild();
  showSelection(null);
  return {
    id: 'trees', title: 'Trees', root,
    importNewickText,
    setMethod(m) { method = m; pick(); renderBoot(); },
    getState: () => ({ method, seed: Number(seedIn.value) || DEFAULT_BOOT_SEED, replicates: Number(repIn.value) || 100, importedNewick: imported.length > 0 ? writeNewick((imported.at(-1) as { tree: Tree }).tree) : null }),
    setState(st) { method = st.method; repIn.value = String(st.replicates); seedIn.value = String(st.seed); if (st.importedNewick) importNewickText(st.importedNewick, 'Imported tree (from project)'); pick(); },
    onShow() { renderBoot(); refreshCompare(); },
    handleAction(a) {
      if (a === 'open-newick') { importBtn.click(); return true; }
      if (a === 'export') { exportNwk.click(); return true; }
      return false;
    },
  };
}
