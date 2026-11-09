// Multiple-alignment viewer on a canvas: sequence names pinned on the left, a ruler, a conservation bar chart and a consensus
// row pinned on top, residues coloured by the colour-blind-safe palette (letters are ALWAYS drawn), and a selectable column range.
// The canvas only paints what is visible (it sits "sticky" inside a native scroll container), so large alignments stay fast.
import type { Alphabet } from '../shared/types';
import { conservation } from '../bio/conservation';
import type { Conservation } from '../bio/conservation';
import { el } from './dom';
import { residueClass } from './residueClass';
import { onThemeChange, token } from './theme';

export type Metric = 'identity' | 'conservation' | 'entropy';

export const NAME_W = 176;
const RULER_H = 20;
const BAR_H = 54;
const CONS_H = 20;
const HEADER_H = RULER_H + BAR_H + CONS_H;
const ROW_H = 18;
const MAX_PNG_PIXELS = 36_000_000;

export interface MsaCanvas {
  root: HTMLElement;
  setData(ids: readonly string[] | null, rows: readonly string[] | null, alphabet: Alphabet): void;
  setMetric(m: Metric): void;
  setCellWidth(px: number): void;
  /** 1-based inclusive column range, or null. */
  getSelection(): { from: number; to: number } | null;
  setSelection(sel: { from: number; to: number } | null): void;
  onSelection(fn: (sel: { from: number; to: number } | null) => void): void;
  getConservation(): Conservation | null;
  toPng(): string | null;
}

/** Builds the viewer. */
export function createMsaCanvas(): MsaCanvas {
  const root = el('div', 'msa-viewer');
  const scroller = el('div', 'msa-scroll', undefined, { tabindex: 0, role: 'region', 'aria-label': 'Multiple sequence alignment. Scroll to move; drag over columns to select a range. A text version is available below.' });
  const spacer = el('div', 'msa-spacer');
  const canvas = el('canvas', 'msa-canvas');
  scroller.append(spacer, canvas);
  root.append(scroller);

  let ids: readonly string[] = [];
  let rows: readonly string[] = [];
  let alphabet: Alphabet = 'dna';
  let cons: Conservation | null = null;
  let metric: Metric = 'identity';
  let cw = 12;
  let sel: { from: number; to: number } | null = null;
  let selCb: (s: { from: number; to: number } | null) => void = () => undefined;

  const cols = (): number => rows[0]?.length ?? 0;
  const metricValue = (c: number): number => {
    const s = cons?.columns[c];
    if (!s) return 0;
    if (metric === 'identity') return s.identity;
    if (metric === 'conservation') return s.conservation;
    return 1 - Math.min(1, s.entropy / Math.log2(alphabet === 'protein' ? 20 : 4)); // low entropy = tall bar
  };

  /** Paints the alignment into `ctx` for the window starting at (sx, sy) of size (W, H). */
  const paint = (ctx: CanvasRenderingContext2D, sx: number, sy: number, W: number, H: number): void => {
    const surface = token('--surface'); const text = token('--text'); const muted = token('--text-muted'); const border = token('--border'); const primary = token('--primary'); const accent = token('--accent'); const surf2 = token('--surface-2');
    const resText = token('--res-text');
    const cache = new Map<string, string>();
    const colour = (cls: string): string => { let c = cache.get(cls); if (c === undefined) { c = cls === 'r-gap' ? 'transparent' : token(`--res-${cls.slice(2)}`); cache.set(cls, c); } return c; };
    ctx.fillStyle = surface; ctx.fillRect(0, 0, W, H);
    const nCols = cols(); const nRows = rows.length;
    const c0 = Math.max(0, Math.floor(sx / cw)); const c1 = Math.min(nCols - 1, Math.floor((sx + W - NAME_W) / cw));
    const r0 = Math.max(0, Math.floor(sy / ROW_H)); const r1 = Math.min(nRows - 1, Math.floor((sy + H - HEADER_H) / ROW_H));
    const x = (c: number): number => NAME_W + c * cw - sx;
    // residues
    ctx.font = `${Math.max(9, Math.min(13, cw - 1))}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = r0; r <= r1; r++) {
      const y = HEADER_H + r * ROW_H - sy; const row = rows[r] as string;
      for (let c = c0; c <= c1; c++) {
        const ch = row.charAt(c);
        const cls = residueClass(ch, alphabet);
        if (ch !== '-') { ctx.fillStyle = colour(cls); ctx.fillRect(x(c), y, cw - (cw >= 8 ? 1 : 0), ROW_H - 1); }
        if (cw >= 7) { ctx.fillStyle = ch === '-' ? accent : resText; ctx.fillText(ch, x(c) + cw / 2, y + ROW_H / 2); }
      }
    }
    // selection overlay
    if (sel) {
      const a = x(sel.from - 1); const b = x(sel.to);
      ctx.fillStyle = 'rgba(91,52,166,0.18)'; ctx.fillRect(Math.max(NAME_W, a), HEADER_H, Math.max(0, b - Math.max(NAME_W, a)), H - HEADER_H);
      ctx.strokeStyle = primary; ctx.lineWidth = 2; ctx.strokeRect(Math.max(NAME_W, a) + 1, 1, Math.max(0, b - Math.max(NAME_W, a) - 2), H - 2);
    }
    // header background (pinned)
    ctx.fillStyle = surface; ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = surf2; ctx.fillRect(NAME_W, RULER_H, W - NAME_W, BAR_H);
    // ruler + bars + consensus
    ctx.textBaseline = 'middle';
    for (let c = c0; c <= c1; c++) {
      const h = Math.max(1, metricValue(c) * (BAR_H - 6));
      ctx.fillStyle = primary; ctx.fillRect(x(c), RULER_H + BAR_H - 2 - h, Math.max(1, cw - 1), h);
      if ((c + 1) % 10 === 0 || c === 0) { ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(c + 1), x(c) + cw / 2, RULER_H / 2); ctx.fillRect(x(c) + cw / 2, RULER_H - 4, 1, 4); }
      const k = cons?.consensus.charAt(c) ?? ' ';
      if (cw >= 7) { ctx.fillStyle = text; ctx.font = `bold ${Math.max(9, Math.min(13, cw - 1))}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'center'; ctx.fillText(k, x(c) + cw / 2, RULER_H + BAR_H + CONS_H / 2); }
    }
    // pinned names column
    ctx.fillStyle = surface; ctx.fillRect(0, 0, NAME_W, H);
    ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(metric === 'identity' ? 'identity' : metric === 'conservation' ? 'conservation' : 'low entropy', 6, RULER_H + BAR_H / 2);
    ctx.fillText('consensus', 6, RULER_H + BAR_H + CONS_H / 2);
    ctx.fillStyle = text; ctx.font = '12px ui-monospace, Menlo, monospace';
    for (let r = r0; r <= r1; r++) { const nm = ids[r] ?? ''; ctx.fillText(nm.length > 24 ? `${nm.slice(0, 23)}…` : nm, 6, HEADER_H + r * ROW_H - sy + ROW_H / 2); }
    ctx.fillStyle = border; ctx.fillRect(NAME_W - 1, 0, 1, H); ctx.fillRect(0, HEADER_H - 1, W, 1);
    // headers sit above rows: redraw name header cover so scrolled rows do not show through
  };

  const draw = (): void => {
    const W = Math.max(300, scroller.clientWidth); const H = Math.max(HEADER_H + ROW_H, scroller.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (rows.length === 0) { ctx.fillStyle = token('--surface'); ctx.fillRect(0, 0, W, H); ctx.fillStyle = token('--text-muted'); ctx.font = '14px system-ui, sans-serif'; ctx.fillText('The alignment appears here after you run the aligner.', 16, 40); return; }
    paint(ctx, scroller.scrollLeft, scroller.scrollTop, W, H);
  };

  const resize = (): void => {
    const contentH = HEADER_H + rows.length * ROW_H + 2;
    scroller.style.height = `${Math.min(Math.max(contentH, 120), 520)}px`;
    spacer.style.width = `${NAME_W + cols() * cw + 8}px`;
    spacer.style.height = `${contentH}px`;
    draw();
  };
  scroller.addEventListener('scroll', () => requestAnimationFrame(draw));
  new ResizeObserver(() => { if (scroller.isConnected && scroller.clientWidth > 0) draw(); }).observe(scroller);
  onThemeChange(draw);

  const colAt = (e: PointerEvent): number | null => {
    const r = scroller.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < NAME_W) return null;
    const c = Math.floor((px - NAME_W + scroller.scrollLeft) / cw);
    return c >= 0 && c < cols() ? c : null;
  };
  let anchor: number | null = null;
  let moved = false;
  canvas.addEventListener('pointerdown', (e) => { const c = colAt(e); if (c === null) return; anchor = c; moved = false; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (anchor === null) return; const c = colAt(e); if (c === null) return; moved = true; sel = { from: Math.min(anchor, c) + 1, to: Math.max(anchor, c) + 1 }; draw(); selCb(sel); });
  canvas.addEventListener('pointerup', (e) => { if (anchor !== null && !moved) { const c = colAt(e); sel = c === null ? null : { from: c + 1, to: c + 1 }; draw(); selCb(sel); } anchor = null; });
  scroller.addEventListener('keydown', (e) => { if (e.key === 'Escape') { sel = null; draw(); selCb(null); } });

  return {
    root,
    setData(i, r, a) {
      ids = i ?? []; rows = r ?? []; alphabet = a; sel = null;
      cons = rows.length > 0 ? conservation(rows, a) : null;
      scroller.scrollLeft = 0; scroller.scrollTop = 0;
      resize();
    },
    setMetric(m) { metric = m; draw(); },
    setCellWidth(px) { cw = px; resize(); },
    getSelection: () => sel,
    setSelection(s) { sel = s === null ? null : { from: Math.max(1, Math.min(s.from, s.to)), to: Math.min(cols(), Math.max(s.from, s.to)) }; if (sel && sel.from > sel.to) sel = null; draw(); },
    onSelection(fn) { selCb = fn; },
    getConservation: () => cons,
    toPng() {
      if (rows.length === 0) return null;
      const W = NAME_W + cols() * cw + 8; const H = HEADER_H + rows.length * ROW_H + 2;
      if (W * H > MAX_PNG_PIXELS) return null;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      paint(ctx, 0, 0, W, H);
      return c.toDataURL('image/png');
    },
  };
}
