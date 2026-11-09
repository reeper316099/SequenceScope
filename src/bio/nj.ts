// Neighbor-joining, Saitou & Nei (ALGORITHMS.md section 8). With n active nodes and r_i = sum_k d(i,k):
//   Q(i,j) = (n-2) d(i,j) - r_i - r_j                         (Eq. 8.1)  join the pair with the smallest Q
//   branch(i->u) = d(i,j)/2 + (r_i - r_j) / (2(n-2))          (Eq. 8.2)  branch(j->u) = d(i,j) - branch(i->u)
//   d(u,k) = (d(i,k) + d(j,k) - d(i,j)) / 2                   (Eq. 8.3)
// When 3 nodes remain they are joined in a star with x_i = (d(i,j) + d(i,k) - d(j,k)) / 2 (Eq. 8.4).
// Ties: the first minimal Q in scan order. Negative branch lengths can occur and are NEVER clamped.
import type { DistanceMatrix, Tree, TreeNode } from '../shared/types';
import { BioError } from './errors';
import { assertTreeReady, toRows } from './distance';

export interface NjJoinStep {
  kind: 'join';
  step: number;
  active: number[];
  matrix: number[][];
  /** r_i for each active node. */
  sums: number[];
  /** Q matrix (diagonal entries are 0 and not candidates). */
  q: number[][];
  i: number;
  j: number;
  a: number;
  b: number;
  distance: number;
  qMin: number;
  newId: number;
  branchA: number;
  branchB: number;
  others: number[];
  newRow: number[];
}
export interface NjFinalStep {
  kind: 'final';
  step: number;
  active: number[];
  matrix: number[][];
  ids: [number, number, number];
  branches: [number, number, number];
  newId: number;
}
export type NjStep = NjJoinStep | NjFinalStep;

export interface NjResult {
  tree: Tree;
  steps: NjStep[];
  names: string[];
}

/** Builds the NJ tree (unrooted: the root has 3 children) and records every step. */
export function neighborJoining(m: DistanceMatrix): NjResult {
  assertTreeReady(m);
  const d0 = toRows(m);
  const n0 = m.n;
  const total = 2 * n0 - 1;
  const dist: number[][] = Array.from({ length: total }, () => new Array<number>(total).fill(0));
  for (let i = 0; i < n0; i++) for (let j = 0; j < n0; j++) (dist[i] as number[])[j] = (d0[i] as number[])[j] as number; // safe: in range
  const D = (a: number, b: number): number => (dist[a] as number[])[b] as number; // safe: ids < total
  const nodes: TreeNode[] = m.names.map((name) => ({ name, children: [] }));
  let active = Array.from({ length: n0 }, (_, k) => k);
  const steps: NjStep[] = [];
  let next = n0;
  while (active.length > 3) {
    const n = active.length;
    const sums = active.map((x) => active.reduce((s, y) => s + D(x, y), 0));
    const q = active.map((x, p) => active.map((y, r) => (p === r ? 0 : (n - 2) * D(x, y) - (sums[p] as number) - (sums[r] as number)))); // Eq. 8.1
    let bi = 0, bj = 1, best = Infinity;
    for (let p = 0; p < n; p++) for (let r = p + 1; r < n; r++) {
      const v = (q[p] as number[])[r] as number; // safe: p, r < n
      if (v < best) { best = v; bi = p; bj = r; }
    }
    const a = active[bi] as number;
    const b = active[bj] as number;
    const dab = D(a, b);
    const branchA = dab / 2 + ((sums[bi] as number) - (sums[bj] as number)) / (2 * (n - 2)); // Eq. 8.2
    const branchB = dab - branchA;
    (nodes[a] as TreeNode).length = branchA;
    (nodes[b] as TreeNode).length = branchB;
    const newId = next++;
    nodes[newId] = { children: [nodes[a] as TreeNode, nodes[b] as TreeNode] };
    const others = active.filter((_, k) => k !== bi && k !== bj);
    const newRow: number[] = [];
    for (const k of others) {
      const v = (D(a, k) + D(b, k) - dab) / 2; // Eq. 8.3
      (dist[newId] as number[])[k] = v;
      (dist[k] as number[])[newId] = v;
      newRow.push(v);
    }
    steps.push({ kind: 'join', step: steps.length + 1, active: [...active], matrix: active.map((x) => active.map((y) => D(x, y))), sums, q, i: bi, j: bj, a, b, distance: dab, qMin: best, newId, branchA, branchB, others, newRow });
    active = [...others, newId];
  }
  const [x, y, z] = active as [number, number, number]; // safe: exactly 3 remain (n0 >= 3)
  const bx = (D(x, y) + D(x, z) - D(y, z)) / 2; // Eq. 8.4
  const by = (D(x, y) + D(y, z) - D(x, z)) / 2;
  const bz = (D(x, z) + D(y, z) - D(x, y)) / 2;
  (nodes[x] as TreeNode).length = bx;
  (nodes[y] as TreeNode).length = by;
  (nodes[z] as TreeNode).length = bz;
  const newId = next; // the root of the unrooted tree
  nodes[newId] = { children: [nodes[x] as TreeNode, nodes[y] as TreeNode, nodes[z] as TreeNode] };
  steps.push({ kind: 'final', step: steps.length + 1, active: [...active], matrix: active.map((p) => active.map((r) => D(p, r))), ids: [x, y, z], branches: [bx, by, bz], newId });
  return { tree: { root: nodes[newId] }, steps, names: m.names };
}

/** Rebuilds the tree from the recorded steps alone. */
export function replayNj(steps: readonly NjStep[], names: readonly string[]): Tree {
  if (steps.length === 0) throw new BioError('invalid-argument', 'No steps to replay.');
  const nodes = new Map<number, TreeNode>(names.map((name, k) => [k, { name, children: [] }]));
  let last: TreeNode | undefined;
  for (const s of steps) {
    if (s.kind === 'join') {
      const a = nodes.get(s.a) as TreeNode; // safe: ids come from earlier steps or leaves
      const b = nodes.get(s.b) as TreeNode;
      a.length = s.branchA; b.length = s.branchB;
      last = { children: [a, b] };
    } else {
      const kids = s.ids.map((id, k) => { const nd = nodes.get(id) as TreeNode; nd.length = s.branches[k]; return nd; }); // safe: k < 3
      last = { children: kids };
    }
    nodes.set(s.newId, last);
  }
  return { root: last as TreeNode }; // safe: steps is non-empty
}
