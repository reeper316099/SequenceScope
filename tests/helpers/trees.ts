// Seeded random tree generators (using the project's own PRNG) with their exact distance matrices.
import { leafDistances } from '../../src/bio/tree';
import { createRng } from '../../src/bio/rng';
import type { Rng } from '../../src/bio/rng';
import type { DistanceMatrix, Tree, TreeNode } from '../../src/shared/types';
import { DIST_OK } from '../../src/shared/types';

/** Uniform float in [lo, hi). */
export const uniform = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng.nextFloat();

/** Random rooted binary ULTRAMETRIC tree: clusters are merged at strictly increasing heights; branch = height difference. */
export function randomUltrametric(seed: number, n: number): Tree {
  const rng = createRng(seed);
  const clusters: { node: TreeNode; height: number }[] = Array.from({ length: n }, (_, k) => ({ node: { name: `t${k}`, children: [] }, height: 0 }));
  while (clusters.length > 1) {
    const a = clusters.splice(rng.nextInt(clusters.length), 1)[0] as { node: TreeNode; height: number }; // safe: non-empty
    const b = clusters.splice(rng.nextInt(clusters.length), 1)[0] as { node: TreeNode; height: number };
    const h = Math.max(a.height, b.height) + uniform(rng, 0.1, 2);
    a.node.length = h - a.height;
    b.node.length = h - b.height;
    clusters.push({ node: { children: [a.node, b.node] }, height: h });
  }
  return { root: (clusters[0] as { node: TreeNode }).node }; // safe: one cluster remains
}

/** Random unrooted binary ADDITIVE tree (root has 3 children) built by attaching leaves to random edges. */
export function randomAdditive(seed: number, n: number): Tree {
  const rng = createRng(seed);
  const leaf = (k: number): TreeNode => ({ name: `t${k}`, length: uniform(rng, 0.2, 4), children: [] });
  const root: TreeNode = { children: [leaf(0), leaf(1), leaf(2)] };
  for (let k = 3; k < n; k++) {
    // collect (parent, index) of all edges
    const edges: { parent: TreeNode; idx: number }[] = [];
    const walk = (p: TreeNode): void => p.children.forEach((c, idx) => { edges.push({ parent: p, idx }); walk(c); });
    walk(root);
    const e = edges[rng.nextInt(edges.length)] as { parent: TreeNode; idx: number }; // safe: non-empty
    const child = e.parent.children[e.idx] as TreeNode;
    const split = uniform(rng, 0.1, 0.9);
    const whole = child.length ?? 1;
    const mid: TreeNode = { length: whole * split, children: [child, leaf(k)] };
    child.length = whole * (1 - split);
    e.parent.children[e.idx] = mid;
  }
  return { root };
}

/** Exact leaf-to-leaf distance matrix of a tree, as a tree-ready DistanceMatrix. */
export function matrixOfTree(t: Tree, order?: string[]): DistanceMatrix {
  const { names, dist } = leafDistances(t);
  const use = order ?? names;
  const n = use.length;
  const values = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) values[i * n + j] = (dist[names.indexOf(use[i] as string)] as number[])[names.indexOf(use[j] as string)] as number; // safe: names present
  return { names: use, n, values, status: new Uint8Array(n * n).fill(DIST_OK), compared: new Uint32Array(n * n).fill(100), model: 'p', gapPolicy: 'pairwise-deletion' };
}

/** Builds a tree-ready matrix from a nested-array of numbers. */
export function matrixOf(names: string[], rows: number[][]): DistanceMatrix {
  const n = names.length;
  const values = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) values[i * n + j] = (rows[i] as number[])[j] as number; // safe: square input
  return { names, n, values, status: new Uint8Array(n * n).fill(DIST_OK), compared: new Uint32Array(n * n).fill(100), model: 'p', gapPolicy: 'pairwise-deletion' };
}
