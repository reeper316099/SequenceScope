// Alignment statistics, match line, re-scorer error paths, and the validator's ability to catch broken alignments.
import { describe, expect, it } from 'vitest';
import { alignmentStats, matchLine, scoreAlignedRows, validateAlignment } from '../../src/bio/alignstats';
import { align } from '../../src/bio/pairwise';
import type { PairwiseAlignment } from '../../src/shared/types';
import { affine, dna, linear, protein } from '../helpers/scoring';

const mk = (rowA: string, rowB: string, score: number, mode: 'global' | 'local' = 'global'): PairwiseAlignment => ({
  mode, score, rowA, rowB, startA: 0, endA: rowA.replace(/-/g, '').length, startB: 0, endB: rowB.replace(/-/g, '').length,
});

describe('alignmentStats (hand-counted)', () => {
  const sc = dna(2, -3, affine(5, 1));
  // A C G - - T T A
  // A G G C C T - A   -> identities: A,G,T,A = 4 ; mismatch: C/G = 1 ; gap columns: 3 (2 in A-row run, 1 in B-row run)
  const aln = mk('ACG--TTA', 'AGGCCT-A', 0);
  it('counts identities, mismatches, gap columns and gap openings', () => {
    expect(alignmentStats(aln, sc)).toMatchObject({ length: 8, identities: 4, mismatches: 1, gapColumns: 3, gapOpens: 2, gapsInA: 2, gapsInB: 1, alignedColumns: 5 });
  });
  it('identity % uses the alignment length as denominator', () => {
    expect(alignmentStats(aln, sc).identityPct).toBe((4 / 8) * 100);
  });
  it('an empty alignment has null percentages (not NaN)', () => {
    expect(alignmentStats(mk('', '', 0, 'local'), sc)).toMatchObject({ length: 0, identityPct: null, similarityPct: null });
  });
  it('similarity counts positive-scoring non-identical pairs under a matrix', () => {
    const p = protein('BLOSUM62', linear(5));
    const s = alignmentStats(mk('ILK', 'VLR', 0), p); // I/V = 3 (positive), L/L identity, K/R = 2 (positive)
    expect(s).toMatchObject({ identities: 1, positives: 2 });
    expect(s.similarityPct).toBe(100);
  });
  it('adjacent gaps in opposite rows count as two openings', () => {
    expect(alignmentStats(mk('A-C', 'AGC', 0), sc).gapOpens).toBe(1);
    expect(alignmentStats(mk('A-CG', 'AG-G', 0), sc).gapOpens).toBe(2);
  });
});

describe('matchLine', () => {
  it("uses | for identity, : for positive, . for zero, space for negative/gap", () => {
    const p = protein('BLOSUM62', linear(5));
    // A/A identity, I/V positive(3), S/T positive(1), A/C = 0 (weak), A/W = -3, gap
    expect(matchLine(mk('AISAA-', 'AVTCWA', 0), p)).toBe('|::.  ');
  });
});

describe('scoreAlignedRows', () => {
  const sc = dna(2, -3, affine(5, 1));
  it('a switch between the two gap rows pays a fresh open', () => {
    expect(scoreAlignedRows('A-', '-C', sc)).toBe(-10);
    expect(scoreAlignedRows('A--', '-CC', sc)).toBe(-5 - 5 - 1);
  });
  it('rejects unequal rows and double-gap columns', () => {
    expect(() => scoreAlignedRows('AC', 'A', sc)).toThrow(RangeError);
    expect(() => scoreAlignedRows('A-', 'A-', sc)).toThrow(/two gaps/);
  });
});

describe('validateAlignment catches broken alignments', () => {
  const sc = dna(2, -3, linear(4));
  const good = align('ACGT', 'ACGT', 'global', sc);
  it('accepts a correct alignment', () => { expect(validateAlignment(good, 'ACGT', 'ACGT', sc).ok).toBe(true); });
  it('detects a wrong score', () => { expect(validateAlignment({ ...good, score: good.score + 1 }, 'ACGT', 'ACGT', sc).problems.join()).toMatch(/Re-scoring/); });
  it('detects rows that do not match the input sequences', () => {
    expect(validateAlignment(mk('ACGA', 'ACGT', 5), 'ACGT', 'ACGT', sc).problems.join()).toMatch(/Row A/);
    expect(validateAlignment(mk('ACGT', 'ACGA', 5), 'ACGT', 'ACGT', sc).problems.join()).toMatch(/Row B/);
  });
  it('detects unequal rows, double-gap columns, and incomplete global alignments', () => {
    expect(validateAlignment(mk('ACG', 'AC', 0), 'ACG', 'AC', sc).problems.join()).toMatch(/different lengths/);
    expect(validateAlignment(mk('A-C', 'A-C', 0), 'AC', 'AC', sc).problems.join()).toMatch(/two gaps/);
    expect(validateAlignment({ ...good, endA: 3, rowA: 'ACG', rowB: 'ACG' }, 'ACGT', 'ACGT', sc).problems.join()).toMatch(/cover both/);
  });
});
