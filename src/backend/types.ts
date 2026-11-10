// The one interface the UI uses to talk to a background computation. It is the small part of a Web Worker the UI needs
// (postMessage / onmessage / onerror / terminate), so the TypeScript worker and the Rust (Tauri) backend are interchangeable.
import type { WorkerReply } from '../shared/types';

/** A background job runner for one kind of request. Replies arrive as `WorkerReply<R>`: progress, then a result or an error. */
export interface JobWorker<R> {
  onmessage: ((ev: { data: WorkerReply<R> }) => void) | null;
  onerror: ((ev: { message: string }) => void) | null;
  /** Starts the job. */
  postMessage(message: unknown): void;
  /** Cancels the job; nothing is delivered afterwards. */
  terminate(): void;
}

/** Which implementation does the computing. */
export type BackendName = 'ts' | 'rust';
