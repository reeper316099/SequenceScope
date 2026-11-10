// Pairwise alignment by dynamic programming: Needleman-Wunsch (global) and Smith-Waterman (local), each with
// linear gaps (one matrix H) or affine gaps (Gotoh's three matrices M, X, Y). See ALGORITHMS.md sections 1-3.
//
// Conventions (all documented in ALGORITHMS.md):
//  * Penalties are positive numbers; internally scores are NEGATIVE for gaps. Affine: gap of length k costs open + (k-1)*extend.
//  * Traceback preference on ties: diagonal, then up (gap in B), then left (gap in A); in affine, previous state M, X, Y.
//  * End gaps are penalised in global mode. Local alignments are reported in minimal form (they stop at a zero cell).
//  * Co-optimal alignments can be enumerated up to a hard cap.
//
// Memory per cell: linear = Int32 H (4 B) + Uint8 pointers (1 B) = 5 B; affine = 3 x Int32 (12 B) + Uint16 pointers (2 B) = 14 B.
import type { AlignMode, CellInfo, DpSnapshot, PairwiseAlignment } from '../shared/types';
import { BioError } from './errors';
import { encodeResidues } from './scoring';
import type { CompiledScoring } from './scoring';
import { i32, u16, u8 } from './typed';

export const MAX_DP_CELLS = 5001 * 5001; // (m+1)*(n+1) hard cap = two 5,000-residue sequences: ~125 MB linear, ~350 MB affine
export const MAX_ENUMERATED_ALIGNMENTS = 1000; // default cap for co-optimal enumeration
const NEG = -1_000_000_000; // "minus infinity" that cannot overflow Int32 when a penalty is subtracted once
const ENDS_CAP = 10_000; // max tied local end cells remembered

// Linear pointer bits: which predecessors achieve the maximum.
const L_DIAG = 1;
const L_UP = 2;
const L_LEFT = 4;
// Affine pointer layout in a Uint16: bits 0-2 = predecessor states of M (M=1, X=2, Y=4), bit 3 = local start,
// bits 4-6 = predecessor states of X, bits 7-9 = predecessor states of Y.
const A_START = 8;
const A_X_SHIFT = 4;
const A_Y_SHIFT = 7;

/** One alignment column type: M = both residues, X = residue of A against a gap, Y = residue of B against a gap. */
type Op = 'M' | 'X' | 'Y';

interface DpBase {
  mode: AlignMode;
  strA: string;
  strB: string;
  codesA: Uint8Array;
  codesB: Uint8Array;
  rows: number; // m + 1
  cols: number; // n + 1
  scoring: CompiledScoring;
  /** Optimal score (local: 0 if no positive-scoring region exists). */
  score: number;
  /** Cells where an optimal traceback may start: linear = flat cell index; affine = flat index * 3 + state. */
  ends: number[];
}
export interface LinearDp extends DpBase {
  kind: 'linear';
  H: Int32Array;
  P: Uint8Array;
}
export interface AffineDp extends DpBase {
  kind: 'affine';
  M: Int32Array;
  X: Int32Array;
  Y: Int32Array;
  P: Uint16Array;
}
export type Dp = LinearDp | AffineDp;

/** Refuses requests whose DP tables would exceed the memory cap (typed error, not a crash). */
export function assertWithinCap(m: number, n: number, affine: boolean): void {
  const cells = (m + 1) * (n + 1);
  if (cells > MAX_DP_CELLS) {
    const mb = Math.round((cells * (affine ? 14 : 5)) / 1048576);
    throw new BioError('too-large', `Aligning ${m} x ${n} residues needs about ${mb} MB (${cells.toLocaleString('en-US')} cells); the limit is ${MAX_DP_CELLS.toLocaleString('en-US')} cells.`);
  }
}

/** Fills the DP tables (Eq. 1-3 in ALGORITHMS.md) and records which predecessors achieve each maximum. */
export function fillMatrix(a: string, b: string, mode: AlignMode, scoring: CompiledScoring): Dp {
  assertWithinCap(a.length, b.length, scoring.affine);
  const codesA = encodeResidues(a, scoring);
  const codesB = encodeResidues(b, scoring);
  return scoring.affine ? fillAffine(a, b, codesA, codesB, mode, scoring) : fillLinear(a, b, codesA, codesB, mode, scoring);
}

/** Linear-gap fill: H[i][j] = max(H[i-1][j-1]+s, H[i-1][j]-g, H[i][j-1]-g) (and 0 for local). */
function fillLinear(strA: string, strB: string, codesA: Uint8Array, codesB: Uint8Array, mode: AlignMode, sc: CompiledScoring): LinearDp {
  const m = codesA.length;
  const n = codesB.length;
  const w = n + 1;
  const K = sc.classes;
  const T = sc.table;
  const g = sc.gapOpen; // linear: open === extend === g
  const local = mode === 'local';
  const H = new Int32Array((m + 1) * w);
  const P = new Uint8Array((m + 1) * w);
  if (!local) {
    for (let i = 1; i <= m; i++) { H[i * w] = -i * g; P[i * w] = L_UP; } // H[i][0] = -i*g
    for (let j = 1; j <= n; j++) { H[j] = -j * g; P[j] = L_LEFT; } // H[0][j] = -j*g
  }
  let best = 0;
  let ends: number[] = [];
  for (let i = 1; i <= m; i++) {
    const row = i * w;
    const prow = row - w;
    const ai = u8(codesA, i - 1) * K;
    for (let j = 1; j <= n; j++) {
      const d = i32(H, prow + j - 1) + i32(T, ai + u8(codesB, j - 1)); // diagonal: align a_i with b_j
      const up = i32(H, prow + j) - g; // a_i against a gap
      const left = i32(H, row + j - 1) - g; // b_j against a gap
      let v = d;
      if (up > v) v = up;
      if (left > v) v = left;
      if (local) {
        if (v <= 0) continue; // H stays 0, pointer 0: traceback stops here
        if (v > best) { best = v; ends = [row + j]; } else if (v === best && ends.length < ENDS_CAP) ends.push(row + j);
      }
      H[row + j] = v;
      P[row + j] = (d === v ? L_DIAG : 0) | (up === v ? L_UP : 0) | (left === v ? L_LEFT : 0);
    }
  }
  const score = local ? best : i32(H, m * w + n);
  return { kind: 'linear', mode, strA, strB, codesA, codesB, rows: m + 1, cols: w, scoring: sc, score, ends: local ? ends : [m * w + n], H, P };
}

/** Clamps a value at NEG so repeated penalties can never overflow Int32. */
function clampNeg(v: number): number {
  return v < NEG ? NEG : v;
}

/** Gotoh fill: M (aligned pair), X (A residue vs gap), Y (B residue vs gap); see ALGORITHMS.md section 2. */
function fillAffine(strA: string, strB: string, codesA: Uint8Array, codesB: Uint8Array, mode: AlignMode, sc: CompiledScoring): AffineDp {
  const m = codesA.length;
  const n = codesB.length;
  const w = n + 1;
  const K = sc.classes;
  const T = sc.table;
  const open = sc.gapOpen;
  const ext = sc.gapExtend;
  const local = mode === 'local';
  const size = (m + 1) * w;
  const M = new Int32Array(size).fill(NEG);
  const X = new Int32Array(size).fill(NEG);
  const Y = new Int32Array(size).fill(NEG);
  const P = new Uint16Array(size);
  if (!local) {
    M[0] = 0;
    for (let i = 1; i <= m; i++) { // leading gap in B: first column pays open, later ones extend
      X[i * w] = clampNeg(-open - (i - 1) * ext);
      P[i * w] = (i === 1 ? 1 : 2) << A_X_SHIFT; // from M (open) or from X (extend)
    }
    for (let j = 1; j <= n; j++) {
      Y[j] = clampNeg(-open - (j - 1) * ext);
      P[j] = (j === 1 ? 1 : 4) << A_Y_SHIFT; // from M (open) or from Y (extend)
    }
  }
  let best = 0;
  let ends: number[] = [];
  for (let i = 1; i <= m; i++) {
    const row = i * w;
    const prow = row - w;
    const ai = u8(codesA, i - 1) * K;
    for (let j = 1; j <= n; j++) {
      const idx = row + j;
      // M: best of the three states at (i-1,j-1) plus s(a_i,b_j); local may also start fresh (value 0).
      const pi = prow + j - 1;
      const pm = i32(M, pi);
      const px = i32(X, pi);
      const py = i32(Y, pi);
      let pb = pm;
      if (px > pb) pb = px;
      if (py > pb) pb = py;
      const s = i32(T, ai + u8(codesB, j - 1));
      let mv: number;
      let mmask: number;
      if (local && pb <= 0) { mv = s; mmask = A_START; } else {
        mv = clampNeg(pb + s);
        mmask = (pm === pb ? 1 : 0) | (px === pb ? 2 : 0) | (py === pb ? 4 : 0);
      }
      M[idx] = mv;
      if (local) {
        if (mv > best) { best = mv; ends = [idx * 3]; } else if (mv === best && mv > 0 && ends.length < ENDS_CAP) ends.push(idx * 3);
      }
      // X: gap column consuming a_i. Open from M or Y (pays open), or extend X (pays extend).
      const ui = prow + j;
      const xm = i32(M, ui) - open;
      const xx = i32(X, ui) - ext;
      const xy = i32(Y, ui) - open;
      let xv = xm;
      if (xx > xv) xv = xx;
      if (xy > xv) xv = xy;
      const xmask = (xm === xv ? 1 : 0) | (xx === xv ? 2 : 0) | (xy === xv ? 4 : 0);
      X[idx] = clampNeg(xv);
      // Y: gap column consuming b_j. Open from M or X, or extend Y.
      const li = row + j - 1;
      const ym = i32(M, li) - open;
      const yx = i32(X, li) - open;
      const yy = i32(Y, li) - ext;
      let yv = ym;
      if (yx > yv) yv = yx;
      if (yy > yv) yv = yy;
      const ymask = (ym === yv ? 1 : 0) | (yx === yv ? 2 : 0) | (yy === yv ? 4 : 0);
      Y[idx] = clampNeg(yv);
      P[idx] = mmask | (xmask << A_X_SHIFT) | (ymask << A_Y_SHIFT);
    }
  }
  let score: number;
  let endList: number[];
  if (local) {
    score = best;
    endList = best > 0 ? ends : [];
  } else {
    const last = m * w + n;
    const vals = [i32(M, last), i32(X, last), i32(Y, last)];
    score = Math.max(vals[0] ?? NEG, vals[1] ?? NEG, vals[2] ?? NEG);
    endList = [];
    for (let st = 0; st < 3; st++) if (vals[st] === score) endList.push(last * 3 + st);
  }
  return { kind: 'affine', mode, strA, strB, codesA, codesB, rows: m + 1, cols: w, scoring: sc, score, ends: endList, M, X, Y, P };
}

interface Option {
  i: number;
  j: number;
  state: number;
  op: Op;
  end?: true; // after taking this step the local alignment is finished
}

/** Predecessor options of a cell/state in preference order (diagonal, up, left; or states M, X, Y). */
function neighbors(dp: Dp, i: number, j: number, state: number): Option[] {
  const idx = i * dp.cols + j;
  if (dp.kind === 'linear') {
    const mask = u8(dp.P, idx);
    const out: Option[] = [];
    if (mask & L_DIAG) out.push({ i: i - 1, j: j - 1, state: 0, op: 'M' });
    if (mask & L_UP) out.push({ i: i - 1, j, state: 0, op: 'X' });
    if (mask & L_LEFT) out.push({ i, j: j - 1, state: 0, op: 'Y' });
    return out;
  }
  const p = u16(dp.P, idx);
  if (state === 0 && (p & A_START) !== 0) return [{ i: i - 1, j: j - 1, state: 0, op: 'M', end: true }];
  const bits = state === 0 ? p & 7 : state === 1 ? (p >> A_X_SHIFT) & 7 : (p >> A_Y_SHIFT) & 7;
  const di = state === 1 ? 1 : state === 0 ? 1 : 0;
  const dj = state === 2 ? 1 : state === 0 ? 1 : 0;
  const op: Op = state === 0 ? 'M' : state === 1 ? 'X' : 'Y';
  const out: Option[] = [];
  for (let st = 0; st < 3; st++) if ((bits & (1 << st)) !== 0) out.push({ i: i - di, j: j - dj, state: st, op });
  return out;
}

/** Converts traceback-order operations into the two gapped rows and original-sequence coordinates. */
function toAlignment(dp: Dp, opsBackward: readonly Op[], startI: number, startJ: number, endI: number, endJ: number): PairwiseAlignment {
  let i = startI;
  let j = startJ;
  const ra: string[] = [];
  const rb: string[] = [];
  for (let k = opsBackward.length - 1; k >= 0; k--) {
    const op = opsBackward[k];
    if (op === 'M') { ra.push(dp.strA.charAt(i++)); rb.push(dp.strB.charAt(j++)); }
    else if (op === 'X') { ra.push(dp.strA.charAt(i++)); rb.push('-'); }
    else { ra.push('-'); rb.push(dp.strB.charAt(j++)); }
  }
  return { mode: dp.mode, score: dp.score, rowA: ra.join(''), rowB: rb.join(''), startA: startI, endA: endI, startB: startJ, endB: endJ };
}

/** Empty alignment for local searches with no positive-scoring region. */
function emptyAlignment(dp: Dp): PairwiseAlignment {
  return { mode: dp.mode, score: 0, rowA: '', rowB: '', startA: 0, endA: 0, startB: 0, endB: 0 };
}

/** Deterministic traceback: starts at the first optimal end and always takes the first (preferred) predecessor. */
export function tracebackFirst(dp: Dp): PairwiseAlignment {
  const first = dp.ends[0];
  if (first === undefined) return emptyAlignment(dp);
  const affine = dp.kind === 'affine';
  const cell = affine ? Math.floor(first / 3) : first;
  let state = affine ? first % 3 : 0;
  let i = Math.floor(cell / dp.cols);
  let j = cell % dp.cols;
  const endI = i;
  const endJ = j;
  const ops: Op[] = [];
  for (;;) {
    const opts = neighbors(dp, i, j, state);
    const o = opts[0];
    if (o === undefined) break;
    ops.push(o.op);
    i = o.i; j = o.j; state = o.state;
    if (o.end === true) break;
  }
  return toAlignment(dp, ops, i, j, endI, endJ);
}

interface Frame {
  i: number;
  j: number;
  state: number;
  opts: Option[];
  k: number;
  viaOp: boolean;
}

/** Enumerates co-optimal alignments by depth-first search over tied predecessors, stopping at `cap`. */
export function tracebackAll(dp: Dp, cap = MAX_ENUMERATED_ALIGNMENTS): { alignments: PairwiseAlignment[]; capped: boolean } {
  if (!Number.isInteger(cap) || cap < 1) throw new BioError('invalid-argument', 'Enumeration cap must be a positive integer.');
  const results: PairwiseAlignment[] = [];
  if (dp.ends.length === 0) return { alignments: [emptyAlignment(dp)], capped: false };
  const affine = dp.kind === 'affine';
  let capped = false;
  for (const e of dp.ends) {
    const cell = affine ? Math.floor(e / 3) : e;
    const endI = Math.floor(cell / dp.cols);
    const endJ = cell % dp.cols;
    const stack: Frame[] = [{ i: endI, j: endJ, state: affine ? e % 3 : 0, opts: [], k: 0, viaOp: false }];
    const top0 = stack[0];
    if (top0 === undefined) continue;
    top0.opts = neighbors(dp, top0.i, top0.j, top0.state);
    const ops: Op[] = [];
    const record = (si: number, sj: number): boolean => {
      if (results.length >= cap) { capped = true; return false; }
      results.push(toAlignment(dp, ops, si, sj, endI, endJ));
      return true;
    };
    if (top0.opts.length === 0 && !record(endI, endJ)) return { alignments: results, capped };
    while (stack.length > 0) {
      const f = stack[stack.length - 1];
      if (f === undefined) break;
      if (f.k >= f.opts.length) { stack.pop(); if (f.viaOp) ops.pop(); continue; }
      const o = f.opts[f.k++];
      if (o === undefined) continue;
      ops.push(o.op);
      const childOpts = o.end === true ? [] : neighbors(dp, o.i, o.j, o.state);
      if (childOpts.length === 0) {
        if (!record(o.i, o.j)) return { alignments: results, capped };
        ops.pop();
      } else {
        stack.push({ i: o.i, j: o.j, state: o.state, opts: childOpts, k: 0, viaOp: true });
      }
    }
  }
  return { alignments: results, capped };
}

/** Aligns two residue strings and returns the deterministic (first-preference) optimal alignment. */
export function align(a: string, b: string, mode: AlignMode, scoring: CompiledScoring): PairwiseAlignment {
  return tracebackFirst(fillMatrix(a, b, mode, scoring));
}

/** Aligns and also enumerates up to `cap` co-optimal alignments (first one equals `align`'s result). */
export function alignAll(a: string, b: string, mode: AlignMode, scoring: CompiledScoring, cap = MAX_ENUMERATED_ALIGNMENTS): { alignments: PairwiseAlignment[]; capped: boolean; score: number } {
  const dp = fillMatrix(a, b, mode, scoring);
  const r = tracebackAll(dp, cap);
  return { ...r, score: dp.score };
}

/** Score only, in two rows of memory (O(n) instead of O(mn)); used by the shuffle test where no traceback is needed. */
export function alignScoreOnly(a: string, b: string, mode: AlignMode, scoring: CompiledScoring): number {
  const codesA = encodeResidues(a, scoring);
  const codesB = encodeResidues(b, scoring);
  const m = codesA.length;
  const n = codesB.length;
  const w = n + 1;
  const K = scoring.classes;
  const T = scoring.table;
  const local = mode === 'local';
  let best = 0;
  if (!scoring.affine) {
    const g = scoring.gapOpen;
    let prev = new Int32Array(w);
    let cur = new Int32Array(w);
    if (!local) for (let j = 1; j <= n; j++) prev[j] = -j * g;
    for (let i = 1; i <= m; i++) {
      cur[0] = local ? 0 : -i * g;
      const ai = u8(codesA, i - 1) * K;
      for (let j = 1; j <= n; j++) {
        let v = i32(prev, j - 1) + i32(T, ai + u8(codesB, j - 1));
        const up = i32(prev, j) - g;
        const left = i32(cur, j - 1) - g;
        if (up > v) v = up;
        if (left > v) v = left;
        if (local) { if (v < 0) v = 0; if (v > best) best = v; }
        cur[j] = v;
      }
      [prev, cur] = [cur, prev];
    }
    return local ? best : i32(prev, n);
  }
  const open = scoring.gapOpen;
  const ext = scoring.gapExtend;
  let pM = new Int32Array(w).fill(NEG);
  let pX = new Int32Array(w).fill(NEG);
  let pY = new Int32Array(w).fill(NEG);
  let cM = new Int32Array(w);
  let cX = new Int32Array(w);
  let cY = new Int32Array(w);
  if (!local) { pM[0] = 0; for (let j = 1; j <= n; j++) pY[j] = clampNeg(-open - (j - 1) * ext); }
  for (let i = 1; i <= m; i++) {
    cM[0] = NEG; cY[0] = NEG;
    cX[0] = local ? NEG : clampNeg(-open - (i - 1) * ext);
    const ai = u8(codesA, i - 1) * K;
    for (let j = 1; j <= n; j++) {
      let pb = i32(pM, j - 1);
      pb = Math.max(pb, i32(pX, j - 1), i32(pY, j - 1));
      const s = i32(T, ai + u8(codesB, j - 1));
      const mv = clampNeg((local && pb < 0 ? 0 : pb) + s);
      cM[j] = local && pb <= 0 ? s : mv;
      if (local && i32(cM, j) > best) best = i32(cM, j);
      cX[j] = clampNeg(Math.max(i32(pM, j) - open, i32(pY, j) - open, i32(pX, j) - ext));
      cY[j] = clampNeg(Math.max(i32(cM, j - 1) - open, i32(cX, j - 1) - open, i32(cY, j - 1) - ext));
    }
    [pM, cM] = [cM, pM];
    [pX, cX] = [cX, pX];
    [pY, cY] = [cY, pY];
  }
  return local ? best : Math.max(i32(pM, n), i32(pX, n), i32(pY, n));
}

export type { CellInfo };

const STATE_NAMES = ['M', 'X', 'Y'];

/** Reads the three-state predecessor names from a 3-bit mask (M=1, X=2, Y=4). */
function maskNames(mask: number): string[] {
  return STATE_NAMES.filter((_, k) => (mask & (1 << k)) !== 0);
}

/** Explains one DP cell: recomputes the candidate values from the stored tables (no recomputation of the whole fill). */
export function cellInfo(dp: Dp, i: number, j: number): CellInfo {
  const w = dp.cols;
  const idx = i * w + j;
  if (i === 0 || j === 0) {
    const value = dp.kind === 'linear' ? i32(dp.H, idx) : Math.max(i32(dp.M, idx), i32(dp.X, idx), i32(dp.Y, idx));
    const note = dp.mode === 'local' ? 'Local alignment: the first row and column are 0 (an alignment may start anywhere).' : 'Global alignment: leading gaps are charged, so the border holds the cost of gaps only.';
    return { kind: 'border', i, j, value: value <= NEG / 2 ? 0 : value, note };
  }
  const s = i32(dp.scoring.table, u8(dp.codesA, i - 1) * dp.scoring.classes + u8(dp.codesB, j - 1));
  if (dp.kind === 'linear') {
    const g = dp.scoring.gapOpen;
    const diag = i32(dp.H, idx - w - 1) + s;
    const up = i32(dp.H, idx - w) - g;
    const left = i32(dp.H, idx - 1) - g;
    const best = Math.max(diag, up, left);
    const zeroFloor = dp.mode === 'local' && best <= 0;
    const mask = u8(dp.P, idx);
    const chosen: ('diagonal' | 'up' | 'left')[] = [];
    if (mask & L_DIAG) chosen.push('diagonal');
    if (mask & L_UP) chosen.push('up');
    if (mask & L_LEFT) chosen.push('left');
    return { kind: 'linear', i, j, s, diag, up, left, zeroFloor, value: i32(dp.H, idx), chosen };
  }
  const p = u16(dp.P, idx);
  const open = dp.scoring.gapOpen;
  const ext = dp.scoring.gapExtend;
  const pi = idx - w - 1;
  const ui = idx - w;
  const li = idx - 1;
  return {
    kind: 'affine', i, j, s,
    M: { fromM: i32(dp.M, pi), fromX: i32(dp.X, pi), fromY: i32(dp.Y, pi), startFresh: (p & A_START) !== 0, value: i32(dp.M, idx), chosen: (p & A_START) !== 0 ? ['fresh start'] : maskNames(p & 7) },
    X: { openFromM: i32(dp.M, ui) - open, extendX: i32(dp.X, ui) - ext, openFromY: i32(dp.Y, ui) - open, value: i32(dp.X, idx), chosen: maskNames((p >> A_X_SHIFT) & 7) },
    Y: { openFromM: i32(dp.M, li) - open, openFromX: i32(dp.X, li) - open, extendY: i32(dp.Y, li) - ext, value: i32(dp.Y, idx), chosen: maskNames((p >> A_Y_SHIFT) & 7) },
  };
}

/** Rebuilds a full Dp (with encoded sequences and compiled scoring) from a transferred snapshot, for inspection in the UI. */
export function dpFromSnapshot(snap: DpSnapshot, a: string, b: string, scoring: CompiledScoring): Dp {
  const base = { mode: snap.mode, strA: a, strB: b, codesA: encodeResidues(a, scoring), codesB: encodeResidues(b, scoring), rows: snap.rows, cols: snap.cols, scoring, score: snap.score, ends: snap.ends };
  return snap.kind === 'linear' ? { ...base, kind: 'linear', H: snap.H, P: snap.P } : { ...base, kind: 'affine', M: snap.M, X: snap.X, Y: snap.Y, P: snap.P };
}

/** Extracts the plain, transferable tables from a Dp (worker side). */
export function dpToSnapshot(dp: Dp): DpSnapshot {
  return dp.kind === 'linear'
    ? { kind: 'linear', mode: dp.mode, rows: dp.rows, cols: dp.cols, score: dp.score, ends: dp.ends, H: dp.H, P: dp.P }
    : { kind: 'affine', mode: dp.mode, rows: dp.rows, cols: dp.cols, score: dp.score, ends: dp.ends, M: dp.M, X: dp.X, Y: dp.Y, P: dp.P };
}
