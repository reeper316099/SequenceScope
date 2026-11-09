// Shuffle significance tests (ALGORITHMS.md section 12).
import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/bio/rng';
import { runShuffleTest, shuffleResidues } from '../../src/bio/shuffle';
import { alignScoreOnly } from '../../src/bio/pairwise';
import { dna, linear, protein, affine } from '../helpers/scoring';

const rand = (seed: number, n: number, letters: string): string => { const r = createRng(seed); return Array.from({ length: n }, () => letters.charAt(r.nextInt(letters.length))).join(''); };

describe('runShuffleTest', () => {
  const sc = dna(2, -3, affine(5, 2));
  it('same seed gives an identical distribution; a different seed does not', () => {
    const a = rand(1, 60, 'ACGT'), b = rand(2, 60, 'ACGT');
    const r1 = runShuffleTest({ a, b, mode: 'local', scoring: sc, shuffles: 100, seed: 11 });
    const r2 = runShuffleTest({ a, b, mode: 'local', scoring: sc, shuffles: 100, seed: 11 });
    const r3 = runShuffleTest({ a, b, mode: 'local', scoring: sc, shuffles: 100, seed: 12 });
    if (r1.cancelled || r2.cancelled || r3.cancelled) throw new Error('unexpected cancel');
    expect(Array.from(r1.scores)).toEqual(Array.from(r2.scores));
    expect(Array.from(r1.scores)).not.toEqual(Array.from(r3.scores));
  });
  it('a clearly related pair falls far in the tail; two unrelated random sequences do not', () => {
    const a = rand(5, 80, 'ACGT');
    const related = runShuffleTest({ a, b: a, mode: 'local', scoring: sc, shuffles: 200, seed: 1 });
    if (related.cancelled) throw new Error('cancel');
    expect(related.atLeastAsGood).toBe(0);
    expect(related.pValue).toBeCloseTo(1 / 201, 12);
    expect(related.z ?? 0).toBeGreaterThan(5);
    // unrelated: across 20 independent random pairs the p-value must not be tiny for (almost) all of them
    let small = 0;
    for (let k = 0; k < 20; k++) {
      const u = runShuffleTest({ a: rand(100 + k, 80, 'ACGT'), b: rand(300 + k, 80, 'ACGT'), mode: 'local', scoring: sc, shuffles: 100, seed: k });
      if (u.cancelled) throw new Error('cancel');
      if (u.pValue < 0.01) small++;
    }
    expect(small).toBeLessThanOrEqual(2); // expected ~0.2 false alarms at 1% level; allow slack
  });
  it('p-value uses the +1 correction and is never exactly 0; z is null (not NaN) when all shuffles score the same', () => {
    const r = runShuffleTest({ a: 'AAAA', b: 'AAAA', mode: 'global', scoring: dna(1, -1, linear(1)), shuffles: 10, seed: 3 });
    if (r.cancelled) throw new Error('cancel');
    expect(r.sd).toBe(0);
    expect(r.z).toBeNull();
    expect(r.pValue).toBe(1); // every shuffle equals the real score: (1+10)/(10+1)
    const strong = runShuffleTest({ a: 'ACGTACGTAC', b: 'ACGTACGTAC', mode: 'global', scoring: dna(5, -4, linear(6)), shuffles: 50, seed: 4 });
    if (strong.cancelled) throw new Error('cancel');
    expect(strong.pValue).toBeGreaterThan(0);
  });
  it('the real score equals the score-only value and cancellation stops early', () => {
    const a = rand(8, 30, 'ACGT'), b = rand(9, 30, 'ACGT');
    let calls = 0;
    const c = runShuffleTest({ a, b, mode: 'global', scoring: sc, shuffles: 100, seed: 1, shouldCancel: () => ++calls > 5 });
    expect(c).toEqual({ cancelled: true, completed: 5, seed: 1 });
    const r = runShuffleTest({ a, b, mode: 'global', scoring: sc, shuffles: 5, seed: 1 });
    if (r.cancelled) throw new Error('cancel');
    expect(r.realScore).toBe(alignScoreOnly(a, b, 'global', sc));
  });
  it('rejects invalid shuffle counts and seeds with typed errors', () => {
    for (const n of [0, -1, 1.5, 5001]) expect(() => runShuffleTest({ a: 'A', b: 'A', mode: 'global', scoring: sc, shuffles: n, seed: 1 })).toThrow(/shuffles/);
    expect(() => runShuffleTest({ a: 'A', b: 'A', mode: 'global', scoring: sc, shuffles: 5, seed: -3 })).toThrow(/Seed/);
  });
  it('works for protein with a matrix', () => {
    const p = protein('BLOSUM62', affine(11, 1));
    const a = rand(21, 50, 'ACDEFGHIKLMNPQRSTVWY');
    const r = runShuffleTest({ a, b: a, mode: 'local', scoring: p, shuffles: 50, seed: 2 });
    if (r.cancelled) throw new Error('cancel');
    expect(r.pValue).toBeCloseTo(1 / 51, 12);
  });
  it('shuffleResidues of an empty string is empty', () => { expect(shuffleResidues(createRng(1), '')).toBe(''); });
});
