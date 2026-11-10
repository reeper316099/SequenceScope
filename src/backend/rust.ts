// The Rust backend: runs alignments and shuffle tests in the Tauri app's Rust code (commands in src-tauri/src/compute.rs)
// and presents them with the same replies the TypeScript workers send. Progress arrives on a channel, the alignment tables
// arrive as one binary frame, and cancellation is a cancel_job command.
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AlignRequest, AlignResult, DpSnapshot, PairwiseAlignment, ShuffleRequest, ShuffleSummary, WorkerReply } from '../shared/types';
import { decodeFrame } from './frame';
import type { JobWorker } from './types';

/** Milliseconds Rust spent filling the matrix and tracing back (the rest of a round trip is transfer and decoding). */
export interface RustTimings {
  fillMs: number;
  tracebackMs: number;
}

/** An alignment result plus measurements, for the benchmark. */
export interface RustAlignOutcome {
  result: AlignResult;
  timings: RustTimings;
  frameBytes: number;
}

let nextJobId = 1;

/** The error shape Rust sends when a job fails: { code, message } (code "cancelled" when the job was stopped). */
interface JobFailure {
  code: string;
  message: string;
}

/** Recognises a Rust job failure among the things invoke() can reject with. */
function asFailure(e: unknown): JobFailure {
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
    const code = 'code' in e && typeof e.code === 'string' ? e.code : 'unexpected';
    return { code, message: e.message };
  }
  return { code: 'unexpected', message: typeof e === 'string' ? e : 'Unexpected error' };
}

interface AlignHeader {
  alignment: PairwiseAlignment;
  all: PairwiseAlignment[];
  capped: boolean;
  dp: { kind: 'linear' | 'affine'; mode: 'global' | 'local'; rows: number; cols: number; score: number; ends: number[] };
  timings: RustTimings;
}

/** Aligns in Rust; resolves with the result in the shape the UI already uses (typed-array views on the received buffer). */
export async function rustAlign(req: AlignRequest, onProgress?: (fraction: number) => void, jobId: number = nextJobId++): Promise<RustAlignOutcome> {
  const channel = new Channel<{ fraction: number }>();
  channel.onmessage = (m) => onProgress?.(m.fraction);
  const buf = await invoke<ArrayBuffer>('align_pair', { jobId, request: req, onProgress: channel }); // Rust ignores the extra `type` field
  const { header, tables } = decodeFrame(buf);
  const h = header as AlignHeader;
  const dp: DpSnapshot =
    h.dp.kind === 'linear'
      ? { kind: 'linear', mode: h.dp.mode, rows: h.dp.rows, cols: h.dp.cols, score: h.dp.score, ends: h.dp.ends, H: tables['H'] as Int32Array, P: tables['P'] as Uint8Array }
      : { kind: 'affine', mode: h.dp.mode, rows: h.dp.rows, cols: h.dp.cols, score: h.dp.score, ends: h.dp.ends, M: tables['M'] as Int32Array, X: tables['X'] as Int32Array, Y: tables['Y'] as Int32Array, P: tables['P'] as Uint16Array };
  return { result: { alignment: h.alignment, all: h.all, capped: h.capped, dp }, timings: h.timings, frameBytes: buf.byteLength };
}

/** The JSON Rust returns for a shuffle test (scores as a plain array). */
type ShuffleJson = Omit<ShuffleSummary, 'scores'> & { scores: number[] };

/** Runs the shuffle test in Rust. */
export async function rustShuffle(req: ShuffleRequest, onProgress?: (fraction: number) => void, jobId: number = nextJobId++): Promise<ShuffleSummary> {
  const channel = new Channel<{ fraction: number }>();
  channel.onmessage = (m) => onProgress?.(m.fraction);
  const r = await invoke<ShuffleJson>('shuffle_test', { jobId, request: req, onProgress: channel });
  return { ...r, scores: Int32Array.from(r.scores) };
}

/** A JobWorker backed by Rust. `kind` selects which command a posted request goes to. */
export class RustWorker<R> implements JobWorker<R> {
  onmessage: ((ev: { data: WorkerReply<R> }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  private terminated = false;
  private jobId: number | null = null;

  constructor(private readonly kind: 'align' | 'shuffle') {}

  /** Starts the job; replies are delivered through `onmessage` unless the job was terminated first. */
  postMessage(message: unknown): void {
    const jobId = nextJobId++;
    this.jobId = jobId;
    const send = (reply: WorkerReply<R>): void => { if (!this.terminated) this.onmessage?.({ data: reply }); };
    // The Align view treats ANY first message as "the worker is done" (the TypeScript align worker sends only the result), so
    // alignment progress is not forwarded here; it is still reported to callers of rustAlign() directly. The shuffle panel
    // does show progress, so shuffle progress is forwarded.
    const progress = (fraction: number): void => send({ type: 'progress', fraction });
    const run: Promise<unknown> = this.kind === 'align' ? rustAlign(message as AlignRequest, undefined, jobId).then((o) => o.result) : rustShuffle(message as ShuffleRequest, progress, jobId);
    run.then(
      (value) => send({ type: 'result', value: value as R }),
      (e: unknown) => {
        const f = asFailure(e);
        if (f.code === 'cancelled' || this.terminated) return; // a stopped job says nothing
        send({ type: 'error', message: f.message, code: f.code });
      },
    );
  }

  /** Stops the job (if it is still running) and silences any later reply. */
  terminate(): void {
    this.terminated = true;
    if (this.jobId !== null) void invoke('cancel_job', { jobId: this.jobId }).catch(() => undefined); // nothing to do if it already finished
  }
}
