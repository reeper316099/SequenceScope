// THE most important test: the DP score equals the true maximum found by enumerating every alignment.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { alignAll, align, alignScoreOnly } from '../../src/bio/pairwise';
import { seqOf } from '../helpers/arb';
import { bruteForce } from '../helpers/brute';
import { affine, dna, linear, protein } from '../helpers/scoring';
import type { AlignMode, GapModel } from '../../src/shared/types';

const seqDna = (max: number) => seqOf('ACGT', max);
const seqSmall = (max: number) => seqOf('AC', max);
const seqProt = (max: number) => seqOf('ARNDW', max);

const gapModels: { name: string; g: GapModel }[] = [
  { name: 'linear 2', g: linear(2) }, { name: 'linear 0', g: linear(0) }, { name: 'linear 7', g: linear(7) },
  { name: 'affine 5/1', g: affine(5, 1) }, { name: 'affine 3/3', g: affine(3, 3) },
  { name: 'affine 1/4 (open cheaper than extend)', g: affine(1, 4) }, { name: 'affine 0/0', g: affine(0, 0) }, { name: 'affine 10/2', g: affine(10, 2) },
];

describe.each(['global', 'local'] as AlignMode[])('brute force vs DP, DNA, %s', (mode) => {
  for (const { name, g } of gapModels) {
    it(`${name}: score equals the maximum over all alignments`, () => {
      fc.assert(
        fc.property(seqDna(mode === 'local' ? 5 : 6), seqDna(mode === 'local' ? 5 : 6), fc.integer({ min: 1, max: 5 }), fc.integer({ min: -5, max: 3 }), (a, b, match, mismatch) => {
          const sc = dna(match, mismatch, g);
          const expected = bruteForce(a, b, mode, sc);
          expect(alignAll(a, b, mode, sc, 5).score).toBe(expected);
          expect(align(a, b, mode, sc).score).toBe(expected);
          expect(alignScoreOnly(a, b, mode, sc)).toBe(expected);
        }),
        { numRuns: mode === 'local' ? 60 : 150 },
      );
    });
  }
  it('binary alphabet, many ties', () => {
    fc.assert(fc.property(seqSmall(6), seqSmall(6), (a, b) => {
      for (const { g } of gapModels) {
        const sc = dna(1, -1, g);
        expect(align(a, b, mode, sc).score).toBe(bruteForce(a, b, mode, sc));
      }
    }), { numRuns: mode === 'local' ? 40 : 100 });
  });
  it('protein with BLOSUM62 (subset alphabet)', () => {
    fc.assert(fc.property(seqProt(5), seqProt(5), (a, b) => {
      for (const g of [linear(4), affine(11, 1), affine(6, 3)]) {
        const sc = protein('BLOSUM62', g);
        expect(align(a, b, mode, sc).score).toBe(bruteForce(a, b, mode, sc));
      }
    }), { numRuns: mode === 'local' ? 30 : 80 });
  });
});

describe('exhaustive over all pairs on a tiny alphabet', () => {
  it('every pair of sequences up to length 3 over {A,C}, all modes and gap models', () => {
    const all: string[] = [''];
    for (let len = 1; len <= 3; len++) for (let k = 0; k < 2 ** len; k++) all.push([...k.toString(2).padStart(len, '0')].map((c) => (c === '0' ? 'A' : 'C')).join(''));
    let checked = 0;
    for (const a of all) for (const b of all) for (const mode of ['global', 'local'] as AlignMode[]) for (const { g } of gapModels) {
      const sc = dna(2, -1, g);
      expect(align(a, b, mode, sc).score).toBe(bruteForce(a, b, mode, sc));
      checked++;
    }
    expect(checked).toBe(15 * 15 * 2 * gapModels.length);
  });
});
