// Bootstrap support for ALIGNED input (ALGORITHMS.md section 10): resample alignment COLUMNS with replacement (same
// number of columns), recompute distances with the same model and gap policy, rebuild the tree, and count how often each
// split of the reference tree reappears. Support = count / replicates * 100.
//
// A bootstrap value measures STABILITY under resampling, NOT the probability that a branch is true. It needs columns, so it
// cannot be computed from pairwise distances alone.
//
// Reproducibility: replicate r uses its own PRNG stream derived from (seed, r), so results do not depend on how replicates
// are split across workers; `bootstrapRange` computes any slice and `mergeBootstrap` combines slices exactly.
import type { Alphabet, DistanceModel, GapPolicy, Tree } from '../shared/types';
import { assertModel, distanceMatrixFromCodes, encodeAligned, MAX_BOOTSTRAP_WORK, MAX_TREE_TAXA, unusablePairs } from './distance';
import { BioError } from './errors';
import { neighborJoining } from './nj';
import { createRng, deriveSeed } from './rng';
import { annotateSupport, nontrivialSplits } from './tree';
import { upgma } from './upgma';

export type TreeMethod = 'upgma' | 'nj';
export const MAX_REPLICATES = 1000;
export const MAX_COLUMNS = 50_000;

export interface BootstrapInput {
  names: string[];
  rows: string[]; // aligned, equal length
  alphabet: Alphabet;
  model: DistanceModel;
  gapPolicy: GapPolicy;
  method: TreeMethod;
  replicates: number;
  seed: number;
}

export interface BootstrapCounts {
  /** split key -> number of replicates (in this slice) containing it. */
  counts: Map<string, number>;
  /** replicates in this slice whose distance matrix could not be turned into a tree. */
  failed: number;
  /** replicates covered by this slice. */
  done: number;
}

export interface BootstrapSplitSupport {
  leaves: string[];
  count: number;
  percent: number;
}

export interface BootstrapResult {
  referenceTree: Tree; // with support values attached
  supports: BootstrapSplitSupport[]; // one entry per non-trivial split of the reference tree
  replicates: number;
  seed: number;
  failedReplicates: number;
  method: TreeMethod;
  model: DistanceModel;
  gapPolicy: GapPolicy;
}

/** Checks sizes and model before any work starts. */
export function validateBootstrapInput(inp: BootstrapInput): void {
  assertModel(inp.model, inp.alphabet);
  if (inp.names.length < 3) throw new BioError('too-few-sequences', `Bootstrap needs at least 3 sequences (got ${inp.names.length}).`);
  if (inp.names.length > MAX_TREE_TAXA) throw new BioError('too-large', `At most ${MAX_TREE_TAXA} sequences are supported.`);
  if (new Set(inp.names).size !== inp.names.length) throw new BioError('duplicate-names', 'Sequence names must be unique.');
  const len = inp.rows[0]?.length ?? 0;
  if (len === 0) throw new BioError('not-aligned', 'The alignment has no columns.');
  inp.rows.forEach((r, k) => { if (r.length !== len) throw new BioError('not-aligned', `Sequence "${inp.names[k] ?? k}" has ${r.length} columns but the first has ${len}. Bootstrap needs an alignment (all rows the same length) because it resamples columns.`); });
  if (len > MAX_COLUMNS) throw new BioError('too-large', `At most ${MAX_COLUMNS.toLocaleString('en-US')} alignment columns are supported (got ${len.toLocaleString('en-US')}).`);
  if (!Number.isInteger(inp.replicates) || inp.replicates < 1 || inp.replicates > MAX_REPLICATES) throw new BioError('invalid-argument', `Replicates must be a whole number from 1 to ${MAX_REPLICATES}.`);
  const work = inp.replicates * ((inp.names.length * (inp.names.length - 1)) / 2) * len;
  if (work > MAX_BOOTSTRAP_WORK) throw new BioError('too-large', `This bootstrap needs about ${(work / 1e9).toFixed(1)} billion column comparisons; the limit is ${MAX_BOOTSTRAP_WORK / 1e9} billion. Use fewer replicates or fewer sequences.`);
}

/** Builds the tree for a given matrix with the chosen method. */
function build(method: TreeMethod, names: string[], codes: Uint8Array[], model: DistanceModel, policy: GapPolicy, weights?: Int32Array): Tree | null {
  const m = distanceMatrixFromCodes(names, codes, model, policy, weights);
  if (unusablePairs(m).length > 0) return null;
  return method === 'nj' ? neighborJoining(m).tree : upgma(m).tree;
}

/** The reference tree from the original (unresampled) alignment. */
export function referenceTree(inp: BootstrapInput): Tree {
  validateBootstrapInput(inp);
  const codes = inp.rows.map((r) => encodeAligned(r, inp.alphabet));
  const t = build(inp.method, inp.names, codes, inp.model, inp.gapPolicy);
  if (!t) throw new BioError('saturated-distances', 'The original alignment has pairs with no usable distance (saturated or no comparable sites), so no reference tree can be built. Try the p-distance or another gap policy.');
  return t;
}

/** Column multiplicities for replicate r: how many times each column was drawn (sums to the number of columns). */
export function replicateWeights(columns: number, seed: number, r: number): Int32Array {
  const rng = createRng(deriveSeed(seed, r));
  const w = new Int32Array(columns);
  for (let k = 0; k < columns; k++) { const c = rng.nextInt(columns); w[c] = (w[c] as number) + 1; } // safe: c < columns
  return w;
}

/** Computes replicates [from, to) and returns the split counts of that slice. Slices merge exactly (see mergeBootstrap). */
export function bootstrapRange(inp: BootstrapInput, from: number, to: number, hooks: { onProgress?: (done: number) => void; shouldCancel?: () => boolean } = {}): BootstrapCounts | null {
  validateBootstrapInput(inp);
  const codes = inp.rows.map((r) => encodeAligned(r, inp.alphabet));
  const columns = codes[0]?.length ?? 0;
  const counts = new Map<string, number>();
  let failed = 0;
  for (let r = from; r < to; r++) {
    if (hooks.shouldCancel?.() === true) return null;
    const t = build(inp.method, inp.names, codes, inp.model, inp.gapPolicy, replicateWeights(columns, inp.seed, r));
    if (t === null) failed++;
    else for (const key of nontrivialSplits(t).splits.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
    hooks.onProgress?.(r - from + 1);
  }
  return { counts, failed, done: to - from };
}

/** Adds slice results together (order does not matter). */
export function mergeBootstrap(parts: readonly BootstrapCounts[]): BootstrapCounts {
  const counts = new Map<string, number>();
  let failed = 0;
  let done = 0;
  for (const p of parts) {
    failed += p.failed; done += p.done;
    for (const [k, v] of p.counts) counts.set(k, (counts.get(k) ?? 0) + v);
  }
  return { counts, failed, done };
}

/** Turns merged counts into the final result: support percentages on the reference tree's splits. */
export function finishBootstrap(inp: BootstrapInput, counts: BootstrapCounts): BootstrapResult {
  const ref = referenceTree(inp);
  const refSplits = nontrivialSplits(ref).splits;
  const percentByKey = new Map<string, number>();
  const supports: BootstrapSplitSupport[] = [];
  for (const [key, leaves] of refSplits) {
    const count = counts.counts.get(key) ?? 0;
    const percent = (count / inp.replicates) * 100; // failed replicates count as NOT containing the split
    percentByKey.set(key, percent);
    supports.push({ leaves, count, percent });
  }
  return { referenceTree: annotateSupport(ref, percentByKey), supports, replicates: inp.replicates, seed: inp.seed, failedReplicates: counts.failed, method: inp.method, model: inp.model, gapPolicy: inp.gapPolicy };
}

/** Full bootstrap in one call (single worker). Returns null if cancelled. */
export function bootstrap(inp: BootstrapInput, hooks: { onProgress?: (fraction: number) => void; shouldCancel?: () => boolean } = {}): BootstrapResult | null {
  validateBootstrapInput(inp);
  const part = bootstrapRange(inp, 0, inp.replicates, { onProgress: (d) => hooks.onProgress?.(d / inp.replicates), shouldCancel: hooks.shouldCancel });
  return part === null ? null : finishBootstrap(inp, part);
}
