// Text exports (pure functions; saving goes through the native dialog in the main process).
import type { PairwiseAlignment } from '../shared/types';

/** Wraps a string every `width` characters. */
function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out.length === 0 ? [''] : out;
}

/** Aligned FASTA: two records whose rows contain '-' for gaps. */
export function alignmentToFasta(aln: PairwiseAlignment, idA: string, idB: string): string {
  return [`>${idA}`, ...wrap(aln.rowA, 60), `>${idB}`, ...wrap(aln.rowB, 60)].join('\n') + '\n';
}

/** CLUSTAL-style text (blocks of 60 with a '*' line for identical columns). Not produced by Clustal; format only. */
export function alignmentToClustal(aln: PairwiseAlignment, idA: string, idB: string): string {
  const name = (s: string): string => s.slice(0, 15).padEnd(16, ' ');
  const lines = ['CLUSTAL-style pairwise alignment (exported by SequenceScope; not produced by Clustal)', ''];
  for (let i = 0; i < Math.max(aln.rowA.length, 1); i += 60) {
    const a = aln.rowA.slice(i, i + 60);
    const b = aln.rowB.slice(i, i + 60);
    let cons = '';
    for (let k = 0; k < a.length; k++) cons += a.charAt(k) === b.charAt(k) && a.charAt(k) !== '-' ? '*' : ' ';
    lines.push(name(idA) + a, name(idB) + b, ' '.repeat(16) + cons, '');
  }
  return lines.join('\n');
}

/** Score matrix as CSV: first row = sequence B letters, first column = sequence A letters ('' for the border row/column). */
export function matrixToCsv(a: string, b: string, valueAt: (i: number, j: number) => number): string {
  const rows: string[] = [['', '', ...b.split('')].join(',')];
  for (let i = 0; i <= a.length; i++) {
    const cells: string[] = [i === 0 ? '' : a.charAt(i - 1)];
    for (let j = 0; j <= b.length; j++) cells.push(String(valueAt(i, j)));
    rows.push(cells.join(','));
  }
  return rows.join('\n') + '\n';
}

/** Aligned FASTA for a multiple alignment (rows keep their input order). */
export function msaToFasta(ids: readonly string[], rows: readonly string[]): string {
  return ids.map((id, k) => [`>${id}`, ...wrap(rows[k] ?? '', 60)].join('\n')).join('\n') + '\n';
}

/** CLUSTAL-style text for a multiple alignment: blocks of 60 columns, '*' marks columns where every sequence has the same residue. */
export function msaToClustal(ids: readonly string[], rows: readonly string[]): string {
  const width = Math.min(30, Math.max(10, ...ids.map((i) => i.length)) + 1);
  const name = (s: string): string => s.slice(0, width - 1).padEnd(width, ' ');
  const len = rows[0]?.length ?? 0;
  const lines = ['CLUSTAL-style multiple alignment (exported by SequenceScope; produced by its own progressive aligner, not by Clustal)', ''];
  for (let i = 0; i < len; i += 60) {
    ids.forEach((id, k) => lines.push(name(id) + (rows[k] ?? '').slice(i, i + 60)));
    let cons = '';
    for (let c = i; c < Math.min(len, i + 60); c++) { const first = rows[0]?.charAt(c) ?? '-'; cons += first !== '-' && rows.every((r) => r.charAt(c) === first) ? '*' : ' '; }
    lines.push(' '.repeat(width) + cons, '');
  }
  return lines.join('\n');
}
