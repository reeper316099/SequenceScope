// Edge cases from the brief: empty, single residue, identical, dissimilar, very unequal lengths, ambiguity, caps.
import { describe, expect, it } from 'vitest';
import { alignmentStats, matchLine, validateAlignment } from '../../src/bio/alignstats';
import { BioError } from '../../src/bio/errors';
import { MAX_DP_CELLS, align, alignAll, assertWithinCap, fillMatrix } from '../../src/bio/pairwise';
import { compileScoring } from '../../src/bio/scoring';
import { affine, dna, linear, protein } from '../helpers/scoring';

describe('empty and tiny inputs', () => {
  it('global: empty vs empty scores 0; empty vs non-empty is one all-gap alignment', () => {
    const sc = dna(2, -3, affine(5, 1));
    expect(align('', '', 'global', sc)).toMatchObject({ score: 0, rowA: '', rowB: '' });
    expect(align('', 'ACG', 'global', sc)).toMatchObject({ score: -(5 + 1 + 1), rowA: '---', rowB: 'ACG' });
    expect(align('AC', '', 'global', dna(2, -3, linear(4)))).toMatchObject({ score: -8, rowA: 'AC', rowB: '--' });
  });
  it('local: empty input gives score 0 and an empty alignment', () => {
    expect(align('', 'ACG', 'local', dna(2, -3, linear(4)))).toMatchObject({ score: 0, rowA: '' });
    expect(alignAll('', '', 'local', dna(2, -3, affine(3, 1)))).toMatchObject({ score: 0, capped: false });
  });
  it('single residues', () => {
    const sc = dna(2, -3, linear(4));
    expect(align('A', 'A', 'global', sc).score).toBe(2);
    expect(align('A', 'C', 'global', sc).score).toBe(-3); // mismatch (-3) beats two gaps (-8)
    expect(align('A', 'C', 'local', sc).score).toBe(0);
  });
});

describe('identical, dissimilar, and unequal sequences', () => {
  it('identical sequences: no gaps, 100% identity', () => {
    const sc = protein('BLOSUM62', affine(11, 1));
    const a = align('MKVLAAGIVGLLLA', 'MKVLAAGIVGLLLA', 'global', sc);
    expect(a.rowA).toBe(a.rowB);
    expect(alignmentStats(a, sc)).toMatchObject({ identityPct: 100, gapColumns: 0, gapOpens: 0 });
  });
  it('completely different sequences: local score is 0 (no real alignment); global still aligns end to end', () => {
    const sc = dna(2, -3, affine(5, 2));
    expect(align('AAAAAA', 'CCCCCC', 'local', sc)).toMatchObject({ score: 0, rowA: '', endA: 0 });
    const g = align('AAAAAA', 'CCCCCC', 'global', sc);
    expect(g.score).toBe(-18);
    expect(alignmentStats(g, sc).identityPct).toBe(0);
  });
  it('very unequal lengths work and validate', () => {
    const sc = dna(2, -3, affine(5, 1));
    const long = 'ACGT'.repeat(50);
    const r = align(long, 'ACGT', 'global', sc);
    expect(validateAlignment(r, long, 'ACGT', sc).problems).toEqual([]);
    expect(r.rowA).toHaveLength(long.length);
    const l = align(long, 'ACGT', 'local', sc);
    expect(l.score).toBe(8);
  });
  it('an all-gap-forced alignment (one sequence empty after the other is long) has the affine closed form', () => {
    expect(align('', 'A'.repeat(10), 'global', dna(1, -1, affine(7, 2))).score).toBe(-(7 + 9 * 2));
  });
});

describe('ambiguity codes and invalid residues', () => {
  it('DNA ambiguity codes score 0 and never count as identity', () => {
    const sc = dna(2, -3, linear(4));
    const r = align('ACNGT', 'ACNGT', 'global', sc);
    expect(r.score).toBe(2 * 4 + 0);
    const st = alignmentStats(r, sc);
    expect(st.identities).toBe(4);
    expect(st.ambiguousColumns).toBe(1);
    expect(matchLine(r, sc)).toBe('|| ||');
  });
  it('protein B/Z/X/* come from the matrix; J/U/O are treated as X', () => {
    const sc = protein('BLOSUM62', linear(5));
    expect(sc.charScore('B', 'D')).toBe(4);
    expect(sc.charScore('J', 'A')).toBe(sc.charScore('X', 'A'));
    expect(align('BZX*', 'BZX*', 'global', sc).score).toBe(sc.charScore('B', 'B') + sc.charScore('Z', 'Z') + sc.charScore('X', 'X') + sc.charScore('*', '*'));
  });
  it('the DP table agrees with the independent char scorer for every letter pair', () => {
    for (const [alpha, sc] of [['dna', dna(3, -2, linear(1))], ['protein', protein('BLOSUM80', linear(1))]] as const) {
      const letters = alpha === 'dna' ? 'ACGTRYSWKMBDHVN' : 'ACDEFGHIKLMNPQRSTVWYBZXJUO*';
      for (const x of letters) for (const y of letters) {
        const a = align(x, y, 'global', sc);
        // single-column global alignment: either the pair score, or two gaps if that is better
        expect(a.score).toBe(Math.max(sc.charScore(x, y), -2 * sc.gapOpen));
      }
    }
  });
  it('invalid characters raise a typed error with the position', () => {
    const sc = dna(1, -1, linear(1));
    try { align('ACGT', 'AC#T', 'global', sc); throw new Error('should have thrown'); } catch (e) {
      expect(e).toBeInstanceOf(BioError);
      expect((e as BioError).code).toBe('invalid-residue');
      expect((e as BioError).message).toContain('position 3');
    }
  });
  it('RNA uses U, rejects T; a matrix cannot be used with DNA', () => {
    const rna = dna(1, -1, linear(1), 'rna');
    expect(align('ACGU', 'ACGU', 'global', rna).score).toBe(4);
    expect(() => align('ACGT', 'ACGU', 'global', rna)).toThrow(/not valid for rna/);
    expect(() => compileScoring({ substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: { kind: 'linear', gap: 1 } }, 'dna')).toThrow(/protein/);
  });
});

describe('scoring validation and size cap', () => {
  it('rejects non-integer, negative, or huge parameters', () => {
    expect(() => dna(1.5, -1, linear(1))).toThrow(BioError);
    expect(() => dna(1, -1, linear(-1))).toThrow(/Gap penalty/);
    expect(() => dna(1, -1, affine(10001, 1))).toThrow(/Gap penalty/);
    expect(() => dna(5000, -1, linear(1))).toThrow(/Match/);
  });
  it('cap boundary: exactly at the cap passes, one over fails', () => {
    // : two 5,000-residue sequences fit, 5,001 x 5,000 does not
    expect(() => assertWithinCap(5000, 5000, true)).not.toThrow();
    expect(() => assertWithinCap(0, 26_000_000, false)).toThrow(/limit/); // one huge sequence is refused too
    try { assertWithinCap(5001, 5000, true); throw new Error('should have thrown'); } catch (e) {
      expect((e as BioError).code).toBe('too-large');
      expect((e as BioError).message).toContain('MB');
    }
    const big = 'A'.repeat(6000);
    expect(() => fillMatrix(big, big, 'global', dna(1, -1, linear(1)))).toThrow(/limit is 25,010,001/);
    expect(MAX_DP_CELLS).toBe(25_010_001);
  });
});

describe('co-optimal enumeration and cap', () => {
  it('counts known ties: A vs AA local with match 1 has two optimal alignments', () => {
    const r = alignAll('A', 'AA', 'local', dna(1, -1, linear(2)));
    expect(r.alignments).toHaveLength(2);
    expect(r.capped).toBe(false);
  });
  it('the cap is honoured and reported', () => {
    const r = alignAll('AAAAAAAA', 'AAAAAAAA', 'global', dna(0, 0, linear(0)), 10);
    expect(r.alignments).toHaveLength(10);
    expect(r.capped).toBe(true);
    expect(() => alignAll('A', 'A', 'global', dna(1, -1, linear(1)), 0)).toThrow(/cap/);
  });
  it('first alignment follows the documented preference: diagonal before gaps', () => {
    const r = align('AC', 'AC', 'global', dna(0, 0, linear(0)));
    expect(r.rowA).toBe('AC');
    expect(r.rowB).toBe('AC');
  });
});
