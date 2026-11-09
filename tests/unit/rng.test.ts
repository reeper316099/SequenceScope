// PRNG tests: known answers (from an independent Python port of sfc32/splitmix32), uniformity, independent streams.
import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../../src/bio/rng';
import { shuffleResidues } from '../../src/bio/shuffle';

describe('Rng known-answer test (first 5 uint32 outputs per seed)', () => {
  const cases: [number, number[]][] = [
    [0, [548183886, 1097162541, 2219297441, 1664216021, 3479288465]],
    [1, [1130556604, 2591592147, 3014952990, 960850752, 2734082507]],
    [12345, [2142345551, 3083893245, 1997626643, 3123200824, 1123390551]],
    [4294967295, [2246433216, 2156899173, 2040853526, 3823104220, 1358629326]],
  ];
  for (const [seed, expected] of cases) {
    it(`seed ${seed}`, () => {
      const r = createRng(seed);
      expect([0, 1, 2, 3, 4].map(() => r.nextUint32())).toEqual(expected);
    });
  }
  it('deriveSeed known answers (seed 42, streams 0..3)', () => {
    expect([0, 1, 2, 3].map((k) => deriveSeed(42, k))).toEqual([3301857756, 1832936576, 2771854531, 3733768584]);
  });
});

describe('Rng behaviour', () => {
  it('same seed gives the same sequence; different seeds differ', () => {
    const a = createRng(7), b = createRng(7), c = createRng(8);
    const xs = Array.from({ length: 50 }, () => a.nextUint32());
    expect(Array.from({ length: 50 }, () => b.nextUint32())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c.nextUint32())).not.toEqual(xs);
  });
  it('nextFloat is in [0,1) and roughly uniform (10 bins, chi-square below the 0.001 critical value 27.88 for 9 dof)', () => {
    const r = createRng(2024);
    const N = 100_000, bins = new Array<number>(10).fill(0);
    for (let i = 0; i < N; i++) { const f = r.nextFloat(); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1); bins[Math.floor(f * 10)] = (bins[Math.floor(f * 10)] ?? 0) + 1; }
    const chi = bins.reduce((t, o) => t + (o - N / 10) ** 2 / (N / 10), 0);
    expect(chi).toBeLessThan(27.88);
  });
  it('nextInt is unbiased over a bound that does not divide 2^32 (chi-square, 7 bins, critical 22.46 for 6 dof at 0.001)', () => {
    const r = createRng(99);
    const N = 70_000, bins = new Array<number>(7).fill(0);
    for (let i = 0; i < N; i++) { const k = r.nextInt(7); bins[k] = (bins[k] ?? 0) + 1; }
    expect(bins.reduce((t, o) => t + (o - N / 7) ** 2 / (N / 7), 0)).toBeLessThan(22.46);
  });
  it('derived streams are independent: first outputs differ and replicate r does not depend on others', () => {
    const firsts = Array.from({ length: 200 }, (_, k) => createRng(deriveSeed(5, k)).nextUint32());
    expect(new Set(firsts).size).toBe(200);
    // computing stream 3 alone equals computing it after other streams
    const alone = createRng(deriveSeed(5, 3)).nextUint32();
    for (let k = 0; k < 3; k++) createRng(deriveSeed(5, k)).nextUint32();
    expect(createRng(deriveSeed(5, 3)).nextUint32()).toBe(alone);
  });
  it('rejects bad seeds and bounds with typed errors', () => {
    for (const s of [-1, 1.5, 2 ** 32, Number.NaN]) expect(() => createRng(s)).toThrow(/Seed must be/);
    expect(() => createRng(1).nextInt(0)).toThrow(/bound/);
  });
  it('shuffle preserves composition and is deterministic per seed', () => {
    const s = 'AACCCGGGGTTTTT';
    const x = shuffleResidues(createRng(3), s);
    expect([...x].sort().join('')).toBe([...s].sort().join(''));
    expect(shuffleResidues(createRng(3), s)).toBe(x);
  });
});
