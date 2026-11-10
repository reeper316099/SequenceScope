// Background jobs. The UI asks this module for a worker; each one runs its job in the Rust core (src-tauri/src/compute.rs) and
// presents it with the small Web-Worker-like interface the views already use (progress, then a result or an error, and terminate).
import type { BootstrapResult, MsaResult } from '../shared/results';
import type { AlignResult, DistanceMatrix, ShuffleSummary } from '../shared/types';
import { RustWorker } from './rust';
import type { JobWorker } from './types';

export type { JobWorker } from './types';

/** A worker that runs ONE pairwise alignment (request: AlignRequest, result: AlignResult). */
export function createPairwiseWorker(): JobWorker<AlignResult> {
  return new RustWorker<AlignResult>('align');
}

/** A worker that runs ONE shuffle significance test (request: ShuffleRequest, result: ShuffleSummary). */
export function createShuffleWorker(): JobWorker<ShuffleSummary> {
  return new RustWorker<ShuffleSummary>('shuffle');
}

/** A worker that computes ONE distance matrix (request: DistancesRequest, result: DistanceMatrix). */
export function createDistancesWorker(): JobWorker<DistanceMatrix> {
  return new RustWorker<DistanceMatrix>('distances');
}

/** A worker that runs ONE column bootstrap (request: BootstrapRequest, result: BootstrapResult). */
export function createBootstrapWorker(): JobWorker<BootstrapResult> {
  return new RustWorker<BootstrapResult>('bootstrap');
}

/** A worker that runs ONE progressive multiple alignment (request: MsaRequest, result: MsaResult). */
export function createMsaWorker(): JobWorker<MsaResult> {
  return new RustWorker<MsaResult>('msa');
}
