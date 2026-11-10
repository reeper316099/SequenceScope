// Reconstructs the partial forest after k steps of UPGMA / neighbor-joining so the step-through can draw the tree growing.
import type { TreeNode } from '../shared/types';
import type { NjStep } from '../shared/results';
import type { UpgmaStep } from '../shared/results';

export interface ForestResult {
  /** Clusters (subtrees) alive after k steps, in creation order. */
  clusters: { id: number; node: TreeNode }[];
}

/** The forest after the first `k` steps (k = 0: just the leaves). Branch lengths are set only where already decided. */
export function forestAfter(steps: readonly (UpgmaStep | NjStep)[], names: readonly string[], k: number): ForestResult {
  const nodes = new Map<number, TreeNode>(names.map((name, i) => [i, { name, children: [] }]));
  let alive = names.map((_, i) => i);
  for (const s of steps.slice(0, k)) {
    if ('kind' in s && s.kind === 'final') {
      const kids = s.ids.map((id, j) => { const nd = nodes.get(id) as TreeNode; nd.length = s.branches[j]; return nd; }); // safe: ids exist
      nodes.set(s.newId, { children: kids });
      alive = [s.newId];
    } else {
      const j = s;
      const a = nodes.get(j.a) as TreeNode; // safe: ids come from earlier steps or leaves
      const b = nodes.get(j.b) as TreeNode;
      a.length = j.branchA; b.length = j.branchB;
      nodes.set(j.newId, { children: [a, b] });
      alive = alive.filter((id) => id !== j.a && id !== j.b).concat(j.newId);
    }
  }
  return { clusters: alive.map((id) => ({ id, node: nodes.get(id) as TreeNode })) }; // safe: alive ids exist
}
