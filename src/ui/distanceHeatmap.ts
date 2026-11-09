// Distance-matrix heatmap on a canvas: names on both axes, colour by distance, saturated / undefined cells clearly marked
// (hatched + "S" / "?"), hover and keyboard cell inspection. Colour is never the only signal: the exact value is shown on hover.
import type { DistanceMatrix } from '../shared/types';
import { DIST_OK, DIST_SATURATED } from '../shared/types';
import { el } from './dom';
import { mix, parseHex } from './matrixGeometry';
import { onThemeChange, token } from './theme';

export interface Heatmap {
  root: HTMLElement;
  setMatrix(m: DistanceMatrix | null): void;
}

const MAXLABEL = 18;
/** Shortens long names for axis labels (full name appears in the hover text). */
const short = (s: string): string => (s.length > MAXLABEL ? `${s.slice(0, MAXLABEL - 1)}…` : s);

/** Builds the heatmap component. */
export function createHeatmap(): Heatmap {
  const root = el('div', 'heatmap');
  const canvas = el('canvas', 'heatmap-canvas', undefined, { tabindex: 0, role: 'img', 'aria-label': 'Distance heatmap. Arrow keys move between cells; the cell value is shown below.' });
  const legend = el('div', 'legend');
  const lo = el('span', 'mono', '0');
  const bar = el('span', 'legend-bar');
  const hi = el('span', 'mono', '');
  const keyNote = el('span', 'hint', ' Hatched “S” = saturated (correction undefined) · “?” = no comparable sites');
  legend.append(lo, bar, hi, keyNote);
  const caption = el('p', 'hint mono heatmap-caption', 'Hover or focus a cell to read its value.', { 'aria-live': 'polite' });
  root.append(canvas, legend, caption);

  let m: DistanceMatrix | null = null;
  let cell = 20;
  let sel: { i: number; j: number } | null = null;
  const LEFT = 130;
  const TOP = 96;
  let maxV = 1;

  const describe = (i: number, j: number): string => {
    if (!m) return '';
    const k = i * m.n + j;
    const st = m.status[k];
    const v = st === DIST_OK ? `${(m.values[k] as number).toFixed(5)}` : st === DIST_SATURATED ? 'saturated: the correction is undefined (too many multiple substitutions to count)' : 'undefined: no comparable sites';
    return `${m.names[i]} vs ${m.names[j]}: ${v}  (${m.compared[k]} compared sites)`;
  };

  const draw = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const n = m?.n ?? 0;
    const w = Math.max(320, root.clientWidth || 640);
    cell = Math.max(6, Math.min(34, Math.floor((w - LEFT - 10) / Math.max(n, 1))));
    const cssW = LEFT + n * cell + 10;
    const cssH = TOP + n * cell + 10;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = token('--surface');
    ctx.fillRect(0, 0, cssW, cssH);
    if (!m) { ctx.fillStyle = token('--text-muted'); ctx.font = '14px system-ui, sans-serif'; ctx.fillText('The heatmap appears here once a distance matrix is computed.', 12, 28); return; }
    const loC = parseHex(token('--heat-lo')); const hiC = parseHex(token('--heat-hi'));
    maxV = 0;
    for (let k = 0; k < n * n; k++) if (m.status[k] === DIST_OK) maxV = Math.max(maxV, m.values[k] as number);
    if (maxV <= 0) maxV = 1;
    hi.textContent = maxV.toFixed(3);
    const text = token('--text'); const border = token('--border'); const bad = token('--bad');
    ctx.font = `${Math.min(12, Math.max(8, cell - 2))}px ui-monospace, Menlo, monospace`;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const k = i * n + j; const st = m.status[k];
      const x = LEFT + j * cell; const y = TOP + i * cell;
      if (st === DIST_OK) { const c = mix(loC, hiC, (m.values[k] as number) / maxV); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(x, y, cell - 1, cell - 1); }
      else {
        ctx.fillStyle = token('--surface-2'); ctx.fillRect(x, y, cell - 1, cell - 1);
        ctx.strokeStyle = bad; ctx.lineWidth = 1; ctx.beginPath();
        for (let d = -cell; d < cell; d += 4) { ctx.moveTo(x + Math.max(0, d), y + Math.max(0, -d)); ctx.lineTo(x + Math.min(cell - 1, d + cell), y + Math.min(cell - 1, cell - d)); }
        ctx.stroke();
        if (cell >= 12) { ctx.fillStyle = bad; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st === DIST_SATURATED ? 'S' : '?', x + cell / 2, y + cell / 2); }
      }
    }
    ctx.fillStyle = text; ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      ctx.textAlign = 'right'; ctx.fillText(short(m.names[i] ?? ''), LEFT - 6, TOP + i * cell + cell / 2);
      ctx.save(); ctx.translate(LEFT + i * cell + cell / 2, TOP - 6); ctx.rotate(-Math.PI / 3); ctx.textAlign = 'left'; ctx.fillText(short(m.names[i] ?? ''), 0, 0); ctx.restore();
    }
    if (sel) { ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.strokeRect(LEFT + sel.j * cell, TOP + sel.i * cell, cell - 1, cell - 1); }
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(LEFT - 0.5, TOP - 0.5, n * cell + 0.5, n * cell + 0.5);
  };

  const at = (e: PointerEvent): { i: number; j: number } | null => {
    if (!m) return null;
    const r = canvas.getBoundingClientRect();
    const j = Math.floor((e.clientX - r.left - LEFT) / cell); const i = Math.floor((e.clientY - r.top - TOP) / cell);
    return i >= 0 && j >= 0 && i < m.n && j < m.n ? { i, j } : null;
  };
  canvas.addEventListener('pointermove', (e) => { const c = at(e); if (c) { sel = c; caption.textContent = describe(c.i, c.j); draw(); } });
  canvas.addEventListener('click', (e) => { const c = at(e); if (c) { sel = c; caption.textContent = describe(c.i, c.j); draw(); } });
  canvas.addEventListener('keydown', (e) => {
    if (!m) return;
    const s = sel ?? { i: 0, j: 0 };
    const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = d[e.key];
    if (!step) return;
    e.preventDefault(); e.stopPropagation();
    sel = { i: Math.min(m.n - 1, Math.max(0, s.i + step[0])), j: Math.min(m.n - 1, Math.max(0, s.j + step[1])) };
    caption.textContent = describe(sel.i, sel.j);
    draw();
  });
  new ResizeObserver(() => { if (root.isConnected && root.clientWidth > 0) draw(); }).observe(root);
  onThemeChange(draw);
  draw();
  return { root, setMatrix(next) { m = next; sel = null; caption.textContent = 'Hover or focus a cell to read its value.'; draw(); } };
}
