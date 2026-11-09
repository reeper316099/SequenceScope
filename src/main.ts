// Renderer bootstrap: shell (top bar, rail, workspace, details panel), view router with back/forward, theme, menu actions.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { MENU_ACTIONS } from './shared/types';
import type { MenuAction, SequenceScopeApi } from './shared/types';
import { createAboutView } from './ui/aboutView';
import { createAlignView } from './ui/alignView';
import { toast } from './ui/cards';
import { createComingSoonView } from './ui/comingSoonView';
import { createDetailsPanel } from './ui/detailsPanel';
import { el } from './ui/dom';
import { createExamplesView } from './ui/examplesView';
import { createLearnView } from './ui/learnView';
import { currentTheme, initialTheme, setTheme } from './ui/theme';
import type { AppView } from './ui/view';

declare global {
  interface Window {
    sequenceScope: SequenceScopeApi;
  }
}

/** Builds the shell and mounts all views. */
function main(): void {
  const root = document.getElementById('app');
  if (root === null) throw new Error('#app missing');
  setTheme(initialTheme());

  const details = createDetailsPanel();
  const align = createAlignView(details);
  const views: AppView[] = [
    align,
    createComingSoonView('distances', 'Distances', 'Milestone B', 'Pairwise-alignment-based distance matrices with Jukes–Cantor and Poisson corrections and a heatmap.'),
    createComingSoonView('trees', 'Trees', 'Milestone B', 'UPGMA and neighbor-joining with step-through, a tree viewer, Newick import/export, tree comparison, and bootstrap support for aligned input.'),
    createComingSoonView('msa', 'MSA', 'Milestone C', 'Progressive multiple sequence alignment with conservation and bootstrap trees from the app’s own alignments.'),
    createExamplesView((a, b) => { show(0); align.loadTexts(a, b); }),
    createLearnView(() => align.getContext()),
    createAboutView(),
  ];

  const shell = el('div', 'shell');
  const top = el('header', 'topbar');
  const backBtn = el('button', 'btn btn-small', '◀', { type: 'button', 'aria-label': 'Back to the previous view' });
  const fwdBtn = el('button', 'btn btn-small', '▶', { type: 'button', 'aria-label': 'Forward to the next view' });
  const brand = el('div', 'brand', 'SequenceScope');
  const honesty = el('span', 'honesty', 'Educational tool — not a replacement for BLAST, MAFFT, or research phylogenetics software.');
  const themeBtn = el('button', 'btn btn-small', 'Dark / light', { type: 'button', 'aria-label': 'Toggle dark mode' });
  top.append(backBtn, fwdBtn, brand, honesty, themeBtn);
  const rail = el('nav', 'rail', undefined, { 'aria-label': 'Views' });
  const workspace = el('main', 'workspace', undefined, { id: 'main', tabindex: -1 });
  const toastRegion = el('div', undefined, undefined, { id: 'toast', role: 'status', 'aria-live': 'polite' });
  shell.append(top, rail, workspace, details.root);
  root.append(shell, toastRegion);

  const buttons = views.map((v, i) => {
    const b = el('button', undefined, `${i + 1}  ${v.title}`, { type: 'button' });
    b.addEventListener('click', () => show(i));
    rail.append(b);
    workspace.append(v.root);
    v.root.hidden = true;
    return b;
  });

  // Navigation history between views.
  const stack: number[] = [0];
  let pos = 0;
  /** Makes view `i` visible without touching the history stack. */
  function display(i: number): void {
    views.forEach((v, k) => { v.root.hidden = k !== i; });
    buttons.forEach((b, k) => (k === i ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    details.root.hidden = i !== 0;
    shell.dataset['details'] = i === 0 ? 'on' : 'off';
    views[i]?.onShow?.();
    workspace.scrollTop = 0;
    backBtn.disabled = pos === 0;
    fwdBtn.disabled = pos === stack.length - 1;
  }
  /** Navigates to view `i` and records it in the history. */
  function show(i: number): void {
    if (stack[pos] === i) { display(i); return; }
    stack.splice(pos + 1);
    stack.push(i);
    pos = stack.length - 1;
    display(i);
  }
  backBtn.addEventListener('click', () => { if (pos > 0) { pos--; display(stack[pos] ?? 0); } });
  fwdBtn.addEventListener('click', () => { if (pos < stack.length - 1) { pos++; display(stack[pos] ?? 0); } });
  themeBtn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  display(0);

  window.addEventListener('menu-action', (e) => {
    const action = (e as CustomEvent<unknown>).detail;
    if (typeof action !== 'string' || !(MENU_ACTIONS as readonly string[]).includes(action)) return;
    const a = action as MenuAction; // safe: membership in MENU_ACTIONS was just checked
    if (a === 'toggle-dark') { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); return; }
    if (a.startsWith('view-')) { const n = Number(a.slice(5)) - 1; if (n >= 0 && n < views.length) show(n); return; }
    if (a === 'open-newick') { toast('Newick import arrives with Milestone B (the Trees view).'); return; }
    // File, save and export commands belong to the Align view (the only one with data so far): switch to it first.
    if (['open-fasta', 'open-project', 'save-project', 'export'].includes(a) && (stack[pos] ?? 0) !== 0) show(0);
    const view = views[stack[pos] ?? 0];
    if (!(view?.handleAction?.(a) ?? false)) toast('That command is not available in this view.');
  });
}

main();
