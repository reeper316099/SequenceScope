// Score-matrix heatmap on a <canvas>: zoom/pan, axis letters, numbers and arrows for small matrices, traceback path,
// fill-progress for the stepper, keyboard cell navigation, and a text-table fallback. Large matrices are drawn as a
// max-pooled overview (each pixel summarises several cells) that becomes exact when zoomed in.
import type { Dp } from '../bio/pairwise';
import { clear, el } from './dom';
import { cellAt, fitView, mix, parseHex, visibleRange, zoomAt } from './matrixGeometry';
import type { View } from './matrixGeometry';
import { onThemeChange, token } from './theme';

export const INTERACTIVE_CELL_CAP = 250_000; // stepping + numbers only up to ~500 x 500 (see README caps)
const NEG_HALF = -500_000_000; // anything at or below this is an unreachable "minus infinity" state
const LEFT = 34;
const TOP = 26;

export type Layer = 'best' | 'M' | 'X' | 'Y';

export interface Progress {
  /** Number of interior cells filled so far (row-major). */
  filled: number;
  /** Number of traceback cells highlighted so far (counted from the end of the alignment). */
  pathShown: number;
  /** The cell the stepper is currently working on. */
  current: { i: number; j: number } | null;
}

export interface MatrixCanvas {
  root: HTMLElement;
  setDp(dp: Dp | null, path: readonly (readonly [number, number])[]): void;
  setProgress(p: Progress | null): void;
  select(cell: { i: number; j: number } | null): void;
  getSelected(): { i: number; j: number } | null;
  toPng(): string | null;
  valueAt(i: number, j: number): number | null;
}

/** Creates the matrix view. `onSelect` fires when the user clicks or moves the selection with the keyboard. */
export function createMatrixCanvas(onSelect: (cell: { i: number; j: number } | null) => void): MatrixCanvas {
  const root = el('div', 'matrix');
  const controls = el('div', 'matrix-controls');
  const layerSel = el('select', undefined, undefined, { 'aria-label': 'Matrix layer' });
  for (const [v, t] of [['best', 'Best of M, X, Y'], ['M', 'M (aligned pair)'], ['X', 'X (gap in B)'], ['Y', 'Y (gap in A)']] as const) layerSel.append(el('option', undefined, t, { value: v }));
  const zoomOut = el('button', 'btn btn-small', '−', { type: 'button', 'aria-label': 'Zoom out' });
  const zoomIn = el('button', 'btn btn-small', '+', { type: 'button', 'aria-label': 'Zoom in' });
  const fitBtn = el('button', 'btn btn-small', 'Fit', { type: 'button', 'aria-label': 'Fit matrix to view' });
  const arrowsLabel = el('label', 'check');
  const arrowsBox = el('input', undefined, undefined, { type: 'checkbox' });
  arrowsLabel.append(arrowsBox, document.createTextNode(' Arrows'));
  const tableLabel = el('label', 'check');
  const tableBox = el('input', undefined, undefined, { type: 'checkbox' });
  tableLabel.append(tableBox, document.createTextNode(' Text table'));
  controls.append(layerSel, zoomOut, zoomIn, fitBtn, arrowsLabel, tableLabel);

  const note = el('p', 'hint matrix-note');
  const stage = el('div', 'matrix-stage');
  const canvas = el('canvas', 'matrix-canvas', undefined, { tabindex: 0, role: 'img', 'aria-label': 'Score matrix heatmap. Use arrow keys to move between cells, plus and minus to zoom.' });
  const tableWrap = el('div', 'matrix-table-wrap');
  tableWrap.hidden = true;
  stage.append(canvas, tableWrap);
  const legend = el('div', 'legend');
  const legLo = el('span', 'mono', '');
  const legBar = el('span', 'legend-bar');
  const legHi = el('span', 'mono', '');
  legend.append(legLo, legBar, legHi);
  const hover = el('p', 'hint mono matrix-hover', 'Hover or click a cell for details.');
  root.append(controls, note, stage, legend, hover);

  let dp: Dp | null = null;
  let path: readonly (readonly [number, number])[] = [];
  let progress: Progress | null = null;
  let selected: { i: number; j: number } | null = null;
  let view: View = { cs: 10, ox: 0, oy: 0 };
  let fitted = true;
  let lo = 0;
  let hi = 1;
  let cssW = 600;
  let cssH = 420;
  let hoverCell: { i: number; j: number } | null = null;

  /** Value of one cell in the chosen layer, or null if that state is unreachable. */
  const valueAt = (i: number, j: number): number | null => {
    if (!dp) return null;
    const k = i * dp.cols + j;
    let v: number;
    if (dp.kind === 'linear') v = dp.H[k] ?? 0;
    else {
      const layer = layerSel.value as Layer; // safe: the select only offers the four Layer values
      v = layer === 'M' ? (dp.M[k] ?? 0) : layer === 'X' ? (dp.X[k] ?? 0) : layer === 'Y' ? (dp.Y[k] ?? 0) : Math.max(dp.M[k] ?? 0, dp.X[k] ?? 0, dp.Y[k] ?? 0);
    }
    return v <= NEG_HALF ? null : v;
  };

  /** Recomputes the colour range over reachable cells of the current layer. */
  const computeRange = (): void => {
    lo = Infinity; hi = -Infinity;
    if (dp) for (let i = 0; i < dp.rows; i++) for (let j = 0; j < dp.cols; j++) { const v = valueAt(i, j); if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    legLo.textContent = String(lo);
    legHi.textContent = String(hi);
  };

  const isFilled = (i: number, j: number): boolean => progress === null || dp === null || i === 0 || j === 0 || (i - 1) * (dp.cols - 1) + (j - 1) < progress.filled;

  const plotSize = (): { w: number; h: number } => ({ w: cssW - LEFT, h: cssH - TOP });

  /** Paints everything. */
  const draw = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const surface = token('--surface');
    const text = token('--text');
    const muted = token('--text-muted');
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, cssW, cssH);
    if (!dp) {
      ctx.fillStyle = muted;
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('The score matrix appears here once two valid sequences are entered.', 16, 40);
      return;
    }
    const { w: pw, h: ph } = plotSize();
    const loRgb = parseHex(token('--heat-lo'));
    const hiRgb = parseHex(token('--heat-hi'));
    const emptyRgb = parseHex(token('--surface-2'));
    const unreachable = parseHex(token('--border'));
    const colorOf = (i: number, j: number): [number, number, number] => {
      if (!isFilled(i, j)) return emptyRgb;
      const v = valueAt(i, j);
      return v === null ? unreachable : mix(loRgb, hiRgb, (v - lo) / (hi - lo));
    };
    const rows = dp.rows;
    const cols = dp.cols;
    const { cs, ox, oy } = view;
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT, TOP, pw, ph);
    ctx.clip();
    const r = visibleRange(view, pw, ph, rows, cols);
    if (cs >= 1.5) {
      const gap = cs >= 8 ? 1 : 0;
      for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) {
        const c = colorOf(i, j);
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(LEFT + ox + j * cs, TOP + oy + i * cs, cs - gap, cs - gap);
      }
    } else {
      // Overview: one canvas pixel covers several cells; show the MAX of up to 3 x 3 samples.
      const tmp = document.createElement('canvas');
      tmp.width = Math.max(1, Math.floor(pw));
      tmp.height = Math.max(1, Math.floor(ph));
      const tctx = tmp.getContext('2d');
      if (tctx) {
        const img = tctx.createImageData(tmp.width, tmp.height);
        const n = Math.min(3, Math.ceil(1 / cs));
        const bg = parseHex(surface);
        for (let y = 0; y < tmp.height; y++) for (let x = 0; x < tmp.width; x++) {
          let best = -Infinity; let any = false; let bi = 0; let bj = 0;
          for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
            const i = Math.floor((y + (sy + 0.5) / n - oy) / cs);
            const j = Math.floor((x + (sx + 0.5) / n - ox) / cs);
            if (i < 0 || j < 0 || i >= rows || j >= cols || !isFilled(i, j)) continue;
            const v = valueAt(i, j);
            if (v !== null && v > best) { best = v; bi = i; bj = j; any = true; }
          }
          const c = any ? colorOf(bi, bj) : (cellAt(view, x + 0.5, y + 0.5, rows, cols) ? emptyRgb : bg);
          const p = (y * tmp.width + x) * 4;
          img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        ctx.drawImage(tmp, LEFT, TOP);
      }
    }
    const visibleCells = (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1);
    // Numbers and arrows only when cells are big enough to read.
    if (cs >= 26 && visibleCells <= 4000) {
      ctx.font = `${Math.min(14, Math.floor(cs / 3))}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) {
        if (!isFilled(i, j)) continue;
        const v = valueAt(i, j);
        const c = colorOf(i, j);
        ctx.fillStyle = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 140 ? '#1d1730' : '#ffffff';
        ctx.fillText(v === null ? '−∞' : String(v), LEFT + ox + (j + 0.5) * cs, TOP + oy + (i + 0.5) * cs);
      }
    }
    if (arrowsBox.checked && dp.kind === 'linear' && cs >= 34 && visibleCells <= 2000) {
      ctx.strokeStyle = muted; ctx.lineWidth = 1.5;
      for (let i = Math.max(1, r.i0); i <= r.i1; i++) for (let j = Math.max(1, r.j0); j <= r.j1; j++) {
        if (!isFilled(i, j)) continue;
        const mask = dp.P[i * cols + j] ?? 0;
        const cx = LEFT + ox + (j + 0.5) * cs; const cy = TOP + oy + (i + 0.5) * cs;
        const arrow = (dx: number, dy: number): void => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - dx * cs * 0.34, cy - dy * cs * 0.34); ctx.stroke(); };
        if (mask & 1) arrow(1, 1);
        if (mask & 2) arrow(0, 1);
        if (mask & 4) arrow(1, 0);
      }
    }
    // Traceback path (amber): polyline through cell centres plus a ring on each shown cell.
    const shown = progress === null ? path.length : Math.min(path.length, progress.pathShown);
    if (shown > 0 && path.length > 0) {
      const accent = token('--accent');
      ctx.strokeStyle = accent; ctx.lineWidth = cs >= 6 ? 2.5 : 1.5;
      ctx.beginPath();
      for (let k = 0; k < shown; k++) {
        const cell = path[path.length - 1 - k];
        if (!cell) continue;
        const x = LEFT + ox + (cell[1] + 0.5) * cs; const y = TOP + oy + (cell[0] + 0.5) * cs;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (cs >= 8) for (let k = 0; k < shown; k++) {
        const cell = path[path.length - 1 - k];
        if (!cell) continue;
        ctx.strokeRect(LEFT + ox + cell[1] * cs + 1, TOP + oy + cell[0] * cs + 1, cs - 3, cs - 3);
      }
    }
    const ring = (cell: { i: number; j: number } | null, color: string, width: number): void => {
      if (!cell) return;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      const s = Math.max(cs, 6);
      ctx.strokeRect(LEFT + ox + cell.j * cs + (cs - s) / 2, TOP + oy + cell.i * cs + (cs - s) / 2, s, s);
    };
    ring(progress?.current ?? null, token('--secondary'), 3);
    ring(selected, token('--primary'), 3);
    ring(hoverCell, text, 1);
    ctx.restore();

    // Axes: sequence letters when cells are big enough, otherwise index ticks.
    ctx.fillStyle = text; ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const a = dp.strA; const b = dp.strB;
    const step = cs >= 12 ? 1 : Math.max(1, Math.ceil(30 / cs / 10) * 10);
    for (let j = Math.max(1, r.j0); j <= r.j1; j++) {
      const ay = TOP + Math.max(0, oy) - 12; // letters sit right above the matrix, even when it is centred in the plot
      if (cs >= 12) ctx.fillText(b.charAt(j - 1), LEFT + ox + (j + 0.5) * cs, ay);
      else if (j % step === 0) ctx.fillText(String(j), LEFT + ox + (j + 0.5) * cs, ay);
    }
    ctx.textAlign = 'right';
    for (let i = Math.max(1, r.i0); i <= r.i1; i++) {
      const ax = LEFT + Math.max(0, ox) - 6;
      if (cs >= 12) ctx.fillText(a.charAt(i - 1), ax, TOP + oy + (i + 0.5) * cs);
      else if (i % step === 0) ctx.fillText(String(i), ax + 2, TOP + oy + (i + 0.5) * cs);
    }
    note.textContent = cs < 1.5
      ? `Overview: each pixel shows the highest score among the cells it covers (${rows.toLocaleString('en-US')} × ${cols.toLocaleString('en-US')} cells). Zoom in with the + button or mouse wheel to see individual cells.`
      : `${rows - 1} × ${cols - 1} residues. Rows are sequence A, columns are sequence B. Amber path = traceback.`;
  };

  /** Rebuilds the text-table fallback (small matrices only). */
  const renderTable = (): void => {
    clear(tableWrap);
    if (!dp) return;
    if (dp.rows * dp.cols > 2500) { tableWrap.append(el('p', 'hint', 'The text table is only available for small matrices (up to about 50 × 50 cells).')); return; }
    const onPath = new Set(path.map(([i, j]) => `${i},${j}`));
    const table = el('table', 'matrix-table', undefined, { 'aria-label': 'Score matrix as a table' });
    const head = el('tr'); head.append(el('th'), el('th', undefined, '—'));
    for (const ch of dp.strB) head.append(el('th', undefined, ch));
    table.append(head);
    for (let i = 0; i < dp.rows; i++) {
      const tr = el('tr'); tr.append(el('th', undefined, i === 0 ? '—' : dp.strA.charAt(i - 1)));
      for (let j = 0; j < dp.cols; j++) {
        const v = valueAt(i, j);
        const td = el('td', onPath.has(`${i},${j}`) ? 'on-path' : undefined, v === null ? '−∞' : String(v));
        if (onPath.has(`${i},${j}`)) td.setAttribute('title', 'On the traceback path');
        tr.append(td);
      }
      table.append(tr);
    }
    tableWrap.append(table);
  };

  const resize = (): void => {
    const r = stage.getBoundingClientRect();
    cssW = Math.max(300, Math.floor(r.width));
    cssH = 420;
    canvas.style.height = `${cssH}px`;
    if (dp && fitted) view = fitView(dp.rows, dp.cols, cssW - LEFT, cssH - TOP);
    draw();
  };
  new ResizeObserver(() => { if (stage.isConnected && stage.clientWidth > 0) resize(); }).observe(stage);
  onThemeChange(draw);

  const setSelected = (cell: { i: number; j: number } | null, notify: boolean): void => {
    selected = cell;
    draw();
    if (notify) onSelect(cell);
  };

  const plotPoint = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - LEFT, y: e.clientY - r.top - TOP };
  };
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => { const p = plotPoint(e); drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false }; canvas.setPointerCapture(e.pointerId); void p; });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) { view = { ...view, ox: drag.ox + dx, oy: drag.oy + dy }; fitted = false; draw(); }
      return;
    }
    if (!dp) return;
    const p = plotPoint(e);
    const c = cellAt(view, p.x, p.y, dp.rows, dp.cols);
    hoverCell = c;
    hover.textContent = c ? describe(c.i, c.j) : 'Hover or click a cell for details.';
    draw();
  });
  canvas.addEventListener('pointerleave', () => { hoverCell = null; if (!drag) draw(); });
  canvas.addEventListener('pointerup', (e) => {
    const was = drag; drag = null;
    if (!was || was.moved || !dp) return;
    const p = plotPoint(e);
    setSelected(cellAt(view, p.x, p.y, dp.rows, dp.cols), true);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!dp) return;
    e.preventDefault();
    const p = plotPoint(e);
    view = zoomAt(view, p.x, p.y, e.deltaY < 0 ? 1.25 : 0.8); fitted = false; draw();
  }, { passive: false });
  const describe = (i: number, j: number): string => {
    if (!dp) return '';
    const v = valueAt(i, j);
    const ai = i === 0 ? '—' : dp.strA.charAt(i - 1);
    const bj = j === 0 ? '—' : dp.strB.charAt(j - 1);
    return `cell (${i}, ${j})  A: ${ai}  B: ${bj}  value: ${v === null ? '−∞ (unreachable)' : v}`;
  };
  canvas.addEventListener('keydown', (e) => {
    if (!dp) return;
    const s = selected ?? { i: 0, j: 0 };
    let next: { i: number; j: number } | null = null;
    if (e.key === 'ArrowUp') next = { i: Math.max(0, s.i - 1), j: s.j };
    else if (e.key === 'ArrowDown') next = { i: Math.min(dp.rows - 1, s.i + 1), j: s.j };
    else if (e.key === 'ArrowLeft') next = { i: s.i, j: Math.max(0, s.j - 1) };
    else if (e.key === 'ArrowRight') next = { i: s.i, j: Math.min(dp.cols - 1, s.j + 1) };
    else if (e.key === '+' || e.key === '=') { view = zoomAt(view, (cssW - LEFT) / 2, (cssH - TOP) / 2, 1.25); fitted = false; draw(); e.preventDefault(); return; }
    else if (e.key === '-') { view = zoomAt(view, (cssW - LEFT) / 2, (cssH - TOP) / 2, 0.8); fitted = false; draw(); e.preventDefault(); return; }
    if (next) {
      e.preventDefault(); e.stopPropagation();
      setSelected(next, true);
      hover.textContent = describe(next.i, next.j);
    }
  });
  zoomIn.addEventListener('click', () => { view = zoomAt(view, (cssW - LEFT) / 2, (cssH - TOP) / 2, 1.5); fitted = false; draw(); });
  zoomOut.addEventListener('click', () => { view = zoomAt(view, (cssW - LEFT) / 2, (cssH - TOP) / 2, 1 / 1.5); fitted = false; draw(); });
  fitBtn.addEventListener('click', () => { if (dp) { view = fitView(dp.rows, dp.cols, cssW - LEFT, cssH - TOP); fitted = true; draw(); } });
  layerSel.addEventListener('change', () => { computeRange(); renderTable(); draw(); });
  arrowsBox.addEventListener('change', draw);
  tableBox.addEventListener('change', () => { tableWrap.hidden = !tableBox.checked; canvas.hidden = tableBox.checked; renderTable(); });

  return {
    root,
    setDp(next, nextPath) {
      dp = next; path = nextPath; progress = null; selected = null; hoverCell = null;
      layerSel.hidden = !next || next.kind !== 'affine';
      arrowsLabel.hidden = !next || next.kind !== 'linear';
      layerSel.value = 'best';
      computeRange();
      if (dp) { const r = stage.getBoundingClientRect(); if (r.width > 0) cssW = Math.max(300, Math.floor(r.width)); view = fitView(dp.rows, dp.cols, cssW - LEFT, cssH - TOP); fitted = true; }
      canvas.style.height = `${cssH}px`;
      renderTable();
      draw();
    },
    setProgress(p) { progress = p; if (p?.current && dp && view.cs >= 4) { /* keep view; the ring shows the current cell */ } draw(); },
    select(cell) { setSelected(cell, false); },
    getSelected: () => selected,
    toPng: () => (dp ? canvas.toDataURL('image/png') : null),
    valueAt,
  };
}

