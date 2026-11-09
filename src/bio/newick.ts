// Newick parser and writer (ALGORITHMS.md section 9). Written from scratch.
//
// Conventions:
//  * Labels may be quoted with single quotes ('' is an escaped quote). Unquoted underscores are KEPT as underscores
//    (many tools turn them into spaces; we keep sequence IDs like HBA_HUMAN intact).
//  * Branch lengths may use scientific notation (1e-3) and may be negative. A missing length stays undefined.
//  * [bracketed comments] are skipped.
//  * A numeric label on an internal node is read as a support value (node.support); any other internal label stays a label.
//  * Only the first tree of a multi-tree file is returned; the number of extra trees is reported.
import type { Tree, TreeNode } from '../shared/types';
import { BioError } from './errors';

export class NewickError extends BioError {
  readonly position: number;
  readonly line: number;
  readonly column: number;

  /** An error at a 0-based character offset, with 1-based line/column for messages. */
  constructor(message: string, text: string, position: number) {
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    super('newick-syntax', `${message} (line ${line}, column ${column}).`);
    this.name = 'NewickError';
    this.position = position;
    this.line = line;
    this.column = column;
  }
}

export interface ParsedNewick {
  tree: Tree;
  /** Additional trees found after the first one (ignored). */
  extraTrees: number;
}

const MAX_DEPTH = 3000;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Parses the first tree in `text`. Throws NewickError with a position for malformed input. */
export function parseNewick(text: string): ParsedNewick {
  let i = 0;
  let lastQuoted = false; // was the most recently read label quoted? (quoted numeric internal labels stay labels)
  const err = (msg: string, at = i): never => { throw new NewickError(msg, text, at); };

  /** Skips whitespace and [comments]. */
  const skip = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text.charAt(i))) i++;
      if (text.charAt(i) === '[') {
        const start = i;
        let depth = 0;
        do {
          const ch = text.charAt(i);
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          i++;
        } while (depth > 0 && i < text.length);
        if (depth > 0) err('Unterminated [comment]', start);
      } else return;
    }
  };

  /** Reads a quoted or unquoted label; null if there is none at this position. */
  const label = (): string | null => {
    skip();
    lastQuoted = false;
    if (text.charAt(i) === "'") {
      lastQuoted = true;
      const start = i;
      i++;
      let out = '';
      for (;;) {
        if (i >= text.length) err('Unterminated quoted label', start);
        const ch = text.charAt(i);
        if (ch === "'") {
          if (text.charAt(i + 1) === "'") { out += "'"; i += 2; continue; }
          i++;
          return out;
        }
        out += ch; i++;
      }
    }
    const start = i;
    while (i < text.length && !/[\s()[\]',:;]/.test(text.charAt(i))) i++;
    return i > start ? text.slice(start, i) : null;
  };

  /** Reads an optional ":length". */
  const length = (): number | undefined => {
    skip();
    if (text.charAt(i) !== ':') return undefined;
    i++;
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return err('Expected a branch length number after ":"');
    i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) err('Branch length is not a finite number', i - m[0].length);
    return v;
  };

  const subtree = (depth: number): TreeNode => {
    if (depth > MAX_DEPTH) err(`Tree is nested more than ${MAX_DEPTH} levels deep`);
    skip();
    if (text.charAt(i) === '(') {
      const open = i;
      i++;
      const children: TreeNode[] = [subtree(depth + 1)];
      for (;;) {
        skip();
        const ch = text.charAt(i);
        if (ch === ',') { i++; children.push(subtree(depth + 1)); }
        else if (ch === ')') { i++; break; }
        else if (i >= text.length) return err('Unbalanced parentheses: the "(" was never closed', open);
        else return err(`Expected "," or ")" but found "${ch}"`);
      }
      const node: TreeNode = { children };
      const lab = label();
      if (lab !== null) {
        const asNum = !lastQuoted && lab.trim() !== '' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(lab.trim()) ? Number(lab) : NaN;
        if (Number.isFinite(asNum)) node.support = asNum; else node.label = lab;
      }
      const len = length();
      if (len !== undefined) node.length = len;
      return node;
    }
    const at = i;
    const name = label();
    if (name === null) {
      const ch = text.charAt(i);
      return err(i >= text.length ? 'Unexpected end of input: expected a taxon name or "("' : `Expected a taxon name or "(" but found "${ch}"`, at);
    }
    const node: TreeNode = { name, children: [] };
    const len = length();
    if (len !== undefined) node.length = len;
    return node;
  };

  /** Parses one `subtree ;` and returns it. */
  const oneTree = (): TreeNode => {
    skip();
    if (i >= text.length) err('The input is empty: expected a Newick tree');
    const root = subtree(0);
    skip();
    if (text.charAt(i) !== ';') {
      if (i >= text.length) err('Missing ";" at the end of the tree');
      err(`Expected ";" but found "${text.charAt(i)}"`);
    }
    i++;
    return root;
  };

  const first = oneTree();
  let extra = 0;
  for (;;) {
    skip();
    if (i >= text.length) break;
    oneTree();
    extra++;
  }
  return { tree: { root: first }, extraTrees: extra };
}

/** Quotes a label only when needed (always for an internal label that looks like a number, so it is not read back as support). */
function quoteLabel(s: string, internal = false): string {
  const numeric = internal && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s.trim());
  if (s !== '' && !numeric && !/[\s()[\]',:;]/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export interface WriteOptions {
  /** Write internal support values as labels (default true). */
  includeSupport?: boolean;
  /** Write branch lengths (default true). */
  includeLengths?: boolean;
}

/** Writes a tree as Newick. Numbers use JavaScript's shortest exact representation, so a re-read tree is identical. */
export function writeNewick(tree: Tree, opts: WriteOptions = {}): string {
  const withSupport = opts.includeSupport !== false;
  const withLengths = opts.includeLengths !== false;
  const walk = (n: TreeNode): string => {
    let s = n.children.length > 0 ? `(${n.children.map(walk).join(',')})` : quoteLabel(n.name ?? '');
    if (n.children.length > 0) {
      if (n.label !== undefined) s += quoteLabel(n.label, true);
      else if (withSupport && n.support !== undefined) s += String(n.support);
    }
    if (withLengths && n.length !== undefined) s += `:${String(n.length)}`;
    return s;
  };
  return `${walk(tree.root)};`;
}
