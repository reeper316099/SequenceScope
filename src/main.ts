// Renderer bootstrap: builds the shell (rail + top bar + workspace) and runs the Phase 2 self-checks.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { MENU_ACTIONS } from './shared/types';
import type { MenuAction, PingRequest, SequenceScopeApi, WorkerReply } from './shared/types';

declare global {
  interface Window {
    sequenceScope: SequenceScopeApi;
  }
}

const VIEWS = ['Align', 'Distances', 'Trees', 'MSA', 'Examples', 'Learn', 'About'] as const;

/** Creates an element with optional class and text (textContent only: never innerHTML, so CSP and XSS stay simple). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Applies the theme (light/dark) to the document; defaults to the OS preference. */
function applyTheme(dark: boolean): void {
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** Round-trips a number through a module worker; rejects if the worker errors or never answers. */
function workerPing(value: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/ping.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 5000);
    worker.onmessage = (e: MessageEvent<WorkerReply<number>>): void => {
      clearTimeout(timer);
      worker.terminate();
      if (e.data.type === 'result') resolve(e.data.value);
      else reject(new Error(e.data.type === 'error' ? e.data.message : 'unexpected reply'));
    };
    worker.onerror = (e): void => { clearTimeout(timer); reject(new Error(e.message)); };
    const request: PingRequest = { type: 'ping', value };
    worker.postMessage(request);
  });
}

/** Adds one self-check line to the list and fills in pass/fail when the promise settles. */
function addCheck(list: HTMLElement, id: string, label: string, run: () => Promise<string>): void {
  const li = el('li', 'wait', `${label}`);
  li.dataset['check'] = id;
  list.append(li);
  run().then(
    (detail) => { li.className = 'pass'; li.textContent = `${label}: ${detail}`; },
    (err: unknown) => { li.className = 'fail'; li.textContent = `${label}: ${err instanceof Error ? err.message : 'failed'}`; },
  );
}

/** Builds the shell DOM and wires the view switcher, menu actions, and self-checks. */
function main(): void {
  const root = document.getElementById('app');
  if (root === null) throw new Error('#app missing');
  let dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark);

  const shell = el('div', 'shell');
  const top = el('header', 'topbar', 'SequenceScope');
  const rail = el('nav', 'rail');
  rail.setAttribute('aria-label', 'Views');
  const workspace = el('main', 'workspace');
  const card = el('section', 'card');
  const heading = el('h2');
  const checks = el('ul', 'checks');
  card.append(heading, checks);
  workspace.append(card);

  const buttons = VIEWS.map((name, i) => {
    const b = el('button', undefined, `${i + 1}  ${name}`);
    b.addEventListener('click', () => select(i));
    rail.append(b);
    return b;
  });
  /** Highlights the chosen view and updates the heading. */
  function select(i: number): void {
    buttons.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    heading.textContent = `${VIEWS[i] ?? ''} — shell ready (Phase 2)`;
  }
  select(0);

  shell.append(top, rail, workspace);
  root.append(shell);

  window.addEventListener('menu-action', (e) => {
    const action = (e as CustomEvent<unknown>).detail;
    if (typeof action !== 'string' || !(MENU_ACTIONS as readonly string[]).includes(action)) return;
    const a = action as MenuAction; // safe: membership in MENU_ACTIONS was just checked
    if (a === 'toggle-dark') { dark = !dark; applyTheme(dark); }
    else if (a.startsWith('view-')) select(Number(a.slice(5)) - 1);
  });

  addCheck(checks, 'bridge', 'Preload bridge', async () => {
    const info = await window.sequenceScope.getAppInfo();
    return `${info.name} ${info.version} on Electron ${info.electron}`;
  });
  addCheck(checks, 'worker', 'Module worker (CSP worker-src self)', async () => `21 → ${await workerPing(21)}`);
  addCheck(checks, 'example', 'Example FASTA via app://', async () => {
    const r = await fetch('/examples/pair_unrelated/sequences.fasta');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return `${(text.match(/^>/gm) ?? []).length} records, ${text.length} bytes`;
  });
  addCheck(checks, 'sandbox', 'Renderer has no Node access', () => {
    const leaked = typeof (window as unknown as { require?: unknown }).require !== 'undefined' ||
      typeof (window as unknown as { process?: unknown }).process !== 'undefined';
    if (leaked) return Promise.reject(new Error('require/process visible!'));
    return Promise.resolve('require/process undefined');
  });
  addCheck(checks, 'network', 'Outbound network blocked', async () => {
    try { await fetch('https://example.com/'); } catch { return 'blocked'; }
    throw new Error('request was allowed!');
  });
}

main();
