// Card + message building blocks shared by all views.
import { el } from './dom';

/** A titled card; returns the card and its body for appending content. */
export function card(title: string, subtitle?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', undefined, title));
  if (subtitle !== undefined) head.append(el('p', 'card-sub', subtitle));
  const body = el('div', 'card-body');
  root.append(head, body);
  return { root, body };
}

/** A small statistic tile (label, big value, optional detail line). */
export function statTile(label: string, value: string, detail?: string): HTMLElement {
  const t = el('div', 'stat');
  t.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
  if (detail !== undefined) t.append(el('div', 'stat-detail', detail));
  return t;
}

/** A callout box: info, warning, or error. */
export function callout(kind: 'info' | 'warn' | 'error', text: string): HTMLElement {
  const box = el('div', `callout callout-${kind}`, undefined, { role: kind === 'error' ? 'alert' : 'note' });
  box.append(el('span', 'callout-icon', kind === 'error' ? '✘' : kind === 'warn' ? '⚠' : 'ℹ', { 'aria-hidden': 'true' }), el('span', undefined, text));
  return box;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a short status message in the live region at the bottom of the window. */
export function toast(message: string): void {
  const region = document.getElementById('toast');
  if (!region) return;
  region.textContent = message;
  region.classList.add('show');
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.classList.remove('show'), 4500);
}
