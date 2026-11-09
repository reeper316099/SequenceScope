// UPGMA (ALGORITHMS.md section 7): repeatedly merge the closest two clusters; new height = d/2; the distance from the
// merged cluster to another cluster k is the size-weighted average of the old distances (Eq. 7.1). Output is ultrametric.
// Ties: the first minimal pair in scan order (clusters in creation order: leaves in input order, merged clusters appended).
import type { DistanceMatrix, Tree, TreeNode } from '../shared/types';
import { BioError } from './errors';
import { assertTreeReady, toRows } from './distance';

export interface UpgmaStep {
  step: number;
  /** Cluster ids in scan order before this merge (leaves are 0..n-1, merged clusters n, n+1, ...). */
  active: number[];
  /** Distances among the active clusters (same order). */
  matrix: number[][];
  /** Chosen pair as indices into `active`, and as cluster ids. */
  i: number;
  j: number;
  a: number;
  b: number;
  distance: number;
  newId: number;
  /** New node height = distance / 2, and the old heights of the two clusters. */
  height: number;
  heightA: number;
  heightB: number;
  /** Branch lengths from the new node to its two children (= height - child height). */
  branchA: number;
  branchB: number;
  sizeA: number;
  sizeB: number;
  /** Distance from the new cluster to each remaining cluster (ids in `others`). */
  others: number[];
  newRow: number[];
}

export interface UpgmaResult {
  tree: Tree;
  steps: UpgmaStep[];
  names: string[];
}

/** Builds the UPGMA tree and records every merge. Needs at least 3 sequences and a tree-ready matrix. */
export function upgma(m: DistanceMatrix): UpgmaResult {
  assertTreeReady(m);
  const d0 = toRows(m);
  const n = m.n;
  const total = 2 * n - 1;
  const dist: number[][] = Array.from({ length: total }, () => new Array<number>(total).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) (dist[i] as number[])[j] = (d0[i] as number[])[j] as number; // safe: in range
  const D = (a: number, b: number): number => (dist[a] as number[])[b] as number; // safe: ids < total
  const nodes: TreeNode[] = m.names.map((name) => ({ name, children: [] }));
  const height = new Array<number>(total).fill(0);
  const size = new Array<number>(total).fill(1);
  let active = Array.from({ length: n }, (_, k) => k);
  const steps: UpgmaStep[] = [];
  let next = n;
  while (active.length > 1) {
    let bi = 0, bj = 1, best = Infinity;
    for (let p = 0; p < active.length; p++) for (let q = p + 1; q < active.length; q++) {
      const d = D(active[p] as number, active[q] as number); // safe: p, q < length
      if (d < best) { best = d; bi = p; bj = q; }
    }
    const a = active[bi] as number;
    const b = active[bj] as number;
    const newId = next++;
    const h = best / 2;
    const branchA = h - (height[a] as number);
    const branchB = h - (height[b] as number);
    const nodeA = nodes[a] as TreeNode;
    const nodeB = nodes[b] as TreeNode;
    nodeA.length = branchA;
    nodeB.length = branchB;
    nodes[newId] = { children: [nodeA, nodeB] };
    height[newId] = h;
    size[newId] = (size[a] as number) + (size[b] as number);
    const others = active.filter((_, k) => k !== bi && k !== bj);
    const newRow: number[] = [];
    for (const k of others) {
      const v = ((size[a] as number) * D(a, k) + (size[b] as number) * D(b, k)) / (size[newId]); // Eq. 7.1
      (dist[newId] as number[])[k] = v;
      (dist[k] as number[])[newId] = v;
      newRow.push(v);
    }
    steps.push({
      step: steps.length + 1, active: [...active], matrix: active.map((x) => active.map((y) => D(x, y))), i: bi, j: bj, a, b, distance: best,
      newId, height: h, heightA: height[a] as number, heightB: height[b] as number, branchA, branchB, sizeA: size[a] as number, sizeB: size[b] as number, others, newRow,
    });
    active = [...others, newId];
  }
  return { tree: { root: nodes[next - 1] as TreeNode }, steps, names: m.names };
}

/** Rebuilds the tree from the recorded steps alone (used to prove the trace is complete). */
export function replayUpgma(steps: readonly UpgmaStep[], names: readonly string[]): Tree {
  if (steps.length === 0) throw new BioError('invalid-argument', 'No steps to replay.');
  const nodes = new Map<number, TreeNode>(names.map((name, k) => [k, { name, children: [] }]));
  let last: TreeNode | undefined;
  for (const s of steps) {
    const a = nodes.get(s.a) as TreeNode; // safe: ids come from earlier steps or leaves
    const b = nodes.get(s.b) as TreeNode;
    a.length = s.branchA;
    b.length = s.branchB;
    last = { children: [a, b] };
    nodes.set(s.newId, last);
  }
  return { root: last as TreeNode }; // safe: steps is non-empty
}
