// Tree utilities: traversal, splits (bipartitions), edge lengths, re-rooting, midpoint rooting, ordering, support.
// A tree is a recursive TreeNode. A root with 3 children is the usual unrooted form; a root with 2 children is a rooted form.
import type { Tree, TreeNode } from '../shared/types';
import { BioError } from './errors';

/** Deep copy (trees are treated as immutable values everywhere else). */
export function cloneTree(t: Tree): Tree {
  const cp = (n: TreeNode): TreeNode => {
    const out: TreeNode = { children: n.children.map(cp) };
    if (n.name !== undefined) out.name = n.name;
    if (n.label !== undefined) out.label = n.label;
    if (n.length !== undefined) out.length = n.length;
    if (n.support !== undefined) out.support = n.support;
    return out;
  };
  return { root: cp(t.root) };
}

/** True for a leaf node. */
export function isLeaf(n: TreeNode): boolean {
  return n.children.length === 0;
}

/** Leaf names in left-to-right order. */
export function leafNames(t: Tree | TreeNode): string[] {
  const root = 'root' in t ? t.root : t;
  const out: string[] = [];
  const walk = (n: TreeNode): void => { if (isLeaf(n)) out.push(n.name ?? ''); else n.children.forEach(walk); };
  walk(root);
  return out;
}

/** Nodes in pre-order (parent before children, children left to right). Index = node id used by the UI. */
export function preorder(t: Tree): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode): void => { out.push(n); n.children.forEach(walk); };
  walk(t.root);
  return out;
}

/** Sum of all branch lengths (missing lengths count as 0). */
export function totalLength(t: Tree): number {
  return preorder(t).reduce((s, n) => s + (n.length ?? 0), 0);
}

/** True if any branch length is negative (neighbor-joining can produce these; they are never clamped). */
export function hasNegativeBranches(t: Tree): boolean {
  return preorder(t).some((n) => (n.length ?? 0) < 0);
}

/** Validates a tree for comparison/building: unique, non-empty leaf names. */
export function assertValidLeaves(t: Tree): string[] {
  const names = leafNames(t);
  if (names.some((n) => n === '')) throw new BioError('invalid-tree', 'Every leaf needs a name.');
  if (new Set(names).size !== names.length) throw new BioError('duplicate-names', 'Leaf names must be unique.');
  return names;
}

const SEP = '\u0001';

/** Canonical key of a split: the side NOT containing the reference leaf (smallest name), sorted and joined. */
function sideKey(side: string[]): string {
  return [...side].sort().join(SEP);
}

interface CladeInfo {
  node: TreeNode;
  leaves: string[];
}

/** Computes the leaf set below every node (pre-order). */
function cladeSets(t: Tree): CladeInfo[] {
  const out: CladeInfo[] = [];
  const walk = (n: TreeNode): string[] => {
    const idx = out.length;
    out.push({ node: n, leaves: [] });
    const leaves = isLeaf(n) ? [n.name ?? ''] : n.children.flatMap(walk);
    (out[idx] as CladeInfo).leaves = leaves; // safe: idx was just pushed
    return leaves;
  };
  walk(t.root);
  return out;
}

/** The canonical (reference-free) side of a split for a clade, given the complete leaf list. */
function canonicalSide(clade: string[], all: string[], ref: string): string[] {
  if (!clade.includes(ref)) return clade;
  const inClade = new Set(clade);
  return all.filter((x) => !inClade.has(x));
}

export interface SplitMap {
  /** key -> leaf names on the canonical side (the side not containing the smallest leaf name), sorted. */
  splits: Map<string, string[]>;
  leaves: string[];
}

/** All NON-TRIVIAL splits (both sides have at least 2 leaves) of the tree viewed as UNROOTED. */
export function nontrivialSplits(t: Tree): SplitMap {
  const all = assertValidLeaves(t);
  const ref = [...all].sort()[0] ?? '';
  const splits = new Map<string, string[]>();
  for (const { node, leaves } of cladeSets(t)) {
    if (node === t.root) continue;
    if (leaves.length < 2 || leaves.length > all.length - 2) continue;
    const side = canonicalSide(leaves, all, ref).sort();
    splits.set(sideKey(side), side);
  }
  return { splits, leaves: [...all].sort() };
}

/** Key for the split induced by a clade (for any clade size 1..n-1), relative to a leaf list. */
export function cladeKey(clade: string[], all: string[]): string {
  const ref = [...all].sort()[0] ?? '';
  return sideKey(canonicalSide(clade, all, ref));
}

/**
 * Length of every edge, keyed by split (trivial splits included). A rooted-form tree's two root edges are one
 * unrooted edge, so their lengths are summed. Edges without a length are skipped.
 */
export function edgeLengthMap(t: Tree): Map<string, number> {
  const all = assertValidLeaves(t);
  const ref = [...all].sort()[0] ?? '';
  const out = new Map<string, number>();
  for (const { node, leaves } of cladeSets(t)) {
    if (node === t.root || node.length === undefined) continue;
    const key = sideKey(canonicalSide(leaves, all, ref));
    out.set(key, (out.get(key) ?? 0) + node.length);
  }
  return out;
}

/** Orders children so output is deterministic: smaller clades first, ties by smallest leaf name. */
export function ladderize(t: Tree): Tree {
  const sorted = (n: TreeNode): { node: TreeNode; size: number; first: string } => {
    if (isLeaf(n)) return { node: { ...n, children: [] }, size: 1, first: n.name ?? '' };
    const kids = n.children.map(sorted).sort((a, b) => a.size - b.size || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    return { node: { ...n, children: kids.map((k) => k.node) }, size: kids.reduce((s, k) => s + k.size, 0), first: kids.map((k) => k.first).sort()[0] ?? '' };
  };
  return { root: sorted(t.root).node };
}

/** Leaf order of the ladderized tree: deterministic regardless of how the tree was built. */
export function orderedLeaves(t: Tree): string[] {
  return leafNames(ladderize(t));
}

/** Reverses the children of one node (the UI's "rotate branches"). `index` is the pre-order index. */
export function rotateNode(t: Tree, index: number): Tree {
  const c = cloneTree(t);
  const n = preorder(c)[index];
  if (n) n.children.reverse();
  return c;
}

// ---------------------------------------------------------------- re-rooting via an undirected graph

interface GNode {
  name?: string;
  label?: string;
  nbrs: { to: number; length: number | undefined; support: number | undefined }[];
}

/** Converts to an undirected graph; a rooted-form root (2 children) is dissolved into one edge (lengths summed). */
function toGraph(t: Tree): GNode[] {
  const g: GNode[] = [];
  const add = (n: TreeNode): number => {
    const id = g.length;
    const gn: GNode = { nbrs: [] };
    if (n.name !== undefined) gn.name = n.name;
    if (n.label !== undefined) gn.label = n.label;
    g.push(gn);
    for (const c of n.children) {
      const cid = add(c);
      gn.nbrs.push({ to: cid, length: c.length, support: c.support });
      (g[cid] as GNode).nbrs.push({ to: id, length: c.length, support: c.support }); // safe: cid was just added
    }
    return id;
  };
  add(t.root);
  const root = g[0] as GNode; // safe: at least the root exists
  if (root.nbrs.length === 2 && root.name === undefined) {
    // Dissolve the degree-2 root: connect its two neighbours directly.
    const [e1, e2] = root.nbrs as [GNode['nbrs'][number], GNode['nbrs'][number]];
    const length = e1.length === undefined && e2.length === undefined ? undefined : (e1.length ?? 0) + (e2.length ?? 0);
    const support = e1.support ?? e2.support;
    const n1 = g[e1.to] as GNode;
    const n2 = g[e2.to] as GNode;
    n1.nbrs = n1.nbrs.filter((x) => x.to !== 0).concat({ to: e2.to, length, support });
    n2.nbrs = n2.nbrs.filter((x) => x.to !== 0).concat({ to: e1.to, length, support });
    root.nbrs = [];
    root.label = '__dissolved__';
  }
  return g;
}

/** Builds a rooted tree from the graph by placing a NEW root on edge (a,b) at `fraction` of the way from a to b. */
function fromGraphOnEdge(g: GNode[], a: number, b: number, fraction: number): Tree {
  const edge = (g[a] as GNode).nbrs.find((x) => x.to === b);
  if (!edge) throw new BioError('invalid-tree', 'That branch does not exist.');
  const build = (id: number, from: number, length: number | undefined, support: number | undefined): TreeNode => {
    const gn = g[id] as GNode;
    const node: TreeNode = { children: gn.nbrs.filter((x) => x.to !== from).map((x) => build(x.to, id, x.length, x.support)) };
    if (gn.name !== undefined) node.name = gn.name;
    if (gn.label !== undefined && gn.label !== '__dissolved__') node.label = gn.label;
    if (length !== undefined) node.length = length;
    if (support !== undefined && node.children.length > 0) node.support = support;
    return node;
  };
  const la = edge.length === undefined ? undefined : edge.length * fraction;
  const lb = edge.length === undefined ? undefined : edge.length * (1 - fraction);
  return { root: { children: [build(a, b, la, edge.support), build(b, a, lb, edge.support)] } };
}

/** Graph id of the node with the given pre-order index (ids follow the same pre-order traversal). */
function graphEdgeAbove(t: Tree, index: number): { g: GNode[]; a: number; b: number } {
  const g = toGraph(t);
  const nodes = preorder(t);
  const node = nodes[index];
  if (!node || index === 0) throw new BioError('invalid-tree', 'Choose a branch below the root to re-root on.');
  // parent of the node: find the pre-order parent by scanning
  const parentOf = new Map<TreeNode, number>();
  nodes.forEach((n, k) => n.children.forEach((c) => parentOf.set(c, k)));
  const parent = parentOf.get(node);
  if (parent === undefined) throw new BioError('invalid-tree', 'The node has no parent.');
  return { g, a: parent, b: index };
}

/**
 * Re-roots on the branch above the node with pre-order index `index`, putting the root at `fraction` (0..1) of the way
 * from the parent to the node (default: the middle). Unrooted splits and total tree length are preserved. Support values
 * belong to branches, so a split branch gives the same support to both halves.
 */
export function rerootAbove(t: Tree, index: number, fraction = 0.5): Tree {
  const nodes = preorder(t);
  const node = nodes[index];
  const root = t.root;
  // If the node hangs directly off a degree-2 root, its edge was merged with the sibling edge: use the merged edge.
  if (root.children.length === 2 && node && root.children.includes(node)) {
    const sib = root.children.find((c) => c !== node) as TreeNode; // safe: the root has two distinct children
    const g = toGraph(t);
    const na = nodes.indexOf(node);
    const nb = nodes.indexOf(sib);
    const f = fraction; // distance from `node` side
    return fromGraphOnEdge(g, na, nb, f);
  }
  const { g, a, b } = graphEdgeAbove(t, index);
  return fromGraphOnEdge(g, a, b, fraction);
}

/** Re-roots on the branch leading to the named leaf (outgroup rooting): the root goes in the middle of that branch. */
export function rerootAtLeaf(t: Tree, leafName: string): Tree {
  const idx = preorder(t).findIndex((n) => isLeaf(n) && n.name === leafName);
  if (idx < 0) throw new BioError('invalid-tree', `No leaf named "${leafName}".`);
  return rerootAbove(t, idx, 0.5);
}

/** Path distance between every pair of leaves (undirected, using branch lengths; missing = 0). */
export function leafDistances(t: Tree): { names: string[]; dist: number[][] } {
  const g = toGraph(t);
  const leaves = g.map((n, id) => ({ n, id })).filter(({ n }) => n.name !== undefined && n.nbrs.length === 1).map(({ id }) => id);
  const names = leaves.map((id) => (g[id] as GNode).name as string); // safe: filtered to named nodes
  const dist = leaves.map((src) => {
    const d = new Map<number, number>([[src, 0]]);
    const stack = [src];
    while (stack.length > 0) {
      const u = stack.pop() as number; // safe: loop guard
      for (const e of (g[u] as GNode).nbrs) if (!d.has(e.to)) { d.set(e.to, (d.get(u) as number) + (e.length ?? 0)); stack.push(e.to); }
    }
    return leaves.map((l) => d.get(l) ?? 0);
  });
  return { names, dist };
}

/**
 * Midpoint rooting: the root goes at the middle of the longest leaf-to-leaf path. Ties between equally long paths are
 * broken by the lexicographically smallest (name A, name B) pair. Assumes non-negative branch lengths.
 */
export function midpointRoot(t: Tree): Tree {
  assertValidLeaves(t);
  const { names, dist } = leafDistances(t);
  let best = -Infinity;
  let pair: [number, number] = [0, 1];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const d = (dist[i] as number[])[j] as number; // safe: in range
    const [ni, nj] = [names[i] as string, names[j] as string];
    const key: [string, string] = ni < nj ? [ni, nj] : [nj, ni];
    const cur: [string, string] = (() => { const [pi, pj] = pair; const a = names[pi] as string; const b = names[pj] as string; return a < b ? [a, b] : [b, a]; })();
    if (d > best + 1e-12 || (Math.abs(d - best) <= 1e-12 && (key[0] < cur[0] || (key[0] === cur[0] && key[1] < cur[1])))) { best = d; pair = [i, j]; }
  }
  const g = toGraph(t);
  const idOf = (name: string): number => g.findIndex((n) => n.name === name);
  const src = idOf(names[pair[0]] as string);
  const dst = idOf(names[pair[1]] as string);
  // DFS from src recording parents, then walk the path to dst.
  const parent = new Map<number, number>([[src, -1]]);
  const stack = [src];
  while (stack.length > 0) {
    const u = stack.pop() as number; // safe: loop guard
    for (const e of (g[u] as GNode).nbrs) if (!parent.has(e.to)) { parent.set(e.to, u); stack.push(e.to); }
  }
  const path: number[] = [];
  for (let v = dst; v !== -1; v = parent.get(v) as number) path.push(v); // safe: every node was reached
  path.reverse(); // src ... dst
  const half = best / 2;
  let cum = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    const u = path[k] as number; const v = path[k + 1] as number; // safe: k+1 < length
    const len = ((g[u] as GNode).nbrs.find((x) => x.to === v) as GNode['nbrs'][number]).length ?? 0; // safe: consecutive path nodes are neighbours
    if (cum + len >= half - 1e-12) return fromGraphOnEdge(g, u, v, len === 0 ? 0.5 : Math.min(1, Math.max(0, (half - cum) / len)));
    cum += len;
  }
  const u = path[path.length - 2] as number; const v = path[path.length - 1] as number; // safe: at least 2 leaves
  return fromGraphOnEdge(g, u, v, 1);
}

/** Sets node.support from a map of split key -> percent (internal, non-root nodes only). Returns a new tree. */
export function annotateSupport(t: Tree, percentByKey: ReadonlyMap<string, number>): Tree {
  const c = cloneTree(t);
  const all = leafNames(c);
  for (const { node, leaves } of cladeSets(c)) {
    if (node === c.root || isLeaf(node)) continue;
    const key = cladeKey(leaves, all);
    const v = percentByKey.get(key);
    if (v !== undefined) node.support = v; else delete node.support;
  }
  return c;
}
