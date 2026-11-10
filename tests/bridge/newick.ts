// A tiny independent Newick reader for the tests (names, lengths, unrooted splits, Robinson–Foulds, leaf-to-leaf distances).
// It is deliberately NOT the app's parser: the exported files are checked by code that shares nothing with either backend.
export interface LiteNode { name: string; length: number | null; children: LiteNode[] }

/** Parses one Newick tree (no comments; quoted names are not needed by these tests). */
export function parseLite(text: string): LiteNode {
  let i = 0;
  const s = text.trim();
  const node = (): LiteNode => {
    const n: LiteNode = { name: '', length: null, children: [] };
    if (s[i] === '(') {
      i++;
      for (;;) {
        n.children.push(node());
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') { i++; break; }
        throw new Error(`bad Newick at ${i}`);
      }
    }
    const start = i;
    while (i < s.length && !':,();'.includes(s[i] as string)) i++;
    n.name = s.slice(start, i);
    if (s[i] === ':') {
      i++;
      const b = i;
      while (i < s.length && !',();'.includes(s[i] as string)) i++;
      n.length = Number(s.slice(b, i));
    }
    return n;
  };
  const root = node();
  if (s[i] !== ';') throw new Error('Newick must end with ;');
  return root;
}

/** Leaf names in order. */
export function leaves(n: LiteNode): string[] {
  return n.children.length === 0 ? [n.name] : n.children.flatMap(leaves);
}

/** The non-trivial unrooted splits, each written as the sorted leaf names of the side that does not contain the first leaf. */
export function splits(root: LiteNode): Set<string> {
  const all = leaves(root).sort();
  const first = all[0] as string;
  const out = new Set<string>();
  const walk = (n: LiteNode): string[] => {
    const below = n.children.length === 0 ? [n.name] : n.children.flatMap(walk);
    if (n !== root && below.length >= 2 && below.length <= all.length - 2) {
      const side = below.includes(first) ? all.filter((x) => !below.includes(x)) : below;
      out.add([...side].sort().join('|'));
    }
    return below;
  };
  walk(root);
  return out;
}

/** Robinson–Foulds distance between two trees on the same leaves (unrooted). */
export function robinsonFoulds(a: LiteNode, b: LiteNode): number {
  const sa = splits(a); const sb = splits(b);
  let d = 0;
  for (const x of sa) if (!sb.has(x)) d++;
  for (const x of sb) if (!sa.has(x)) d++;
  return d;
}

/** Longest leaf-to-leaf path length, and the largest root-to-leaf depth. */
export function longestPath(root: LiteNode): number {
  let best = 0;
  const walk = (n: LiteNode): number => {
    if (n.children.length === 0) return 0;
    const depths = n.children.map((c) => walk(c) + (c.length ?? 0)).sort((x, y) => y - x);
    best = Math.max(best, (depths[0] ?? 0) + (depths[1] ?? 0));
    return depths[0] ?? 0;
  };
  walk(root);
  return best;
}

/** Largest distance from the root to any leaf. */
export function maxDepth(root: LiteNode): number {
  const walk = (n: LiteNode, d: number): number => (n.children.length === 0 ? d : Math.max(...n.children.map((c) => walk(c, d + (c.length ?? 0)))));
  return walk(root, 0);
}
