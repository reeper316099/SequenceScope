// Pure geometry for the score-matrix canvas (zoom, pan, hit-testing, alignment path). No DOM, so it is unit-tested.
import type { PairwiseAlignment } from '../shared/types';

/** View transform: `cs` = pixels per cell; (ox, oy) = position of cell (0,0)'s top-left corner inside the plot area. */
export interface View {
  cs: number;
  ox: number;
  oy: number;
}

export const MIN_CELL = 0.02;
export const MAX_CELL = 96;

/** Clamps a cell size to the allowed zoom range. */
export function clampCell(cs: number): number {
  return Math.min(MAX_CELL, Math.max(MIN_CELL, cs));
}

/** Zoom so the whole matrix fits the plot area, centred. */
export function fitView(rows: number, cols: number, plotW: number, plotH: number): View {
  const cs = clampCell(Math.min(plotW / Math.max(cols, 1), plotH / Math.max(rows, 1)));
  return { cs, ox: (plotW - cs * cols) / 2, oy: (plotH - cs * rows) / 2 };
}

/** Which cell is under plot-area point (px, py)? null if outside the matrix. */
export function cellAt(v: View, px: number, py: number, rows: number, cols: number): { i: number; j: number } | null {
  const j = Math.floor((px - v.ox) / v.cs);
  const i = Math.floor((py - v.oy) / v.cs);
  return i >= 0 && i < rows && j >= 0 && j < cols ? { i, j } : null;
}

/** Zoom by `factor` keeping the matrix point under (px, py) fixed. */
export function zoomAt(v: View, px: number, py: number, factor: number): View {
  const cs = clampCell(v.cs * factor);
  const k = cs / v.cs;
  return { cs, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
}

/** Range of cells (inclusive) that intersect the plot area. */
export function visibleRange(v: View, plotW: number, plotH: number, rows: number, cols: number): { i0: number; i1: number; j0: number; j1: number } {
  return {
    i0: Math.max(0, Math.floor(-v.oy / v.cs)),
    i1: Math.min(rows - 1, Math.floor((plotH - v.oy) / v.cs)),
    j0: Math.max(0, Math.floor(-v.ox / v.cs)),
    j1: Math.min(cols - 1, Math.floor((plotW - v.ox) / v.cs)),
  };
}

/** The DP cells (i, j) visited by an alignment path, from its start cell to its end cell. */
export function pathCells(aln: PairwiseAlignment): [number, number][] {
  let i = aln.startA;
  let j = aln.startB;
  const cells: [number, number][] = [[i, j]];
  for (let k = 0; k < aln.rowA.length; k++) {
    if (aln.rowA.charAt(k) !== '-') i++;
    if (aln.rowB.charAt(k) !== '-') j++;
    cells.push([i, j]);
  }
  return cells;
}

/** Linear interpolation between two RGB triples; t in [0,1]. */
export function mix(lo: readonly [number, number, number], hi: readonly [number, number, number], t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  return [Math.round(lo[0] + (hi[0] - lo[0]) * u), Math.round(lo[1] + (hi[1] - lo[1]) * u), Math.round(lo[2] + (hi[2] - lo[2]) * u)];
}

/** Parses "#rrggbb" into an RGB triple (falls back to black for anything else). */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || m[1] === undefined) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG) of an RGB colour. */
export function luminance(rgb: readonly [number, number, number]): number {
  const f = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
