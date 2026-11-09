// Message types for the Milestone B workers (distance matrices and bootstrap).
import type { BootstrapInput, BootstrapResult } from '../bio/bootstrap';
import type { GuideMethod, MsaResult } from '../bio/msa';
import type { Alphabet, DistanceMatrix, DistanceModel, GapPolicy, ScoringSpec, Sequence } from '../shared/types';

/** Compute a distance matrix either from an alignment (columns) or by aligning every pair. */
export type DistancesRequest =
  | { type: 'distances'; mode: 'aligned'; names: string[]; rows: string[]; alphabet: Alphabet; model: DistanceModel; gapPolicy: GapPolicy }
  | { type: 'distances'; mode: 'unaligned'; seqs: Sequence[]; alphabet: Alphabet; model: DistanceModel; gapPolicy: GapPolicy; scoring: ScoringSpec };

export type DistancesResult = DistanceMatrix;

export type BootstrapRequest = { type: 'bootstrap'; input: BootstrapInput };

export type { BootstrapResult };

/** Progressive multiple alignment request/result. */
export type MsaRequest = { type: 'msa'; seqs: Sequence[]; alphabet: Alphabet; scoring: ScoringSpec; guide: GuideMethod };
export type MsaWorkerResult = MsaResult;
