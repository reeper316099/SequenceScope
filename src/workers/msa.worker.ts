// Runs the progressive multiple alignment off the UI thread, with progress; Cancel = terminate() from the page.
import { BioError } from '../bio/errors';
import { progressiveAlign } from '../bio/msa';
import { compileScoring } from '../bio/scoring';
import type { WorkerReply } from '../shared/types';
import type { MsaRequest, MsaWorkerResult } from './protocol';

self.onmessage = (event: MessageEvent<MsaRequest>): void => {
  const req = event.data;
  try {
    let last = 0;
    const r = progressiveAlign(req.seqs, compileScoring(req.scoring, req.alphabet), req.guide, {
      onProgress: (fraction) => { if (fraction - last >= 0.01 || fraction === 1) { last = fraction; const p: WorkerReply<MsaWorkerResult> = { type: 'progress', fraction }; self.postMessage(p); } },
    });
    if (r === null) throw new Error('cancelled');
    const reply: WorkerReply<MsaWorkerResult> = { type: 'result', value: r };
    self.postMessage(reply);
  } catch (e) {
    const reply: WorkerReply<MsaWorkerResult> = e instanceof BioError ? { type: 'error', message: e.message, code: e.code } : { type: 'error', message: e instanceof Error ? e.message : 'Unexpected error', code: 'unexpected' };
    self.postMessage(reply);
  }
};
