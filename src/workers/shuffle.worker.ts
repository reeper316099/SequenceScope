// Runs the seeded shuffle significance test off the UI thread, reporting progress. Cancel = terminate() from the page.
import { BioError } from '../bio/errors';
import { runShuffleTest } from '../bio/shuffle';
import { compileScoring } from '../bio/scoring';
import type { ShuffleRequest, ShuffleSummary, WorkerReply } from '../shared/types';

self.onmessage = (event: MessageEvent<ShuffleRequest>): void => {
  const req = event.data;
  try {
    const scoring = compileScoring(req.scoring, req.alphabet);
    let last = 0;
    const r = runShuffleTest({
      a: req.a, b: req.b, mode: req.mode, scoring, shuffles: req.shuffles, seed: req.seed,
      onProgress: (fraction) => {
        if (fraction - last >= 0.01 || fraction === 1) { last = fraction; const p: WorkerReply<ShuffleSummary> = { type: 'progress', fraction }; self.postMessage(p); }
      },
    });
    if (r.cancelled) throw new Error('cancelled');
    const summary: ShuffleSummary = { seed: r.seed, shuffles: r.shuffles, realScore: r.realScore, scores: r.scores, mean: r.mean, sd: r.sd, z: r.z, atLeastAsGood: r.atLeastAsGood, pValue: r.pValue };
    const reply: WorkerReply<ShuffleSummary> = { type: 'result', value: summary };
    self.postMessage(reply);
  } catch (e) {
    const reply: WorkerReply<ShuffleSummary> = e instanceof BioError ? { type: 'error', message: e.message, code: e.code } : { type: 'error', message: e instanceof Error ? e.message : 'Unexpected error', code: 'unexpected' };
    self.postMessage(reply);
  }
};
