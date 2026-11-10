// Tree comparison: Robinson-Foulds distance (unrooted), the splits unique to each tree, and both trees drawn with the
// disagreeing branches marked in red.
import type { Tree } from '../shared/types';
import { BioError } from '../bio/errors';
import { compareTreesAsync } from '../backend/api';
import { callout, card } from './cards';
import { clear, el } from './dom';
import { createTreeViewer } from './treeView';

export interface NamedTree {
  id: string;
  label: string;
  tree: Tree;
}

export interface CompareView {
  root: HTMLElement;
  /** Updates the list of trees that can be compared. */
  setTrees(list: readonly NamedTree[]): void;
}

/** Builds the compare card. */
export function createCompareView(): CompareView {
  const c = card('Compare two trees', 'Robinson–Foulds distance = the number of branch splits that appear in one tree but not the other (trees are compared as unrooted).');
  const root = c.root;
  let list: readonly NamedTree[] = [];
  const selA = el('select', undefined, undefined, { 'aria-label': 'First tree' });
  const selB = el('select', undefined, undefined, { 'aria-label': 'Second tree' });
  const lab = (t: string, x: HTMLElement): HTMLElement => { const l = el('label', 'field'); l.append(el('span', 'field-label', t), x); return l; };
  const row = el('div', 'row'); row.append(lab('Tree A', selA), lab('Tree B', selB));
  const summary = el('div', 'compare-summary', undefined, { 'aria-live': 'polite' });
  const vA = createTreeViewer('Tree A with branches that disagree marked in red');
  const vB = createTreeViewer('Tree B with branches that disagree marked in red');
  const pair = el('div', 'pair'); pair.append(vA.root, vB.root);
  c.body.append(row, summary, pair);

  const listSplits = (title: string, splits: string[][]): HTMLElement => {
    const d = el('details', 'compare-list');
    d.append(el('summary', undefined, `${title}: ${splits.length}`));
    const ul = el('ul');
    for (const s of splits) ul.append(el('li', 'mono', `{ ${s.join(', ')} }`));
    d.append(ul);
    return d;
  };

  let refreshSeq = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++refreshSeq;
    const a = list.find((t) => t.id === selA.value); const b = list.find((t) => t.id === selB.value);
    if (!a || !b) {
      clear(summary); summary.append(callout('info', 'Build at least two trees (for example UPGMA and neighbor-joining) or import a Newick tree to compare.')); vA.setTree(null); vB.setTree(null); return; }
    let cmp: Awaited<ReturnType<typeof compareTreesAsync>>;
    try { cmp = await compareTreesAsync(a.tree, b.tree); } catch (e) {
      if (mine !== refreshSeq) return; // a newer comparison was asked for meanwhile
      clear(summary);
      summary.append(callout('error', e instanceof BioError ? e.message : 'These trees cannot be compared.'));
      vA.setTree(a.tree); vB.setTree(b.tree); return;
    }
    if (mine !== refreshSeq) return;
    clear(summary);
    const rf = cmp.rf;
    summary.append(
      callout(rf.distance === 0 ? 'info' : 'warn', rf.distance === 0 ? `Robinson–Foulds distance 0: "${a.label}" and "${b.label}" have the same unrooted topology (${rf.leafCount} taxa, ${rf.shared.length} shared internal splits).` : `Robinson–Foulds distance ${rf.distance} (largest possible for these trees: ${rf.max}). ${rf.shared.length} splits are shared; ${rf.onlyInA.length} only in "${a.label}", ${rf.onlyInB.length} only in "${b.label}".`),
      listSplits(`Splits only in ${a.label}`, rf.onlyInA), listSplits(`Splits only in ${b.label}`, rf.onlyInB),
    );
    vA.setTree(a.tree); vB.setTree(b.tree);
    vA.setMarked(new Set(cmp.uniqueA)); vB.setMarked(new Set(cmp.uniqueB));
  };
  selA.addEventListener('change', () => void refresh()); selB.addEventListener('change', () => void refresh());

  return {
    root,
    setTrees(next) {
      list = next;
      const keepA = selA.value; const keepB = selB.value;
      for (const s of [selA, selB]) { clear(s); for (const t of next) s.append(el('option', undefined, t.label, { value: t.id })); }
      selA.value = next.some((t) => t.id === keepA) ? keepA : (next[0]?.id ?? '');
      selB.value = next.some((t) => t.id === keepB) ? keepB : (next[1]?.id ?? next[0]?.id ?? '');
      void refresh();
    },
  };
}
