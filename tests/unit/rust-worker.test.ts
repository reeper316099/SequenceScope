// RustWorker is the adapter that makes a Rust job look like a Web Worker. Here the Tauri bridge is replaced by a double, so
// the routing (which command, which arguments), progress, results, errors and cancellation are checked without a window.
// The real round trip is checked in the Tauri window by `SEQUENCESCOPE_SMOKE_MODE=parity`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { command: string; args: Record<string, unknown> };
const calls: Call[] = [];
let respond: (call: Call) => Promise<unknown> = () => Promise.resolve(undefined);

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage: ((m: unknown) => void) | null = null; },
  invoke: (command: string, args: Record<string, unknown>): Promise<unknown> => { const call = { command, args }; calls.push(call); return respond(call); },
}));

const { RustWorker } = await import('../../src/backend/rust');

/** Lets queued promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { calls.length = 0; respond = () => Promise.resolve(undefined); });

describe('RustWorker (msa)', () => {
  const request = { type: 'msa', seqs: [{ id: 'a', residues: 'ACGT' }], alphabet: 'dna', scoring: {}, guide: 'upgma' };

  it('sends the request to msa_job, forwards progress and delivers the result', async () => {
    const result = { ids: ['a'], rows: ['ACGT'], alphabet: 'dna', guideTree: { root: { name: 'a', children: [] } }, guide: 'upgma', steps: [], sumOfPairs: 0 };
    respond = (call) => {
      const channel = call.args['onProgress'] as { onmessage: ((m: { fraction: number }) => void) | null };
      channel.onmessage?.({ fraction: 0.5 });
      return Promise.resolve(result);
    };
    const w = new RustWorker<typeof result>('msa');
    const got: unknown[] = [];
    w.onmessage = (ev) => got.push(ev.data);
    w.postMessage(request);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('msa_job');
    expect(calls[0]?.args['request']).toBe(request);
    expect(typeof calls[0]?.args['jobId']).toBe('number');
    expect(got).toEqual([{ type: 'progress', fraction: 0.5 }, { type: 'result', value: result }]);
  });

  it('turns a Rust failure into an error reply with its code and message', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain error object the command returned
    respond = () => Promise.reject({ code: 'duplicate-names', message: 'Sequence names must be unique so the guide tree can name them.' });
    const w = new RustWorker<unknown>('msa');
    const got: unknown[] = [];
    w.onmessage = (ev) => got.push(ev.data);
    w.postMessage(request);
    await settle();
    expect(got).toEqual([{ type: 'error', message: 'Sequence names must be unique so the guide tree can name them.', code: 'duplicate-names' }]);
  });

  it('terminate() cancels the job by id and silences every later reply', async () => {
    let finish: (v: unknown) => void = () => undefined;
    respond = (call) => (call.command === 'msa_job' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const w = new RustWorker<unknown>('msa');
    const got: unknown[] = [];
    w.onmessage = (ev) => got.push(ev.data);
    w.postMessage(request);
    const jobId = calls[0]?.args['jobId'];
    w.terminate();
    expect(calls[1]).toEqual({ command: 'cancel_job', args: { jobId } });
    finish({ ids: [] });
    await settle();
    expect(got).toEqual([]);
  });

  it('a job that Rust reports as cancelled says nothing', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain error object the command returned
    respond = () => Promise.reject({ code: 'cancelled', message: 'Cancelled.' });
    const w = new RustWorker<unknown>('msa');
    const got: unknown[] = [];
    w.onmessage = (ev) => got.push(ev.data);
    w.postMessage(request);
    await settle();
    expect(got).toEqual([]);
  });
});
