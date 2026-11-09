// Runs the column bootstrap off the UI thread, with progress; Cancel = terminate() from the page.
import { bootstrap } from '../bio/bootstrap';
import { BioError } from '../bio/errors';
import type { WorkerReply } from '../shared/types';
import type { BootstrapRequest, BootstrapResult } from './protocol';

self.onmessage = (event: MessageEvent<BootstrapRequest>): void => {
  try {
    let last = 0;
    const r = bootstrap(event.data.input, {
      onProgress: (fraction) => { if (fraction - last >= 0.01 || fraction === 1) { last = fraction; const p: WorkerReply<BootstrapResult> = { type: 'progress', fraction }; self.postMessage(p); } },
    });
    if (r === null) throw new Error('cancelled');
    const reply: WorkerReply<BootstrapResult> = { type: 'result', value: r };
    self.postMessage(reply);
  } catch (e) {
    const reply: WorkerReply<BootstrapResult> = e instanceof BioError ? { type: 'error', message: e.message, code: e.code } : { type: 'error', message: e instanceof Error ? e.message : 'Unexpected error', code: 'unexpected' };
    self.postMessage(reply);
  }
};
