// Generates the TS-vs-Rust PARITY fixtures in tests/fixtures/parity/ by running the TypeScript reference implementation
// (src/bio) on a fixed, seeded set of inputs and recording its exact outputs. The Rust crate's tests replay the same
// inputs and must reproduce every output. Run with: npm run parity:generate  (NOT part of `npm test`).
//
// Everything is deterministic: inputs come from the project's own seeded PRNG, so re-running gives byte-identical files.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanSequenceText, detectAlphabet, findInvalid } from '../../src/bio/alphabet';
import { BioError } from '../../src/bio/errors';
import { parseFasta, writeFasta } from '../../src/bio/fasta';
import { RAW_MATRICES } from '../../src/bio/matrices.data';
import { alignAll, alignScoreOnly, fillMatrix, tracebackFirst } from '../../src/bio/pairwise';
import type { Dp } from '../../src/bio/pairwise';
import { createRng, deriveSeed } from '../../src/bio/rng';
import { runShuffleTest, shuffleResidues } from '../../src/bio/shuffle';
import type { Rng } from '../../src/bio/rng';
import { compileScoring } from '../../src/bio/scoring';
import type { Alphabet, AlignMode, GapModel, ScoringSpec } from '../../src/shared/types';

const OUT = 'tests/fixtures/parity';

/** FNV-1a 32-bit hash of raw bytes (the Rust tests implement the same function, so whole DP tables can be compared). */
function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const bytesOf = (a: Int32Array | Uint8Array | Uint16Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Hashes every table of a DP (values and traceback pointers), little-endian element bytes. */
function dpHashes(dp: Dp): Record<string, string> {
  if (dp.kind === 'linear') return { H: fnv1a32(bytesOf(dp.H)), P: fnv1a32(bytesOf(dp.P)) };
  return { M: fnv1a32(bytesOf(dp.M)), X: fnv1a32(bytesOf(dp.X)), Y: fnv1a32(bytesOf(dp.Y)), P: fnv1a32(bytesOf(dp.P)) };
}

/** Random element of a string. */
const pick = (rng: Rng, s: string): string => s.charAt(rng.nextInt(s.length));
/** Random integer in [lo, hi]. */
const between = (rng: Rng, lo: number, hi: number): number => lo + rng.nextInt(hi - lo + 1);

/** A random sequence over `letters`. */
function randomSeq(rng: Rng, letters: string, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += pick(rng, letters);
  return s;
}

/** A related sequence: point substitutions plus short insertions and deletions (so alignments contain gaps). */
function mutate(rng: Rng, s: string, letters: string, rate: number): string {
  let out = '';
  for (const ch of s) {
    const r = rng.nextFloat();
    if (r < rate * 0.5) out += pick(rng, letters);
    else if (r < rate * 0.75) continue;
    else if (r < rate) out += ch + randomSeq(rng, letters, between(rng, 1, 3));
    else out += ch;
  }
  return out;
}

const STANDARD: Record<Alphabet, string> = { dna: 'ACGT', rna: 'ACGU', protein: 'ACDEFGHIKLMNPQRSTVWY' };
const AMBIG: Record<Alphabet, string> = { dna: 'RYSWKMBDHVN', rna: 'RYSWKMBDHVN', protein: 'BZXJUO*' };

interface PairCase {
  id: string;
  alphabet: Alphabet;
  mode: AlignMode;
  scoring: ScoringSpec;
  a: string;
  b: string;
}

/** Computes the TypeScript implementation's complete answer for one case (or its typed error). */
function expectedFor(c: PairCase): unknown {
  try {
    const sc = compileScoring(c.scoring, c.alphabet);
    const dp = fillMatrix(c.a, c.b, c.mode, sc);
    const first = tracebackFirst(dp);
    const big = alignAll(c.a, c.b, c.mode, sc, 1000);
    const small = alignAll(c.a, c.b, c.mode, sc, 4);
    return {
      score: dp.score,
      alignment: first,
      endsCount: dp.ends.length,
      endsFirst: dp.ends.slice(0, 10),
      hashes: dpHashes(dp),
      allCount: big.alignments.length,
      allCapped: big.capped,
      first4: small.alignments,
      first4Capped: small.capped,
      scoreOnly: alignScoreOnly(c.a, c.b, c.mode, sc),
    };
  } catch (e) {
    if (e instanceof BioError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

/** Builds the seeded pairwise input set. */
function pairCases(): PairCase[] {
  const rng = createRng(20260101);
  const cases: PairCase[] = [];
  const add = (c: Omit<PairCase, 'id'>): void => { cases.push({ id: `p${String(cases.length).padStart(4, '0')}`, ...c }); };
  const modes: AlignMode[] = ['global', 'local'];
  const gapsFor = (kind: 'dna' | 'protein'): GapModel => {
    const r = rng.nextInt(10);
    if (r < 3) return { kind: 'linear', gap: kind === 'dna' ? between(rng, 0, 9) : between(rng, 1, 10) };
    if (r < 9) return kind === 'dna' ? { kind: 'affine', open: between(rng, 0, 12), extend: between(rng, 0, 6) } : { kind: 'affine', open: between(rng, 5, 15), extend: between(rng, 1, 4) };
    const g = between(rng, 0, 8); // open = extend: must behave exactly like linear
    return { kind: 'affine', open: g, extend: g };
  };
  // 1) DNA / RNA with simple scores, random and related pairs, some ambiguity codes.
  for (let k = 0; k < 900; k++) {
    const alphabet: Alphabet = rng.nextInt(5) === 0 ? 'rna' : 'dna';
    const letters = STANDARD[alphabet] + (rng.nextInt(6) === 0 ? AMBIG[alphabet] : '');
    const a = randomSeq(rng, letters, between(rng, 0, 40));
    const b = rng.nextInt(3) === 0 ? randomSeq(rng, letters, between(rng, 0, 40)) : mutate(rng, a, letters, 0.15 + rng.nextFloat() * 0.3);
    add({ alphabet, mode: modes[rng.nextInt(2)] as AlignMode, scoring: { substitution: { kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -5, 2) }, gaps: gapsFor('dna') }, a, b });
  }
  // 2) Protein with BLOSUM matrices (and some simple scoring), ambiguity codes included.
  for (let k = 0; k < 900; k++) {
    const letters = STANDARD.protein + (rng.nextInt(5) === 0 ? AMBIG.protein : '');
    const a = randomSeq(rng, letters, between(rng, 0, 50));
    const b = rng.nextInt(3) === 0 ? randomSeq(rng, letters, between(rng, 0, 50)) : mutate(rng, a, letters, 0.15 + rng.nextFloat() * 0.35);
    const substitution = rng.nextInt(4) === 0 ? ({ kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -4, 1) } as const) : ({ kind: 'matrix', name: ['BLOSUM45', 'BLOSUM62', 'BLOSUM80'][rng.nextInt(3)] as string } as const);
    add({ alphabet: 'protein', mode: modes[rng.nextInt(2)] as AlignMode, scoring: { substitution, gaps: gapsFor('protein') }, a, b });
  }
  // 3) Tiny binary-alphabet pairs: lots of ties, so the traceback order and the enumeration order are really exercised.
  for (let k = 0; k < 500; k++) {
    const a = randomSeq(rng, 'AC', between(rng, 0, 12));
    const b = randomSeq(rng, 'AC', between(rng, 0, 12));
    add({ alphabet: 'dna', mode: modes[rng.nextInt(2)] as AlignMode, scoring: { substitution: { kind: 'simple', match: between(rng, 1, 3), mismatch: between(rng, -3, 0) }, gaps: gapsFor('dna') }, a, b });
  }
  // 4) Longer related sequences (more realistic gap structure).
  for (let k = 0; k < 100; k++) {
    const a = randomSeq(rng, 'ACGT', between(rng, 80, 150));
    add({ alphabet: 'dna', mode: modes[rng.nextInt(2)] as AlignMode, scoring: { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 1 } }, a, b: mutate(rng, a, 'ACGT', 0.25) });
  }
  // 5) Hand-picked edge cases.
  const lin = (g: number): GapModel => ({ kind: 'linear', gap: g });
  const aff = (o: number, e: number): GapModel => ({ kind: 'affine', open: o, extend: e });
  const dnaS = (g: GapModel): ScoringSpec => ({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: g });
  for (const mode of modes) {
    for (const g of [lin(4), aff(5, 1)]) {
      for (const [a, b] of [['', ''], ['', 'ACG'], ['AC', ''], ['A', 'A'], ['A', 'C'], ['AAAAAA', 'CCCCCC'], ['ACNGT', 'ACNGT'], ['ACGT'.repeat(50), 'ACGT']] as const) add({ alphabet: 'dna', mode, scoring: dnaS(g), a, b });
    }
  }
  // 6) Typed errors: bad residue, matrix with DNA, unknown matrix, bad penalties, too large.
  add({ alphabet: 'dna', mode: 'global', scoring: dnaS(lin(1)), a: 'ACGT', b: 'AC#T' });
  add({ alphabet: 'dna', mode: 'global', scoring: dnaS(lin(1)), a: 'ACGU', b: 'ACGT' });
  add({ alphabet: 'rna', mode: 'local', scoring: dnaS(aff(3, 1)), a: 'ACGT', b: 'ACGU' });
  add({ alphabet: 'dna', mode: 'global', scoring: { substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: lin(1) }, a: 'ACGT', b: 'ACGT' });
  add({ alphabet: 'protein', mode: 'global', scoring: { substitution: { kind: 'matrix', name: 'PAM250' }, gaps: lin(1) }, a: 'ACDE', b: 'ACDE' });
  add({ alphabet: 'dna', mode: 'global', scoring: dnaS(lin(-1)), a: 'AC', b: 'AC' });
  add({ alphabet: 'dna', mode: 'global', scoring: dnaS(aff(5, 10001)), a: 'AC', b: 'AC' });
  add({ alphabet: 'dna', mode: 'global', scoring: { substitution: { kind: 'simple', match: 1001, mismatch: -1 }, gaps: lin(1) }, a: 'AC', b: 'AC' });
  add({ alphabet: 'dna', mode: 'global', scoring: { substitution: { kind: 'simple', match: 1, mismatch: -1001 }, gaps: lin(1) }, a: 'AC', b: 'AC' });
  add({ alphabet: 'dna', mode: 'global', scoring: dnaS(lin(1)), a: 'A'.repeat(5001), b: 'A'.repeat(5001) });
  add({ alphabet: 'dna', mode: 'local', scoring: dnaS(aff(5, 1)), a: 'A'.repeat(5001), b: 'A'.repeat(5001) });
  return cases;
}

interface ShuffleCase {
  alphabet: Alphabet;
  mode: AlignMode;
  scoring: ScoringSpec;
  a: string;
  b: string;
  shuffles: number;
  seed: number;
}

/** Runs the TypeScript shuffle test for one case and records its complete summary (or typed error). */
function shuffleExpected(c: ShuffleCase): unknown {
  try {
    const r = runShuffleTest({ a: c.a, b: c.b, mode: c.mode, scoring: compileScoring(c.scoring, c.alphabet), shuffles: c.shuffles, seed: c.seed });
    if (r.cancelled) throw new Error('unexpected cancel');
    return { ...c, expected: { realScore: r.realScore, scores: Array.from(r.scores), mean: r.mean, sd: r.sd, z: r.z, atLeastAsGood: r.atLeastAsGood, pValue: r.pValue } };
  } catch (e) {
    if (e instanceof BioError) return { ...c, expected: { error: { code: e.code, message: e.message } } };
    throw e;
  }
}

describe('generate parity fixtures from the TypeScript reference implementation', () => {
  it('matrices', () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'matrices-ts.json'), JSON.stringify(RAW_MATRICES.map((m) => ({ name: m.name, letters: m.letters, values: m.values, sha256: m.sha256 }))) + '\n');
  });

  it('pairwise', () => {
    const cases = pairCases();
    const lines = cases.map((c) => JSON.stringify({ ...c, expected: expectedFor(c) }));
    writeFileSync(path.join(OUT, 'pairwise-ts.json'), '[\n' + lines.join(',\n') + '\n]\n');
    const errors = cases.filter((c) => (expectedFor(c) as { error?: unknown }).error !== undefined).length;
    expect(errors).toBeGreaterThanOrEqual(10);
    console.log(`pairwise parity cases: ${cases.length} (${errors} typed-error cases)`);
  });

  it('rng + shuffle + shuffle test', () => {
    const rng = createRng(20260303);
    const seeds = [0, 1, 2, 7, 42, 12345, 99999, 4294967295, 2147483648, 3000000000];
    for (let k = 0; k < 30; k++) seeds.push(rng.nextUint32());
    const bounds = [1, 2, 3, 7, 10, 100, 65537, 2147483649, 4294967296];
    const rngCases = seeds.map((seed) => ({
      seed,
      u32: (() => { const r = createRng(seed); return Array.from({ length: 30 }, () => r.nextUint32()); })(),
      floats: (() => { const r = createRng(seed); return Array.from({ length: 10 }, () => r.nextFloat()); })(),
      ints: bounds.map((bound) => { const r = createRng(seed); return { bound, values: Array.from({ length: 20 }, () => r.nextInt(bound)) }; }),
      derived: [0, 1, 2, 3, 10, 1000, 4294967295].map((stream) => ({ stream, seed: deriveSeed(seed, stream) })),
    }));
    const shuffleCases = Array.from({ length: 150 }, () => {
      const seed = rng.nextUint32();
      const s = randomSeq(rng, 'ACGTN', between(rng, 0, 40));
      return { seed, input: s, expected: shuffleResidues(createRng(seed), s) };
    });
    const testCases: unknown[] = [];
    for (let k = 0; k < 70; k++) {
      const alphabet: Alphabet = rng.nextInt(4) === 0 ? 'protein' : 'dna';
      const letters = STANDARD[alphabet];
      const a = randomSeq(rng, letters, between(rng, 5, 70));
      const b = rng.nextInt(2) === 0 ? mutate(rng, a, letters, 0.3) : randomSeq(rng, letters, between(rng, 5, 70));
      const gaps: GapModel = rng.nextInt(2) === 0 ? { kind: 'linear', gap: between(rng, 1, 8) } : { kind: 'affine', open: between(rng, 1, 12), extend: between(rng, 0, 4) };
      const substitution = alphabet === 'dna' ? ({ kind: 'simple', match: between(rng, 1, 5), mismatch: between(rng, -4, 0) } as const) : ({ kind: 'matrix', name: 'BLOSUM62' } as const);
      const scoring: ScoringSpec = { substitution, gaps };
      const mode: AlignMode = rng.nextInt(2) === 0 ? 'global' : 'local';
      const shuffles = between(rng, 1, 60);
      const seed = rng.nextUint32();
      testCases.push(shuffleExpected({ alphabet, mode, scoring, a, b, shuffles, seed }));
    }
    const dnaScoring: ScoringSpec = { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 2 } };
    testCases.push(
      shuffleExpected({ alphabet: 'dna', mode: 'local', scoring: dnaScoring, a: 'ACGT', b: 'ACGT', shuffles: 0, seed: 1 }),
      shuffleExpected({ alphabet: 'dna', mode: 'local', scoring: dnaScoring, a: 'ACGT', b: 'ACGT', shuffles: 5001, seed: 1 }),
      shuffleExpected({ alphabet: 'dna', mode: 'local', scoring: dnaScoring, a: 'AC#T', b: 'ACGT', shuffles: 5, seed: 1 }),
      shuffleExpected({ alphabet: 'dna', mode: 'global', scoring: { substitution: { kind: 'simple', match: 1, mismatch: -1 }, gaps: { kind: 'linear', gap: 1 } }, a: 'AAAA', b: 'AAAA', shuffles: 10, seed: 3 }),
      shuffleExpected({ alphabet: 'dna', mode: 'global', scoring: dnaScoring, a: '', b: '', shuffles: 3, seed: 9 }),
    );
    writeFileSync(path.join(OUT, 'rng-shuffle-ts.json'), JSON.stringify({ rngCases, shuffleCases, testCases }) + '\n');
    console.log(`rng cases ${rngCases.length}, shuffle cases ${shuffleCases.length}, shuffle-test cases ${testCases.length}`);
    expect(testCases.length).toBeGreaterThan(70);
  });

  it('fasta + alphabet helpers', () => {
    const rng = createRng(20260202);
    const texts: { name: string; text: string }[] = [];
    for (const f of readdirSync('tests/fixtures/fasta').sort()) texts.push({ name: `file:${f}`, text: readFileSync(path.join('tests/fixtures/fasta', f), 'utf8') });
    const pieces = ['>seq', '>', '> only description', '>id with a longer description here', ';a comment', '', '   ', '\t', 'ACGT', 'acgtn', 'AC GT 12', 'MKVLAAGIVGL', 'ACGU', 'AC-GT', 'AC.GT', 'AC#T', 'ACXGT', 'ÀCGT', 'AC GT', 'AC﻿GT', 'ß', '12345', 'ACGTACGTACGTACGTACGTACGT', 'MVLSPADKTNVKAAWGKVGAHAGE'];
    for (let k = 0; k < 400; k++) {
      const n = between(rng, 0, 9);
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(pieces[rng.nextInt(pieces.length)] as string);
      const sep = ['\n', '\r\n', '\r'][rng.nextInt(3)] as string;
      texts.push({ name: `gen${k}`, text: lines.join(sep) + (rng.nextInt(2) === 0 ? sep : '') });
    }
    const optionSets: { alphabet?: Alphabet | 'auto'; allowGaps?: boolean }[] = [{}, { alphabet: 'dna' }, { alphabet: 'protein' }, { alphabet: 'rna', allowGaps: true }, { allowGaps: true }];
    const parseCases = texts.flatMap((t, ti) => optionSets.filter((_, oi) => ti < 12 || (ti + oi) % 2 === 0).map((options) => ({ name: t.name, text: t.text, options, expected: parseFasta(t.text, options) })));
    const helperCases = texts.map((t) => ({
      raw: t.text,
      clean: cleanSequenceText(t.text),
      detect: detectAlphabet(cleanSequenceText(t.text).residues),
      invalidDna: findInvalid(cleanSequenceText(t.text).residues, 'dna'),
      invalidProteinGaps: findInvalid(cleanSequenceText(t.text).residues, 'protein', true),
    }));
    const writeCases = [
      { records: [{ id: 'x', description: 'd', alphabet: 'dna' as const, residues: 'ACGT'.repeat(40) }, { id: 'e', description: '', alphabet: 'dna' as const, residues: '' }, { id: 'y', description: '', alphabet: 'protein' as const, residues: 'MKV' }], width: 60 },
      { records: [{ id: 'z', description: 'long', alphabet: 'dna' as const, residues: 'ACGTACGTAC' }], width: 4 },
    ].map((w) => ({ ...w, expected: writeFasta(w.records, w.width) }));
    writeFileSync(path.join(OUT, 'fasta-ts.json'), JSON.stringify({ parseCases, helperCases, writeCases }) + '\n');
    console.log(`fasta parity: ${parseCases.length} parse cases, ${helperCases.length} helper cases, ${writeCases.length} write cases`);
    expect(parseCases.length).toBeGreaterThan(500);
  });
});
