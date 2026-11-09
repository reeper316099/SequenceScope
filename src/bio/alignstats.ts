// Alignment statistics, the independent re-scorer, and validity checks. The re-scorer deliberately does NOT use
// the DP tables: it walks the two gapped rows column by column with the char-level scorer, so it can catch bugs in the DP.
import type { PairwiseAlignment } from '../shared/types';
import type { CompiledScoring } from './scoring';

/** Scores two gapped rows: substitution per aligned pair; a gap run of length k costs open + (k-1)*extend. */
export function scoreAlignedRows(rowA: string, rowB: string, sc: CompiledScoring): number {
  if (rowA.length !== rowB.length) throw new RangeError('Alignment rows must have equal length.');
  let total = 0;
  let inGapA = false; // currently inside a run of gaps in row A (B residues unpaired)
  let inGapB = false;
  for (let k = 0; k < rowA.length; k++) {
    const x = rowA.charAt(k);
    const y = rowB.charAt(k);
    if (x === '-' && y === '-') throw new RangeError('A column of two gaps is not a valid alignment column.');
    if (x === '-') {
      total -= inGapA ? sc.gapExtend : sc.gapOpen; // continuing a run pays extend; a new run (also after a B-gap run) pays open
      inGapA = true; inGapB = false;
    } else if (y === '-') {
      total -= inGapB ? sc.gapExtend : sc.gapOpen;
      inGapB = true; inGapA = false;
    } else {
      total += sc.charScore(x, y);
      inGapA = false; inGapB = false;
    }
  }
  return total;
}

export interface ValidationReport {
  ok: boolean;
  problems: string[];
}

/** Checks an alignment against the original sequences: gap-free rows equal the aligned substrings and the score re-computes. */
export function validateAlignment(aln: PairwiseAlignment, a: string, b: string, sc: CompiledScoring): ValidationReport {
  const problems: string[] = [];
  if (aln.rowA.length !== aln.rowB.length) problems.push('Rows have different lengths.');
  if (aln.rowA.replace(/-/g, '') !== a.slice(aln.startA, aln.endA)) problems.push('Row A without gaps is not the stated substring of sequence A.');
  if (aln.rowB.replace(/-/g, '') !== b.slice(aln.startB, aln.endB)) problems.push('Row B without gaps is not the stated substring of sequence B.');
  if (aln.mode === 'global' && (aln.startA !== 0 || aln.endA !== a.length || aln.startB !== 0 || aln.endB !== b.length)) problems.push('A global alignment must cover both sequences completely.');
  if (aln.rowA.length === aln.rowB.length) {
    try {
      const rescored = scoreAlignedRows(aln.rowA, aln.rowB, sc);
      if (rescored !== aln.score) problems.push(`Re-scoring gives ${rescored}, but the reported score is ${aln.score}.`);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : 'Could not re-score.');
    }
  }
  return { ok: problems.length === 0, problems };
}

export interface AlignmentStats {
  length: number; // alignment columns
  identities: number; // columns with the same STANDARD residue in both rows
  mismatches: number; // aligned residue pairs that are not identities
  positives: number; // aligned non-identical pairs with a positive score (matrix scoring only meaningful)
  gapColumns: number;
  gapOpens: number; // number of gap runs
  gapsInA: number; // gap characters in row A
  gapsInB: number;
  ambiguousColumns: number; // aligned pairs involving an ambiguity code (never counted as identity)
  identityPct: number | null; // identities / length * 100 (null for an empty alignment)
  similarityPct: number | null; // (identities + positives) / length * 100 (null if length 0)
  alignedColumns: number; // columns without a gap
}

/** Computes identity, similarity, and gap statistics (denominator for the percentages is the alignment length). */
export function alignmentStats(aln: PairwiseAlignment, sc: CompiledScoring): AlignmentStats {
  let identities = 0, mismatches = 0, positives = 0, gapColumns = 0, gapOpens = 0, gapsInA = 0, gapsInB = 0, ambiguousColumns = 0;
  let prevGap: 'A' | 'B' | null = null;
  for (let k = 0; k < aln.rowA.length; k++) {
    const x = aln.rowA.charAt(k);
    const y = aln.rowB.charAt(k);
    if (x === '-' || y === '-') {
      gapColumns++;
      const which = x === '-' ? 'A' : 'B';
      if (which === 'A') gapsInA++; else gapsInB++;
      if (prevGap !== which) gapOpens++;
      prevGap = which;
      continue;
    }
    prevGap = null;
    if (sc.isAmbiguous(x) || sc.isAmbiguous(y)) { ambiguousColumns++; mismatches++; continue; }
    if (x === y) identities++;
    else { mismatches++; if (sc.charScore(x, y) > 0) positives++; }
  }
  const length = aln.rowA.length;
  return {
    length, identities, mismatches, positives, gapColumns, gapOpens, gapsInA, gapsInB, ambiguousColumns,
    identityPct: length === 0 ? null : (identities / length) * 100,
    similarityPct: length === 0 ? null : ((identities + positives) / length) * 100,
    alignedColumns: length - gapColumns,
  };
}

/** Match line: '|' identity, ':' positive score (strong similarity), '.' score 0 (weak), ' ' mismatch or gap. */
export function matchLine(aln: PairwiseAlignment, sc: CompiledScoring): string {
  let out = '';
  for (let k = 0; k < aln.rowA.length; k++) {
    const x = aln.rowA.charAt(k);
    const y = aln.rowB.charAt(k);
    if (x === '-' || y === '-' || sc.isAmbiguous(x) || sc.isAmbiguous(y)) out += ' ';
    else if (x === y) out += '|';
    else {
      const s = sc.charScore(x, y);
      out += s > 0 ? ':' : s === 0 ? '.' : ' ';
    }
  }
  return out;
}
