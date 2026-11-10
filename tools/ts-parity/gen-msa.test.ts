// Checkpoint 5 parity fixtures: runs the TypeScript reference (progressive multiple alignment, profile merging, the
// sum-of-pairs scorer, the exhaustive optimum, conservation statistics, and V8's Math.log2 that the entropy uses) on seeded
// inputs and records the exact outputs in tests/fixtures/parity/msa-ts.json. The Rust tests replay the same inputs.
// Run with: npm run parity:generate
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnStat, conservation, conservationCsv } from '../../src/bio/conservation';
import { BioError } from '../../src/bio/errors';
import { bruteForceOptimumSP, mergeProfiles, progressiveAlign, sumOfPairsScore } from '../../src/bio/msa';
import type { GuideMethod } from '../../src/bio/msa';
import { createRng } from '../../src/bio/rng';
import type { Rng } from '../../src/bio/rng';
import { compileScoring } from '../../src/bio/scoring';
import type { Alphabet, GapModel, ScoringSpec, Sequence } from '../../src/shared/types';

const OUT = 'tests/fixtures/parity';
const between = (rng: Rng, lo: number, hi: number): number => lo + rng.nextInt(hi - lo + 1);

/** FNV-1a 32-bit hash of a byte array (same function as the Rust tests). */
function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const hashStrings = (xs: string[]): string => fnv(new TextEncoder().encode(xs.join('\n')));
const dv = new DataView(new ArrayBuffer(8));
const bitsOf = (x: number): string => { dv.setFloat64(0, x); return dv.getBigUint64(0).toString(16).padStart(16, '0'); };

/** Runs `f`; a BioError becomes { error: { code, message } } so errors are part of the comparison. */
function capture<T>(f: () => T): { ok: T } | { error: { code: string; message: string } } {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof BioError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

const LETTERS: Record<Alphabet, string> = { dna: 'ACGT', rna: 'ACGU', protein: 'ACDEFGHIKLMNPQRSTVWY' };

/** A random scoring choice valid for the alphabet. */
function randomScoring(rng: Rng, alphabet: Alphabet): ScoringSpec {
  const gaps: GapModel = rng.nextInt(3) === 0 ? { kind: 'linear', gap: between(rng, 1, 8) } : { kind: 'affine', open: between(rng, 2, 12), extend: between(rng, 1, 4) };
  if (alphabet === 'protein') {
    return { substitution: rng.nextInt(4) === 0 ? { kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -4, 0) } : { kind: 'matrix', name: ['BLOSUM45', 'BLOSUM62', 'BLOSUM80'][rng.nextInt(3)] as string }, gaps };
  }
  return { substitution: { kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -4, 0) }, gaps };
}

/** Copies `base` with substitutions, deletions and insertions. */
function mutate(rng: Rng, base: string, letters: string, rate: number): string {
  let out = '';
  for (const c of base) {
    const r = rng.nextFloat();
    if (r < rate * 0.5) out += letters.charAt(rng.nextInt(letters.length));
    else if (r < rate * 0.75) continue;
    else if (r < rate) out += c + letters.charAt(rng.nextInt(letters.length));
    else out += c;
  }
  return out.length === 0 ? base.slice(0, 1) : out;
}

const randomString = (rng: Rng, len: number, letters: string): string => Array.from({ length: len }, () => letters.charAt(rng.nextInt(letters.length))).join('');
const asSeq = (id: string, residues: string, alphabet: Alphabet): Sequence => ({ id, description: '', alphabet, residues });

/** Random alignment rows over `letters` with gaps mixed in (all-gap columns allowed). */
function randomRows(rng: Rng, n: number, len: number, letters: string, gapPercent: number): string[] {
  return Array.from({ length: n }, () => Array.from({ length: len }, () => (rng.nextInt(100) < gapPercent ? '-' : letters.charAt(rng.nextInt(letters.length)))).join(''));
}

describe('Checkpoint 5 parity fixtures', () => {
  it('writes msa-ts.json', () => {
    mkdirSync(OUT, { recursive: true });

    // ---- Math.log2: every fraction c/n the entropy can see, plus seeded doubles over a wide range
    const log2a: string[] = [];
    const firstA: [string, string][] = [];
    for (let n = 1; n <= 400; n++) for (let c = 1; c <= n; c++) { const y = Math.log2(c / n); log2a.push(bitsOf(y)); if (log2a.length <= 1500) firstA.push([bitsOf(c / n), bitsOf(y)]); }
    const lr = createRng(4242);
    const pow2 = (e: number): number => { let v = 1; for (let k = 0; k < Math.abs(e); k++) v = e >= 0 ? v * 2 : v / 2; return v; }; // exact powers of two
    const log2b: string[] = [];
    const firstB: [string, string][] = [];
    for (let k = 0; k < 300_000; k++) {
      const u = lr.nextFloat();
      const x = k % 3 === 0 ? u : k % 3 === 1 ? u * 8 + 0.001 : (0.5 + u) * pow2(lr.nextInt(201) - 100);
      const y = Math.log2(x);
      log2b.push(bitsOf(y));
      if (k < 1500) firstB.push([bitsOf(x), bitsOf(y)]);
    }
    const log2 = { fractions: { maxN: 400, count: log2a.length, hash: hashStrings(log2a), first: firstA }, random: { seed: 4242, count: 300_000, hash: hashStrings(log2b), first: firstB }, twenty: bitsOf(Math.log2(20)) };

    // ---- progressive alignment
    const rng = createRng(20260707);
    const msa: unknown[] = [];
    const runMsa = (seqs: Sequence[], alphabet: Alphabet, scoring: ScoringSpec, guide: GuideMethod): void => {
      const expected = capture(() => {
        const r = progressiveAlign(seqs, compileScoring(scoring, alphabet), guide);
        if (r === null) throw new Error('unexpected cancel');
        return { ids: r.ids, rows: r.rows, alphabet: r.alphabet, guideTree: r.guideTree, guide: r.guide, steps: r.steps, sumOfPairs: r.sumOfPairs };
      });
      msa.push({ seqs: seqs.map((s) => ({ id: s.id, residues: s.residues })), alphabet, scoring, guide, expected });
    };
    const alphabetOf = (): Alphabet => { const r = rng.nextInt(100); return r < 62 ? 'dna' : r < 72 ? 'rna' : 'protein'; };
    // related families of 2..12 sequences
    for (let k = 0; k < 110; k++) {
      const alphabet = alphabetOf();
      const letters = LETTERS[alphabet];
      const n = k < 6 ? between(rng, 1, 2) : between(rng, 3, 12);
      const base = randomString(rng, between(rng, 8, 60), letters);
      const seqs = Array.from({ length: n }, (_, i) => asSeq(`s${i + 1}`, mutate(rng, base, letters, 0.05 + rng.nextFloat() * 0.3), alphabet));
      runMsa(seqs, alphabet, randomScoring(rng, alphabet), rng.nextInt(2) === 0 ? 'upgma' : 'nj');
    }
    // unrelated random sequences
    for (let k = 0; k < 20; k++) {
      const alphabet = alphabetOf();
      const n = between(rng, 3, 8);
      runMsa(Array.from({ length: n }, (_, i) => asSeq(`r${i + 1}`, randomString(rng, between(rng, 3, 40), LETTERS[alphabet]), alphabet)), alphabet, randomScoring(rng, alphabet), rng.nextInt(2) === 0 ? 'upgma' : 'nj');
    }
    // tie-heavy: repeats, homopolymers and identical copies (many equal scores, so the traceback preference matters)
    const tieSets: string[][] = [['AAAA', 'AAA', 'AAAAA', 'AA'], ['ACACAC', 'ACAC', 'ACACACAC'], ['ACGT', 'ACGT', 'ACGT', 'ACGT'], ['AAAAAAAA', 'CCCCCCCC', 'AAAACCCC', 'CCCCAAAA'], ['A', 'C', 'G', 'T'], ['ACGTACGT', 'ACGT', 'ACGTACGTACGT'], ['GATTACA', 'GATTACA', 'GACA', 'GATTA']];
    for (const [k, set] of tieSets.entries()) {
      for (const guide of ['upgma', 'nj'] as const) {
        const scoring: ScoringSpec = { substitution: { kind: 'simple', match: 2, mismatch: -1 }, gaps: k % 2 === 0 ? { kind: 'affine', open: 3, extend: 1 } : { kind: 'linear', gap: 2 } };
        runMsa(set.map((r, i) => asSeq(`t${i + 1}`, r, 'dna')), 'dna', scoring, guide);
      }
    }
    // larger sets (the sizes the app is used at)
    for (let k = 0; k < 7; k++) {
      const alphabet: Alphabet = k % 3 === 0 ? 'protein' : 'dna';
      const letters = LETTERS[alphabet];
      const base = randomString(rng, between(rng, 90, 170), letters);
      const n = between(rng, 14, 24);
      runMsa(Array.from({ length: n }, (_, i) => asSeq(`L${i + 1}`, mutate(rng, base, letters, 0.12 + rng.nextFloat() * 0.2), alphabet)), alphabet, randomScoring(rng, alphabet), k % 2 === 0 ? 'upgma' : 'nj');
    }
    // typed errors
    const dnaSc: ScoringSpec = { substitution: { kind: 'simple', match: 2, mismatch: -1 }, gaps: { kind: 'affine', open: 3, extend: 1 } };
    runMsa([], 'dna', dnaSc, 'upgma');
    runMsa([asSeq('a', 'ACGT', 'dna'), asSeq('a', 'ACGA', 'dna')], 'dna', dnaSc, 'upgma');
    runMsa([asSeq('a', '', 'dna'), asSeq('b', 'ACGA', 'dna')], 'dna', dnaSc, 'upgma');
    runMsa([asSeq('a', 'ACXT', 'dna'), asSeq('b', 'ACGA', 'dna')], 'dna', dnaSc, 'nj');
    runMsa([asSeq('a', 'ACGT', 'dna'), asSeq('b', 'ACGA', 'dna'), asSeq('c', 'AC GA', 'dna')], 'dna', dnaSc, 'nj');
    runMsa([asSeq('a', 'A'.repeat(3001), 'dna'), asSeq('b', 'ACGA', 'dna')], 'dna', dnaSc, 'upgma');
    runMsa(Array.from({ length: 51 }, (_, i) => asSeq(`s${i}`, 'ACGT', 'dna')), 'dna', dnaSc, 'upgma');
    runMsa(Array.from({ length: 50 }, (_, i) => asSeq(`w${i}`, 'ACGT'.repeat(300), 'dna')), 'dna', dnaSc, 'upgma'); // pairwise work over the limit
    runMsa([asSeq('a', 'ACGT', 'dna'), asSeq('b', 'ACGA', 'dna')], 'dna', { substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: { kind: 'linear', gap: 2 } }, 'upgma'); // matrix with DNA

    // ---- profile merging (any groups of equal-length rows; gaps allowed anywhere)
    const merges: unknown[] = [];
    for (let k = 0; k < 160; k++) {
      const alphabet = alphabetOf();
      const letters = LETTERS[alphabet];
      const a = randomRows(rng, between(rng, 1, 5), between(rng, 1, 36), letters, rng.nextInt(30));
      const b = randomRows(rng, between(rng, 1, 5), between(rng, 1, 36), letters, rng.nextInt(30));
      const scoring = randomScoring(rng, alphabet);
      merges.push({ a, b, alphabet, scoring, expected: capture(() => mergeProfiles(a, b, compileScoring(scoring, alphabet))) });
    }
    for (const [a, b] of [[['ACXT'], ['ACGT']], [['ACGT', 'AC-T'], ['AC#T']], [['A-GT'], ['----']]] as const) {
      merges.push({ a, b, alphabet: 'dna', scoring: dnaSc, expected: capture(() => mergeProfiles(a, b, compileScoring(dnaSc, 'dna'))) });
    }

    // ---- sum of pairs
    const sops: unknown[] = [];
    for (let k = 0; k < 140; k++) {
      const alphabet = alphabetOf();
      const rows = randomRows(rng, between(rng, 1, 6), between(rng, 0, 40), LETTERS[alphabet], rng.nextInt(40));
      const scoring = randomScoring(rng, alphabet);
      sops.push({ rows, alphabet, scoring, expected: capture(() => sumOfPairsScore(rows, compileScoring(scoring, alphabet))) });
    }

    // ---- exhaustive optimum
    const brute: unknown[] = [];
    for (let k = 0; k < 36; k++) {
      const alphabet: Alphabet = k % 4 === 3 ? 'protein' : 'dna';
      const n = k % 3 === 0 ? 2 : k % 3 === 1 ? 3 : 4;
      const maxLen = n === 2 ? 6 : n === 3 ? 5 : 3;
      const seqs = Array.from({ length: n }, () => randomString(rng, between(rng, 1, maxLen), alphabet === 'protein' ? 'ACDE' : 'ACG'));
      const scoring = randomScoring(rng, alphabet);
      brute.push({ seqs, alphabet, scoring, expected: capture(() => bruteForceOptimumSP(seqs, compileScoring(scoring, alphabet))) });
    }
    brute.push({ seqs: ['ACGT', 'ACGT', 'ACGT', 'ACGT', 'ACGT'], alphabet: 'dna', scoring: dnaSc, expected: capture(() => bruteForceOptimumSP(['ACGT', 'ACGT', 'ACGT', 'ACGT', 'ACGT'], compileScoring(dnaSc, 'dna'))) });
    brute.push({ seqs: ['ACGTACG', 'ACGT'], alphabet: 'dna', scoring: dnaSc, expected: capture(() => bruteForceOptimumSP(['ACGTACG', 'ACGT'], compileScoring(dnaSc, 'dna'))) });

    // ---- conservation: single columns (counts listed in JavaScript object order), then whole alignments and CSV
    const columns: unknown[] = [];
    const thresholds = [0.5, 0.5, 0.5, 0.3, 0.75, 1, 0];
    for (let k = 0; k < 2000; k++) {
      const alphabet = alphabetOf();
      const letters = k % 9 === 0 ? 'AC12' : LETTERS[alphabet];
      const n = k % 50 === 0 ? 0 : between(rng, 1, k % 2 === 0 ? 50 : 24);
      const col = Array.from({ length: n }, () => (rng.nextInt(100) < 20 ? '-' : letters.charAt(rng.nextInt(Math.max(1, rng.nextInt(letters.length) + 1))))).join('');
      const threshold = thresholds[rng.nextInt(thresholds.length)] as number;
      columns.push({ column: col, alphabet, threshold, expected: capture(() => { const c = columnStat(col, alphabet, threshold); return { ...c, counts: Object.entries(c.counts) }; }) });
    }
    const alignments: unknown[] = [];
    for (let k = 0; k < 90; k++) {
      const alphabet = alphabetOf();
      const n = between(rng, 1, k % 3 === 0 ? 50 : 10);
      const len = k % 15 === 0 ? 0 : between(rng, 1, 50);
      const base = randomString(rng, len, LETTERS[alphabet]);
      const rows = Array.from({ length: n }, () => base.split('').map((c) => (rng.nextInt(100) < 25 ? LETTERS[alphabet].charAt(rng.nextInt(LETTERS[alphabet].length)) : rng.nextInt(100) < 12 ? '-' : c)).join(''));
      if (k % 13 === 12 && rows.length > 1) rows[rows.length - 1] = (rows[rows.length - 1] as string).slice(1); // ragged
      const threshold = thresholds[rng.nextInt(thresholds.length)] as number;
      alignments.push({
        rows, alphabet, threshold,
        expected: capture(() => { const c = conservation(rows, alphabet, threshold); return { columns: c.columns.map((x) => ({ ...x, counts: Object.entries(x.counts) })), consensus: c.consensus, meanIdentity: c.meanIdentity, fullyConserved: c.fullyConserved }; }),
        csv: capture(() => conservationCsv(rows, alphabet)),
      });
    }
    alignments.push({ rows: [], alphabet: 'dna', threshold: 0.5, expected: capture(() => { const c = conservation([], 'dna', 0.5); return { columns: [], consensus: c.consensus, meanIdentity: c.meanIdentity, fullyConserved: c.fullyConserved }; }), csv: capture(() => conservationCsv([], 'dna')) });

    const file = path.join(OUT, 'msa-ts.json');
    writeFileSync(file, JSON.stringify({ log2, msa, merges, sops, brute, columns, alignments }) + '\n');
    expect(msa.length).toBeGreaterThan(150);
  });
});
