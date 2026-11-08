// Phase 2 smoke-test worker: proves module workers load under the strict CSP and typed messages round-trip.
import type { PingRequest, WorkerReply } from '../shared/types';

self.onmessage = (event: MessageEvent<PingRequest>): void => {
  const reply: WorkerReply<number> = { type: 'result', value: event.data.value * 2 };
  self.postMessage(reply);
};
