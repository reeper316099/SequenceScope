// Smoke self-check for the Tauri build. Runs only when Rust started the app with SEQUENCESCOPE_SMOKE=1 (hidden window).
// It checks the facts that matter for the migration: the UI rendered, the bridge has exactly five functions, module Web
// Workers load under the strict CSP, no CSP violation happened, expected bad requests are refused by Rust, and the page
// has NO access to the dialog / clipboard / opener plugins. The result goes to Rust, which prints it and exits 0 or 1.
import { invoke } from '@tauri-apps/api/core';
import type { PingRequest, WorkerReply } from '../shared/types';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const EXPECTED_BRIDGE = ['copyText', 'getAppInfo', 'openExternal', 'openFile', 'saveFile'];
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} blocked ${e.blockedURI}`));

/** Waits (up to `ms`) until `test` returns true; resolves false on timeout. */
async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return test();
}

/** Starts the ping worker and resolves with its answer (or null on error/timeout). */
function pingWorker(): Promise<number | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/ping.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); resolve(null); }, 5000);
    worker.onmessage = (ev: MessageEvent<WorkerReply<number>>): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ev.data.type === 'result' ? ev.data.value : null);
    };
    worker.onerror = (): void => { clearTimeout(timer); resolve(null); };
    const msg: PingRequest = { type: 'ping', value: 21 };
    worker.postMessage(msg);
  });
}

/** True if calling the plugin command from the page is REFUSED (which is what least privilege requires). */
async function refused(command: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    await invoke(command, args);
    return false;
  } catch {
    return true;
  }
}

/** Runs every check, then sends one report to Rust. */
export async function runSmokeCheck(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string): void => { checks.push(detail === undefined ? { name, pass } : { name, pass, detail }); };
  try {
    const rendered = await waitFor(() => document.querySelector('.view-align') !== null && document.querySelector('.rail, nav') !== null, 15000);
    add('UI rendered (.view-align present)', rendered);
    add('document title', document.title === 'SequenceScope', document.title);

    const keys = Object.keys(window.sequenceScope).sort();
    add('bridge has exactly 5 functions', JSON.stringify(keys) === JSON.stringify(EXPECTED_BRIDGE), keys.join(','));
    add('no Node globals in the page', typeof (window as unknown as { require?: unknown }).require === 'undefined' && typeof (window as unknown as { process?: unknown }).process === 'undefined');

    const info = await window.sequenceScope.getAppInfo();
    add('getAppInfo returns version and platform', info.version.length > 0 && info.platform.length > 0, JSON.stringify(info));

    const ping = await pingWorker();
    add('module Web Worker runs under the CSP', ping === 42, String(ping));

    const res = await fetch(location.href);
    const csp = res.headers.get('content-security-policy') ?? '';
    add('CSP header present and strict', csp.includes("default-src 'self'") && !csp.includes("'unsafe-eval'"), csp);

    const bad1 = await window.sequenceScope.openFile('bogus' as never);
    add('openFile rejects an unknown kind', !bad1.ok && bad1.reason === 'invalid-request', JSON.stringify(bad1));
    const bad2 = await window.sequenceScope.saveFile({ suggestedName: '../evil', extensions: ['txt'], content: 'x', encoding: 'utf8' });
    add('saveFile rejects a path-tricking name', !bad2.ok && bad2.reason === 'invalid-request', JSON.stringify(bad2));
    const bad3 = await window.sequenceScope.openExternal('https://evil.example/');
    add('openExternal rejects a non-allowlisted host', !bad3.ok, JSON.stringify(bad3));
    const bad4 = await window.sequenceScope.openExternal('http://github.com/');
    add('openExternal rejects http', !bad4.ok, JSON.stringify(bad4));
    const bad5 = await window.sequenceScope.copyText('x'.repeat(5 * 1024 * 1024 + 1));
    add('copyText rejects text over 5 MB', !bad5.ok, JSON.stringify(bad5).slice(0, 120));

    add('page cannot call the dialog plugin', await refused('plugin:dialog|open', { options: {} }));
    add('page cannot call the clipboard plugin', await refused('plugin:clipboard-manager|read_text', {}));
    add('page cannot call the opener plugin', await refused('plugin:opener|open_url', { url: 'https://github.com/' }));
    add('page cannot call an unknown command', await refused('definitely_not_a_command', {}));

    add('no CSP violations', violations.length === 0, violations.join('; '));
  } catch (e) {
    add('smoke check itself did not crash', false, e instanceof Error ? e.message : String(e));
  }
  const ok = checks.every((c) => c.pass);
  await invoke('smoke_report', { report: { ok, checks } });
}
