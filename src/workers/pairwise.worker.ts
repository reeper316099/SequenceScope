// Runs one pairwise alignment off the UI thread and TRANSFERS the DP tables back (no copy).
import { BioError } from '../bio/errors';
import { dpToSnapshot, fillMatrix, tracebackAll, tracebackFirst } from '../bio/pairwise';
import { compileScoring } from '../bio/scoring';
import type { AlignRequest, AlignResult, WorkerReply } from '../shared/types';

self.onmessage = (event: MessageEvent<AlignRequest>): void => {
  const req = event.data;
  try {
    const sc = compileScoring(req.scoring, req.alphabet);
    const dp = fillMatrix(req.a, req.b, req.mode, sc);
    const alignment = tracebackFirst(dp);
    const { alignments, capped } = tracebackAll(dp, req.enumerateCap);
    const dpSnap = dpToSnapshot(dp);
    const value: AlignResult = { alignment, all: alignments, capped, dp: dpSnap };
    const reply: WorkerReply<AlignResult> = { type: 'result', value };
    const transfer: ArrayBuffer[] = dpSnap.kind === 'linear' ? [dpSnap.H.buffer as ArrayBuffer, dpSnap.P.buffer as ArrayBuffer] : [dpSnap.M.buffer as ArrayBuffer, dpSnap.X.buffer as ArrayBuffer, dpSnap.Y.buffer as ArrayBuffer, dpSnap.P.buffer as ArrayBuffer]; // safe: these typed arrays own plain ArrayBuffers (never SharedArrayBuffer)
    self.postMessage(reply, transfer);
  } catch (e) {
    const reply: WorkerReply<AlignResult> = e instanceof BioError ? { type: 'error', message: e.message, code: e.code } : { type: 'error', message: e instanceof Error ? e.message : 'Unexpected error', code: 'unexpected' };
    self.postMessage(reply);
  }
};
