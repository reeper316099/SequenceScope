// Computes a distance matrix off the UI thread, with progress; Cancel = terminate() from the page.
import { BioError } from '../bio/errors';
import { distanceMatrixFromAligned, pairwiseDistanceMatrix } from '../bio/distance';
import { compileScoring } from '../bio/scoring';
import type { WorkerReply } from '../shared/types';
import type { DistancesRequest, DistancesResult } from './protocol';

self.onmessage = (event: MessageEvent<DistancesRequest>): void => {
  const req = event.data;
  try {
    let m: DistancesResult | null;
    if (req.mode === 'aligned') {
      m = distanceMatrixFromAligned(req.names, req.rows, req.alphabet, req.model, req.gapPolicy);
    } else {
      const scoring = compileScoring(req.scoring, req.alphabet);
      let last = 0;
      m = pairwiseDistanceMatrix(req.seqs, scoring, req.model, req.gapPolicy, {
        onProgress: (fraction) => { if (fraction - last >= 0.01 || fraction === 1) { last = fraction; const p: WorkerReply<DistancesResult> = { type: 'progress', fraction }; self.postMessage(p); } },
      });
    }
    if (m === null) throw new Error('cancelled');
    const reply: WorkerReply<DistancesResult> = { type: 'result', value: m };
    self.postMessage(reply);
  } catch (e) {
    const reply: WorkerReply<DistancesResult> = e instanceof BioError ? { type: 'error', message: e.message, code: e.code } : { type: 'error', message: e instanceof Error ? e.message : 'Unexpected error', code: 'unexpected' };
    self.postMessage(reply);
  }
};
