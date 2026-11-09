// Pure tree layouts for the SVG viewer: rectangular (phylogram / cladogram) and radial (equal-angle, for unrooted trees).
// Coordinates are abstract (branch-length units); the viewer scales them. Negative branch lengths are drawn AS GIVEN.
import type { Tree, TreeNode } from '../shared/types';

export interface LayoutNode {
  /** Pre-order index in the whole tree (stable between layouts of the same tree). */
  index: number;
  /** Clade key: the sorted leaf names joined by "|" (stable across collapse/expand and re-layout). */
  key: string;
  node: TreeNode;
  x: number;
  y: number;
  /** Radial layout only: angle in radians (0 = right). */
  angle: number;
  isLeaf: boolean;
  /** True if this internal node is currently collapsed and drawn as one block. */
  collapsed: boolean;
  /** Number of taxa below (1 for a leaf). */
  taxa: number;
  parent: number | null;
  label: string;
  /** The branch above this node has a negative length. */
  negative: boolean;
  /** Indices (into `nodes`) of visible children. */
  children: number[];
}

export interface Layout {
  nodes: LayoutNode[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  leafRows: number;
}

export interface LayoutOptions {
  /** Ignore branch lengths: all leaves line up on the right (rectangular) / equal radii steps (radial). */
  cladogram: boolean;
  /** Keys of clades drawn collapsed. */
  collapsed: ReadonlySet<string>;
}

/** The key of a clade: sorted leaf names joined by "|". */
export function cladeNodeKey(leaves: string[]): string {
  return [...leaves].sort().join('|');
}

interface Raw {
  node: TreeNode;
  index: number;
  key: string;
  leaves: string[];
  parent: number | null;
  kids: number[]; // raw indices
  height: number;
}

/** Walks the tree once in pre-order, collecting parent links, leaf lists, and heights (edges to the deepest leaf). */
function collect(tree: Tree): Raw[] {
  const raw: Raw[] = [];
  const walk = (n: TreeNode, parent: number | null): number => {
    const index = raw.length;
    const r: Raw = { node: n, index, key: '', leaves: [], parent, kids: [], height: 0 };
    raw.push(r);
    if (n.children.length === 0) { r.leaves = [n.name ?? '']; r.height = 0; }
    else {
      for (const c of n.children) {
        const ci = walk(c, index);
        r.kids.push(ci);
        const cr = raw[ci] as Raw; // safe: just created
        r.leaves.push(...cr.leaves);
        r.height = Math.max(r.height, cr.height + 1);
      }
    }
    r.key = cladeNodeKey(r.leaves);
    return index;
  };
  walk(tree.root, null);
  return raw;
}

/** Shared pre-pass: which raw nodes are visible, and the cumulative x (length or depth) of each. */
function prepare(tree: Tree, opts: LayoutOptions): { raw: Raw[]; visible: boolean[]; collapsedAt: boolean[]; xs: number[] } {
  const raw = collect(tree);
  const visible = new Array<boolean>(raw.length).fill(false);
  const collapsedAt = new Array<boolean>(raw.length).fill(false);
  const xs = new Array<number>(raw.length).fill(0);
  const rootHeight = (raw[0] as Raw).height;
  const show = (i: number): void => {
    const r = raw[i] as Raw;
    visible[i] = true;
    if (r.kids.length > 0 && opts.collapsed.has(r.key) && r.parent !== null) { collapsedAt[i] = true; return; }
    for (const k of r.kids) {
      const kr = raw[k] as Raw;
      xs[k] = opts.cladogram ? rootHeight - kr.height : (xs[i] as number) + (kr.node.length ?? 0);
      show(k);
    }
  };
  xs[0] = 0;
  show(0);
  return { raw, visible, collapsedAt, xs };
}

/** Builds LayoutNode objects for visible raw nodes (positions are filled in by the caller). */
function makeNodes(raw: Raw[], visible: boolean[], collapsedAt: boolean[], xs: number[]): { nodes: LayoutNode[]; map: Map<number, number> } {
  const map = new Map<number, number>();
  const nodes: LayoutNode[] = [];
  raw.forEach((r, i) => {
    if (!visible[i]) return;
    map.set(i, nodes.length);
    const isLeaf = r.kids.length === 0;
    const collapsed = collapsedAt[i] === true;
    const label = isLeaf ? (r.node.name ?? '') : collapsed ? `${r.node.label ?? 'clade'} (${r.leaves.length} taxa)` : (r.node.label ?? '');
    nodes.push({ index: r.index, key: r.key, node: r.node, x: xs[i] as number, y: 0, angle: 0, isLeaf, collapsed, taxa: r.leaves.length, parent: null, label, negative: (r.node.length ?? 0) < 0, children: [] });
  });
  nodes.forEach((ln) => {
    const r = raw[ln.index] as Raw;
    ln.parent = r.parent === null ? null : (map.get(r.parent) ?? null);
    if (!collapsedAt[ln.index]) ln.children = r.kids.map((k) => map.get(k)).filter((v): v is number => v !== undefined);
  });
  return { nodes, map };
}

/** Rectangular layout: x = distance from the root, y = leaf rows (internal nodes centred on their children). */
export function layoutRectangular(tree: Tree, opts: LayoutOptions): Layout {
  const { raw, visible, collapsedAt, xs } = prepare(tree, opts);
  const { nodes } = makeNodes(raw, visible, collapsedAt, xs);
  let row = 0;
  const place = (i: number): number => {
    const n = nodes[i] as LayoutNode;
    if (n.children.length === 0) { n.y = row++; return n.y; }
    const ys = n.children.map(place);
    n.y = ((ys[0] as number) + (ys[ys.length - 1] as number)) / 2;
    return n.y;
  };
  place(0);
  const xsAll = nodes.map((n) => n.x);
  return { nodes, xMin: Math.min(...xsAll), xMax: Math.max(...xsAll), yMin: 0, yMax: Math.max(0, row - 1), leafRows: row };
}

/** Radial (equal-angle) layout: each leaf gets an equal slice of the circle; the root is at the centre. */
export function layoutRadial(tree: Tree, opts: LayoutOptions): Layout {
  const { raw, visible, collapsedAt, xs } = prepare(tree, opts);
  const { nodes } = makeNodes(raw, visible, collapsedAt, xs);
  const weight = (i: number): number => { const n = nodes[i] as LayoutNode; return n.children.length === 0 ? 1 : n.children.reduce((s, c) => s + weight(c), 0); };
  const total = weight(0);
  const assign = (i: number, a0: number, a1: number): void => {
    const n = nodes[i] as LayoutNode;
    n.angle = (a0 + a1) / 2;
    n.x = (xs[n.index] as number) * Math.cos(n.angle); // x holds the cartesian x here; radius is recomputed below
    n.y = (xs[n.index] as number) * Math.sin(n.angle);
    let cur = a0;
    for (const c of n.children) { const share = (weight(c) / weight(i)) * (a1 - a0); assign(c, cur, cur + share); cur += share; }
  };
  assign(0, 0, 2 * Math.PI);
  const root = nodes[0] as LayoutNode;
  root.x = 0; root.y = 0;
  void total;
  const xsAll = nodes.map((n) => n.x); const ysAll = nodes.map((n) => n.y);
  return { nodes, xMin: Math.min(...xsAll), xMax: Math.max(...xsAll), yMin: Math.min(...ysAll), yMax: Math.max(...ysAll), leafRows: nodes.filter((n) => n.children.length === 0).length };
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** Keyboard tree navigation over the visible nodes: Up/Down = previous/next visible node, Left = parent, Right = first child. */
export function navigate(layout: Layout, selected: number | null, key: NavKey): number | null {
  const list = layout.nodes;
  if (list.length === 0) return null;
  const pos = selected === null ? -1 : list.findIndex((n) => n.index === selected);
  if (pos < 0) return (list[0] as LayoutNode).index;
  const cur = list[pos] as LayoutNode;
  if (key === 'ArrowDown') return (list[Math.min(list.length - 1, pos + 1)] as LayoutNode).index;
  if (key === 'ArrowUp') return (list[Math.max(0, pos - 1)] as LayoutNode).index;
  if (key === 'ArrowLeft') return cur.parent === null ? cur.index : (list[cur.parent] as LayoutNode).index;
  const firstChild = cur.children[0];
  return firstChild === undefined ? cur.index : (list[firstChild] as LayoutNode).index;
}

/** Counts how many clades below a node are collapsed-able (internal, non-root). */
export function collapsibleKeys(tree: Tree): string[] {
  return collect(tree).filter((r) => r.kids.length > 0 && r.parent !== null).map((r) => r.key);
}
