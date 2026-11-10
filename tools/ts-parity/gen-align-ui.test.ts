// Checkpoint 6 parity fixtures for what the Align view shows: alignment statistics, the match line of every co-optimal
// alignment, the pre-check errors, and the explanation of individual DP cells. Runs the TypeScript reference on seeded
// inputs and records the exact outputs in tests/fixtures/parity/align-ui-ts.json; the Rust tests replay the same inputs.
// Run with: npm run parity:generate
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignmentStats, matchLine } from '../../src/bio/alignstats';
import { BioError } from '../../src/bio/errors';
import { assertWithinCap, cellInfo, fillMatrix, tracebackAll, tracebackFirst } from '../../src/bio/pairwise';
import type { Dp } from '../../src/bio/pairwise';
import { createRng } from '../../src/bio/rng';
import type { Rng } from '../../src/bio/rng';
import { compileScoring } from '../../src/bio/scoring';
import type { AlignMode, Alphabet, GapModel, ScoringSpec } from '../../src/shared/types';

const OUT = 'tests/fixtures/parity';
const between = (rng: Rng, lo: number, hi: number): number => lo + rng.nextInt(hi - lo + 1);
const LETTERS: Record<Alphabet, string> = { dna: 'ACGTN', rna: 'ACGUN', protein: 'ACDEFGHIKLMNPQRSTVWYXBZ' };

/** Runs `f`; a BioError becomes { error: { code, message } }. */
function capture<T>(f: () => T): { ok: T } | { error: { code: string; message: string } } {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof BioError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

const randomString = (rng: Rng, len: number, letters: string): string => Array.from({ length: len }, () => letters.charAt(rng.nextInt(letters.length))).join('');

/** The table entries around a cell, exactly as the page reads them. */
function valuesAround(dp: Dp, i: number, j: number): unknown {
  const w = dp.cols;
  const idx = i * w + j;
  if (dp.kind === 'linear') return { kind: 'linear', diag: i > 0 && j > 0 ? dp.H[idx - w - 1] : 0, up: i > 0 ? dp.H[idx - w] : 0, left: j > 0 ? dp.H[idx - 1] : 0, here: dp.H[idx], pointer: dp.P[idx] };
  const at = (k: number): number[] => [dp.M[k] as number, dp.X[k] as number, dp.Y[k] as number];
  const zero = [0, 0, 0];
  return { kind: 'affine', diag: i > 0 && j > 0 ? at(idx - w - 1) : zero, up: i > 0 ? at(idx - w) : zero, left: j > 0 ? at(idx - 1) : zero, here: at(idx), pointer: dp.P[idx] };
}

describe('Checkpoint 6 parity fixtures: the Align view', () => {
  it('writes align-ui-ts.json', () => {
    mkdirSync(OUT, { recursive: true });
    const rng = createRng(20260808);
    const cases: unknown[] = [];
    for (let k = 0; k < 160; k++) {
      const alphabet: Alphabet = k % 5 === 4 ? 'protein' : k % 7 === 6 ? 'rna' : 'dna';
      const letters = LETTERS[alphabet];
      const base = randomString(rng, between(rng, 0, 40), letters);
      const a = k % 6 === 0 ? base : randomString(rng, between(rng, 0, 40), letters);
      const b = base.split('').filter(() => rng.nextInt(100) > 12).map((c) => (rng.nextInt(100) < 20 ? letters.charAt(rng.nextInt(letters.length)) : c)).join('');
      const mode: AlignMode = rng.nextInt(2) === 0 ? 'global' : 'local';
      const gaps: GapModel = rng.nextInt(2) === 0 ? { kind: 'linear', gap: between(rng, 0, 8) } : { kind: 'affine', open: between(rng, 0, 12), extend: between(rng, 0, 5) };
      const scoring: ScoringSpec = alphabet === 'protein' && rng.nextInt(4) !== 0
        ? { substitution: { kind: 'matrix', name: ['BLOSUM45', 'BLOSUM62', 'BLOSUM80', 'PAM250'][rng.nextInt(4)] as string }, gaps }
        : { substitution: { kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -4, 1) }, gaps };
      // Letters outside the standard set (N, X, B, Z) are valid residues but count as ambiguity codes.
      const expected = capture(() => {
        const sc = compileScoring(scoring, alphabet);
        const dp = fillMatrix(a, b, mode, sc);
        const first = tracebackFirst(dp);
        const { alignments } = tracebackAll(dp, 25);
        const cells: unknown[] = [];
        const pick = (i: number, j: number): void => { cells.push({ i, j, letterA: i > 0 ? a.charAt(i - 1) : '', letterB: j > 0 ? b.charAt(j - 1) : '', values: valuesAround(dp, i, j), info: cellInfo(dp, i, j) }); };
        pick(0, 0); if (dp.rows > 1) pick(dp.rows - 1, 0); if (dp.cols > 1) pick(0, dp.cols - 1);
        if (dp.rows > 1 && dp.cols > 1) { pick(dp.rows - 1, dp.cols - 1); pick(1, 1); }
        for (let q = 0; q < 24 && dp.rows > 1 && dp.cols > 1; q++) pick(between(rng, 1, dp.rows - 1), between(rng, 1, dp.cols - 1));
        return { stats: alignmentStats(first, sc), matchLines: alignments.map((x) => matchLine(x, sc)), cells };
      });
      cases.push({ a, b, alphabet, mode, scoring, expected });
    }
    // pre-check: scoring errors and the memory cap, same messages as the job
    const pre: unknown[] = [];
    const aff: GapModel = { kind: 'affine', open: 5, extend: 1 };
    const simple: ScoringSpec = { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: aff };
    const sizes: [number, number][] = [[10, 10], [5000, 5000], [5001, 5000], [6000, 6000], [0, 0], [3000, 9000], [12000, 100]];
    for (const [m, n] of sizes) for (const gaps of [aff, { kind: 'linear', gap: 4 } as GapModel]) {
      const scoring: ScoringSpec = { ...simple, gaps };
      pre.push({ alphabet: 'dna', scoring, lenA: m, lenB: n, expected: capture(() => { const sc = compileScoring(scoring, 'dna'); assertWithinCap(m, n, sc.affine); return { affine: sc.affine }; }) });
    }
    const bad: [Alphabet, ScoringSpec][] = [
      ['dna', { substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: aff }],
      ['protein', { substitution: { kind: 'matrix', name: 'NOPE' }, gaps: aff }],
      ['dna', { substitution: { kind: 'simple', match: 2000, mismatch: -3 }, gaps: aff }],
      ['dna', { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 8 } }],
      ['dna', { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'linear', gap: -1 } }],
    ];
    for (const [alphabet, scoring] of bad) pre.push({ alphabet, scoring, lenA: 10, lenB: 10, expected: capture(() => { const sc = compileScoring(scoring, alphabet); assertWithinCap(10, 10, sc.affine); return { affine: sc.affine }; }) });
    writeFileSync(path.join(OUT, 'align-ui-ts.json'), JSON.stringify({ cases, pre }) + '\n');
    expect(cases.length).toBe(160);
  });
});
