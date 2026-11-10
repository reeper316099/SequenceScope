// Checkpoint 4 parity fixtures: runs the TypeScript reference (distances, UPGMA, neighbor-joining, tree utilities, Newick,
// Robinson-Foulds, bootstrap, and the JavaScript number behaviours they depend on) on seeded inputs and records the exact
// outputs in tests/fixtures/parity/. The Rust tests replay the same inputs. Run with: npm run parity:generate
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap, replicateWeights } from '../../src/bio/bootstrap';
import type { BootstrapInput } from '../../src/bio/bootstrap';
import { assertTreeReady, distanceMatrixFromAligned, pairwiseDistanceMatrix, toDistanceCsv, toPhylip } from '../../src/bio/distance';
import { BioError } from '../../src/bio/errors';
import { neighborJoining } from '../../src/bio/nj';
import { NewickError, parseNewick, writeNewick } from '../../src/bio/newick';
import { createRng } from '../../src/bio/rng';
import type { Rng } from '../../src/bio/rng';
import { compileScoring } from '../../src/bio/scoring';
import { annotateSupport, edgeLengthMap, hasNegativeBranches, ladderize, leafDistances, leafNames, midpointRoot, nontrivialSplits, orderedLeaves, preorder, rerootAbove, rerootAtLeaf, rotateNode, totalLength } from '../../src/bio/tree';
import { robinsonFoulds } from '../../src/bio/treecompare';
import { upgma } from '../../src/bio/upgma';
import type { Alphabet, DistanceMatrix, DistanceModel, GapPolicy, Tree } from '../../src/shared/types';
import { DIST_OK } from '../../src/shared/types';
import { matrixOf, matrixOfTree, randomAdditive, randomUltrametric, uniform } from '../../tests/helpers/trees';

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

/** Runs `f`; a BioError becomes { error: { code, message, ... } } so errors are part of the comparison. */
function capture<T>(f: () => T): { ok: T } | { error: { code: string; message: string; position?: number; line?: number; column?: number } } {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof NewickError) return { error: { code: e.code, message: e.message, position: e.position, line: e.line, column: e.column } };
    if (e instanceof BioError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

/** Flattens a distance matrix to plain arrays. */
function matrixJson(m: DistanceMatrix): unknown {
  return { names: m.names, n: m.n, values: Array.from(m.values), status: Array.from(m.status), compared: Array.from(m.compared), model: m.model, gapPolicy: m.gapPolicy };
}

/** Random alignment rows over `letters` (with some gap and ambiguity characters mixed in). */
function randomRows(rng: Rng, n: number, len: number, letters: string): string[] {
  const base = Array.from({ length: len }, () => letters.charAt(rng.nextInt(letters.length)));
  return Array.from({ length: n }, () => base.map((c) => (rng.nextInt(100) < 25 ? letters.charAt(rng.nextInt(letters.length)) : rng.nextInt(100) < 5 ? '-' : c)).join(''));
}

describe('Checkpoint 4 parity fixtures', () => {
  it('numbers: V8 Math.log, String(number), toFixed', () => {
    mkdirSync(OUT, { recursive: true });
    // ---- logs: exactly the inputs Rust regenerates from the same seeded PRNG
    const r = createRng(777);
    const logs: string[] = [];
    const firstLogs: [string, string][] = [];
    for (let k = 0; k < 200_000; k++) {
      const p = r.nextFloat() * 0.75;
      const x = k % 2 === 0 ? 1 - (4 * p) / 3 : 1 - p;
      const y = Math.log(x);
      logs.push(bitsOf(y));
      if (k < 2000) firstLogs.push([bitsOf(x), bitsOf(y)]);
    }
    // ---- number printing
    const q = createRng(888);
    const nextDouble = (): number => {
      for (;;) {
        const hi = q.nextUint32(); const lo = q.nextUint32();
        dv.setUint32(0, hi); dv.setUint32(4, lo);
        const x = dv.getFloat64(0);
        if (Number.isFinite(x)) return x;
      }
    };
    const strs: string[] = [];
    for (let k = 0; k < 100_000; k++) {
      const mode = k % 4;
      const x = mode === 0 ? nextDouble() : mode === 1 ? q.nextFloat() : mode === 2 ? q.nextFloat() * Number(`1e${q.nextInt(25) - 12}`) : q.nextUint32() / 2 ** q.nextInt(8);
      strs.push(String(x));
    }
    // ---- toFixed (ties are possible only for odd multiples of 1/128)
    const f = createRng(999);
    const fixed6: string[] = [];
    const fixed1: string[] = [];
    for (let k = 0; k < 40_000; k++) {
      const x = k % 3 === 0 ? (f.nextUint32() % 20000) / 128 : k % 3 === 1 ? f.nextFloat() * 10 : (f.nextUint32() % 2000) / 8;
      fixed6.push(x.toFixed(6));
      fixed1.push(x.toFixed(1));
    }
    writeFileSync(path.join(OUT, 'numbers-ts.json'), JSON.stringify({
      ln: { seed: 777, count: 200_000, hash: hashStrings(logs), first: firstLogs },
      toString: { seed: 888, count: 100_000, hash: hashStrings(strs), first: strs.slice(0, 2000) },
      toFixed: { seed: 999, count: 40_000, hash6: hashStrings(fixed6), hash1: hashStrings(fixed1), first6: fixed6.slice(0, 1000), first1: fixed1.slice(0, 1000) },
    }) + '\n');
    expect(strs.length).toBe(100_000);
  });

  it('distances', () => {
    const rng = createRng(20260606);
    const cases: unknown[] = [];
    const models: DistanceModel[] = ['p', 'jc', 'poisson'];
    const policies: GapPolicy[] = ['pairwise-deletion', 'gaps-as-differences'];
    for (let k = 0; k < 260; k++) {
      const protein = k % 3 === 0;
      const alphabet: Alphabet = protein ? 'protein' : rng.nextInt(6) === 0 ? 'rna' : 'dna';
      const letters = protein ? 'ACDEFGHIKLMNPQRSTVWYX' : alphabet === 'rna' ? 'ACGUN' : 'ACGTN';
      const n = between(rng, 2, 8);
      const rows = randomRows(rng, n, between(rng, 4, 45), letters);
      if (k % 17 === 0) rows[rows.length - 1] = rows[rows.length - 1]?.slice(1) ?? ''; // not aligned
      const names = Array.from({ length: n }, (_, i) => (k % 11 === 0 && i === 1 ? 'dup' : `s${i}`));
      const model = models[rng.nextInt(3)] as DistanceModel; // includes models that do not fit the alphabet (typed errors)
      const gapPolicy = policies[rng.nextInt(2)] as GapPolicy;
      const weights = k % 5 === 0 ? Array.from({ length: rows[0]?.length ?? 0 }, () => rng.nextInt(4)) : undefined;
      const res = capture(() => {
        const m = distanceMatrixFromAligned(names, rows, alphabet, model, gapPolicy, weights ? Int32Array.from(weights) : undefined);
        return { matrix: matrixJson(m), phylip: capture(() => toPhylip(m)), csv: toDistanceCsv(m), ready: capture(() => { assertTreeReady(m); return true; }) };
      });
      cases.push({ names, rows, alphabet, model, gapPolicy, weights: weights ?? null, expected: res });
    }
    // unaligned (every pair aligned globally)
    const pairwise: unknown[] = [];
    const sc = compileScoring({ substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 2 } }, 'dna');
    for (let k = 0; k < 24; k++) {
      const n = between(rng, 2, 6);
      const base = Array.from({ length: between(rng, 10, 40) }, () => 'ACGT'.charAt(rng.nextInt(4))).join('');
      const seqs = Array.from({ length: n }, (_, i) => ({ id: `q${i}`, description: '', alphabet: 'dna' as const, residues: base.split('').filter(() => rng.nextInt(100) > 8).map((c) => (rng.nextInt(100) < 12 ? 'ACGT'.charAt(rng.nextInt(4)) : c)).join('') }));
      const model: DistanceModel = k % 2 === 0 ? 'p' : 'jc';
      const policy = policies[rng.nextInt(2)] as GapPolicy;
      pairwise.push({ seqs, model, gapPolicy: policy, expected: capture(() => { const m = pairwiseDistanceMatrix(seqs, sc, model, policy); return m === null ? null : matrixJson(m); }) });
    }
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, description: '', alphabet: 'dna' as const, residues: 'ACGT' }));
    pairwise.push({ seqs: many, model: 'p', gapPolicy: 'pairwise-deletion', expected: capture(() => pairwiseDistanceMatrix(many, sc, 'p', 'pairwise-deletion')) });
    const longs = Array.from({ length: 60 }, (_, i) => ({ id: `L${i}`, description: '', alphabet: 'dna' as const, residues: 'A'.repeat(4000) }));
    pairwise.push({ seqs: longs, model: 'p', gapPolicy: 'pairwise-deletion', expected: capture(() => pairwiseDistanceMatrix(longs, sc, 'p', 'pairwise-deletion')) });
    writeFileSync(path.join(OUT, 'distances-ts.json'), JSON.stringify({ cases, pairwise }) + '\n');
    expect(cases.length).toBe(260);
  });

  // Trees are shared by the next three tests.
  const treeRng = createRng(20260707);
  const matrices: { names: string[]; rows: number[][]; kind: string }[] = [];
  for (let k = 0; k < 110; k++) {
    const n = between(treeRng, 3, 10);
    const kind = ['random', 'ties', 'zeros', 'additive', 'ultrametric'][k % 5] as string;
    let names = Array.from({ length: n }, (_, i) => `t${i}`);
    let rows: number[][];
    if (kind === 'additive' || kind === 'ultrametric') {
      const tree = kind === 'additive' ? randomAdditive(1000 + k, n) : randomUltrametric(1000 + k, n);
      const m = matrixOfTree(tree);
      names = m.names;
      rows = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => m.values[i * n + j] as number));
    } else {
      rows = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const v = kind === 'zeros' ? 0 : kind === 'ties' ? between(treeRng, 1, 5) : uniform(treeRng, 0.05, 2.5);
        (rows[i] as number[])[j] = v; (rows[j] as number[])[i] = v;
      }
    }
    matrices.push({ names, rows, kind });
  }
  const built = matrices.map((m) => ({ ...m, matrix: matrixOf(m.names, m.rows) })).map((m) => ({ ...m, u: upgma(m.matrix), j: neighborJoining(m.matrix) }));

  it('trees: UPGMA and neighbor-joining with every recorded step', () => {
    const cases = built.map((b) => ({ names: b.names, rows: b.rows, kind: b.kind, upgma: b.u, nj: b.j }));
    // typed errors: too few, duplicate names, saturated
    const errors = [
      { name: 'two taxa', names: ['a', 'b'], rows: [[0, 1], [1, 0]], saturated: [] as [number, number][] },
      { name: 'duplicate names', names: ['a', 'a', 'b'], rows: [[0, 1, 2], [1, 0, 2], [2, 2, 0]], saturated: [] as [number, number][] },
      { name: 'saturated', names: ['a', 'b', 'c'], rows: [[0, 1, 2], [1, 0, 2], [2, 2, 0]], saturated: [[0, 1]] as [number, number][] },
    ].map((e) => {
      const m = matrixOf(e.names, e.rows);
      for (const [i, j] of e.saturated) { m.status[i * m.n + j] = 1; m.status[j * m.n + i] = 1; }
      return { ...e, upgma: capture(() => upgma(m)), nj: capture(() => neighborJoining(m)) };
    });
    writeFileSync(path.join(OUT, 'trees-ts.json'), JSON.stringify({ cases, errors }) + '\n');
    expect(cases.length).toBe(110);
  });

  it('tree utilities, Robinson-Foulds, and Newick', () => {
    // The trees: every UPGMA and NJ result, plus the fixtures' hand-written trees.
    const trees: { id: string; tree: Tree }[] = [];
    built.forEach((b, k) => { if (k % 2 === 0) { trees.push({ id: `upgma${k}`, tree: b.u.tree }); trees.push({ id: `nj${k}`, tree: b.j.tree }); } });
    for (const text of ['((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);', '(A:1,(B:1,C:1):5,D:0.5);', '((A,B),(C,D),(E,F));', '((A:1,B:1)95:0.5,(C:1,D:1)80:0.5,E:2);', '(A,B,(C,D));']) trees.push({ id: text, tree: parseNewick(text).tree });
    const ops = trees.map(({ id, tree }) => {
      const nodes = preorder(tree).length;
      const idxs = Array.from({ length: Math.min(nodes + 1, 14) }, (_, i) => i); // includes 0 (error) and one past the end (error)
      const leaves = leafNames(tree);
      const splits = nontrivialSplits(tree);
      const percent = new Map([...splits.splits.keys()].map((key, i) => [key, 10 * (i + 1) + 0.5] as const));
      return {
        id, tree,
        leafNames: leaves, orderedLeaves: orderedLeaves(tree), totalLength: totalLength(tree), hasNegative: hasNegativeBranches(tree),
        splits: { entries: [...splits.splits.entries()], leaves: splits.leaves },
        edgeLengths: capture(() => [...edgeLengthMap(tree).entries()]),
        ladderized: ladderize(tree),
        rotated: idxs.slice(0, 5).map((i) => ({ index: i, tree: rotateNode(tree, i) })),
        rerooted: idxs.flatMap((i) => [0.5, 0.3].map((fraction) => ({ index: i, fraction, result: capture(() => rerootAbove(tree, i, fraction)) }))),
        rerootLeaf: [...leaves.slice(0, 3), 'nonexistent'].map((name) => ({ name, result: capture(() => rerootAtLeaf(tree, name)) })),
        midpoint: capture(() => midpointRoot(tree)),
        leafDistances: leafDistances(tree),
        annotated: annotateSupport(tree, percent),
        percent: [...percent.entries()],
      };
    });
    // Robinson-Foulds on pairs with identical leaf sets (and a few with different leaves)
    const rf: unknown[] = [];
    for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length && j < i + 6; j++) {
      const a = trees[i] as { id: string; tree: Tree }; const b = trees[j] as { id: string; tree: Tree };
      const same = leafNames(a.tree).slice().sort().join() === leafNames(b.tree).slice().sort().join();
      if (same || (i + j) % 9 === 0) rf.push({ a: a.tree, b: b.tree, expected: capture(() => robinsonFoulds(a.tree, b.tree)) });
    }
    // Newick: write every tree (3 option sets); parse seeded strings (fixtures, mutations, garbage)
    const written = trees.flatMap(({ tree }) => [{}, { includeSupport: false }, { includeLengths: false }].map((options) => ({ tree, options, text: writeNewick(tree, options) })));
    const fx = JSON.parse(readFileSync('tests/fixtures/newick/cases.json', 'utf8')) as { good: { text: string }[]; bad: { text: string }[] };
    const texts: string[] = [...fx.good.map((g) => g.text), ...fx.bad.map((b) => b.text)];
    const nr = createRng(20260808);
    const alphabetSoup = "(),:;[]' \n1e.-+_ABab";
    const seeds = [...written.map((w) => w.text).filter((_, i) => i % 7 === 0), ...fx.good.map((g) => g.text)];
    for (let k = 0; k < 600; k++) {
      const s = seeds[nr.nextInt(seeds.length)] as string;
      const pos = nr.nextInt(s.length + 1);
      const kind = nr.nextInt(4);
      texts.push(kind === 0 ? s.slice(0, pos) + s.slice(pos + 1) : kind === 1 ? s.slice(0, pos) + alphabetSoup.charAt(nr.nextInt(alphabetSoup.length)) + s.slice(pos) : kind === 2 ? s.slice(0, pos) + s.charAt(pos) + s.slice(pos) : s.slice(0, pos));
    }
    for (let k = 0; k < 100; k++) texts.push(Array.from({ length: between(nr, 1, 25) }, () => alphabetSoup.charAt(nr.nextInt(alphabetSoup.length))).join(''));
    for (const t of ['(A:1e5,B:2.5e-3,C:.5e1);', '(A:+1,B:-.5,C:3.);', '(A:1e,B,C);', '(A:1.5.5,B,C);', '(a:1E+2,B:1e+,C);', '((A,B)1e2,(C,D)+3.5:1,E);', "(A,B)'12';", '(A:1) ;']) texts.push(t);
    const parsed = texts.map((text) => ({ text, expected: capture(() => parseNewick(text)) }));
    writeFileSync(path.join(OUT, 'tree-ops-ts.json'), JSON.stringify({ ops, rf }) + '\n');
    writeFileSync(path.join(OUT, 'newick-ts.json'), JSON.stringify({ written, parsed }) + '\n');
    expect(parsed.length).toBeGreaterThan(700);
  });

  it('bootstrap', () => {
    const rng = createRng(20260909);
    const cases: unknown[] = [];
    for (let k = 0; k < 45; k++) {
      const protein = k % 4 === 3;
      const alphabet: Alphabet = protein ? 'protein' : 'dna';
      const n = between(rng, 3, 8);
      const rows = randomRows(rng, n, between(rng, 8, 60), protein ? 'ACDEFGHIKLMNPQRSTVWY' : 'ACGT');
      const model: DistanceModel = protein ? (rng.nextInt(2) === 0 ? 'p' : 'poisson') : rng.nextInt(2) === 0 ? 'p' : 'jc';
      const input: BootstrapInput = { names: Array.from({ length: n }, (_, i) => `s${i}`), rows, alphabet, model, gapPolicy: (rng.nextInt(2) === 0 ? 'pairwise-deletion' : 'gaps-as-differences'), method: rng.nextInt(2) === 0 ? 'nj' : 'upgma', replicates: between(rng, 5, 60), seed: rng.nextUint32() };
      cases.push({ input, expected: capture(() => bootstrap(input)) });
    }
    // the example alignments the app ships (reproduces the real-data path)
    cases.push({ input: { names: ['A', 'B', 'C'], rows: ['AAAA', 'AAAA', 'AAAA'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 5, seed: 1 }, expected: capture(() => bootstrap({ names: ['A', 'B', 'C'], rows: ['AAAA', 'AAAA', 'AAAA'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 5, seed: 1 })) });
    const bad: BootstrapInput[] = [
      { names: ['A', 'B'], rows: ['AC', 'AC'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['ACG', 'AC', 'ACG'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['AAAAAAAAAAAA', 'CCCCCCCCCCCC', 'GGGGGGGGGGGG'], alphabet: 'dna', model: 'jc', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['ACG', 'ACG', 'ACG'], alphabet: 'protein', model: 'jc', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['ACG', 'ACG', 'ACG'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 0, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['ACG', 'ACG', 'ACG'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 1001, seed: 1 },
      { names: ['A', 'A', 'C'], rows: ['ACG', 'ACG', 'ACG'], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['', '', ''], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: ['A', 'B', 'C'], rows: ['A'.repeat(60000), 'A'.repeat(60000), 'A'.repeat(60000)], alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: Array.from({ length: 101 }, (_, i) => `s${i}`), rows: Array.from({ length: 101 }, () => 'ACGT'), alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 10, seed: 1 },
      { names: Array.from({ length: 100 }, (_, i) => `s${i}`), rows: Array.from({ length: 100 }, () => 'ACGT'.repeat(5000)), alphabet: 'dna', model: 'p', gapPolicy: 'pairwise-deletion', method: 'nj', replicates: 1000, seed: 1 },
    ];
    for (const input of bad) cases.push({ input, expected: capture(() => bootstrap(input)) });
    const weights = Array.from({ length: 30 }, () => { const columns = between(rng, 1, 80); const seed = rng.nextUint32(); const r = between(rng, 0, 40); return { columns, seed, r, expected: Array.from(replicateWeights(columns, seed, r)) }; });
    writeFileSync(path.join(OUT, 'bootstrap-ts.json'), JSON.stringify({ cases, weights }) + '\n');
    expect(cases.length).toBe(57);
    expect(DIST_OK).toBe(0);
  });
});
