// The calculations the UI needs, as ASYNC functions. Every one of them runs in Rust (the Tauri commands in src-tauri/src/compute.rs
// and the `bio_op` command in src-tauri/src/ops.rs); nothing is computed in TypeScript any more.
import type { Conservation, Detection, MsaRequest, MsaResult, NjResult, ParsedFasta, RfResult, SubstitutionMatrix, UpgmaResult } from '../shared/results';
import { BioError } from '../bio/errors';
import type { AlignRequest, AlignResult, Alphabet, AlphabetChoice, BioErrorCode, CellInfo, DistanceMatrix, DistanceModel, DpSnapshot, ScoringSpec, Sequence, Tree, TreeNode } from '../shared/types';
import { createMsaWorker, createPairwiseWorker } from './index';
import { rustOp } from './ops';

// ---------------------------------------------------------------------------------------------- reference data

/** Size limits shared by the UI and the algorithms. */
export interface Limits {
  maxDpCells: number;
  maxEnumeratedAlignments: number;
  maxTreeTaxa: number;
  maxMsaSeqs: number;
  maxMsaLength: number;
  maxReplicates: number;
  maxShuffles: number;
}

interface RawMatrix {
  name: string;
  letters: string;
  values: number[];
  sha256: string;
  citation: string;
  source: string;
}

type ModelTable = Record<Alphabet, DistanceModel[]>;
let cache: { limits: Limits; matrices: Map<string, SubstitutionMatrix>; models: ModelTable } | null = null;

/** Turns the plain matrix data from Rust into the object the UI uses (with a `get` lookup). */
function toMatrix(m: RawMatrix): SubstitutionMatrix {
  const n = m.letters.length;
  return {
    name: m.name, letters: m.letters, sha256: m.sha256, citation: m.citation, source: m.source,
    get: (a: string, b: string): number | undefined => {
      const i = m.letters.indexOf(a); const j = m.letters.indexOf(b);
      return i < 0 || j < 0 || a.length !== 1 || b.length !== 1 ? undefined : m.values[i * n + j];
    },
  };
}

/** Loads the limits and substitution matrices once, at start-up; afterwards `limits()` and `getMatrix()` are synchronous. */
export async function loadReferenceData(): Promise<void> {
  const r = await rustOp<{ limits: Limits; matrices: RawMatrix[]; modelsFor: ModelTable }>({ op: 'referenceData' });
  cache = { limits: r.limits, matrices: new Map(r.matrices.map((m) => [m.name, toMatrix(m)])), models: r.modelsFor };
}

/** The size limits (available after `loadReferenceData`). */
export function limits(): Limits {
  if (cache === null) throw new Error('Reference data has not been loaded yet.');
  return cache.limits;
}

/** Names of the bundled substitution matrices, in display order. */
export function listMatrices(): string[] {
  if (cache === null) throw new Error('Reference data has not been loaded yet.');
  return [...cache.matrices.keys()];
}

/** One bundled matrix by name, or a typed "unknown-matrix" error. */
export function getMatrix(name: string): SubstitutionMatrix {
  const m = cache?.matrices.get(name);
  if (m === undefined) throw new BioError('unknown-matrix', `Unknown substitution matrix "${name}". Available: ${listMatrices().join(', ')}.`);
  return m;
}

/** The distance models that make sense for an alphabet. */
export function modelsFor(alphabet: Alphabet): DistanceModel[] {
  if (cache === null) throw new Error('Reference data has not been loaded yet.');
  return cache.models[alphabet];
}

// ---------------------------------------------------------------------------------------------- FASTA and alphabet

/** Parses pasted text or a FASTA file into records plus every issue. */
export async function parseFastaAsync(text: string, options: { alphabet?: AlphabetChoice; allowGaps?: boolean } = {}): Promise<ParsedFasta> {
  return rustOp<ParsedFasta>({ op: 'fastaParse', text, alphabet: options.alphabet ?? 'auto', allowGaps: options.allowGaps ?? false });
}

/** Writes records as FASTA text with the given line width. */
export async function writeFastaAsync(records: readonly Sequence[], width = 60): Promise<string> {
  return rustOp<string>({ op: 'fastaWrite', records, width });
}

/** Guesses the alphabet of some residues. */
export async function detectAlphabetAsync(residues: string): Promise<Detection> {
  return rustOp<Detection>({ op: 'detectAlphabet', residues });
}

// ---------------------------------------------------------------------------------------------- one-off alignment

/** Runs ONE pairwise alignment on the selected backend and resolves with its result (errors reject with a BioError). */
export function alignOnce(req: AlignRequest): Promise<AlignResult> {
  return new Promise((resolve, reject) => {
    const worker = createPairwiseWorker();
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return;
      worker.terminate();
      if (m.type === 'result') resolve(m.value);
      else reject(new BioError((m.code === 'unexpected' ? 'invalid-argument' : m.code) as BioErrorCode, m.message));
    };
    worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message)); };
    worker.postMessage(req);
  });
}

// ---------------------------------------------------------------------------------------------- alignment page helpers

/** Checks the scoring choice and the table size BEFORE an alignment starts; throws a BioError like the job itself would. */
export async function alignPrecheck(alphabet: Alphabet, scoring: ScoringSpec, lenA: number, lenB: number): Promise<{ affine: boolean }> {
  return rustOp<{ affine: boolean }>({ op: 'alignPrecheck', alphabet, scoring, lenA, lenB });
}

/** What the matrix view and the details panel need about one finished alignment: the tables plus the inputs they came from. */
export type DpView = DpSnapshot & {
  strA: string;
  strB: string;
  alphabet: Alphabet;
  scoring: ScoringSpec;
  /** Penalty for the first gap column (linear: the single gap penalty) and for each further one. */
  gapOpen: number;
  gapExtend: number;
};

/** Wraps a transferred DP snapshot with the sequences and scoring it belongs to. */
export function makeDpView(snap: DpSnapshot, strA: string, strB: string, alphabet: Alphabet, scoring: ScoringSpec): DpView {
  const g = scoring.gaps;
  return { ...snap, strA, strB, alphabet, scoring, gapOpen: g.kind === 'linear' ? g.gap : g.open, gapExtend: g.kind === 'linear' ? g.gap : g.extend };
}

/** The table entries around cell (i, j), read straight from the typed arrays the page already holds. */
function valuesAround(dp: DpView, i: number, j: number): Record<string, unknown> {
  const w = dp.cols;
  const idx = i * w + j;
  const diag = i > 0 && j > 0 ? idx - w - 1 : -1;
  const up = i > 0 ? idx - w : -1;
  const left = j > 0 ? idx - 1 : -1;
  if (dp.kind === 'linear') {
    const at = (k: number): number => (k < 0 ? 0 : (dp.H[k] as number)); // safe: k is a valid cell index or -1
    return { kind: 'linear', diag: at(diag), up: at(up), left: at(left), here: dp.H[idx], pointer: dp.P[idx] };
  }
  const tri = (k: number): number[] => (k < 0 ? [0, 0, 0] : [dp.M[k] as number, dp.X[k] as number, dp.Y[k] as number]); // safe: k is a valid cell index or -1
  return { kind: 'affine', diag: tri(diag), up: tri(up), left: tri(left), here: tri(idx), pointer: dp.P[idx] };
}

/** Explains one DP cell (candidate values and chosen move) for the details panel. */
export async function cellInfoAsync(dp: DpView, i: number, j: number): Promise<CellInfo> {
  return rustOp<CellInfo>({
      op: 'cellInfo', mode: dp.mode, i, j, letterA: i > 0 ? dp.strA.charAt(i - 1) : '', letterB: j > 0 ? dp.strB.charAt(j - 1) : '',
      alphabet: dp.alphabet, scoring: dp.scoring, values: valuesAround(dp, i, j),
  });
}

// ---------------------------------------------------------------------------------------------- trees and distances

/** A tree node in the flat form that is sent to Rust (pre-order; each node names its parent, -1 for the root). */
interface FlatNode {
  name?: string;
  label?: string;
  length?: number;
  support?: number;
  parent: number;
}

/** Flattens a tree without recursion, so any depth works (JSON nesting deeper than 128 levels would be refused by Rust). */
function flattenTree(tree: Tree): { nodes: FlatNode[] } {
  const nodes: FlatNode[] = [];
  const stack: { node: TreeNode; parent: number }[] = [{ node: tree.root, parent: -1 }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop() as { node: TreeNode; parent: number }; // safe: the stack is not empty
    const me = nodes.length;
    const flat: FlatNode = { parent };
    if (node.name !== undefined) flat.name = node.name;
    if (node.label !== undefined) flat.label = node.label;
    if (node.length !== undefined) flat.length = node.length;
    if (node.support !== undefined) flat.support = node.support;
    nodes.push(flat);
    for (let k = node.children.length - 1; k >= 0; k--) stack.push({ node: node.children[k] as TreeNode, parent: me }); // safe: k < length
  }
  return { nodes };
}

/** A distance matrix as plain lists (typed arrays do not travel as JSON). */
function matrixIn(m: DistanceMatrix): Record<string, unknown> {
  return { names: m.names, n: m.n, values: Array.from(m.values), status: Array.from(m.status), compared: Array.from(m.compared), model: m.model, gapPolicy: m.gapPolicy };
}

/** Both trees (with every recorded step) from a distance matrix; throws a BioError like the algorithms do. */
export async function buildTreesAsync(m: DistanceMatrix): Promise<{ upgma: UpgmaResult; nj: NjResult }> {
  return rustOp<{ upgma: UpgmaResult; nj: NjResult }>({ op: 'treeBuild', matrix: matrixIn(m) });
}

/** Both trees from plain rows of numbers (the teaching examples). */
export async function buildTreesFromRowsAsync(names: string[], rows: number[][]): Promise<{ upgma: UpgmaResult; nj: NjResult }> {
  return rustOp<{ upgma: UpgmaResult; nj: NjResult }>({ op: 'treeBuildRows', names, rows });
}

/** Reads a Newick string. With `validate` the leaves must also be named and unique. */
export async function parseNewickAsync(text: string, validate = false): Promise<{ tree: Tree; extraTrees: number }> {
  return rustOp<{ tree: Tree; extraTrees: number }>({ op: 'newickParse', text, validate });
}

/** Writes trees as Newick (one string per tree). */
export async function writeNewickMany(trees: readonly Tree[], opts: { includeLengths?: boolean; includeSupport?: boolean } = {}): Promise<string[]> {
  return rustOp<string[]>({ op: 'newickWrite', trees: trees.map(flattenTree), includeLengths: opts.includeLengths ?? true, includeSupport: opts.includeSupport ?? true });
}

/** Writes one tree as Newick. */
export async function writeNewickAsync(tree: Tree, opts: { includeLengths?: boolean; includeSupport?: boolean } = {}): Promise<string> {
  return (await writeNewickMany([tree], opts))[0] as string; // safe: one tree in, one string out
}

/** A change to a tree: rotate a node's children, re-root above a node or at a leaf, or midpoint-root. */
export type TreeEdit = { kind: 'rotate'; index: number } | { kind: 'rerootAbove'; index: number; fraction: number } | { kind: 'rerootAtLeaf'; leaf: string } | { kind: 'midpoint' };

/** Applies one edit and returns the new tree (a BioError if the edit is not possible). */
export async function editTreeAsync(tree: Tree, edit: TreeEdit): Promise<Tree> {
  return rustOp<Tree>({ op: 'treeEdit', tree: flattenTree(tree), edit });
}

/** Robinson-Foulds comparison plus the pre-order indexes of the branches each tree lacks in the other. */
export async function compareTreesAsync(a: Tree, b: Tree): Promise<{ rf: RfResult; uniqueA: number[]; uniqueB: number[] }> {
  return rustOp<{ rf: RfResult; uniqueA: number[]; uniqueB: number[] }>({ op: 'treeCompare', a: flattenTree(a), b: flattenTree(b) });
}

/** Leaf names and the path distance between every pair of leaves. */
export async function leafDistancesAsync(tree: Tree): Promise<{ names: string[]; dist: number[][] }> {
  return rustOp<{ names: string[]; dist: number[][] }>({ op: 'leafDistances', tree: flattenTree(tree) });
}

/** The corrected distance for each observed proportion (null where the correction is undefined). */
export async function correctDistancesAsync(model: 'jc' | 'poisson', ps: number[]): Promise<(number | null)[]> {
  return rustOp<(number | null)[]>({ op: 'correctDistance', model, ps });
}

/** A distance matrix as CSV or PHYLIP text (PHYLIP throws a BioError when some distances are unusable). */
export async function distanceExportAsync(m: DistanceMatrix, format: 'csv' | 'phylip'): Promise<string> {
  return rustOp<string>({ op: 'distanceExport', matrix: matrixIn(m), format });
}

// ---------------------------------------------------------------------------------------------- multiple alignment helpers

/** Per-column conservation statistics of an alignment. */
export async function conservationAsync(rows: readonly string[], alphabet: Alphabet, threshold = 0.5): Promise<Conservation> {
  return rustOp<Conservation>({ op: 'conservation', rows, alphabet, threshold });
}

/** Conservation as CSV text. */
export async function conservationCsvAsync(rows: readonly string[], alphabet: Alphabet): Promise<string> {
  return rustOp<string>({ op: 'conservationCsv', rows, alphabet });
}

/** The sum-of-pairs score of an alignment. */
export async function sumOfPairsAsync(rows: readonly string[], alphabet: Alphabet, scoring: ScoringSpec): Promise<number> {
  return rustOp<number>({ op: 'sumOfPairs', rows, alphabet, scoring });
}

/** The exhaustive sum-of-pairs optimum for a tiny set (at most 4 sequences of at most 6 residues). */
export async function bruteForceAsync(seqs: readonly string[], alphabet: Alphabet, scoring: ScoringSpec): Promise<{ score: number; rows: string[] }> {
  return rustOp<{ score: number; rows: string[] }>({ op: 'bruteForce', seqs, alphabet, scoring });
}

/** Runs ONE progressive multiple alignment on the selected backend (errors reject with a BioError). */
export function msaOnce(req: MsaRequest): Promise<MsaResult> {
  return new Promise((resolve, reject) => {
    const worker = createMsaWorker();
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return;
      worker.terminate();
      if (m.type === 'result') resolve(m.value);
      else reject(new BioError((m.code === 'unexpected' ? 'invalid-argument' : m.code) as BioErrorCode, m.message));
    };
    worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message)); };
    worker.postMessage(req);
  });
}
