// Deterministic test inputs shared by the parity and benchmark runs. They come from the project's own seeded PRNG
// (src/bio/rng.ts), and the Rust benchmark (crates/sequencescope-core/examples/bench.rs) generates the SAME sequences
// with its port of that PRNG, so TypeScript and Rust are timed on identical inputs.
import { createRng } from '../bio/rng';
import type { BootstrapRequest, DistancesRequest, MsaRequest } from '../workers/protocol';
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

/** An alignment of `n` related rows: one random base row, each other row mutated at ~15% of sites (seeded; the Rust benchmark uses the same recipe). */
export function alignmentRows(seed: number, n: number, len: number, letters: string): string[] {
  const rng = createRng(seed);
  const base = Array.from({ length: len }, () => letters.charAt(rng.nextInt(letters.length)));
  return Array.from({ length: n }, () => base.map((c) => (rng.nextInt(100) < 15 ? letters.charAt(rng.nextInt(letters.length)) : c)).join(''));
}

/** Related unaligned sequences for the MSA benchmark: mutated copies of one base, each trimmed a little at both ends (same recipe in bench.rs). */
function msaSeqs(seed: number, n: number, len: number, letters: string, alphabet: Alphabet): { id: string; description: string; alphabet: Alphabet; residues: string }[] {
  return alignmentRows(seed, n, len, letters).map((r, i) => ({ id: `m${i}`, description: '', alphabet, residues: r.slice(i % 7, r.length - (i % 5)) }));
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
  distancesUnaligned: (): DistancesRequest => ({
    type: 'distances', mode: 'unaligned', alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }),
    seqs: alignmentRows(51, 30, 400, DNA).map((r, i) => ({ id: `s${i}`, description: '', alphabet: 'dna' as const, residues: r.replace(/-/g, '') })),
  }),
  bootstrapSmall: (): BootstrapRequest => ({ type: 'bootstrap', input: { names: Array.from({ length: 10 }, (_, i) => `t${i}`), rows: alignmentRows(61, 10, 1144, DNA), alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 100, seed: 2026 } }),
  bootstrapLarge: (): BootstrapRequest => ({ type: 'bootstrap', input: { names: Array.from({ length: 50 }, (_, i) => `t${i}`), rows: alignmentRows(62, 50, 3000, DNA), alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 100, seed: 2026 } }),
  msaSmall: (): MsaRequest => ({ type: 'msa', alphabet: 'protein', guide: 'upgma', scoring: blosum62({ kind: 'affine', open: 11, extend: 1 }), seqs: msaSeqs(101, 12, 300, PROTEIN, 'protein') }),
  msaLarge: (): MsaRequest => ({ type: 'msa', alphabet: 'dna', guide: 'nj', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }), seqs: msaSeqs(102, 40, 800, DNA, 'dna') }),
  shuffle: (): ShuffleRequest => ({ type: 'shuffle', a: randomSeq(41, 300, DNA), b: randomSeq(42, 300, DNA), alphabet: 'dna', mode: 'local', scoring: dnaScoring({ kind: 'affine', open: 5, extend: 1 }), shuffles: 1000, seed: 7 }),
} as const;
