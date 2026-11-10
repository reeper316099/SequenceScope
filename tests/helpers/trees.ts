// Small tree builders for the UI tests, written independently of the app (no algorithm from src/ is used to make the inputs).
import type { Tree, TreeNode } from '../../src/shared/types';
import { parseLite } from '../bridge/newick';
import type { LiteNode } from '../bridge/newick';

/** A Newick string as the app's Tree shape (internal names stay unset, missing lengths stay unset). */
export function nw(text: string): Tree {
  const conv = (n: LiteNode): TreeNode => {
    const out: TreeNode = { children: n.children.map(conv) };
    if (n.name !== '') out.name = n.name;
    if (n.length !== null) out.length = n.length;
    return out;
  };
  return { root: conv(parseLite(text)) };
}
