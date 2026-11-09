// Distances between sequences (ALGORITHMS.md section 6): p-distance, Jukes-Cantor, Poisson correction, with explicit
// gap policy and explicit "saturated"/"undefined" states (never NaN or Infinity).
import type { Alphabet, DistanceMatrix, DistanceModel, GapPolicy, Sequence } from '../shared/types';
import { DIST_OK, DIST_SATURATED, DIST_UNDEFINED } from '../shared/types';
import { DNA_STANDARD, PROTEIN_STANDARD, RNA_STANDARD } from './alphabet';
import { BioError } from './errors';
import { align } from './pairwise';
import type { CompiledScoring } from './scoring';

export const MAX_TREE_TAXA = 100; // distance matrices / trees: at most 100 sequences
export const MAX_PAIRWISE_WORK = 1_500_000_000; // sum over pairs of (len_i+1)*(len_j+1): keeps pairwise-distance runs to about a minute
export const MAX_BOOTSTRAP_WORK = 5_000_000_000; // replicates * pairs * columns

const GAP = 254; // code for '-'
const AMBIG = 255; // code for an ambiguity code (treated like missing data for that pair)

/** Models that make sense for an alphabet. */
export function modelsFor(alphabet: Alphabet): DistanceModel[] {
  return alphabet === 'protein' ? ['p', 'poisson'] : ['p', 'jc'];
}

/** Asserts the model is valid for the alphabet (Jukes-Cantor is for nucleotides, Poisson for protein). */
export function assertModel(model: DistanceModel, alphabet: Alphabet): void {
  if (!modelsFor(alphabet).includes(model)) {
    throw new BioError('incompatible-model', `The ${model === 'jc' ? 'Jukes–Cantor' : model === 'poisson' ? 'Poisson' : 'p-distance'} model cannot be used for ${alphabet} sequences.`);
  }
}

/** Largest p for which the correction is defined (exclusive): JC 3/4, Poisson 1. */
export function saturationLimit(model: DistanceModel): number {
  return model === 'jc' ? 0.75 : model === 'poisson' ? 1 : Infinity;
}

/**
 * Applies the correction to p.
 *  JC (Eq. 6.2):      d = -(3/4) ln(1 - 4p/3), defined for p < 3/4.
 *  Poisson (Eq. 6.3): d = -ln(1 - p),          defined for p < 1.
 * Returns null when p is at or above the limit ("saturated").
 */
export function correctDistance(p: number, model: DistanceModel): number | null {
  if (p === 0) return 0;
  if (model === 'p') return p;
  if (p >= saturationLimit(model)) return null;
  const d = model === 'jc' ? -0.75 * Math.log(1 - (4 * p) / 3) : -Math.log(1 - p);
  return Number.isFinite(d) ? d : null;
}

/** Encodes aligned residues: standard residues -> 0..K-1, '-' -> 254, anything else (ambiguity) -> 255. */
export function encodeAligned(row: string, alphabet: Alphabet): Uint8Array {
  const std = alphabet === 'dna' ? DNA_STANDARD : alphabet === 'rna' ? RNA_STANDARD : PROTEIN_STANDARD;
  const out = new Uint8Array(row.length);
  for (let k = 0; k < row.length; k++) {
    const ch = row.charAt(k);
    out[k] = ch === '-' ? GAP : std.includes(ch) ? std.indexOf(ch) : AMBIG;
  }
  return out;
}

export interface PairStats {
  compared: number;
  differences: number;
}

/**
 * Counts compared sites and differences for two encoded rows, with optional column weights (bootstrap multiplicities).
 * Columns where both are gaps never count. Ambiguity codes are skipped for that pair.
 * Policy 'pairwise-deletion': a gap in either row skips the column. 'gaps-as-differences': gap vs residue is a difference.
 */
export function pairStats(a: Uint8Array, b: Uint8Array, policy: GapPolicy, weights?: Int32Array): PairStats {
  let compared = 0;
  let differences = 0;
  for (let k = 0; k < a.length; k++) {
    const w = weights ? (weights[k] as number) : 1; // safe: k < a.length === weights.length
    if (w === 0) continue;
    const x = a[k] as number; // safe: k < length
    const y = b[k] as number; // safe: rows have equal length (checked by callers)
    if (x === GAP && y === GAP) continue;
    if (x === GAP || y === GAP) {
      if (policy === 'gaps-as-differences' && x !== AMBIG && y !== AMBIG) { compared += w; differences += w; }
      continue;
    }
    if (x === AMBIG || y === AMBIG) continue;
    compared += w;
    if (x !== y) differences += w;
  }
  return { compared, differences };
}

/** Allocates an empty matrix with zero diagonal. */
function emptyMatrix(names: string[], model: DistanceModel, gapPolicy: GapPolicy): DistanceMatrix {
  const n = names.length;
  return { names, n, values: new Float64Array(n * n), status: new Uint8Array(n * n), compared: new Uint32Array(n * n), model, gapPolicy };
}

/** Writes one symmetric cell from pair statistics. */
export function setCell(m: DistanceMatrix, i: number, j: number, stats: PairStats): void {
  let status = DIST_OK;
  let value = 0;
  if (stats.compared === 0) status = DIST_UNDEFINED;
  else {
    const d = correctDistance(stats.differences / stats.compared, m.model);
    if (d === null) status = DIST_SATURATED;
    else value = d;
  }
  for (const k of [i * m.n + j, j * m.n + i]) { m.values[k] = value; m.status[k] = status; m.compared[k] = stats.compared; }
}

/** Distance matrix from rows that are ALREADY aligned (equal length). */
export function distanceMatrixFromAligned(names: string[], rows: readonly string[], alphabet: Alphabet, model: DistanceModel, gapPolicy: GapPolicy, weights?: Int32Array): DistanceMatrix {
  assertModel(model, alphabet);
  if (names.length !== rows.length) throw new BioError('invalid-argument', 'Names and rows must have the same length.');
  const len = rows[0]?.length ?? 0;
  rows.forEach((r, k) => { if (r.length !== len) throw new BioError('not-aligned', `Sequence "${names[k] ?? k}" has ${r.length} columns but the first has ${len}: the input is not an alignment.`); });
  const codes = rows.map((r) => encodeAligned(r, alphabet));
  return distanceMatrixFromCodes(names, codes, model, gapPolicy, weights);
}

/** Distance matrix from pre-encoded rows (fast path used by bootstrap). */
export function distanceMatrixFromCodes(names: string[], codes: readonly Uint8Array[], model: DistanceModel, gapPolicy: GapPolicy, weights?: Int32Array): DistanceMatrix {
  const m = emptyMatrix(names, model, gapPolicy);
  for (let i = 0; i < m.n; i++) for (let j = i + 1; j < m.n; j++) setCell(m, i, j, pairStats(codes[i] as Uint8Array, codes[j] as Uint8Array, gapPolicy, weights)); // safe: i, j < n === codes.length
  return m;
}

export interface PairwiseHooks {
  onProgress?: (fraction: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * Distance matrix from UNALIGNED sequences: every pair is aligned globally with `scoring`, then the distance is
 * computed from that pairwise alignment. Pairwise-alignment distances are less reliable than distances from a good
 * multiple alignment (each pair is aligned in isolation). Returns null if cancelled.
 */
export function pairwiseDistanceMatrix(seqs: readonly Sequence[], scoring: CompiledScoring, model: DistanceModel, gapPolicy: GapPolicy, hooks: PairwiseHooks = {}): DistanceMatrix | null {
  const alphabet = scoring.alphabet;
  assertModel(model, alphabet);
  if (seqs.length > MAX_TREE_TAXA) throw new BioError('too-large', `At most ${MAX_TREE_TAXA} sequences are supported (got ${seqs.length}).`);
  let work = 0;
  for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) work += ((seqs[i]?.residues.length ?? 0) + 1) * ((seqs[j]?.residues.length ?? 0) + 1);
  if (work > MAX_PAIRWISE_WORK) throw new BioError('too-large', `Aligning every pair needs about ${(work / 1e9).toFixed(1)} billion cell updates; the limit is ${MAX_PAIRWISE_WORK / 1e9} billion. Use fewer or shorter sequences, or provide an alignment.`);
  const m = emptyMatrix(seqs.map((s) => s.id), model, gapPolicy);
  const total = (seqs.length * (seqs.length - 1)) / 2;
  let done = 0;
  for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) {
    if (hooks.shouldCancel?.() === true) return null;
    const a = seqs[i] as Sequence; // safe: i, j < seqs.length
    const b = seqs[j] as Sequence;
    const aln = align(a.residues, b.residues, 'global', scoring);
    setCell(m, i, j, pairStats(encodeAligned(aln.rowA, alphabet), encodeAligned(aln.rowB, alphabet), gapPolicy));
    hooks.onProgress?.(++done / total);
  }
  return m;
}

/** The distance for one cell, or null if saturated/undefined. */
export function cellValue(m: DistanceMatrix, i: number, j: number): number | null {
  return m.status[i * m.n + j] === DIST_OK ? (m.values[i * m.n + j] as number) : null; // safe: i, j < n
}

/** Lists the pairs that cannot be used for tree building (saturated or undefined). */
export function unusablePairs(m: DistanceMatrix): { i: number; j: number; status: 'saturated' | 'undefined' }[] {
  const out: { i: number; j: number; status: 'saturated' | 'undefined' }[] = [];
  for (let i = 0; i < m.n; i++) for (let j = i + 1; j < m.n; j++) {
    const s = m.status[i * m.n + j];
    if (s !== DIST_OK) out.push({ i, j, status: s === DIST_SATURATED ? 'saturated' : 'undefined' });
  }
  return out;
}

/** Throws a typed error that names the bad pairs if the matrix cannot be used to build a tree. */
export function assertTreeReady(m: DistanceMatrix): void {
  if (m.n < 3) throw new BioError('too-few-sequences', `Tree building needs at least 3 sequences (got ${m.n}).`);
  if (new Set(m.names).size !== m.names.length) throw new BioError('duplicate-names', 'Sequence names must be unique to build a tree. Rename the duplicates first.');
  const bad = unusablePairs(m);
  if (bad.length > 0) {
    const shown = bad.slice(0, 4).map((b) => `${m.names[b.i]} / ${m.names[b.j]} (${b.status})`).join('; ');
    throw new BioError('saturated-distances', `${bad.length} pair(s) have no usable distance: ${shown}${bad.length > 4 ? '; …' : ''}. Saturated means the sequences differ so much that the ${m.model === 'p' ? '' : 'correction'} formula is undefined (too many multiple substitutions to count). Try the p-distance, a different gap policy, or remove the most divergent sequences.`);
  }
}

/** Plain nested-array copy of the usable values (used by tree builders); requires a tree-ready matrix. */
export function toRows(m: DistanceMatrix): number[][] {
  assertTreeReady(m);
  const rows: number[][] = [];
  for (let i = 0; i < m.n; i++) { const r: number[] = []; for (let j = 0; j < m.n; j++) r.push(m.values[i * m.n + j] as number); rows.push(r); } // safe: in range
  return rows;
}

/** PHYLIP square distance matrix text. Strict PHYLIP names are 10 characters, so names are sanitised, truncated, and made unique. */
export function toPhylip(m: DistanceMatrix): string {
  assertTreeReady(m);
  const used = new Set<string>();
  const labels = m.names.map((full) => {
    const base = full.replace(/[\s(),:;[\]']/g, '_').slice(0, 10);
    let name = base;
    for (let t = 1; used.has(name); t++) name = base.slice(0, 10 - String(t).length) + String(t);
    used.add(name);
    return name.padEnd(10, ' ');
  });
  const lines = [String(m.n)];
  for (let i = 0; i < m.n; i++) lines.push(`${labels[i] ?? ''} ${Array.from({ length: m.n }, (_, j) => (m.values[i * m.n + j] as number).toFixed(6)).join(' ')}`); // safe: i, j < n
  return lines.join('\n') + '\n';
}

/** CSV with names; saturated/undefined cells are written as the words "saturated" / "undefined". */
export function toDistanceCsv(m: DistanceMatrix): string {
  const q = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [['', ...m.names].map(q).join(',')];
  for (let i = 0; i < m.n; i++) {
    const cells = [q(m.names[i] ?? '')];
    for (let j = 0; j < m.n; j++) {
      const st = m.status[i * m.n + j];
      cells.push(st === DIST_OK ? String(m.values[i * m.n + j]) : st === DIST_SATURATED ? 'saturated' : 'undefined');
    }
    rows.push(cells.join(','));
  }
  return rows.join('\n') + '\n';
}

/** Builds a (status-OK) distance matrix from a plain nested array; used for worked examples and teaching. */
export function matrixFromRows(names: string[], rows: readonly (readonly number[])[], model: DistanceModel = 'p'): DistanceMatrix {
  const n = names.length;
  const m = emptyMatrix(names, model, 'pairwise-deletion');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { m.values[i * n + j] = (rows[i] as readonly number[])[j] as number; m.compared[i * n + j] = 1; } // safe: square input of size n
  return m;
}
