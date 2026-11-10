// Backend switch. The UI asks this module for a worker; it returns either the TypeScript Web Worker (the reference
// implementation, always the default) or the Rust one (only inside the Tauri app). Chosen per job, so it can be flipped
// without reloading:
//   1. window.__SEQUENCESCOPE_BACKEND__  ("ts" | "rust"; set by the Tauri app from the SEQUENCESCOPE_BACKEND environment
//      variable, or by tests)
//   2. localStorage "sequencescope.backend"  (same values; set it from the developer console to flip the app)
//   3. "ts"
import type { AlignResult, ShuffleSummary, WorkerReply } from '../shared/types';
import { RustWorker } from './rust';
import type { BackendName, JobWorker } from './types';

export type { BackendName, JobWorker } from './types';

/** Reads a backend name from an untrusted source; anything but "ts" / "rust" is ignored. */
function parse(v: unknown): BackendName | null {
  return v === 'ts' || v === 'rust' ? v : null;
}

/** True when running inside the Tauri app (the only place the Rust backend exists). */
export function rustAvailable(): boolean {
  return Reflect.has(window, '__TAURI_INTERNALS__');
}

/** The backend that new jobs will use right now. */
export function selectedBackend(): BackendName {
  if (!rustAvailable()) return 'ts';
  let stored: unknown = null;
  try {
    stored = localStorage.getItem('sequencescope.backend');
  } catch {
    /* storage can be unavailable (private mode); fall through to the default */
  }
  return parse((window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__']) ?? parse(stored) ?? 'ts';
}

/** Wraps a real Web Worker in the JobWorker interface (replies are passed through untouched, typed arrays included). */
class TsWorker<R> implements JobWorker<R> {
  onmessage: ((ev: { data: WorkerReply<R> }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<WorkerReply<R>>): void => this.onmessage?.({ data: ev.data });
    worker.onerror = (ev: ErrorEvent): void => this.onerror?.({ message: ev.message });
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** A worker that runs ONE pairwise alignment (request: AlignRequest, result: AlignResult). */
export function createPairwiseWorker(backend: BackendName = selectedBackend()): JobWorker<AlignResult> {
  if (backend === 'rust') return new RustWorker<AlignResult>('align');
  return new TsWorker<AlignResult>(new Worker(new URL('../workers/pairwise.worker.ts', import.meta.url), { type: 'module' }));
}

/** A worker that runs ONE shuffle significance test (request: ShuffleRequest, result: ShuffleSummary). */
export function createShuffleWorker(backend: BackendName = selectedBackend()): JobWorker<ShuffleSummary> {
  if (backend === 'rust') return new RustWorker<ShuffleSummary>('shuffle');
  return new TsWorker<ShuffleSummary>(new Worker(new URL('../workers/shuffle.worker.ts', import.meta.url), { type: 'module' }));
}
