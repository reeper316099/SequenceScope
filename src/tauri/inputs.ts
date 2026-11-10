// Deterministic test inputs shared by the parity and benchmark runs. They come from the project's own seeded PRNG
// (src/bio/rng.ts), and the Rust benchmark (crates/sequencescope-core/examples/bench.rs) generates the SAME sequences
// with its port of that PRNG, so TypeScript and Rust are timed on identical inputs.
import { createRng } from '../bio/rng';
import type { AlignMode, AlignRequest, Alphabet, GapModel, ScoringSpec, ShuffleRequest } from '../shared/types';

export const DNA = 'ACGT';
export const PROTEIN = 'ACDEFGHIKLMNPQRSTVWY';

/** A random sequence of `len` letters drawn from `letters` with a seeded generator. */
export function randomSeq(seed: number, len: number, letters: string): string {
  const rng = createRng(seed);
  let s = '';
  for (let i = 0; i < len; i++) s += letters.charAt(rng.nextInt(letters.length));
  return s;
}

export const dnaScoring = (gaps: GapModel): ScoringSpec => ({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps });
export const blosum62 = (gaps: GapModel): ScoringSpec => ({ substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps });

/** Builds an alignment request the way the UI does (enumeration cap 1000). */
export function alignRequest(a: string, b: string, alphabet: Alphabet, mode: AlignMode, scoring: ScoringSpec, enumerateCap = 1000): AlignRequest {
  return { type: 'align', a, b, alphabet, mode, scoring, enumerateCap };
}

/** The benchmark scenarios: small, medium, and the largest sizes the app allows, plus the shuffle test. */
export const SCENARIOS = {
  small: () => alignRequest(randomSeq(11, 200, DNA), randomSeq(12, 200, DNA), 'dna', 'global', dnaScoring({ kind: 'affine', open: 5, extend: 1 })),
  medium: () => alignRequest(randomSeq(21, 1000, PROTEIN), randomSeq(22, 1000, PROTEIN), 'protein', 'global', blosum62({ kind: 'affine', open: 11, extend: 1 })),
  largestProteinAffine: () => alignRequest(randomSeq(31, 5000, PROTEIN), randomSeq(32, 5000, PROTEIN), 'protein', 'global', blosum62({ kind: 'affine', open: 11, extend: 1 })),
  largestDnaLinear: () => alignRequest(randomSeq(33, 5000, DNA), randomSeq(34, 5000, DNA), 'dna', 'global', dnaScoring({ kind: 'linear', gap: 4 })),
  shuffle: (): ShuffleRequest => ({ type: 'shuffle', a: randomSeq(41, 300, DNA), b: randomSeq(42, 300, DNA), alphabet: 'dna', mode: 'local', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }), shuffles: 1000, seed: 7 }),
} as const;
