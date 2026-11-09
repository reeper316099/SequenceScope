// Distances: hand-computed values, gap policies, corrections and saturation, Biopython identity cross-check, pairwise-alignment route.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertTreeReady, cellValue, correctDistance, distanceMatrixFromAligned, encodeAligned, modelsFor, pairStats, pairwiseDistanceMatrix, saturationLimit, toDistanceCsv, toPhylip, unusablePairs } from '../../src/bio/distance';
import { BioError } from '../../src/bio/errors';
import { parseFasta } from '../../src/bio/fasta';
import { compileScoring } from '../../src/bio/scoring';
import { DIST_OK, DIST_SATURATED, DIST_UNDEFINED } from '../../src/shared/types';
import type { DistanceModel, GapPolicy } from '../../src/shared/types';
import { seqOf } from '../helpers/arb';

const dna = (a: string, b: string, model: DistanceModel = 'p', policy: GapPolicy = 'pairwise-deletion') => distanceMatrixFromAligned(['a', 'b'], [a, b], 'dna', model, policy);

describe('p-distance and gap policies (hand computed)', () => {
  it('2 differences in 8 sites = 0.25', () => { expect(cellValue(dna('ACGTACGT', 'ACGAACGA'), 0, 1)).toBe(0.25); });
  it('identical sequences give 0 (the corrected distance too)', () => {
    expect(cellValue(dna('ACGT', 'ACGT', 'jc'), 0, 1)).toBe(0);
    expect(cellValue(distanceMatrixFromAligned(['a', 'b'], ['MKV', 'MKV'], 'protein', 'poisson', 'pairwise-deletion'), 0, 1)).toBe(0);
  });
  it('pairwise deletion skips columns with a gap in either sequence', () => {
    const m = dna('AC-GT', 'ACAGA');
    expect(m.compared[1]).toBe(4);
    expect(cellValue(m, 0, 1)).toBe(0.25); // A,C,G,T vs A,C,G,A: 1 difference in 4 compared sites
  });
  it('gaps-as-differences counts a gap against a residue as a difference', () => {
    const m = dna('AC-GT', 'ACAGT', 'p', 'gaps-as-differences');
    expect(m.compared[1]).toBe(5);
    expect(cellValue(m, 0, 1)).toBe(0.2);
  });
  it('columns with a gap in BOTH sequences never count, in either policy', () => {
    for (const policy of ['pairwise-deletion', 'gaps-as-differences'] as const) {
      const m = dna('AC-GT', 'AC-GA', 'p', policy);
      expect(m.compared[1]).toBe(4);
      expect(cellValue(m, 0, 1)).toBe(0.25);
    }
  });
  it('ambiguity codes are skipped for that pair', () => {
    const m = dna('ACNGT', 'ACAGA');
    expect(m.compared[1]).toBe(4);
    expect(cellValue(m, 0, 1)).toBe(0.25);
  });
  it('all columns gapped in one sequence: no comparable sites is "undefined", not NaN', () => {
    const m = dna('ACGT', '----');
    expect(m.status[1]).toBe(DIST_UNDEFINED);
    expect(cellValue(m, 0, 1)).toBeNull();
    expect(unusablePairs(m)).toEqual([{ i: 0, j: 1, status: 'undefined' }]);
  });
});

describe('corrections (hand computed) and saturation', () => {
  it('Jukes–Cantor: d = -(3/4) ln(1 - 4p/3). p = 0.5 gives 0.75 ln 3', () => { expect(correctDistance(0.5, 'jc')).toBeCloseTo(0.75 * Math.log(3), 12); });
  it('Poisson: d = -ln(1 - p). p = 0.5 gives ln 2', () => { expect(correctDistance(0.5, 'poisson')).toBeCloseTo(Math.LN2, 12); });
  it('p-distance is returned unchanged; p = 0 gives exactly 0 (never -0)', () => {
    expect(correctDistance(0.3, 'p')).toBe(0.3);
    expect(Object.is(correctDistance(0, 'jc'), 0)).toBe(true);
    expect(Object.is(correctDistance(0, 'poisson'), 0)).toBe(true);
  });
  it('at and above the limit the result is "saturated" (null), never NaN or Infinity', () => {
    for (const [model, limit] of [['jc', 0.75], ['poisson', 1]] as const) {
      expect(saturationLimit(model)).toBe(limit);
      for (const p of [limit, limit + 0.1, 1.5]) expect(correctDistance(p, model)).toBeNull();
      expect(Number.isFinite(correctDistance(limit - 1e-9, model) as number)).toBe(true);
    }
  });
  it('a pair at p = 3/4 is flagged saturated in a JC matrix, and the matrix refuses to build trees with an explanation', () => {
    const m = dna('ACGT', 'CATG', 'jc'); // wait: 4 of 4 differ -> p = 1
    expect(m.status[1]).toBe(DIST_SATURATED);
    const m2 = dna('AAAA', 'AAAC'.replace('AAAC', 'CCCA'), 'jc'); // 3 of 4 differ -> p = 0.75
    expect(m2.status[1]).toBe(DIST_SATURATED);
    expect(() => assertTreeReady(m2)).toThrow(BioError);
  });
  it('corrected distance is always >= p, increasing in p, and finite below the limit (property)', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 0.7499, noNaN: true }), fc.double({ min: 0, max: 0.7499, noNaN: true }), (x, y) => {
      for (const model of ['jc', 'poisson'] as const) {
        const dx = correctDistance(x, model) as number; const dy = correctDistance(y, model) as number;
        expect(Number.isFinite(dx)).toBe(true);
        expect(dx).toBeGreaterThanOrEqual(x - 1e-12);
        if (x < y) expect(dx).toBeLessThanOrEqual(dy);
      }
    }), { numRuns: 300 });
  });
  it('no distance cell is ever NaN or Infinity, whatever the input', () => {
    fc.assert(fc.property(fc.array(seqOf('ACGT-N', 12, 12), { minLength: 2, maxLength: 5 }), fc.constantFrom('p', 'jc' as const), fc.constantFrom('pairwise-deletion', 'gaps-as-differences' as const), (rows, model, policy) => {
      const m = distanceMatrixFromAligned(rows.map((_, k) => `s${k}`), rows, 'dna', model, policy);
      for (let k = 0; k < m.n * m.n; k++) expect(Number.isFinite(m.values[k] as number)).toBe(true);
    }), { numRuns: 200 });
  });
});

describe('matrix structure and errors', () => {
  it('is symmetric with a zero diagonal (property)', () => {
    fc.assert(fc.property(fc.array(seqOf('ACGT-', 15, 15), { minLength: 2, maxLength: 6 }), (rows) => {
      const m = distanceMatrixFromAligned(rows.map((_, k) => `s${k}`), rows, 'dna', 'p', 'pairwise-deletion');
      for (let i = 0; i < m.n; i++) {
        expect(m.values[i * m.n + i]).toBe(0);
        expect(m.status[i * m.n + i]).toBe(DIST_OK);
        for (let j = 0; j < m.n; j++) { expect(m.values[i * m.n + j]).toBe(m.values[j * m.n + i]); expect(m.status[i * m.n + j]).toBe(m.status[j * m.n + i]); }
      }
    }), { numRuns: 100 });
  });
  it('unequal row lengths: typed "not-aligned" error naming the sequence', () => {
    try { distanceMatrixFromAligned(['a', 'b'], ['ACGT', 'ACG'], 'dna', 'p', 'pairwise-deletion'); throw new Error('no throw'); } catch (e) {
      expect((e as BioError).code).toBe('not-aligned');
      expect((e as BioError).message).toContain('"b"');
    }
  });
  it('model must fit the alphabet', () => {
    expect(modelsFor('protein')).toEqual(['p', 'poisson']);
    expect(modelsFor('dna')).toEqual(['p', 'jc']);
    expect(() => distanceMatrixFromAligned(['a', 'b'], ['MK', 'MK'], 'protein', 'jc', 'pairwise-deletion')).toThrow(/cannot be used/);
  });
  it('encodeAligned and pairStats with weights behave like repeated columns', () => {
    const a = encodeAligned('ACGT', 'dna'); const b = encodeAligned('AGGT', 'dna');
    expect(pairStats(a, b, 'pairwise-deletion')).toEqual({ compared: 4, differences: 1 });
    expect(pairStats(a, b, 'pairwise-deletion', new Int32Array([2, 0, 1, 3]))).toEqual({ compared: 6, differences: 0 });
    expect(pairStats(a, b, 'pairwise-deletion', new Int32Array([0, 5, 0, 0]))).toEqual({ compared: 5, differences: 5 });
  });
  it('exports: PHYLIP has unique 10-character names; CSV marks saturated cells with words', () => {
    const rows = ['ACGTACGTAC', 'ACGTACGTAA', 'ACGAACGTAC'];
    const m = distanceMatrixFromAligned(['a_very_long_name_1', 'a_very_long_name_2', 'short name'], rows, 'dna', 'p', 'pairwise-deletion');
    const lines = toPhylip(m).trim().split('\n');
    expect(lines[0]).toBe('3');
    const labels = lines.slice(1).map((l) => l.slice(0, 10));
    expect(new Set(labels).size).toBe(3);
    expect(labels[2]).toBe('short_name');
    const sat = dna('AAAA', 'CCCA', 'jc');
    expect(toDistanceCsv(sat)).toBe(',a,b\na,0,saturated\nb,saturated,0\n');
  });
});

describe('Biopython identity cross-check on the MAFFT-aligned example sets', () => {
  const ref = JSON.parse(readFileSync('tests/fixtures/reference/distances.json', 'utf8')) as { meta: { biopython: string }; sets: { set: string; names: string[]; matrix: number[][]; columns: number }[] };
  for (const s of ref.sets) {
    it(`${s.set}: our p (gaps-as-differences) differs from Biopython's identity distance ONLY through columns where both sequences have a gap`, () => {
      const parsed = parseFasta(readFileSync(`examples/${s.set}/aligned.fasta`, 'utf8'), { allowGaps: true, alphabet: s.set.startsWith('globin') ? 'protein' : 'dna' });
      expect(parsed.issues).toEqual([]);
      const rows = parsed.records.map((r) => r.residues);
      expect(parsed.records.map((r) => r.id)).toEqual(s.names);
      const m = distanceMatrixFromAligned(s.names, rows, parsed.records[0]?.alphabet ?? 'dna', 'p', 'gaps-as-differences');
      let checked = 0; let maxRaw = 0;
      for (let i = 0; i < m.n; i++) for (let j = i + 1; j < m.n; j++) {
        const a = rows[i] as string; const b = rows[j] as string;
        let shared = 0;
        for (let k = 0; k < a.length; k++) if (a[k] === '-' && b[k] === '-') shared++;
        const bio = (s.matrix[i] as number[])[j] as number;
        const ours = cellValue(m, i, j) as number;
        expect(ours * (s.columns - shared)).toBeCloseTo(bio * s.columns, 9); // same number of differing columns
        maxRaw = Math.max(maxRaw, Math.abs(ours - bio));
        checked++;
      }
      expect(checked).toBe((s.names.length * (s.names.length - 1)) / 2);
      expect(maxRaw).toBeLessThan(0.01); // raw difference is small but nonzero when shared-gap columns exist
    });
  }
});

describe('distances from UNALIGNED sequences (every pair aligned globally)', () => {
  const sc = compileScoring({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 2 } }, 'dna');
  const mk = (id: string, residues: string) => ({ id, description: '', alphabet: 'dna' as const, residues });
  it('equals the distance computed from the pairwise alignment, is symmetric, and zero for identical sequences', () => {
    const seqs = [mk('a', 'ACGTACGTACGTAACC'), mk('b', 'ACGTACGTACGTAACC'), mk('c', 'ACGTTCGTACGAAACC'), mk('d', 'ACGTACGTTTACGTAACC')];
    const m = pairwiseDistanceMatrix(seqs, sc, 'p', 'pairwise-deletion');
    if (m === null) throw new Error('unexpected cancel');
    expect(cellValue(m, 0, 1)).toBe(0);
    expect(cellValue(m, 0, 2)).toBe(2 / 16);
    expect(cellValue(m, 2, 0)).toBe(cellValue(m, 0, 2));
    expect(cellValue(m, 0, 3)).toBe(0); // the 2-residue insertion is skipped by pairwise deletion
    const g = pairwiseDistanceMatrix(seqs, sc, 'p', 'gaps-as-differences');
    expect(cellValue(g as NonNullable<typeof g>, 0, 3)).toBeGreaterThan(0);
  });
  it('reports progress, supports cancellation, and enforces size caps with typed errors', () => {
    const seqs = [mk('a', 'ACGTACGT'), mk('b', 'ACGTACGA'), mk('c', 'ACGAACGT')];
    const seen: number[] = [];
    pairwiseDistanceMatrix(seqs, sc, 'p', 'pairwise-deletion', { onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
    expect(pairwiseDistanceMatrix(seqs, sc, 'p', 'pairwise-deletion', { shouldCancel: () => true })).toBeNull();
    const many = Array.from({ length: 101 }, (_, k) => mk(`s${k}`, 'ACGT'));
    expect(() => pairwiseDistanceMatrix(many, sc, 'p', 'pairwise-deletion')).toThrow(/At most 100/);
    const long = Array.from({ length: 60 }, (_, k) => mk(`s${k}`, 'A'.repeat(4000)));
    expect(() => pairwiseDistanceMatrix(long, sc, 'p', 'pairwise-deletion')).toThrow(/limit is 1.5 billion/);
  });
});
