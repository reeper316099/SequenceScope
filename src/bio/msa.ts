// Progressive multiple sequence alignment (simplified Feng-Doolittle / ClustalW style; ALGORITHMS.md section 11):
//   1. align every pair globally and take the p-distance of that pairwise alignment;
//   2. build a guide tree (UPGMA, or neighbor-joining rooted at its midpoint) from those distances;
//   3. walk the guide tree from the leaves up, aligning two PROFILES (already-aligned groups of sequences) at each node
//      with Gotoh dynamic programming over alignment columns.
// Column score between profile column x (group A) and y (group B) = (sum of s(a,b) over residue pairs a in x, b in y) / (|A||B|);
// pairs involving a gap contribute 0. Gap penalties (open/extend) are charged once per profile column, unscaled.
// "Once a gap, always a gap": merging only INSERTS all-gap columns into the two profiles; existing columns are never changed.
// This is a HEURISTIC: it is not guaranteed to maximise the sum-of-pairs score, and an early mistake is frozen in.
import type { Alphabet, DistanceMatrix, Sequence, Tree } from '../shared/types';
import { DIST_OK } from '../shared/types';
import { scoreAlignedRows } from './alignstats';
import { assertTreeReady, pairwiseDistanceMatrix } from './distance';
import { BioError } from './errors';
import { neighborJoining } from './nj';
import { MAX_DP_CELLS } from './pairwise';
import { encodeResidues } from './scoring';
import type { CompiledScoring } from './scoring';
import { isLeaf, leafNames, midpointRoot } from './tree';
import { upgma } from './upgma';

export const MAX_MSA_SEQS = 50;
export const MAX_MSA_LENGTH = 3000;
const GAP = 255;

export type GuideMethod = 'upgma' | 'nj';

export interface MsaHooks {
  onProgress?: (fraction: number) => void;
  shouldCancel?: () => boolean;
}

export interface MsaStep {
  /** Row ids of the merged profile (left group first, then right group). */
  ids: string[];
  leftIds: string[];
  rightIds: string[];
  rows: string[];
  /** Optimal profile-profile alignment score of this merge. */
  score: number;
}

export interface MsaResult {
  ids: string[];
  rows: string[];
  alphabet: Alphabet;
  guideTree: Tree;
  guide: GuideMethod;
  steps: MsaStep[];
  /** Sum over all sequence pairs of the pairwise score of their projected alignment (gap-gap columns removed). */
  sumOfPairs: number;
}

/** Sum-of-pairs score of an alignment: each pair of rows is scored with the independent column-by-column scorer. */
export function sumOfPairsScore(rows: readonly string[], scoring: CompiledScoring): number {
  let total = 0;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i] as string; const b = rows[j] as string; // safe: i, j < length
    let ra = ''; let rb = '';
    for (let k = 0; k < a.length; k++) { if (a[k] === '-' && b[k] === '-') continue; ra += a[k]; rb += b[k]; }
    total += scoreAlignedRows(ra, rb, scoring);
  }
  return total;
}

interface Profile {
  ids: string[];
  rows: string[];
}

/** Per column: the residue classes present with their counts (sparse), used for fast column-vs-column scores. */
function columnClasses(rows: readonly string[], scoring: CompiledScoring): { cls: number[]; cnt: number[] }[] {
  const len = rows[0]?.length ?? 0;
  const codes = rows.map((r) => Array.from(r, (ch) => (ch === '-' ? GAP : (encodeResidues(ch, scoring)[0] as number)))); // safe: one letter -> one code
  const cols: { cls: number[]; cnt: number[] }[] = [];
  for (let c = 0; c < len; c++) {
    const m = new Map<number, number>();
    for (const r of codes) { const k = r[c] as number; if (k !== GAP) m.set(k, (m.get(k) ?? 0) + 1); } // safe: c < len
    cols.push({ cls: [...m.keys()], cnt: [...m.values()] });
  }
  return cols;
}

/** Aligns two profiles (Gotoh over columns) and returns the merged rows (A rows first) and the optimal merge score. */
export function mergeProfiles(a: readonly string[], b: readonly string[], scoring: CompiledScoring): { rows: string[]; score: number } {
  const la = a[0]?.length ?? 0;
  const lb = b[0]?.length ?? 0;
  if ((la + 1) * (lb + 1) > MAX_DP_CELLS) throw new BioError('too-large', `Merging two profiles of ${la} and ${lb} columns needs ${((la + 1) * (lb + 1)).toLocaleString('en-US')} matrix cells; the limit is ${MAX_DP_CELLS.toLocaleString('en-US')}.`);
  const ca = columnClasses(a, scoring);
  const cb = columnClasses(b, scoring);
  const K = scoring.classes; const T = scoring.table;
  const norm = a.length * b.length;
  const sub = (i: number, j: number): number => {
    const x = ca[i] as { cls: number[]; cnt: number[] }; const y = cb[j] as { cls: number[]; cnt: number[] }; // safe: i < la, j < lb
    let s = 0;
    for (let p = 0; p < x.cls.length; p++) for (let q = 0; q < y.cls.length; q++) s += (x.cnt[p] as number) * (y.cnt[q] as number) * (T[(x.cls[p] as number) * K + (y.cls[q] as number)] as number); // safe: p, q in range; table indices valid
    return s / norm; // mean over all |A||B| sequence pairs (pairs with a gap contribute 0)
  };
  const w = lb + 1;
  const open = scoring.gapOpen; const ext = scoring.gapExtend;
  const NEG = -1e18;
  const M = new Float64Array((la + 1) * w).fill(NEG); const X = new Float64Array((la + 1) * w).fill(NEG); const Y = new Float64Array((la + 1) * w).fill(NEG);
  const P = new Uint16Array((la + 1) * w); // bits 0-2: preds of M (M,X,Y); 4-6: preds of X; 7-9: preds of Y
  M[0] = 0;
  for (let i = 1; i <= la; i++) { X[i * w] = -open - (i - 1) * ext; P[i * w] = (i === 1 ? 1 : 2) << 4; }
  for (let j = 1; j <= lb; j++) { Y[j] = -open - (j - 1) * ext; P[j] = (j === 1 ? 1 : 4) << 7; }
  for (let i = 1; i <= la; i++) for (let j = 1; j <= lb; j++) {
    const idx = i * w + j; const d = idx - w - 1; const u = idx - w; const l = idx - 1;
    const pm = M[d] as number; const px = X[d] as number; const py = Y[d] as number;
    const pb = Math.max(pm, px, py);
    M[idx] = pb + sub(i - 1, j - 1);
    const mm = (pm === pb ? 1 : 0) | (px === pb ? 2 : 0) | (py === pb ? 4 : 0);
    const xm = (M[u] as number) - open; const xx = (X[u] as number) - ext; const xy = (Y[u] as number) - open;
    const xv = Math.max(xm, xx, xy); X[idx] = xv;
    const xmask = (xm === xv ? 1 : 0) | (xx === xv ? 2 : 0) | (xy === xv ? 4 : 0);
    const ym = (M[l] as number) - open; const yx = (X[l] as number) - open; const yy = (Y[l] as number) - ext;
    const yv = Math.max(ym, yx, yy); Y[idx] = yv;
    const ymask = (ym === yv ? 1 : 0) | (yx === yv ? 2 : 0) | (yy === yv ? 4 : 0);
    P[idx] = mm | (xmask << 4) | (ymask << 7);
  }
  const last = la * w + lb;
  const vals = [M[last] as number, X[last] as number, Y[last] as number];
  const score = Math.max(...vals);
  let state = vals.indexOf(score); // preference M, X, Y on ties (same as pairwise.ts)
  // traceback: ops in reverse order
  const ops: ('M' | 'X' | 'Y')[] = [];
  let i = la; let j = lb;
  while (i > 0 || j > 0) {
    const p = P[i * w + j] as number;
    const bits = state === 0 ? p & 7 : state === 1 ? (p >> 4) & 7 : (p >> 7) & 7;
    ops.push(state === 0 ? 'M' : state === 1 ? 'X' : 'Y');
    const prev = (bits & 1) !== 0 ? 0 : (bits & 2) !== 0 ? 1 : 2;
    if (state === 0) { i--; j--; } else if (state === 1) i--; else j--;
    state = prev;
  }
  ops.reverse();
  const outA = a.map(() => [] as string[]); const outB = b.map(() => [] as string[]);
  let ia = 0; let ib = 0;
  for (const op of ops) {
    if (op === 'M') { a.forEach((r, k) => (outA[k] as string[]).push(r.charAt(ia))); b.forEach((r, k) => (outB[k] as string[]).push(r.charAt(ib))); ia++; ib++; }
    else if (op === 'X') { a.forEach((r, k) => (outA[k] as string[]).push(r.charAt(ia))); b.forEach((_, k) => (outB[k] as string[]).push('-')); ia++; }
    else { a.forEach((_, k) => (outA[k] as string[]).push('-')); b.forEach((r, k) => (outB[k] as string[]).push(r.charAt(ib))); ib++; }
  }
  return { rows: [...outA, ...outB].map((c) => c.join('')), score };
}

/** Guide-tree distances: p of each pair's global alignment; pairs with no comparable sites get the maximum, 1. */
function guideMatrix(m: DistanceMatrix): DistanceMatrix {
  const values = Float64Array.from(m.values);
  const status = new Uint8Array(m.status.length).fill(DIST_OK);
  for (let k = 0; k < m.status.length; k++) if (m.status[k] !== DIST_OK) values[k] = 1;
  return { ...m, values, status };
}

/**
 * Progressive alignment of 1..50 sequences (each up to 3000 residues). Returns null if cancelled.
 * Sequence ids must be unique (they name the guide-tree leaves).
 */
export function progressiveAlign(seqs: readonly Sequence[], scoring: CompiledScoring, guide: GuideMethod, hooks: MsaHooks = {}): MsaResult | null {
  const alphabet = scoring.alphabet;
  if (seqs.length === 0) throw new BioError('too-few-sequences', 'Provide at least one sequence.');
  if (seqs.length > MAX_MSA_SEQS) throw new BioError('too-large', `At most ${MAX_MSA_SEQS} sequences can be aligned at once (got ${seqs.length}).`);
  if (new Set(seqs.map((s) => s.id)).size !== seqs.length) throw new BioError('duplicate-names', 'Sequence names must be unique so the guide tree can name them.');
  for (const s of seqs) {
    if (s.residues.length === 0) throw new BioError('invalid-argument', `Sequence "${s.id}" is empty.`);
    if (s.residues.length > MAX_MSA_LENGTH) throw new BioError('too-large', `Sequence "${s.id}" has ${s.residues.length} residues; the limit is ${MAX_MSA_LENGTH}.`);
    encodeResidues(s.residues, scoring); // typed error with position for invalid letters
  }
  const ids = seqs.map((s) => s.id);
  if (seqs.length === 1) return { ids, rows: [(seqs[0] as Sequence).residues], alphabet, guideTree: { root: { name: ids[0], children: [] } }, guide, steps: [], sumOfPairs: 0 };

  let tree: Tree;
  let pairWork = 0;
  const total = (seqs.length * (seqs.length - 1)) / 2;
  if (seqs.length === 2) {
    tree = { root: { children: ids.map((name) => ({ name, children: [] })) } };
  } else {
    const dm = pairwiseDistanceMatrix(seqs, scoring, 'p', 'pairwise-deletion', {
      onProgress: (f) => { pairWork = f * total; hooks.onProgress?.(0.6 * (pairWork / total)); },
      shouldCancel: hooks.shouldCancel,
    });
    if (dm === null) return null;
    const gm = guideMatrix(dm);
    assertTreeReady(gm);
    tree = guide === 'upgma' ? upgma(gm).tree : midpointRoot(neighborJoining(gm).tree);
  }

  const byId = new Map(seqs.map((s) => [s.id, s] as const));
  const steps: MsaStep[] = [];
  const merges = (leafNames(tree).length - 1);
  let done = 0;
  let cancelled = false;
  const walk = (n: Tree['root']): Profile | null => {
    if (cancelled) return null;
    if (isLeaf(n)) { const s = byId.get(n.name ?? '') as Sequence; return { ids: [s.id], rows: [s.residues] }; } // safe: leaf names are the sequence ids
    const kids = n.children.map(walk);
    if (kids.some((k) => k === null)) return null;
    let acc = kids[0] as Profile;
    for (const next of kids.slice(1) as Profile[]) {
      if (hooks.shouldCancel?.() === true) { cancelled = true; return null; }
      const left = acc.ids;
      const merged = mergeProfiles(acc.rows, next.rows, scoring);
      acc = { ids: [...left, ...next.ids], rows: merged.rows };
      steps.push({ ids: acc.ids, leftIds: left, rightIds: next.ids, rows: merged.rows, score: merged.score });
      hooks.onProgress?.(0.6 + 0.4 * (++done / merges));
    }
    return acc;
  };
  const final = walk(tree.root);
  if (final === null) return null;
  const order = new Map(final.ids.map((id, k) => [id, k] as const));
  const rows = ids.map((id) => final.rows[order.get(id) as number] as string); // safe: every id is present
  return { ids, rows, alphabet, guideTree: tree, guide, steps, sumOfPairs: sumOfPairsScore(rows, scoring) };
}

/**
 * Exhaustive sum-of-pairs optimum for a tiny set (for teaching and tests): enumerates EVERY alignment. Limited to at most
 * 4 sequences of at most 6 residues each so it cannot run away.
 */
export function bruteForceOptimumSP(seqs: readonly string[], scoring: CompiledScoring): { score: number; rows: string[] } {
  if (seqs.length > 4 || seqs.some((s) => s.length > 6)) throw new BioError('too-large', 'The exhaustive search is limited to 4 sequences of at most 6 residues.');
  const n = seqs.length;
  let best = -Infinity;
  let bestRows: string[] = seqs.map((s) => s);
  const rec = (pos: number[], rows: string[]): void => {
    if (pos.every((p, k) => p === (seqs[k] as string).length)) { const sc = sumOfPairsScore(rows, scoring); if (sc > best) { best = sc; bestRows = rows; } return; }
    for (let mask = 1; mask < 1 << n; mask++) {
      if (!pos.every((p, k) => (mask & (1 << k)) === 0 || p < (seqs[k] as string).length)) continue;
      rec(pos.map((p, k) => p + ((mask >> k) & 1)), rows.map((r, k) => r + (((mask >> k) & 1) === 1 ? (seqs[k] as string).charAt(pos[k] as number) : '-')));
    }
  };
  rec(new Array<number>(n).fill(0), new Array<string>(n).fill(''));
  return { score: best, rows: bestRows };
}
