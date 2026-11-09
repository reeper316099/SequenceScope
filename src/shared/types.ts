// Shared domain, worker, and IPC types. Main, preload, renderer, and workers all import from here so every
// message boundary is type-checked on both sides. Types vanish at runtime: data from disk is validated by zod.

/** Alphabets the app understands. */
export type Alphabet = 'dna' | 'rna' | 'protein';

/** One biological sequence (residues are uppercase, whitespace/digits already removed by the parser). */
export interface Sequence {
  id: string;
  description: string;
  alphabet: Alphabet;
  residues: string;
}

/** State of any long-running job (UI panels switch on `status`). */
export type JobState<T> =
  | { status: 'idle' }
  | { status: 'running'; progress: number }
  | { status: 'done'; result: T }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** Messages a worker sends back to the page. */
export type WorkerReply<R> =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; value: R }
  | { type: 'error'; message: string; code?: string };

/** Request/reply for the Phase 2 worker smoke test (doubles a number). */
export interface PingRequest {
  type: 'ping';
  value: number;
}

// ---- IPC (renderer <-> main), exposed through the preload bridge as window.sequenceScope ----

/** Kinds of file the open dialog can ask for; the main process owns the extension filter for each. */
export type OpenFileKind = 'fasta' | 'newick' | 'project';

/** Result of openFile: text, a cancel, or a typed error (never throws across the bridge). */
export type OpenFileResult =
  | { ok: true; name: string; text: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'too-large' | 'read-error' | 'invalid-request'; message: string };

/** Request to save a file through the native dialog. `content` is UTF-8 text or base64 for binary (PNG). */
export interface SaveFileRequest {
  suggestedName: string;
  extensions: string[];
  content: string;
  encoding: 'utf8' | 'base64';
}

/** Result of saveFile. */
export type SaveFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'write-error' | 'invalid-request'; message: string };

/** Result of openExternal (only allowlisted https hosts are opened). */
export type OpenExternalResult = { ok: true } | { ok: false; message: string };

/** Static facts about the running app, shown on the About page. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  platform: string;
}

/** Result of copyText. */
export type CopyTextResult = { ok: true } | { ok: false; message: string };

/** The ONLY functions the preload exposes to the renderer (copyText was added in Milestone B for Newick clipboard copy). */
export interface SequenceScopeApi {
  openFile(kind: OpenFileKind): Promise<OpenFileResult>;
  saveFile(request: SaveFileRequest): Promise<SaveFileResult>;
  openExternal(url: string): Promise<OpenExternalResult>;
  getAppInfo(): Promise<AppInfo>;
  copyText(text: string): Promise<CopyTextResult>;
}

/** IPC channel names (main registers handlers, preload invokes them). */
export const IPC = {
  openFile: 'sequencescope:open-file',
  saveFile: 'sequencescope:save-file',
  openExternal: 'sequencescope:open-external',
  getAppInfo: 'sequencescope:get-app-info',
  copyText: 'sequencescope:copy-text',
} as const;

/** Menu commands main may ask the renderer to perform (delivered as a DOM CustomEvent, see electron/main.ts). */
export const MENU_ACTIONS = [
  'open-fasta', 'open-newick', 'open-project', 'save-project', 'export', 'undo', 'redo',
  'toggle-dark', 'view-1', 'view-2', 'view-3', 'view-4', 'view-5', 'view-6', 'view-7',
] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];

/** Hard size cap for files opened through the native dialog (checked in the main process). */
export const MAX_OPEN_FILE_BYTES = 10 * 1024 * 1024;

// ---- Bio domain types shared by src/bio, workers, UI, and project files ----

/** Alignment mode: whole-sequence (global) or best-matching region (local). */
export type AlignMode = 'global' | 'local';

/** Gap penalties are entered as POSITIVE numbers. Linear: k gaps cost k*gap. Affine: k gaps cost open + (k-1)*extend. */
export type GapModel = { kind: 'linear'; gap: number } | { kind: 'affine'; open: number; extend: number };

/** How residue pairs are scored: simple match/mismatch (DNA/RNA/protein) or a named substitution matrix (protein). */
export type SubstitutionSpec = { kind: 'simple'; match: number; mismatch: number } | { kind: 'matrix'; name: string };

/** Serializable scoring choice (what goes into worker messages and project files). */
export interface ScoringSpec {
  substitution: SubstitutionSpec;
  gaps: GapModel;
}

/** One pairwise alignment. Coordinates are 0-based, half-open, on the ORIGINAL (ungapped) sequences. */
export interface PairwiseAlignment {
  mode: AlignMode;
  score: number;
  rowA: string;
  rowB: string;
  startA: number;
  endA: number;
  startB: number;
  endB: number;
}

/** Typed error codes thrown by the bio modules (never silent garbage). */
export type BioErrorCode =
  | 'too-large' | 'invalid-residue' | 'invalid-scoring' | 'invalid-argument' | 'unknown-matrix' | 'alphabet-mismatch'
  | 'not-aligned' | 'too-few-sequences' | 'duplicate-names' | 'saturated-distances' | 'invalid-tree' | 'newick-syntax' | 'incompatible-model';

// ---- Pairwise worker protocol (Milestone A) ----

/** Alphabet chosen in the UI: a fixed one, or detected automatically. */
export type AlphabetChoice = Alphabet | 'auto';

/** Everything the DP viewer needs, as plain typed arrays that can be TRANSFERRED (not copied) from the worker. */
export type DpSnapshot =
  | { kind: 'linear'; mode: AlignMode; rows: number; cols: number; score: number; ends: number[]; H: Int32Array; P: Uint8Array }
  | { kind: 'affine'; mode: AlignMode; rows: number; cols: number; score: number; ends: number[]; M: Int32Array; X: Int32Array; Y: Int32Array; P: Uint16Array };

/** Request to align two (already cleaned, uppercase) sequences. */
export interface AlignRequest {
  type: 'align';
  a: string;
  b: string;
  alphabet: Alphabet;
  mode: AlignMode;
  scoring: ScoringSpec;
  enumerateCap: number;
}

/** Worker result: the preferred alignment, co-optimal alignments (capped), and the DP tables for the matrix view. */
export interface AlignResult {
  alignment: PairwiseAlignment;
  all: PairwiseAlignment[];
  capped: boolean;
  dp: DpSnapshot;
}

/** Request to run the seeded shuffle significance test. */
export interface ShuffleRequest {
  type: 'shuffle';
  a: string;
  b: string;
  alphabet: Alphabet;
  mode: AlignMode;
  scoring: ScoringSpec;
  shuffles: number;
  seed: number;
}

/** Plain-data result of the shuffle test (typed arrays are fine to clone). */
export interface ShuffleSummary {
  seed: number;
  shuffles: number;
  realScore: number;
  scores: Int32Array;
  mean: number;
  sd: number;
  z: number | null;
  atLeastAsGood: number;
  pValue: number;
}

/** Worker error payload carries the BioError code when there is one. */
export interface WorkerErrorInfo {
  code: BioErrorCode | 'unexpected';
  message: string;
}

// ---- Milestone B: distances and trees ----

/** Distance models: p-distance (raw proportion), Jukes-Cantor (DNA/RNA), Poisson correction (protein). */
export type DistanceModel = 'p' | 'jc' | 'poisson';

/** What to do with alignment columns containing a gap: skip them (pairwise deletion) or count them as differences. */
export type GapPolicy = 'pairwise-deletion' | 'gaps-as-differences';

/** A tree node. Leaves have a `name` and no children. `length` is the branch above the node; `support` is a bootstrap percentage. */
export interface TreeNode {
  name?: string;
  label?: string; // internal-node label that is not a number
  length?: number;
  support?: number;
  children: TreeNode[];
}

/** A tree is just its root node. A root with 3 children is the usual form of an unrooted tree. */
export interface Tree {
  root: TreeNode;
}

/** Status of one distance cell: ok, saturated (correction undefined), or undefined (no comparable sites). */
export const DIST_OK = 0;
export const DIST_SATURATED = 1;
export const DIST_UNDEFINED = 2;

/** Symmetric distance matrix with a status per cell, so NaN/Infinity never appear. */
export interface DistanceMatrix {
  names: string[];
  n: number;
  /** n*n values; only meaningful where status is DIST_OK. */
  values: Float64Array;
  /** n*n statuses (DIST_OK / DIST_SATURATED / DIST_UNDEFINED). */
  status: Uint8Array;
  /** n*n number of compared sites for each pair. */
  compared: Uint32Array;
  model: DistanceModel;
  gapPolicy: GapPolicy;
}
