// Result and request shapes shared by the UI and the Rust backend (types only; no code runs here). They describe what the Rust core
// returns (see crates/sequencescope-core and src-tauri/src/dto.rs); moved here from the TypeScript algorithms in Checkpoint 6.
import type { Alphabet, DistanceModel, GapPolicy, ScoringSpec, Sequence, Tree } from './types';

export interface Detection {
  alphabet: Alphabet | 'unknown';
  confidence: 'high' | 'low';
  reason: string;
}

export interface ColumnStat {
  gaps: number;
  residues: number;
  counts: Record<string, number>;
  top: string; // most common residue ('' if none)
  identity: number;
  entropy: number;
  conservation: number;
  consensus: string;
}

export interface Conservation {
  columns: ColumnStat[];
  consensus: string;
  meanIdentity: number;
  /** Columns where every sequence has the same residue and no gaps. */
  fullyConserved: number;
}

export type TreeMethod = 'upgma' | 'nj';

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

export type FastaIssueCode =
  | 'no-records' | 'no-header' | 'empty-header' | 'empty-record' | 'duplicate-id' | 'invalid-characters'
  | 'digits-removed' | 'whitespace-removed' | 'gaps-normalized' | 'comment-line' | 'undetected-alphabet' | 'low-confidence-alphabet';

export interface FastaIssue {
  severity: 'error' | 'warning' | 'info';
  code: FastaIssueCode;
  recordIndex: number | null; // 0-based index of the record, or null for whole-input issues
  recordId: string | null;
  message: string;
  positions?: number[]; // 1-based residue positions (for invalid characters)
}

export interface ParsedFasta {
  records: Sequence[];
  issues: FastaIssue[];
}

export interface SubstitutionMatrix {
  name: string;
  letters: string;
  sha256: string;
  citation: string;
  source: string;
  /** Score for two residue letters, or undefined if either is not in the matrix. */
  get(a: string, b: string): number | undefined;
}

export type GuideMethod = 'upgma' | 'nj';

export interface MsaStep {
  /** Row ids of the merged profile (left group first, then right group). */
  ids: string[];
  leftIds: string[];
  rightIds: string[];
  rows: string[];
  /** Optimal profile-profile alignment score of this merge. */
  score: number;
}

export interface MsaResult {
  ids: string[];
  rows: string[];
  alphabet: Alphabet;
  guideTree: Tree;
  guide: GuideMethod;
  steps: MsaStep[];
  /** Sum over all sequence pairs of the pairwise score of their projected alignment (gap-gap columns removed). */
  sumOfPairs: number;
}

export interface NjJoinStep {
  kind: 'join';
  step: number;
  active: number[];
  matrix: number[][];
  /** r_i for each active node. */
  sums: number[];
  /** Q matrix (diagonal entries are 0 and not candidates). */
  q: number[][];
  i: number;
  j: number;
  a: number;
  b: number;
  distance: number;
  qMin: number;
  newId: number;
  branchA: number;
  branchB: number;
  others: number[];
  newRow: number[];
}

export interface NjFinalStep {
  kind: 'final';
  step: number;
  active: number[];
  matrix: number[][];
  ids: [number, number, number];
  branches: [number, number, number];
  newId: number;
}

export type NjStep = NjJoinStep | NjFinalStep;

export interface NjResult {
  tree: Tree;
  steps: NjStep[];
  names: string[];
}

export interface UpgmaStep {
  step: number;
  /** Cluster ids in scan order before this merge (leaves are 0..n-1, merged clusters n, n+1, ...). */
  active: number[];
  /** Distances among the active clusters (same order). */
  matrix: number[][];
  /** Chosen pair as indices into `active`, and as cluster ids. */
  i: number;
  j: number;
  a: number;
  b: number;
  distance: number;
  newId: number;
  /** New node height = distance / 2, and the old heights of the two clusters. */
  height: number;
  heightA: number;
  heightB: number;
  /** Branch lengths from the new node to its two children (= height - child height). */
  branchA: number;
  branchB: number;
  sizeA: number;
  sizeB: number;
  /** Distance from the new cluster to each remaining cluster (ids in `others`). */
  others: number[];
  newRow: number[];
}

export interface UpgmaResult {
  tree: Tree;
  steps: UpgmaStep[];
  names: string[];
}

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

/** Compute a distance matrix either from an alignment (columns) or by aligning every pair. */
export type DistancesRequest =
  | { type: 'distances'; mode: 'aligned'; names: string[]; rows: string[]; alphabet: Alphabet; model: DistanceModel; gapPolicy: GapPolicy }
  | { type: 'distances'; mode: 'unaligned'; seqs: Sequence[]; alphabet: Alphabet; model: DistanceModel; gapPolicy: GapPolicy; scoring: ScoringSpec };

export type BootstrapRequest = { type: 'bootstrap'; input: BootstrapInput };

/** Progressive multiple alignment request. */
export type MsaRequest = { type: 'msa'; seqs: Sequence[]; alphabet: Alphabet; scoring: ScoringSpec; guide: GuideMethod };
