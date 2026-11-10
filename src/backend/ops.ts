// The small-calculation channel to Rust: one Tauri command (`bio_op`) with a tagged request. A Rust failure arrives as
// { code, message } and is rethrown as the same BioError the TypeScript functions throw, so the UI's error handling is unchanged.
import { invoke } from '@tauri-apps/api/core';
import { BioError } from '../bio/errors';
import type { BioErrorCode } from '../shared/types';

/** A request for one operation (see src-tauri/src/ops.rs for the full list). */
export interface OpRequest {
  op: string;
  [field: string]: unknown;
}

/** Runs one operation in Rust and returns its JSON result; failures become BioError. */
export async function rustOp<T>(request: OpRequest): Promise<T> {
  try {
    return await invoke<T>('bio_op', { request });
  } catch (e) {
    const failure = typeof e === 'object' && e !== null ? (e as { code?: unknown; message?: unknown }) : {};
    const message = typeof failure.message === 'string' ? failure.message : typeof e === 'string' ? e : 'Unexpected error';
    throw new BioError(typeof failure.code === 'string' ? (failure.code as BioErrorCode) : 'invalid-argument', message);
  }
}
