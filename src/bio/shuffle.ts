// Shuffle-based significance check (ALGORITHMS.md section 12): shuffle sequence B (composition preserved), re-score,
// and compare the real score with the shuffled scores. All randomness comes from the seeded PRNG.
import type { AlignMode } from '../shared/types';
import { BioError } from './errors';
import { alignScoreOnly } from './pairwise';
import { createRng } from './rng';
import type { Rng } from './rng';
import type { CompiledScoring } from './scoring';

export const MAX_SHUFFLES = 5000;

/** Fisher-Yates shuffle of a string's characters using the seeded generator (unbiased via Rng.nextInt). */
export function shuffleResidues(rng: Rng, s: string): string {
  const arr = s.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = arr[i] as string; // safe: i and j are within 0..length-1
    arr[i] = arr[j] as string; // safe: j <= i
    arr[j] = tmp;
  }
  return arr.join('');
}

export interface ShuffleOptions {
  a: string;
  b: string;
  mode: AlignMode;
  scoring: CompiledScoring;
  shuffles: number;
  seed: number;
  /** Called after each shuffle with the completed fraction. */
  onProgress?: (fraction: number) => void;
  /** Polled between shuffles; return true to stop early. */
  shouldCancel?: () => boolean;
}

export type ShuffleResult =
  | {
      cancelled: false;
      seed: number;
      shuffles: number;
      realScore: number;
      scores: Int32Array;
      mean: number;
      sd: number; // sample standard deviation (n-1); 0 if all equal
      z: number | null; // null when sd is 0 (undefined, never NaN/Infinity)
      atLeastAsGood: number; // shuffled scores >= real score
      pValue: number; // (1 + atLeastAsGood) / (shuffles + 1): never exactly 0
    }
  | { cancelled: true; completed: number; seed: number };

/** Runs the shuffle test; deterministic for a given seed. */
export function runShuffleTest(opts: ShuffleOptions): ShuffleResult {
  if (!Number.isInteger(opts.shuffles) || opts.shuffles < 1 || opts.shuffles > MAX_SHUFFLES) {
    throw new BioError('invalid-argument', `Number of shuffles must be a whole number from 1 to ${MAX_SHUFFLES}.`);
  }
  const rng = createRng(opts.seed);
  const realScore = alignScoreOnly(opts.a, opts.b, opts.mode, opts.scoring);
  const scores = new Int32Array(opts.shuffles);
  for (let k = 0; k < opts.shuffles; k++) {
    if (opts.shouldCancel?.() === true) return { cancelled: true, completed: k, seed: opts.seed };
    scores[k] = alignScoreOnly(opts.a, shuffleResidues(rng, opts.b), opts.mode, opts.scoring);
    opts.onProgress?.((k + 1) / opts.shuffles);
  }
  let sum = 0;
  let atLeastAsGood = 0;
  for (const s of scores) { sum += s; if (s >= realScore) atLeastAsGood++; }
  const mean = sum / opts.shuffles;
  let ss = 0;
  for (const s of scores) ss += (s - mean) * (s - mean);
  const sd = opts.shuffles > 1 ? Math.sqrt(ss / (opts.shuffles - 1)) : 0;
  return {
    cancelled: false, seed: opts.seed, shuffles: opts.shuffles, realScore, scores, mean, sd,
    z: sd > 0 ? (realScore - mean) / sd : null,
    atLeastAsGood, pValue: (1 + atLeastAsGood) / (opts.shuffles + 1),
  };
}
