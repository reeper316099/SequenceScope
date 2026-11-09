// Bootstrap on aligned input: reproducibility regardless of worker count, perfect vs conflicting data, validation.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootstrap, bootstrapRange, finishBootstrap, mergeBootstrap, referenceTree, replicateWeights, validateBootstrapInput } from '../../src/bio/bootstrap';
import type { BootstrapInput } from '../../src/bio/bootstrap';
import type { BioError } from '../../src/bio/errors';
import { parseFasta } from '../../src/bio/fasta';
import { createRng } from '../../src/bio/rng';
import { nontrivialSplits, preorder } from '../../src/bio/tree';

const base = (over: Partial<BootstrapInput>): BootstrapInput => ({ names: [], rows: [], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 100, seed: 42, ...over });
const strip = (r: ReturnType<typeof bootstrap>) => (r === null ? null : { s: r.supports, f: r.failedReplicates, rep: r.replicates, seed: r.seed });

/** Alignment of 5 taxa where EVERY column has the same pattern (A,B = 'A'; C,D = 'C'; E = 'G'): every resample is identical. */
const perfect = base({ names: ['A', 'B', 'C', 'D', 'E'], rows: ['A'.repeat(40), 'A'.repeat(40), 'C'.repeat(40), 'C'.repeat(40), 'G'.repeat(40)] });

/** Hand-built conflict: 30 columns say (A,B)|(C,D) and 10 columns say (A,C)|(B,D). */
const conflict = (() => {
  const rows = ['', '', '', ''];
  const add = (a: string, b: string, c: string, d: string, times: number): void => { for (let k = 0; k < times; k++) { rows[0] += a; rows[1] += b; rows[2] += c; rows[3] += d; } };
  add('A', 'A', 'C', 'C', 18); add('A', 'C', 'A', 'C', 12); add('G', 'G', 'T', 'T', 6); add('G', 'T', 'G', 'T', 4);
  return base({ names: ['A', 'B', 'C', 'D'], rows, replicates: 200, seed: 7 });
})();

describe('reproducibility', () => {
  it('same seed gives identical weights, identical supports; a different seed gives different replicates', () => {
    expect(Array.from(replicateWeights(50, 9, 3))).toEqual(Array.from(replicateWeights(50, 9, 3)));
    expect(Array.from(replicateWeights(50, 9, 3))).not.toEqual(Array.from(replicateWeights(50, 9, 4)));
    expect(Array.from(replicateWeights(50, 9, 3))).not.toEqual(Array.from(replicateWeights(50, 10, 3)));
    expect(replicateWeights(77, 5, 0).reduce((a, b) => a + b, 0)).toBe(77); // same number of columns as the original
    expect(strip(bootstrap(conflict))).toEqual(strip(bootstrap(conflict)));
    expect(strip(bootstrap({ ...conflict, seed: 8 }))).not.toEqual(strip(bootstrap(conflict)));
  });
  it('results do not depend on how replicates are split across workers (1, 2, 3, 7 slices, any merge order)', () => {
    const whole = bootstrapRange(conflict, 0, conflict.replicates);
    if (whole === null) throw new Error('cancelled');
    for (const parts of [1, 2, 3, 7]) {
      const bounds = Array.from({ length: parts + 1 }, (_, k) => Math.round((k * conflict.replicates) / parts));
      const slices = Array.from({ length: parts }, (_, k) => bootstrapRange(conflict, bounds[k] as number, bounds[k + 1] as number) as NonNullable<ReturnType<typeof bootstrapRange>>);
      for (const order of [slices, [...slices].reverse()]) {
        const merged = mergeBootstrap(order);
        expect([...merged.counts.entries()].sort()).toEqual([...whole.counts.entries()].sort());
        expect(merged.done).toBe(conflict.replicates);
        expect(finishBootstrap(conflict, merged).supports).toEqual(finishBootstrap(conflict, whole).supports);
      }
    }
  });
  it('records the number of replicates and the seed in the result', () => {
    const r = bootstrap({ ...conflict, replicates: 20, seed: 123 });
    expect(r).toMatchObject({ replicates: 20, seed: 123, method: 'nj', model: 'p', gapPolicy: 'pairwise-deletion', failedReplicates: 0 });
  });
});

describe('what the support values mean', () => {
  it('a trivially perfect alignment (every column identical across resamples) gives 100 % for every split', () => {
    for (const method of ['nj', 'upgma'] as const) {
      const r = bootstrap({ ...perfect, method, replicates: 60 });
      expect(r?.supports.length).toBeGreaterThan(0);
      for (const s of r?.supports ?? []) expect(s.percent).toBe(100);
      for (const n of preorder(r?.referenceTree ?? { root: { children: [] } })) if (n.children.length > 0 && n !== r?.referenceTree.root) expect(n.support).toBe(100);
    }
  });
  it('conflicting data gives lower support (strictly between 0 and 100) for the reference split', () => {
    const r = bootstrap(conflict);
    expect(r?.supports).toHaveLength(1);
    expect(r?.supports[0]?.leaves.sort().join()).toMatch(/C,D|A,B/);
    const pct = r?.supports[0]?.percent ?? -1;
    expect(pct).toBeGreaterThan(55);
    expect(pct).toBeLessThan(100);
    expect(r?.failedReplicates).toBe(0);
  });
  it('support is a count over replicates (a multiple of 100/replicates), never above 100', () => {
    const r = bootstrap({ ...conflict, replicates: 40 });
    for (const s of r?.supports ?? []) { expect(s.percent).toBeCloseTo((s.count / 40) * 100, 12); expect(s.percent).toBeLessThanOrEqual(100); }
  });
  it('real data: MAFFT-aligned alpha-globins, 100 replicates, completes and is reproducible', () => {
    const parsed = parseFasta(readFileSync('examples/globin_alpha_vertebrates/aligned.fasta', 'utf8'), { allowGaps: true, alphabet: 'protein' });
    const inp = base({ names: parsed.records.map((r) => r.id), rows: parsed.records.map((r) => r.residues), alphabet: 'protein', model: 'poisson', replicates: 100, seed: 2026 });
    const a = bootstrap(inp); const b = bootstrap(inp);
    expect(strip(a)).toEqual(strip(b));
    expect(a?.supports.length).toBe(nontrivialSplits(referenceTree(inp)).splits.size);
    for (const s of a?.supports ?? []) { expect(s.percent).toBeGreaterThanOrEqual(0); expect(s.percent).toBeLessThanOrEqual(100); }
  });
});

describe('failed replicates, cancellation, validation', () => {
  it('replicates whose matrix has no usable distances are counted as failed (and not as containing the split)', () => {
    // Jukes-Cantor saturates when p >= 0.75. Search seeded random 12-column alignments for one whose ORIGINAL matrix is
    // usable but whose resamples sometimes saturate.
    let found: ReturnType<typeof bootstrap> = null;
    let inp: BootstrapInput | null = null;
    for (let seed = 1; seed <= 300 && found === null; seed++) {
      const rng = createRng(seed);
      const rows = Array.from({ length: 4 }, () => Array.from({ length: 12 }, () => 'ACGT'.charAt(rng.nextInt(4))).join(''));
      const cand = base({ names: ['A', 'B', 'C', 'D'], rows, model: 'jc', replicates: 200, seed: 3, method: 'nj' });
      try { referenceTree(cand); } catch { continue; }
      const r = bootstrap(cand);
      if (r !== null && r.failedReplicates > 0) { found = r; inp = cand; }
    }
    expect(found).not.toBeNull();
    expect(inp).not.toBeNull();
    expect(found?.failedReplicates ?? 0).toBeGreaterThan(0);
    for (const s of found?.supports ?? []) expect(s.count).toBeLessThanOrEqual(200 - (found?.failedReplicates ?? 0)); // failures never count as support
    // and a reference alignment that is itself saturated is refused with a typed error
    const saturated = base({ names: ['A', 'B', 'C', 'D'], rows: ['AAAAAAAAAAAA', 'CCCCCCCCCCCC', 'GGGGGGGGGGGG', 'TTTTTTTTTTTT'], model: 'jc', replicates: 10 });
    expect(() => bootstrap(saturated)).toThrow(/no usable distance/);
  });
  it('cancellation returns null and keeps no partial result', () => {
    let calls = 0;
    expect(bootstrap(conflict, { shouldCancel: () => ++calls > 3 })).toBeNull();
  });
  it('progress reaches 1', () => {
    const seen: number[] = [];
    bootstrap({ ...conflict, replicates: 10 }, { onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
  });
  const code = (inp: BootstrapInput): string => { try { validateBootstrapInput(inp); return 'ok'; } catch (e) { return (e as BioError).code; } };
  it('typed errors: not aligned (explains why), too few sequences, duplicate names, bad replicates, wrong model, size caps', () => {
    expect(code({ ...conflict, rows: ['ACGT', 'ACG', 'ACGT', 'ACGT'] })).toBe('not-aligned');
    try { validateBootstrapInput({ ...conflict, rows: ['ACGT', 'ACG', 'ACGT', 'ACGT'] }); } catch (e) { expect((e as BioError).message).toContain('Bootstrap needs an alignment'); }
    expect(code({ ...conflict, names: ['A', 'B'], rows: ['AC', 'AC'] })).toBe('too-few-sequences');
    expect(code({ ...conflict, names: ['A', 'A', 'B', 'C'] })).toBe('duplicate-names');
    expect(code({ ...conflict, replicates: 0 })).toBe('invalid-argument');
    expect(code({ ...conflict, replicates: 1001 })).toBe('invalid-argument');
    expect(code({ ...conflict, alphabet: 'protein', model: 'jc' })).toBe('incompatible-model');
    expect(code({ ...conflict, rows: ['', '', '', ''] })).toBe('not-aligned');
    const wide = 'A'.repeat(60_000);
    expect(code({ ...conflict, rows: [wide, wide, wide, wide] })).toBe('too-large');
    expect(code({ ...conflict, names: Array.from({ length: 101 }, (_, k) => `s${k}`), rows: Array.from({ length: 101 }, () => 'ACGT') })).toBe('too-large');
  });
});
