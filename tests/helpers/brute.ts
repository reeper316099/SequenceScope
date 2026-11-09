// Brute-force oracle: ENUMERATES every possible alignment (no DP, no memoisation) and keeps the best score.
// Used to prove the DP is exact on tiny inputs. Scores follow the documented convention independently of pairwise.ts:
// substitution for aligned pairs; a gap run of length k costs open + (k-1)*extend; a switch between the two gap rows
// starts a new run.
import type { AlignMode } from '../../src/shared/types';
import type { CompiledScoring } from '../../src/bio/scoring';

/** Best global score over ALL alignments of a and b (explicit recursion over every column choice). */
export function bruteGlobal(a: string, b: string, sc: CompiledScoring): number {
  let best = -Infinity;
  // last: 0 = none/aligned pair, 1 = last column was a gap in B (A residue alone), 2 = gap in A
  const rec = (i: number, j: number, last: number, acc: number): void => {
    if (i === a.length && j === b.length) { if (acc > best) best = acc; return; }
    if (i < a.length && j < b.length) rec(i + 1, j + 1, 0, acc + sc.charScore(a.charAt(i), b.charAt(j)));
    if (i < a.length) rec(i + 1, j, 1, acc - (last === 1 ? sc.gapExtend : sc.gapOpen));
    if (j < b.length) rec(i, j + 1, 2, acc - (last === 2 ? sc.gapExtend : sc.gapOpen));
  };
  rec(0, 0, 0, 0);
  return best;
}

/** Best local score: maximum over every pair of substrings (including empty) of the best global score, and 0. */
export function bruteLocal(a: string, b: string, sc: CompiledScoring): number {
  let best = 0;
  for (let i1 = 0; i1 <= a.length; i1++) for (let i2 = i1; i2 <= a.length; i2++) {
    for (let j1 = 0; j1 <= b.length; j1++) for (let j2 = j1; j2 <= b.length; j2++) {
      const s = bruteGlobal(a.slice(i1, i2), b.slice(j1, j2), sc);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Brute-force optimum for the given mode. */
export function bruteForce(a: string, b: string, mode: AlignMode, sc: CompiledScoring): number {
  return mode === 'global' ? bruteGlobal(a, b, sc) : bruteLocal(a, b, sc);
}
