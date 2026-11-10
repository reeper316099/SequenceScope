// Per-column conservation of a multiple alignment: residue counts, identity, Shannon entropy, and a consensus sequence.
//
// For a column with n sequences, g of them gaps, and residue counts c_r (sum = n - g):
//   identity   = max_r c_r / n                      (fraction of ALL sequences that carry the most common residue; gaps lower it)
//   entropy    = - sum_r (c_r/(n-g)) log2(c_r/(n-g)) (bits; 0 = fully conserved among non-gap residues; 0 if no residues)
//   conservation = 1 - entropy / log2(K)            (K = 4 for DNA/RNA, 20 for protein), then scaled by (1 - g/n)
// Consensus rule: '-' if more than half the sequences have a gap; else the most common residue (ties -> alphabetically
// first) in UPPERCASE if identity >= threshold (default 0.5), otherwise '.' (no consensus).
import type { Alphabet } from '../shared/types';
import { BioError } from './errors';
import type { ColumnStat, Conservation } from '../shared/results';
export type { ColumnStat, Conservation }; // moved to shared/results.ts

/** Statistics for one alignment column (a string of one character per sequence). */
export function columnStat(column: string, alphabet: Alphabet, threshold = 0.5): ColumnStat {
  const n = column.length;
  if (n === 0) throw new BioError('invalid-argument', 'A column needs at least one sequence.');
  const counts: Record<string, number> = {};
  let gaps = 0;
  for (const ch of column) { if (ch === '-') gaps++; else counts[ch] = (counts[ch] ?? 0) + 1; }
  const residues = n - gaps;
  let top = ''; let best = 0;
  for (const ch of Object.keys(counts).sort()) if ((counts[ch] as number) > best) { best = counts[ch] as number; top = ch; }
  let entropy = 0;
  for (const c of Object.values(counts)) { const p = c / residues; entropy -= p * Math.log2(p); }
  entropy = Math.abs(entropy); // avoid -0
  const hmax = Math.log2(alphabet === 'protein' ? 20 : 4);
  const identity = best / n;
  const conservation = residues === 0 ? 0 : Math.max(0, 1 - entropy / hmax) * (1 - gaps / n);
  const consensus = gaps / n > 0.5 ? '-' : residues === 0 ? '-' : identity >= threshold ? top : '.';
  return { gaps, residues, counts, top, identity, entropy, conservation, consensus };
}

/** Statistics for every column of an alignment (rows of equal length). */
export function conservation(rows: readonly string[], alphabet: Alphabet, threshold = 0.5): Conservation {
  const len = rows[0]?.length ?? 0;
  rows.forEach((r, k) => { if (r.length !== len) throw new BioError('not-aligned', `Row ${k + 1} has ${r.length} columns but the first has ${len}.`); });
  const columns: ColumnStat[] = [];
  for (let c = 0; c < len; c++) columns.push(columnStat(rows.map((r) => r.charAt(c)).join(''), alphabet, threshold));
  return {
    columns, consensus: columns.map((c) => c.consensus).join(''),
    meanIdentity: len === 0 ? 0 : columns.reduce((s, c) => s + c.identity, 0) / len,
    fullyConserved: columns.filter((c) => c.gaps === 0 && c.identity === 1).length,
  };
}

/** Conservation as CSV: one row per column with position, consensus, identity, entropy, conservation, and gap count. */
export function conservationCsv(rows: readonly string[], alphabet: Alphabet): string {
  const cons = conservation(rows, alphabet);
  const lines = ['column,consensus,identity,entropy_bits,conservation,gaps'];
  cons.columns.forEach((c, k) => lines.push(`${k + 1},${c.consensus},${c.identity.toFixed(4)},${c.entropy.toFixed(4)},${c.conservation.toFixed(4)},${c.gaps}`));
  return lines.join('\n') + '\n';
}
