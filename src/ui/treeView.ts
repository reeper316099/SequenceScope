// SVG tree viewer: rectangular (phylogram / cladogram) and radial layouts, support values with a low-support mark,
// negative-branch warnings, scale bar, select / collapse / highlight / search, zoom and pan, keyboard navigation, SVG + PNG export.
// All colours are SVG presentation ATTRIBUTES (not inline style), which the strict CSP allows and which make exports self-contained.
import type { Tree } from '../shared/types';
import { clear, el } from './dom';
import { layoutRadial, layoutRectangular, navigate } from './treeLayout';
import type { Layout, LayoutNode } from './treeLayout';
import { onThemeChange, token } from './theme';

export const LOW_SUPPORT_THRESHOLD = 70; // percent: bootstrap support below this is visually marked
export const HIGHLIGHT_COLORS = ['#E69F00', '#56B4E9', '#009E73', '#D55E00', '#CC79A7', '#0072B2'] as const; // Okabe-Ito colour-blind-safe palette
const SVGNS = 'http://www.w3.org/2000/svg';
const ROW = 22;
const MARGIN = 24;
const LABEL_SPACE = 210;

export type LayoutKind = 'rect' | 'radial';

export interface TreeViewer {
  root: HTMLElement;
  setTree(t: Tree | null): void;
  getTree(): Tree | null;
  setLayoutKind(k: LayoutKind): void;
  setCladogram(b: boolean): void;
  setShowSupport(b: boolean): void;
  select(index: number | null): void;
  getSelected(): LayoutNode | null;
  toggleCollapseSelected(): void;
  expandAll(): void;
  collapseKeys(): string[];
  setHighlight(key: string, color: string | null): void;
  clearHighlights(): void;
  setSearch(q: string): number;
  setMarked(indexes: ReadonlySet<number>): void;
  zoom(factor: number): void;
  fit(): void;
  layout(): Layout | null;
  toSvg(): string | null;
  toPng(): Promise<string | null>;
}

/** Rounds a length down to 1, 2 or 5 × 10^k (for the scale bar). */
export function niceLength(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/** Shortens a long taxon name for display (the full name is in the tooltip). */
export function truncateName(s: string, max = 26): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Creates an SVG element with attributes. */
function s(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Builds a viewer. `onSelect` fires whenever the selected node changes (null = nothing selected). */
export function createTreeViewer(ariaLabel: string, onSelect: (n: LayoutNode | null) => void = () => undefined, onChange: () => void = () => undefined): TreeViewer {
  const root = el('div', 'treeviewer');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'tree-svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', `${ariaLabel}. Arrow keys move between nodes, Enter collapses or expands a clade.`);
  svg.setAttribute('tabindex', '0');
  const wrap = el('div', 'tree-wrap');
  wrap.append(svg);
  root.append(wrap);

  let tree: Tree | null = null;
  let kind: LayoutKind = 'rect';
  let cladogram = false;
  let showSupport = true;
  let selected: number | null = null;
  let collapsed = new Set<string>();
  const highlights = new Map<string, string>();
  let search = '';
  let marked: ReadonlySet<number> = new Set();
  let lay: Layout | null = null;
  let view = { k: 1, x: 0, y: 0 };
  let content = { w: 600, h: 300 };
  let g: SVGGElement | null = null;

  const col = (name: string): string => token(name);

  /** Re-computes the layout and redraws everything. */
  const render = (): void => {
    clear(svg);
    lay = null;
    if (!tree) return;
    const opts = { cladogram, collapsed };
    lay = kind === 'rect' ? layoutRectangular(tree, opts) : layoutRadial(tree, opts);
    const L = lay;
    const text = col('--text'); const muted = col('--text-muted'); const primary = col('--primary'); const accent = col('--accent'); const bad = col('--bad'); const surface = col('--surface');
    const parts: SVGElement[] = [];
    let px: (n: LayoutNode) => number; let py: (n: LayoutNode) => number;
    let width: number; let height: number; let scale: number;
    const span = (L.xMax - L.xMin) || 1;
    if (kind === 'rect') {
      width = 820 + LABEL_SPACE; height = Math.max(1, L.leafRows) * ROW + 2 * MARGIN + 30;
      const xs = (820 - 2 * MARGIN) / span;
      px = (n) => MARGIN + (n.x - L.xMin) * xs;
      py = (n) => MARGIN + n.y * ROW;
      scale = xs;
    } else {
      const R = Math.max(220, Math.min(380, 30 * Math.sqrt(L.leafRows) + 120));
      const maxR = Math.max(...L.nodes.map((n) => Math.hypot(n.x, n.y))) || 1;
      const k = R / maxR;
      width = 2 * (R + LABEL_SPACE / 2 + MARGIN); height = 2 * (R + MARGIN + 30);
      px = (n) => width / 2 + n.x * k; py = (n) => height / 2 + n.y * k;
      scale = k;
    }
    content = { w: width, h: height };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    svg.setAttribute('font-family', 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif');
    parts.push(s('rect', { x: 0, y: 0, width, height, fill: surface }));

    // subtree membership for selection and highlights
    const subtree = (rootIdx: number): Set<number> => { const out = new Set<number>(); const walk = (i: number): void => { out.add(i); (L.nodes[i] as LayoutNode).children.forEach(walk); }; walk(rootIdx); return out; };
    const selPos = selected === null ? -1 : L.nodes.findIndex((n) => n.index === selected);
    const selSet = selPos >= 0 ? subtree(selPos) : new Set<number>();
    const colorOfPos = (pos: number): string | null => {
      let p: number | null = pos;
      while (p !== null) { const c = highlights.get((L.nodes[p] as LayoutNode).key); if (c) return c; p = (L.nodes[p] as LayoutNode).parent; }
      return null;
    };

    // links
    const linkGroup = s('g', { fill: 'none', 'stroke-linecap': 'round' });
    L.nodes.forEach((n, pos) => {
      if (n.parent === null) {
        if (kind === 'rect') linkGroup.append(s('line', { x1: px(n) - 10, y1: py(n), x2: px(n), y2: py(n), stroke: muted, 'stroke-width': 1.5 }));
        return;
      }
      const p = L.nodes[n.parent] as LayoutNode;
      const isMarked = marked.has(n.index);
      const hl = colorOfPos(pos);
      const stroke = isMarked ? bad : selSet.has(pos) ? primary : (hl ?? text);
      const width1 = isMarked ? 3 : selSet.has(pos) || hl ? 2.6 : 1.5;
      const d = kind === 'rect' ? `M ${px(p)} ${py(p)} V ${py(n)} H ${px(n)}` : `M ${px(p)} ${py(p)} L ${px(n)} ${py(n)}`;
      const attrs: Record<string, string | number> = { d, stroke, 'stroke-width': width1 };
      if (n.negative) attrs['stroke-dasharray'] = '5 3';
      linkGroup.append(s('path', attrs));
    });
    parts.push(linkGroup);

    // nodes and labels
    const nodeGroup = s('g', {});
    const q = search.trim().toLowerCase();
    L.nodes.forEach((n, pos) => {
      const x = px(n); const y = py(n);
      const gn = s('g', { 'data-index': n.index, cursor: 'pointer' });
      const len = n.node.length;
      const tip = `${n.isLeaf ? n.label : n.collapsed ? n.label : 'internal node'}${len !== undefined ? ` · branch length ${len}` : ''}${n.node.support !== undefined ? ` · support ${n.node.support}%` : ''}${n.negative ? ' · NEGATIVE branch length (kept as computed)' : ''}`;
      gn.append(s('title', {}, tip));
      if (n.collapsed) {
        gn.append(s('polygon', { points: `${x},${y} ${x + 46},${y - 11} ${x + 46},${y + 11}`, fill: colorOfPos(pos) ?? muted, stroke: text, 'stroke-width': 1 }));
        gn.append(s('text', { x: x + 52, y: y + 4, 'font-size': 12, fill: text }, n.label));
      } else {
        gn.append(s('circle', { cx: x, cy: y, r: n.index === selected ? 6 : n.isLeaf ? 3 : 4, fill: n.index === selected ? accent : surface, stroke: n.index === selected ? primary : text, 'stroke-width': n.index === selected ? 3 : 1.5 }));
        if (n.isLeaf) {
          const match = q !== '' && n.label.toLowerCase().includes(q);
          const dx = kind === 'rect' ? 7 : Math.cos(n.angle) >= 0 ? 8 : -8;
          const anchor = kind === 'rect' ? 'start' : Math.cos(n.angle) >= 0 ? 'start' : 'end';
          const dy = kind === 'rect' ? 4 : Math.sin(n.angle) * 6 + 4;
          const t = s('text', { x: x + dx, y: y + dy, 'font-size': 12, 'text-anchor': anchor, fill: text, 'font-weight': match || (colorOfPos(pos) !== null) ? 700 : 400 }, truncateName(n.label));
          if (match) { t.setAttribute('stroke', accent); t.setAttribute('stroke-width', '5'); t.setAttribute('paint-order', 'stroke'); }
          gn.append(t);
        } else if (n.node.label) {
          gn.append(s('text', { x: x + 6, y: y - 6, 'font-size': 10, fill: muted }, truncateName(n.node.label, 16)));
        }
      }
      if (showSupport && !n.isLeaf && n.node.support !== undefined && n.parent !== null) {
        const v = n.node.support; const low = v < LOW_SUPPORT_THRESHOLD;
        gn.append(s('text', { x: kind === 'rect' ? x - 6 : x + 6, y: kind === 'rect' ? y - 6 : y - 8, 'font-size': 10, 'text-anchor': kind === 'rect' ? 'end' : 'start', fill: low ? bad : muted, 'font-weight': low ? 700 : 400 }, `${Math.round(v)}${low ? '*' : ''}`));
      }
      if (n.negative) gn.append(s('text', { x: x - 14, y: y + 4, 'font-size': 12, fill: bad }, '⚠'));
      gn.addEventListener('click', (e) => { e.stopPropagation(); selectIndex(n.index); });
      nodeGroup.append(gn);
    });
    parts.push(nodeGroup);

    // scale bar (phylograms only)
    if (!cladogram) {
      const bar = niceLength(kind === 'rect' ? span * 0.2 : (span * 0.25));
      const w = bar * scale;
      const y0 = height - 14; const x0 = MARGIN;
      parts.push(s('line', { x1: x0, y1: y0, x2: x0 + w, y2: y0, stroke: text, 'stroke-width': 2 }), s('text', { x: x0, y: y0 - 6, 'font-size': 11, fill: text }, `${bar} (branch length)`));
    } else {
      parts.push(s('text', { x: MARGIN, y: height - 10, 'font-size': 11, fill: muted }, 'Cladogram: branch lengths are not drawn to scale.'));
    }
    g = s('g', { transform: `translate(${view.x} ${view.y}) scale(${view.k})` }) as SVGGElement;
    for (const p of parts) g.append(p);
    svg.append(g);
  };

  const applyView = (): void => { g?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); };
  const fitView = (): void => {
    const w = wrap.clientWidth || 800; const k = Math.min(1, w / content.w);
    view = { k, x: 0, y: 0 };
    applyView();
  };

  const selectIndex = (index: number | null): void => {
    selected = index;
    render();
    onSelect(getSelected());
  };
  const getSelected = (): LayoutNode | null => (lay && selected !== null ? (lay.nodes.find((n) => n.index === selected) ?? null) : null);

  svg.addEventListener('click', () => selectIndex(null));
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top; view = { k: view.k * f, x: mx - (mx - view.x) * f, y: my - (my - view.y) * f }; applyView(); }, { passive: false });
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; });
  svg.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x; const dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; view = { ...view, x: drag.vx + dx, y: drag.vy + dy }; applyView(); } });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('keydown', (e) => {
    if (!lay) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); selectIndex(navigate(lay, selected, e.key)); } // safe: the four arrow keys are the NavKey values
    else if (e.key === 'Enter') { e.preventDefault(); toggleCollapseSelected(); }
  });

  const toggleCollapseSelected = (): void => {
    const n = getSelected();
    if (!n || n.isLeaf || n.parent === null) return;
    if (collapsed.has(n.key)) collapsed.delete(n.key); else collapsed.add(n.key);
    render(); onChange();
  };
  onThemeChange(render);
  new ResizeObserver(() => { if (root.isConnected && wrap.clientWidth > 0 && lay === null) fitView(); }).observe(wrap);

  const serialise = (): string | null => {
    if (!tree) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement; // safe: cloneNode of an SVG element returns an SVG element
    clone.removeAttribute('tabindex');
    clone.setAttribute('xmlns', SVGNS);
    const gc = clone.querySelector('g');
    gc?.setAttribute('transform', 'translate(0 0) scale(1)');
    clone.setAttribute('width', String(content.w)); clone.setAttribute('height', String(content.h));
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  };

  return {
    root,
    setTree(t) { tree = t; selected = null; collapsed = new Set(); highlights.clear(); marked = new Set(); render(); fitView(); onSelect(null); },
    getTree: () => tree,
    setLayoutKind(k) { kind = k; render(); fitView(); },
    setCladogram(b) { cladogram = b; render(); },
    setShowSupport(b) { showSupport = b; render(); },
    select: selectIndex,
    getSelected,
    toggleCollapseSelected,
    expandAll() { collapsed = new Set(); render(); onChange(); },
    collapseKeys: () => [...collapsed],
    setHighlight(key, color) { if (color === null) highlights.delete(key); else highlights.set(key, color); render(); },
    clearHighlights() { highlights.clear(); render(); },
    setSearch(qs) { search = qs; render(); const q2 = qs.trim().toLowerCase(); return q2 === '' || !lay ? 0 : lay.nodes.filter((n) => n.isLeaf && n.label.toLowerCase().includes(q2)).length; },
    setMarked(ix) { marked = ix; render(); },
    zoom(f) { const w = wrap.clientWidth / 2; const h = 150; view = { k: view.k * f, x: w - (w - view.x) * f, y: h - (h - view.y) * f }; applyView(); },
    fit: fitView,
    layout: () => lay,
    toSvg: serialise,
    async toPng() {
      const text = serialise();
      if (text === null) return null;
      const img = new Image();
      const done = new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('Could not render the tree image.')); });
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`; // utf-8 safe base64 of the SVG text
      await done;
      const c = document.createElement('canvas');
      c.width = content.w * 2; c.height = content.h * 2;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0, content.w, content.h);
      return c.toDataURL('image/png');
    },
  };
}
