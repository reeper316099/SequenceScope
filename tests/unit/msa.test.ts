// Progressive MSA: validity, trivial cases, gap persistence, order sensitivity, comparison with the brute-force optimum, MAFFT agreement.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BioError } from '../../src/bio/errors';
import { parseFasta } from '../../src/bio/fasta';
import { align } from '../../src/bio/pairwise';
import { MAX_MSA_SEQS, mergeProfiles, progressiveAlign, sumOfPairsScore } from '../../src/bio/msa';
import type { MsaResult } from '../../src/bio/msa';
import { createRng } from '../../src/bio/rng';
import type { Sequence } from '../../src/shared/types';
import { seqOf } from '../helpers/arb';
import { affine, dna, linear, protein } from '../helpers/scoring';

const mk = (id: string, residues: string, alphabet: Sequence['alphabet'] = 'dna'): Sequence => ({ id, description: '', alphabet, residues });
const set = (rows: string[], alphabet: Sequence['alphabet'] = 'dna'): Sequence[] => rows.map((r, k) => mk(`s${k}`, r, alphabet));
const must = (r: MsaResult | null): MsaResult => { if (r === null) throw new Error('cancelled'); return r; };
const sc = dna(2, -3, affine(5, 2));

/** Removes columns where every row has a gap. */
const dropAllGap = (rows: string[]): string[] => { const keep: number[] = []; for (let c = 0; c < (rows[0]?.length ?? 0); c++) if (rows.some((r) => r[c] !== '-')) keep.push(c); return rows.map((r) => keep.map((c) => r.charAt(c)).join('')); };

describe('validity (property)', () => {
  it('gap-free rows equal the input; all rows have the same length; no column is entirely gaps', () => {
    fc.assert(fc.property(fc.array(seqOf('ACGT', 14, 1), { minLength: 1, maxLength: 6 }), fc.constantFrom('upgma', 'nj' as const), fc.constantFrom(linear(3), affine(5, 2), affine(8, 1)), (rows, guide, gaps) => {
      const seqs = set(rows);
      const r = must(progressiveAlign(seqs, dna(2, -3, gaps), guide));
      expect(r.rows.map((x) => x.replace(/-/g, ''))).toEqual(rows);
      expect(new Set(r.rows.map((x) => x.length)).size).toBe(1);
      expect(r.rows.length).toBe(rows.length);
      expect(r.ids).toEqual(seqs.map((s) => s.id));
      for (let c = 0; c < (r.rows[0]?.length ?? 0); c++) expect(r.rows.some((x) => x[c] !== '-')).toBe(true);
    }), { numRuns: 150 });
  });
  it('protein with BLOSUM62', () => {
    fc.assert(fc.property(fc.array(seqOf('ACDEFGHIKLMNPQRSTVWY', 16, 1), { minLength: 2, maxLength: 6 }), (rows) => {
      const r = must(progressiveAlign(set(rows, 'protein'), protein('BLOSUM62', affine(11, 1)), 'upgma'));
      expect(r.rows.map((x) => x.replace(/-/g, ''))).toEqual(rows);
      expect(new Set(r.rows.map((x) => x.length)).size).toBe(1);
    }), { numRuns: 80 });
  });
  it('is deterministic', () => {
    const seqs = set(['ACGTTGCA', 'ACGTGCA', 'ACGTTTGCA', 'CGTTGCA']);
    expect(must(progressiveAlign(seqs, sc, 'nj'))).toEqual(must(progressiveAlign(seqs, sc, 'nj')));
  });
});

describe('trivial cases', () => {
  it('one sequence: itself, no steps', () => {
    const r = must(progressiveAlign(set(['ACGT']), sc, 'upgma'));
    expect(r.rows).toEqual(['ACGT']);
    expect(r.steps).toHaveLength(0);
  });
  it('two sequences: equals the pairwise global alignment (rows and score) under the same scheme', () => {
    fc.assert(fc.property(seqOf('ACGT', 20, 1), seqOf('ACGT', 20, 1), fc.constantFrom(linear(4), affine(5, 2), affine(10, 1)), (a, b, gaps) => {
      const scoring = dna(2, -3, gaps);
      const r = must(progressiveAlign(set([a, b]), scoring, 'upgma'));
      const p = align(a, b, 'global', scoring);
      expect(r.steps[0]?.score).toBe(p.score);
      expect(r.sumOfPairs).toBe(p.score);
      expect(r.rows).toEqual([p.rowA, p.rowB]);
    }), { numRuns: 200 });
  });
  it('identical sequences introduce no gaps', () => {
    const r = must(progressiveAlign(set(['ACGTACGT', 'ACGTACGT', 'ACGTACGT', 'ACGTACGT']), sc, 'nj'));
    expect(r.rows.every((x) => x === 'ACGTACGT')).toBe(true);
  });
  it('a clearly related protein family aligns without frame-breaking gaps', () => {
    const base = 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHG';
    const r = must(progressiveAlign(set([base, base.replace('PADK', 'PEDK'), base.replace('AAWG', 'AAFG'), base.replace('TTKT', 'TTRT')], 'protein'), protein('BLOSUM62', affine(11, 1)), 'upgma'));
    expect(r.rows.every((x) => x.length === base.length)).toBe(true);
  });
});

describe('"once a gap, always a gap"', () => {
  it('merging two profiles only inserts all-gap columns: removing them gives back each input profile exactly', () => {
    fc.assert(fc.property(fc.array(seqOf('ACGT-', 12, 12), { minLength: 1, maxLength: 3 }), fc.array(seqOf('ACGT-', 9, 9), { minLength: 1, maxLength: 3 }), (a0, b0) => {
      // make valid profiles: drop all-gap columns from each
      const a = dropAllGap(a0); const b = dropAllGap(b0);
      if ((a[0]?.length ?? 0) === 0 || (b[0]?.length ?? 0) === 0) return;
      const m = mergeProfiles(a, b, sc);
      const left = m.rows.slice(0, a.length); const right = m.rows.slice(a.length);
      expect(dropAllGap(left)).toEqual(a);
      expect(dropAllGap(right)).toEqual(b);
      expect(new Set(m.rows.map((x) => x.length)).size).toBe(1);
    }), { numRuns: 200 });
  });
  it('through the whole guide tree: every merge step is preserved in the final alignment (gaps from earlier steps survive)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = createRng(seed);
      const base = Array.from({ length: 24 }, () => 'ACGT'.charAt(rng.nextInt(4))).join('');
      const rows = Array.from({ length: 5 }, () => { let s = base; for (let k = 0; k < 3; k++) { const p = rng.nextInt(s.length); s = rng.nextInt(2) === 0 ? s.slice(0, p) + s.slice(p + 1 + rng.nextInt(3)) : s.slice(0, p) + 'ACGT'.charAt(rng.nextInt(4)) + s.slice(p); } return s || 'A'; });
      const r = must(progressiveAlign(set(rows), sc, 'upgma'));
      for (const step of r.steps) {
        const idx = step.ids.map((id) => r.ids.indexOf(id));
        const sub = dropAllGap(idx.map((i) => r.rows[i] as string));
        expect(sub).toEqual(step.rows); // the sub-alignment made at this merge is exactly what remains in the final alignment
      }
    }
  });
});

describe('score sanity and honesty about order', () => {
  /** Random related sets: a base sequence with a few substitutions and indels per member. */
  const related = (seed: number, n: number, len: number): string[] => {
    const rng = createRng(seed);
    const base = Array.from({ length: len }, () => 'ACGT'.charAt(rng.nextInt(4))).join('');
    return Array.from({ length: n }, () => {
      let s = base;
      for (let k = 0; k < 4; k++) { const p = rng.nextInt(s.length); const t = rng.nextInt(3); s = t === 0 ? s.slice(0, p) + 'ACGT'.charAt(rng.nextInt(4)) + s.slice(p + 1) : t === 1 ? s.slice(0, p) + s.slice(p + 1 + rng.nextInt(3)) : s.slice(0, p) + 'ACGT'.slice(0, 1 + rng.nextInt(3)) + s.slice(p); }
      return s || 'A';
    });
  };
  const padded = (rows: string[]): string[] => { const w = Math.max(...rows.map((r) => r.length)); return rows.map((r) => r.padEnd(w, '-')); };

  it('the progressive sum-of-pairs score is at least that of the trivially padded alignment on related sets (counted over 200 seeded sets; any miss would fail)', () => {
    let worse = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rows = related(seed, 3 + (seed % 4), 20 + (seed % 15));
      const r = must(progressiveAlign(set(rows), sc, seed % 2 === 0 ? 'upgma' : 'nj'));
      if (r.sumOfPairs < sumOfPairsScore(padded(rows), sc)) worse++;
    }
    expect(worse).toBe(0);
  });

  it('permuting the input order: guarantee = always valid; for 2 sequences the score is identical; for more the score is COMPARABLE, not identical (measured below)', () => {
    let equal = 0; let total = 0; let maxRel = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const rows = related(seed, 4 + (seed % 3), 25);
      const rng = createRng(seed + 999);
      const perm = rows.map((_, k) => k);
      for (let i = perm.length - 1; i > 0; i--) { const j = rng.nextInt(i + 1); [perm[i], perm[j]] = [perm[j] as number, perm[i] as number]; }
      const a = must(progressiveAlign(set(rows), sc, 'upgma'));
      const b = must(progressiveAlign(perm.map((p) => mk(`s${p}`, rows[p] as string)), sc, 'upgma'));
      total++;
      if (a.sumOfPairs === b.sumOfPairs) equal++;
      // difference as a fraction of the best score any alignment of these sequences could get (all pairs fully matching)
      const pairs = (rows.length * (rows.length - 1)) / 2;
      maxRel = Math.max(maxRel, Math.abs(a.sumOfPairs - b.sumOfPairs) / (pairs * 2 * 25));
    }
    console.log(`permutation test: identical SP score in ${equal} of ${total} sets (${((100 * equal) / total).toFixed(1)} %); largest score difference ${(100 * maxRel).toFixed(2)} % of the maximum attainable score`);
    // Real measured behaviour (recorded in ALGORITHMS.md): most sets give the same score; none differ wildly.
    expect(equal / total).toBeGreaterThan(0.6);
    expect(maxRel).toBeLessThan(0.3); // observed maximum was 18.7 % on these seeded sets: a documented observation, NOT a guarantee
  });
  it('two sequences are order-independent: the optimal pairwise score is symmetric', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const [x, y] = related(seed, 2, 22) as [string, string];
      expect(must(progressiveAlign(set([x, y]), sc, 'upgma')).sumOfPairs).toBe(must(progressiveAlign(set([y, x]), sc, 'upgma')).sumOfPairs);
    }
  });
});

/** Brute-force optimum of the sum-of-pairs score for 3 short sequences: enumerates EVERY alignment (every sequence of columns). */
function bruteOptimum(seqs: string[], scoring: ReturnType<typeof dna>): number {
  let best = -Infinity;
  const n = seqs.length;
  const rec = (pos: number[], rows: string[]): void => {
    if (pos.every((p, k) => p === (seqs[k] as string).length)) { best = Math.max(best, sumOfPairsScore(rows, scoring)); return; }
    for (let mask = 1; mask < 1 << n; mask++) {
      if (!pos.every((p, k) => (mask & (1 << k)) === 0 || p < (seqs[k] as string).length)) continue;
      rec(pos.map((p, k) => p + ((mask >> k) & 1)), rows.map((r, k) => r + ((mask >> k) & 1 ? (seqs[k] as string).charAt(pos[k] as number) : '-')));
    }
  };
  rec(new Array<number>(n).fill(0), new Array<string>(n).fill(''));
  return best;
}

describe('progressive alignment versus the brute-force optimum (3 short sequences)', () => {
  it('never exceeds the optimum; the fraction of cases where it reaches it is measured and reported', () => {
    const rng = createRng(2026);
    let reached = 0; const N = 150;
    for (let t = 0; t < N; t++) {
      const rows = Array.from({ length: 3 }, () => Array.from({ length: 2 + rng.nextInt(3) }, () => 'ACG'.charAt(rng.nextInt(3))).join(''));
      const scoring = dna(2, -2, affine(3, 1));
      const prog = must(progressiveAlign(set(rows), scoring, 'upgma')).sumOfPairs;
      const opt = bruteOptimum(rows, scoring);
      expect(prog).toBeLessThanOrEqual(opt);
      if (prog === opt) reached++;
    }
    console.log(`progressive reached the brute-force optimum in ${reached} of ${N} random 3-sequence cases (${((100 * reached) / N).toFixed(1)} %)`);
    expect(reached / N).toBeGreaterThan(0.5);
  }, 120_000);
});

describe('typed errors and caps', () => {
  const code = (f: () => unknown): string => { try { f(); return 'ok'; } catch (e) { return (e as BioError).code; } };
  it('empty list, duplicate names, empty or invalid sequences, too many or too long sequences', () => {
    expect(code(() => progressiveAlign([], sc, 'upgma'))).toBe('too-few-sequences');
    expect(code(() => progressiveAlign([mk('a', 'ACGT'), mk('a', 'ACGT')], sc, 'upgma'))).toBe('duplicate-names');
    expect(code(() => progressiveAlign([mk('a', ''), mk('b', 'ACGT')], sc, 'upgma'))).toBe('invalid-argument');
    expect(code(() => progressiveAlign([mk('a', 'AC#T'), mk('b', 'ACGT')], sc, 'upgma'))).toBe('invalid-residue');
    expect(code(() => progressiveAlign(Array.from({ length: MAX_MSA_SEQS + 1 }, (_, k) => mk(`s${k}`, 'ACGT')), sc, 'upgma'))).toBe('too-large');
    expect(code(() => progressiveAlign([mk('a', 'A'.repeat(3001)), mk('b', 'ACGT')], sc, 'upgma'))).toBe('too-large');
  });
  it('cancellation returns null; progress reaches 1', () => {
    const seqs = set(['ACGTACGTAC', 'ACGTACGAAC', 'ACGAACGTAC', 'TCGTACGTAC']);
    expect(progressiveAlign(seqs, sc, 'upgma', { shouldCancel: () => true })).toBeNull();
    const seen: number[] = [];
    progressiveAlign(seqs, sc, 'nj', { onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((v, k) => k === 0 || v >= (seen[k - 1] as number) - 1e-12)).toBe(true);
  });
});

describe('agreement with MAFFT on the bundled sets (derived alignments stored in examples/)', () => {
  /** Fraction of MAFFT's aligned residue pairs (over all sequence pairs) that our alignment also aligns. */
  const agreement = (ours: string[], theirs: string[]): number => {
    const idx = (rows: string[]): number[][] => rows.map((r) => { let k = 0; return Array.from(r, (ch) => (ch === '-' ? -1 : k++)); });
    const A = idx(ours); const B = idx(theirs);
    let shared = 0; let total = 0;
    for (let i = 0; i < ours.length; i++) for (let j = i + 1; j < ours.length; j++) {
      const pairs = new Set<string>();
      for (let c = 0; c < (A[i] as number[]).length; c++) { const x = (A[i] as number[])[c] as number; const y = (A[j] as number[])[c] as number; if (x >= 0 && y >= 0) pairs.add(`${x},${y}`); }
      for (let c = 0; c < (B[i] as number[]).length; c++) { const x = (B[i] as number[])[c] as number; const y = (B[j] as number[])[c] as number; if (x >= 0 && y >= 0) { total++; if (pairs.has(`${x},${y}`)) shared++; } }
    }
    return total === 0 ? 1 : shared / total;
  };
  for (const [name, alphabet, scoring] of [['globin_alpha_vertebrates', 'protein', protein('BLOSUM62', affine(11, 1))], ['mito_cytb_mammals', 'dna', dna(2, -3, affine(5, 2))]] as const) {
    it(`${name}: our progressive alignment agrees with MAFFT on most aligned residue pairs`, () => {
      const orig = parseFasta(readFileSync(`examples/${name}/sequences.fasta`, 'utf8'), { alphabet }).records;
      const maf = parseFasta(readFileSync(`examples/${name}/aligned.fasta`, 'utf8'), { alphabet, allowGaps: true }).records;
      const r = must(progressiveAlign(orig, scoring, 'upgma'));
      const mafRows = orig.map((o) => (maf.find((m) => m.id === o.id) as Sequence).residues);
      const ag = agreement(r.rows, mafRows);
      console.log(`${name}: ${(100 * ag).toFixed(2)} % of MAFFT's aligned residue pairs are also aligned by our progressive alignment`);
      expect(ag).toBeGreaterThan(0.9);
    }, 120_000);
  }
});

describe('teaching example where the heuristic misses the optimum (Learn view)', () => {
  it('the pinned example is worse than the exhaustive optimum, with exactly the scores shown in the app', async () => {
    const { bruteForceOptimumSP } = await import('../../src/bio/msa');
    const rows = ['ACTA', 'GATC', 'GCGTG'];
    const scoring = dna(2, -2, affine(3, 1));
    const prog = must(progressiveAlign(set(rows), scoring, 'upgma'));
    const best = bruteForceOptimumSP(rows, scoring);
    expect(prog.sumOfPairs).toBe(-14);
    expect(best.score).toBe(-10);
    expect(sumOfPairsScore(best.rows, scoring)).toBe(-10);
    expect(best.rows.map((r) => r.replace(/-/g, ''))).toEqual(rows);
  }, 60_000);
  it('the exhaustive search refuses large inputs', async () => {
    const { bruteForceOptimumSP } = await import('../../src/bio/msa');
    expect(() => bruteForceOptimumSP(['AAAAAAA', 'A'], sc)).toThrow(/limited to/);
    expect(() => bruteForceOptimumSP(['A', 'A', 'A', 'A', 'A'], sc)).toThrow(/limited to/);
  });
});
