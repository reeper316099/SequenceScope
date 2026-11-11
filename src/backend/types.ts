// The one interface the UI uses to talk to a background computation. It is the small part of a Web Worker the UI needs
// (postMessage / onmessage / onerror / terminate), so the views do not care how the job is run (it is run by the Rust core).
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
