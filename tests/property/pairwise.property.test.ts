// fast-check properties for the pairwise aligner (ALGORITHMS.md sections 1-5).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { alignmentStats, scoreAlignedRows, validateAlignment } from '../../src/bio/alignstats';
import { satisfiesSelfAlignmentCondition, getMatrix } from '../../src/bio/matrices';
import { align, alignAll, alignScoreOnly, fillMatrix, tracebackFirst } from '../../src/bio/pairwise';
import type { AlignMode } from '../../src/shared/types';
import { seqOf } from '../helpers/arb';
import { affine, dna, linear, protein } from '../helpers/scoring';

const D = (max: number, min = 0) => seqOf('ACGT', max, min);
const P = (max: number, min = 0) => seqOf('ACDEFGHIKLMNPQRSTVWY', max, min);
const modes: AlignMode[] = ['global', 'local'];
const gapArb = fc.oneof(
  fc.integer({ min: 0, max: 8 }).map((g) => linear(g)),
  fc.tuple(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 6 })).map(([o, e]) => affine(o, e)),
);
const RUNS = { numRuns: 200 };

describe('properties', () => {
  it('re-scoring the returned alignment gives exactly the reported score; gap-free rows return the input', () => {
    fc.assert(fc.property(D(40), D(40), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = dna(2, -3, g);
      const r = validateAlignment(align(a, b, mode, sc), a, b, sc);
      expect(r.problems).toEqual([]);
    }), RUNS);
    fc.assert(fc.property(P(30), P(30), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = protein('BLOSUM62', g);
      expect(validateAlignment(align(a, b, mode, sc), a, b, sc).problems).toEqual([]);
    }), RUNS);
  });

  it('swapping the two sequences gives the same score (symmetric scoring)', () => {
    fc.assert(fc.property(D(35), D(35), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = dna(3, -2, g);
      expect(align(a, b, mode, sc).score).toBe(align(b, a, mode, sc).score);
    }), RUNS);
  });

  it('local score >= global score and local score >= 0', () => {
    fc.assert(fc.property(D(35), D(35), gapArb, (a, b, g) => {
      const sc = dna(2, -2, g);
      const local = align(a, b, 'local', sc).score;
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeGreaterThanOrEqual(align(a, b, 'global', sc).score);
    }), RUNS);
  });

  it('self-alignment: global score is the sum of diagonal scores and identity is 100% (DNA and BLOSUM matrices)', () => {
    fc.assert(fc.property(D(40, 1), gapArb, (a, g) => {
      const sc = dna(2, -3, g);
      const r = align(a, a, 'global', sc);
      expect(r.score).toBe(2 * a.length);
      expect(alignmentStats(r, sc).identityPct).toBe(100);
    }), RUNS);
    for (const name of ['BLOSUM45', 'BLOSUM62', 'BLOSUM80']) {
      expect(satisfiesSelfAlignmentCondition(getMatrix(name))).toBe(true); // precondition from ALGORITHMS.md section 5
      fc.assert(fc.property(P(40, 1), gapArb, (a, g) => {
        const sc = protein(name, g);
        const diag = [...a].reduce((t, ch) => t + sc.charScore(ch, ch), 0);
        const r = align(a, a, 'global', sc);
        expect(r.score).toBe(diag);
        expect(alignmentStats(r, sc).identityPct).toBe(100);
      }), { numRuns: 80 });
    }
  });

  it('affine with open = extend equals linear (score)', () => {
    fc.assert(fc.property(D(35), D(35), fc.constantFrom(...modes), fc.integer({ min: 0, max: 9 }), (a, b, mode, g) => {
      expect(align(a, b, mode, dna(2, -1, affine(g, g))).score).toBe(align(a, b, mode, dna(2, -1, linear(g))).score);
    }), RUNS);
  });

  it('making gaps costlier never improves the score', () => {
    fc.assert(fc.property(D(30), D(30), fc.constantFrom(...modes), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), (a, b, mode, o, e, dOpen, dExt) => {
      const base = align(a, b, mode, dna(2, -2, affine(o, e))).score;
      expect(align(a, b, mode, dna(2, -2, affine(o + dOpen, e + dExt))).score).toBeLessThanOrEqual(base);
    }), RUNS);
  });

  it('is deterministic: same inputs give identical output, including tie-breaking', () => {
    fc.assert(fc.property(seqOf('AC', 25), seqOf('AC', 25), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = dna(1, -1, g);
      expect(align(a, b, mode, sc)).toEqual(align(a, b, mode, sc));
      expect(alignAll(a, b, mode, sc, 50)).toEqual(alignAll(a, b, mode, sc, 50));
    }), RUNS);
  });

  it('score-only (two-row) mode equals the full fill, and the matrix traceback equals align()', () => {
    fc.assert(fc.property(D(40), D(40), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = dna(2, -3, g);
      const dp = fillMatrix(a, b, mode, sc);
      expect(alignScoreOnly(a, b, mode, sc)).toBe(dp.score);
      expect(tracebackFirst(dp)).toEqual(align(a, b, mode, sc));
    }), RUNS);
  });

  it('every enumerated co-optimal alignment is valid, distinct, has the optimal score, and the first equals align()', () => {
    fc.assert(fc.property(seqOf('AC', 9), seqOf('AC', 9), fc.constantFrom(...modes), gapArb, (a, b, mode, g) => {
      const sc = dna(1, -1, g);
      const all = alignAll(a, b, mode, sc, 200);
      expect(all.alignments[0]).toEqual(align(a, b, mode, sc));
      const seen = new Set<string>();
      for (const x of all.alignments) {
        expect(x.score).toBe(all.score);
        expect(validateAlignment(x, a, b, sc).problems).toEqual([]);
        seen.add(`${x.rowA}|${x.rowB}|${x.startA}|${x.startB}`);
      }
      expect(seen.size).toBe(all.alignments.length);
    }), RUNS);
  });

  it('scoreAlignedRows is consistent with a hand-computed value', () => {
    const sc = dna(2, -3, affine(5, 1));
    // A C - - T over A G T T T : match(2) + mismatch(-3) + gap run of 2 (5+1) + match(2) = -5
    expect(scoreAlignedRows('AC--T', 'AGTTT', sc)).toBe(2 - 3 - 6 + 2);
  });
});
