// The few tree helpers the UI needs for drawing and display (traversal only; building, rooting and comparing trees happens in Rust).
import type { Tree, TreeNode } from '../shared/types';

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
