// Robinson-Foulds distance between two trees on the same leaves, viewed as UNROOTED (ALGORITHMS.md section 9).
import type { Tree } from '../shared/types';
import { BioError } from './errors';
import { nontrivialSplits } from './tree';

export interface RfResult {
  /** |S1 Δ S2|: number of non-trivial splits present in exactly one tree. */
  distance: number;
  /** Largest possible RF for these trees: |S1| + |S2|. */
  max: number;
  shared: string[][];
  onlyInA: string[][];
  onlyInB: string[][];
  leafCount: number;
}

/** Compares two trees; throws if their leaf sets differ. */
export function robinsonFoulds(a: Tree, b: Tree): RfResult {
  const sa = nontrivialSplits(a);
  const sb = nontrivialSplits(b);
  if (sa.leaves.length !== sb.leaves.length || sa.leaves.some((l, k) => l !== sb.leaves[k])) {
    const onlyA = sa.leaves.filter((l) => !sb.leaves.includes(l));
    const onlyB = sb.leaves.filter((l) => !sa.leaves.includes(l));
    throw new BioError('invalid-tree', `The trees do not have the same leaves. Only in the first: ${onlyA.slice(0, 5).join(', ') || '—'}; only in the second: ${onlyB.slice(0, 5).join(', ') || '—'}.`);
  }
  const shared: string[][] = [];
  const onlyInA: string[][] = [];
  const onlyInB: string[][] = [];
  for (const [k, v] of sa.splits) (sb.splits.has(k) ? shared : onlyInA).push(v);
  for (const [k, v] of sb.splits) if (!sa.splits.has(k)) onlyInB.push(v);
  return { distance: onlyInA.length + onlyInB.length, max: sa.splits.size + sb.splits.size, shared, onlyInA, onlyInB, leafCount: sa.leaves.length };
}
