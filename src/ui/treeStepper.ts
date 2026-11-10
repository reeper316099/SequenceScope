// Step-through for UPGMA / neighbor-joining: shows, for each merge, the current matrix (or Q matrix), the chosen pair,
// the formulas with the real numbers filled in, and the forest of clusters growing toward the final tree.
import type { Tree, TreeNode } from '../shared/types';
import type { NjJoinStep, NjStep } from '../shared/results';
import { writeNewickMany } from '../backend/api';
import type { UpgmaStep } from '../shared/results';
import { clear, el, prefersReducedMotion } from './dom';
import { layoutRectangular } from './treeLayout';
import { forestAfter } from './treeSteps';
import { onThemeChange, token } from './theme';

export interface StepResult {
  method: 'upgma' | 'nj';
  steps: (UpgmaStep | NjStep)[];
  names: string[];
  tree: Tree;
}

export interface TreeStepper {
  root: HTMLElement;
  setResult(r: StepResult | null): void;
  toggle(): void;
  step(delta: number): void;
  getStep(): number;
}

/** Number formatting for the formulas: at most 4 decimals, no trailing zeros, proper minus sign. */
export const fmt = (n: number): string => { const t = Number(n.toFixed(4)).toString(); return t.startsWith('-') ? `−${t.slice(1)}` : t; };

/** Builds the stepper panel. */
export function createTreeStepper(): TreeStepper {
  const root = el('div', 'tstepper', undefined, { role: 'group', 'aria-label': 'Step through the tree-building algorithm', tabindex: 0 });
  const reduced = prefersReducedMotion();
  const btn = (t: string, aria: string): HTMLButtonElement => el('button', 'btn btn-small', t, { type: 'button', 'aria-label': aria, title: aria });
  const toStart = btn('⏮', 'Back to the start');
  const back = btn('◀', 'Previous merge (Left arrow)');
  const play = btn('▶ Play', 'Play or pause (Space)');
  const fwd = btn('▶', 'Next merge (Right arrow)');
  const toEnd = btn('⏭', 'Jump to the final tree');
  const bar = el('div', 'row'); bar.append(toStart, back, play, fwd, toEnd);
  const status = el('p', 'stepper-status', undefined, { 'aria-live': 'polite' });
  const tables = el('div', 'tstep-tables');
  const formulas = el('div', 'tstep-formulas');
  const forest = el('div', 'tstep-forest');
  const legend = el('p', 'hint mono');
  const grid = el('div', 'tstep-grid'); grid.append(el('div', undefined), forest);
  grid.firstElementChild?.append(tables, formulas);
  root.append(bar, status, grid, legend);

  let res: StepResult | null = null;
  let k = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const label = (id: number, n: number): string => (id < n ? (res?.names[id] ?? '').slice(0, 12) : `u${id - n + 1}`);

  /** Renders a distance table; `chosen` = indices into `active` to highlight; optional extra column text. */
  const table = (title: string, active: number[], m: number[][], n: number, chosen: [number, number] | null, extra?: { header: string; values: string[] }): HTMLElement => {
    const box = el('div', 'tstep-table');
    box.append(el('h4', undefined, title));
    const wrap = el('div', 'matrix-table-wrap');
    const t = el('table', 'matrix-table');
    const head = el('tr'); head.append(el('th'));
    active.forEach((id) => head.append(el('th', undefined, label(id, n))));
    if (extra) head.append(el('th', undefined, extra.header));
    t.append(head);
    active.forEach((id, p) => {
      const tr = el('tr'); tr.append(el('th', undefined, label(id, n)));
      active.forEach((_, q) => {
        const hit = chosen !== null && ((chosen[0] === p && chosen[1] === q) || (chosen[0] === q && chosen[1] === p));
        tr.append(el('td', hit ? 'on-path' : undefined, p === q ? '—' : fmt((m[p] as number[])[q] as number)));
      });
      if (extra) tr.append(el('td', undefined, extra.values[p] ?? ''));
      t.append(tr);
    });
    wrap.append(t); box.append(wrap);
    return box;
  };

  const line = (text: string, strong = false): HTMLElement => el('p', strong ? 'calc strong' : 'calc', text);

  /** Draws the forest as small phylograms stacked vertically (shared scale). */
  const drawForest = (clusters: { id: number; node: TreeNode }[], n: number): void => {
    clear(forest);
    const NS = 'http://www.w3.org/2000/svg';
    const text = token('--text'); const muted = token('--text-muted'); const surface = token('--surface');
    const layouts = clusters.map((c) => layoutRectangular({ root: c.node }, { cladogram: false, collapsed: new Set() }));
    const maxX = Math.max(1e-9, ...layouts.map((l) => l.xMax));
    const W = 340; const rowH = 16; const gap = 12; const scale = (W - 120) / maxX;
    const mk = (tag: string, attrs: Record<string, string | number>, t?: string): SVGElement => { const e = document.createElementNS(NS, tag); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v)); if (t !== undefined) e.textContent = t; return e; };
    let y0 = 8;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Clusters merged so far');
    svg.setAttribute('font-family', 'system-ui, sans-serif');
    clusters.forEach((c, ci) => {
      const l = layouts[ci];
      if (!l) return;
      if (c.node.children.length > 0) svg.append(mk('text', { x: 4, y: y0 + ((l.leafRows - 1) * rowH) / 2 + 4, 'font-size': 11, fill: muted }, label(c.id, n)));
      const px = (nx: number): number => 40 + nx * scale; const py = (ny: number): number => y0 + ny * rowH;
      for (const nd of l.nodes) {
        if (nd.parent !== null) { const p = l.nodes[nd.parent]; if (p) svg.append(mk('path', { d: `M ${px(p.x)} ${py(p.y)} V ${py(nd.y)} H ${px(nd.x)}`, fill: 'none', stroke: text, 'stroke-width': 1.4 })); }
        if (nd.isLeaf) svg.append(mk('text', { x: px(nd.x) + 5, y: py(nd.y) + 4, 'font-size': 11, fill: text }, (nd.label).slice(0, 14)));
        else svg.append(mk('circle', { cx: px(nd.x), cy: py(nd.y), r: 2.5, fill: surface, stroke: text }));
      }
      y0 += l.leafRows * rowH + gap;
    });
    svg.setAttribute('width', String(W)); svg.setAttribute('height', String(y0));
    forest.append(svg);
    // The cluster formulas are Newick text without lengths; they arrive a moment after the picture (a newer step replaces them).
    const withKids = clusters.filter((c) => c.node.children.length > 0);
    const mine = ++legendSeq;
    legend.textContent = '';
    void writeNewickMany(withKids.map((c) => ({ root: c.node })), { includeLengths: false, includeSupport: false }).then((texts) => {
      if (mine === legendSeq) legend.textContent = withKids.map((c, i) => `${label(c.id, n)} = ${(texts[i] ?? '').slice(0, -1)}`).join('   ');
    });
  };

  let legendSeq = 0;
  const render = (): void => {
    clear(tables); clear(formulas);
    const hasRes = res !== null;
    for (const b of [toStart, back, play, fwd, toEnd]) b.disabled = !hasRes;
    play.hidden = reduced;
    play.textContent = timer ? '⏸ Pause' : '▶ Play';
    if (!res) { legendSeq++; status.textContent = 'Build a tree to step through it.'; clear(forest); legend.textContent = ''; return; }
    const n = res.names.length;
    const total = res.steps.length;
    status.textContent = k === 0 ? `Start: ${n} separate taxa (${total} step${total === 1 ? '' : 's'} to a full tree).` : k === total ? `Step ${k} of ${total}: the tree is complete.` : `Step ${k} of ${total}`;
    const clusters = forestAfter(res.steps, res.names, k).clusters;
    drawForest(clusters, n);
    if (k === 0) {
      const first = res.steps[0];
      if (first) tables.append(table(res.method === 'upgma' ? 'Distance matrix' : 'Distance matrix', first.active, first.matrix, n, null));
      formulas.append(line(res.method === 'upgma'
        ? 'UPGMA repeatedly merges the two closest clusters. The new node sits at height d/2, so every leaf ends up the same distance from the root (it assumes a constant rate of change: a molecular clock).'
        : 'Neighbor-joining repeatedly joins the pair that minimises Q(i, j) = (n − 2)·d(i, j) − r_i − r_j, where r_i is the sum of node i’s distances to all others. It does not assume a clock.'));
      return;
    }
    const s = res.steps[k - 1];
    if (!s) return;
    if (res.method === 'upgma') {
      const u = s as UpgmaStep;
      tables.append(table(`Matrix before merge ${k} (closest pair highlighted)`, u.active, u.matrix, n, [u.i, u.j]));
      const A = label(u.a, n); const B = label(u.b, n); const N = label(u.newId, n);
      formulas.append(
        line(`Closest pair: ${A} and ${B}, distance d = ${fmt(u.distance)}.`),
        line(`New node ${N} at height d/2 = ${fmt(u.distance)}/2 = ${fmt(u.height)}.`, true),
        line(`Branch ${N}→${A}: ${fmt(u.height)} − height(${A}) = ${fmt(u.height)} − ${fmt(u.heightA)} = ${fmt(u.branchA)}`),
        line(`Branch ${N}→${B}: ${fmt(u.height)} − height(${B}) = ${fmt(u.height)} − ${fmt(u.heightB)} = ${fmt(u.branchB)}`),
      );
      u.others.forEach((o, idx) => {
        const oi = u.active.indexOf(o);
        const dA = (u.matrix[u.i] as number[])[oi] as number; const dB = (u.matrix[u.j] as number[])[oi] as number;
        formulas.append(line(`d(${N}, ${label(o, n)}) = (${u.sizeA}·${fmt(dA)} + ${u.sizeB}·${fmt(dB)}) / ${u.sizeA + u.sizeB} = ${fmt(u.newRow[idx] ?? 0)}`));
      });
    } else if ((s as NjStep).kind === 'join') {
      const j = s as NjJoinStep; // safe: kind === 'join'
      const m = j.active.length;
      tables.append(table(`Distances before join ${k}`, j.active, j.matrix, n, [j.i, j.j], { header: 'r', values: j.sums.map(fmt) }));
      tables.append(table('Q matrix: Q(i,j) = (n−2)·d(i,j) − r_i − r_j (smallest highlighted)', j.active, j.q, n, [j.i, j.j]));
      const A = label(j.a, n); const B = label(j.b, n); const N = label(j.newId, n);
      const ri = j.sums[j.i] as number; const rj = j.sums[j.j] as number;
      formulas.append(
        line(`n = ${m} active nodes. Smallest Q: Q(${A},${B}) = (${m}−2)×${fmt(j.distance)} − ${fmt(ri)} − ${fmt(rj)} = ${fmt(j.qMin)}`, true),
        line(`Branch ${A}→${N} = d/2 + (r_${A} − r_${B}) / (2(n−2)) = ${fmt(j.distance)}/2 + (${fmt(ri)} − ${fmt(rj)}) / ${2 * (m - 2)} = ${fmt(j.branchA)}`),
        line(`Branch ${B}→${N} = d − ${fmt(j.branchA)} = ${fmt(j.distance)} − ${fmt(j.branchA)} = ${fmt(j.branchB)}${j.branchA < 0 || j.branchB < 0 ? '   ⚠ negative: shown as computed, never clamped' : ''}`),
      );
      j.others.forEach((o, idx) => {
        const oi = j.active.indexOf(o);
        formulas.append(line(`d(${N}, ${label(o, n)}) = (d(${A},${label(o, n)}) + d(${B},${label(o, n)}) − d(${A},${B})) / 2 = (${fmt((j.matrix[j.i] as number[])[oi] as number)} + ${fmt((j.matrix[j.j] as number[])[oi] as number)} − ${fmt(j.distance)}) / 2 = ${fmt(j.newRow[idx] ?? 0)}`));
      });
    } else {
      const f = s as Extract<NjStep, { kind: 'final' }>; // safe: the only remaining NJ step kind
      tables.append(table('Last three nodes', f.active, f.matrix, n, null));
      const [x, y, z] = f.ids.map((id) => label(id, n)) as [string, string, string];
      formulas.append(
        line('Three nodes remain, so they are joined in a star around one internal node:', true),
        line(`${x}: (d(${x},${y}) + d(${x},${z}) − d(${y},${z})) / 2 = ${fmt(f.branches[0])}`),
        line(`${y}: (d(${x},${y}) + d(${y},${z}) − d(${x},${z})) / 2 = ${fmt(f.branches[1])}`),
        line(`${z}: (d(${x},${z}) + d(${y},${z}) − d(${x},${y})) / 2 = ${fmt(f.branches[2])}`),
      );
    }
  };

  const stop = (): void => { if (timer) { clearInterval(timer); timer = undefined; } };
  const go = (to: number): void => { if (!res) return; k = Math.max(0, Math.min(res.steps.length, to)); if (k >= res.steps.length) stop(); render(); };
  toStart.addEventListener('click', () => { stop(); go(0); });
  back.addEventListener('click', () => { stop(); go(k - 1); });
  fwd.addEventListener('click', () => { stop(); go(k + 1); });
  toEnd.addEventListener('click', () => { stop(); go(Infinity); });
  const toggle = (): void => {
    if (!res || reduced) return;
    if (timer) { stop(); render(); return; }
    if (k >= res.steps.length) k = 0;
    timer = setInterval(() => go(k + 1), 1100);
    render();
  };
  play.addEventListener('click', toggle);
  root.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && e.key === ' ') return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(k + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(k - 1); }
  });

  onThemeChange(() => render()); // the forest picture uses theme colours captured at draw time
  return {
    root,
    setResult(r) { stop(); res = r; k = r ? r.steps.length : 0; render(); },
    toggle,
    step(delta) { stop(); go(k + delta); },
    getStep: () => k,
  };
}
