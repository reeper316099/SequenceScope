// Vitest setup for tests that call the real calculations: the page's `invoke` is pointed at the Rust test bridge (started once by
// bridgeGlobal.ts), the same way the Playwright tests do it (tests/bridge/shim.ts). No calculation runs in TypeScript.
import { pageShim } from '../bridge/shim';

const base = process.env['BRIDGE_URL'];
if (base !== undefined) {
  const g = globalThis as unknown as Record<string, unknown>;
  g['window'] = globalThis;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init));
  pageShim();
}
