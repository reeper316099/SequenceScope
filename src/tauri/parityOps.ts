// Checkpoint 6 part of the in-window parity run: every small calculation the UI used to call directly (reference data, FASTA,
// alphabet detection, alignment statistics / match lines / cell explanations, tree building, Newick, tree edits and comparison,
// distance exports, conservation, sum of pairs, the exhaustive optimum). Each runs once with the TypeScript implementation
// (in WKWebView / JavaScriptCore) and once in Rust through the same async facade the UI uses, and the results are compared.
// Everything must be EXACTLY equal, except values that go through a logarithm (JavaScriptCore's log2 / log differ from V8's by
// at most 1 ulp, which Rust reproduces): those may differ by up to 2 ulps.
import { alignOnce, alignPrecheck, buildTreesAsync, buildTreesFromRowsAsync, cellInfoAsync, compareTreesAsync, conservationAsync, conservationCsvAsync, correctDistancesAsync, detectAlphabetAsync, distanceExportAsync, editTreeAsync, getMatrix, leafDistancesAsync, limits, listMatrices, loadReferenceData, makeDpView, modelsFor, parseFastaAsync, parseNewickAsync, sumOfPairsAsync, bruteForceAsync, writeFastaAsync, writeNewickMany } from '../backend/api';
import type { BackendName } from '../backend';
import { getMatrix as tsGetMatrix, listMatrices as tsListMatrices } from '../bio/matrices';
import { matrixFromRows } from '../bio/distance';
import { createRng } from '../bio/rng';
import { preorder } from '../bio/tree';
import type { Alphabet, DistanceMatrix, ScoringSpec, Tree } from '../shared/types';
import { dnaScoring, blosum62, randomSeq, DNA, PROTEIN, alignmentRows } from './inputs';
import { addCheck, jsonDiff } from './util';
import type { Check } from './util';

const setBackend = (b: BackendName): void => { (window as unknown as Record<string, unknown>)['__SEQUENCESCOPE_BACKEND__'] = b; };

type Outcome = { ok: unknown } | { error: { code: string; message: string } };

/** Runs `f`; a thrown error becomes { error: { code, message } } so error text is part of the comparison. */
async function settle(f: () => Promise<unknown>): Promise<Outcome> {
  try { return { ok: await f() }; } catch (e) { const x = e as { code?: unknown; message?: unknown }; return { error: { code: typeof x.code === 'string' ? x.code : 'none', message: typeof x.message === 'string' ? x.message : String(e) } }; }
}

/** Runs `f` under the TypeScript backend and under the Rust backend. */
async function both(f: () => Promise<unknown>): Promise<[Outcome, Outcome]> {
  setBackend('ts'); const ts = await settle(f);
  setBackend('rust'); const rust = await settle(f);
  setBackend('ts');
  return [ts, rust];
}

/** A group of comparisons that reports one check line. */
class Group {
  total = 0; errors = 0; differing = 0; readonly problems: string[] = [];
  /** Compares TypeScript and Rust results of `f`; `maxUlps` allows the logarithm difference. */
  async compare(label: string, f: () => Promise<unknown>, maxUlps = 0): Promise<[Outcome, Outcome]> {
    const [ts, rust] = await both(f);
    this.total++;
    if ('error' in ts) this.errors++;
    const d = jsonDiff(ts, rust, maxUlps);
    if (d !== null) { this.differing++; if (this.problems.length < 6) this.problems.push(`${label}: ${d}`); }
    return [ts, rust];
  }
  report(checks: Check[], what: string): void {
    addCheck(checks, `${what}: ${this.total} comparisons (${this.errors} typed errors) identical under both backends`, this.differing === 0, this.differing === 0 ? '' : `${this.differing} differ; first: ${this.problems.slice(0, 3).join(' | ')}`);
  }
}

// ------------------------------------------------------------------------------------------------ reference data

async function referenceData(checks: Check[]): Promise<void> {
  setBackend('rust');
  await loadReferenceData();
  const rustLimits = limits(); const rustNames = listMatrices(); const rustMatrices = rustNames.map((n) => getMatrix(n));
  const rustModels = (['dna', 'rna', 'protein'] as Alphabet[]).map((a) => modelsFor(a));
  setBackend('ts');
  await loadReferenceData();
  const problems: string[] = [];
  const d1 = jsonDiff(limits(), rustLimits); if (d1) problems.push(`limits ${d1}`);
  if (tsListMatrices().join() !== rustNames.join()) problems.push('matrix names differ');
  let cells = 0;
  for (const [k, name] of tsListMatrices().entries()) {
    const ts = tsGetMatrix(name); const ru = rustMatrices[k];
    if (!ru || ts.letters !== ru.letters || ts.sha256 !== ru.sha256 || ts.citation !== ru.citation || ts.source !== ru.source) { problems.push(`${name}: header differs`); continue; }
    for (const a of ts.letters) for (const b of ts.letters) { cells++; if (ts.get(a, b) !== ru.get(a, b)) problems.push(`${name} ${a}/${b}`); }
  }
  const tsModels = (['dna', 'rna', 'protein'] as Alphabet[]).map((a) => modelsFor(a));
  if (JSON.stringify(tsModels) !== JSON.stringify(rustModels)) problems.push('models per alphabet differ');
  addCheck(checks, `reference data: limits, ${rustNames.length} substitution matrices (${cells} scores, checksums, citations) and the models per alphabet are identical`, problems.length === 0, problems.slice(0, 3).join(' | '));
}

// ------------------------------------------------------------------------------------------------ FASTA and alphabet

async function fastaParity(checks: Check[]): Promise<void> {
  const texts: string[] = ['', ' \n ', '>a\nACGT', '>a\nACGT\n>b\nAC-T', '>a\nACGT\n>b\nAC.T\n', 'ACGT ACGT 12\nacgt', 'MKVLAAGIVGLLLAGCT', '>x\nAC#GT', '>a\n>b\nACGT', '>a\nACGT\n>a\nACGA', ';note\n>a\nACGT', '>a b c\nacgt\n', 'ACGU', 'MKV*XB', '>\nACGT', '>a\n\n>b\nAC', '>p\nACDEFGHIKLMNPQRSTVWY\n>q\nACDEFGHIKLMNPQRSTVWA', '>é\nACGT', '>a\r\nACGT\r\n>b\r\nACGA', 'N'.repeat(50), '>r1\nACGUACGU\n>r2\nACGTACGT'];
  const index = (await (await fetch('/examples/index.json')).json()) as { sets: { id: string; aligned: boolean }[] };
  for (const s of index.sets) { texts.push(await (await fetch(`/examples/${s.id}/sequences.fasta`)).text()); if (s.aligned) texts.push(await (await fetch(`/examples/${s.id}/aligned.fasta`)).text()); }
  const g = new Group();
  const writes = new Group();
  const detects = new Group();
  for (const [k, text] of texts.entries()) {
    for (const alphabet of ['auto', 'dna', 'rna', 'protein'] as const) for (const allowGaps of [false, true]) {
      const [ts] = await g.compare(`text #${k} ${alphabet} gaps=${String(allowGaps)}`, () => parseFastaAsync(text, { alphabet, allowGaps }));
      if (alphabet === 'auto' && 'ok' in ts) {
        const parsed = ts.ok as Awaited<ReturnType<typeof parseFastaAsync>>;
        for (const width of [1, 7, 60, 1_000_000]) await writes.compare(`text #${k} width ${width}`, () => writeFastaAsync(parsed.records, width));
        for (const r of parsed.records.slice(0, 3)) await detects.compare(`text #${k} ${r.id}`, () => detectAlphabetAsync(r.residues));
      }
    }
  }
  for (const r of ['', 'N', '---', 'ACGT', 'acgu', 'ACGTUU', 'MKV']) await detects.compare(`residues "${r}"`, () => detectAlphabetAsync(r));
  // (Deliberate difference, not compared: Rust refuses a line width that is not a whole number; the UI only sends 60 or a huge value.)
  g.report(checks, `FASTA parsing (${texts.length} texts x 4 alphabets x gaps on/off, including every example file)`);
  writes.report(checks, 'FASTA writing (4 line widths)');
  detects.report(checks, 'alphabet detection');
}

// ------------------------------------------------------------------------------------------------ the Align page

async function alignPageParity(checks: Check[]): Promise<void> {
  const aff = { kind: 'affine', open: 5, extend: 1 } as const;
  const jobs: { a: string; b: string; alphabet: Alphabet; mode: 'global' | 'local'; scoring: ScoringSpec }[] = [
    { a: 'GATTACA', b: 'GCATGCG', alphabet: 'dna', mode: 'global', scoring: dnaScoring({ kind: 'linear', gap: 2 }) },
    { a: 'GATTACA', b: 'GCATGCG', alphabet: 'dna', mode: 'local', scoring: dnaScoring(aff) },
    { a: 'ACGTACGTAC', b: 'GTACGTACGT', alphabet: 'dna', mode: 'global', scoring: dnaScoring(aff) },
    { a: 'AAAA', b: 'AA', alphabet: 'dna', mode: 'global', scoring: dnaScoring({ kind: 'linear', gap: 1 }) },
    { a: 'ACGTNNACGT', b: 'ACGTRYACGT', alphabet: 'dna', mode: 'global', scoring: dnaScoring(aff) },
    { a: 'MKVLAAGIVGLLLAGCT', b: 'MKVLSAGIVGLLAGCA', alphabet: 'protein', mode: 'global', scoring: blosum62({ kind: 'affine', open: 11, extend: 1 }) },
    { a: 'MKVXBZAAGIV', b: 'MKVLSAGIVG', alphabet: 'protein', mode: 'local', scoring: blosum62({ kind: 'linear', gap: 4 }) },
    { a: 'ACGU', b: 'UCGA', alphabet: 'rna', mode: 'local', scoring: dnaScoring({ kind: 'linear', gap: 3 }) },
    { a: randomSeq(5, 40, DNA), b: randomSeq(6, 33, DNA), alphabet: 'dna', mode: 'global', scoring: dnaScoring(aff) },
    { a: randomSeq(7, 28, PROTEIN), b: randomSeq(8, 31, PROTEIN), alphabet: 'protein', mode: 'local', scoring: blosum62({ kind: 'affine', open: 10, extend: 2 }) },
  ];
  const g = new Group(); const cells = new Group(); const pre = new Group();
  for (const [k, j] of jobs.entries()) {
    const req = { type: 'align' as const, a: j.a, b: j.b, alphabet: j.alphabet, mode: j.mode, scoring: j.scoring, enumerateCap: 1000 };
    let tsResult: Awaited<ReturnType<typeof alignOnce>> | null = null;
    await g.compare(`job #${k}`, async () => {
      const r = await alignOnce(req);
      if (tsResult === null) tsResult = r;
      const { dp, ...rest } = r;
      return { ...rest, dp: { kind: dp.kind, mode: dp.mode, rows: dp.rows, cols: dp.cols, score: dp.score, ends: dp.ends, tables: dp.kind === 'linear' ? [Array.from(dp.H), Array.from(dp.P)] : [Array.from(dp.M), Array.from(dp.X), Array.from(dp.Y), Array.from(dp.P)] } };
    });
    // The first result (TypeScript backend) supplies the tables; every cell is explained by both implementations.
    if (tsResult !== null) {
      const view = makeDpView((tsResult as Awaited<ReturnType<typeof alignOnce>>).dp, j.a, j.b, j.alphabet, j.scoring);
      for (let i = 0; i < view.rows; i++) for (let jj = 0; jj < view.cols; jj++) await cells.compare(`job #${k} cell ${i},${jj}`, () => cellInfoAsync(view, i, jj));
    }
  }
  const bigs: [number, number][] = [[10, 10], [5000, 5000], [5001, 5000], [6000, 6000], [0, 0]];
  for (const [m, n] of bigs) for (const scoring of [dnaScoring({ kind: 'affine', open: 5, extend: 1 }), dnaScoring({ kind: 'linear', gap: 4 })]) await pre.compare(`${m}x${n}`, () => alignPrecheck('dna', scoring, m, n));
  for (const [alphabet, scoring] of [['dna', blosum62({ kind: 'linear', gap: 2 })], ['protein', { substitution: { kind: 'matrix', name: 'NOPE' }, gaps: { kind: 'linear', gap: 2 } }], ['dna', dnaScoring({ kind: 'affine', open: 5, extend: 9 })], ['dna', { substitution: { kind: 'simple', match: 5000, mismatch: -1 }, gaps: { kind: 'linear', gap: 2 } }]] as [Alphabet, ScoringSpec][]) await pre.compare(`bad scoring ${alphabet}`, () => alignPrecheck(alphabet, scoring, 10, 10));
  g.report(checks, `alignments (${jobs.length} jobs: rows, all co-optimal alignments, statistics, match lines, DP tables)`);
  cells.report(checks, 'DP cell explanations (every cell of every alignment, border/linear/affine)');
  pre.report(checks, 'alignment pre-check (scoring errors and the memory cap)');
}

// ------------------------------------------------------------------------------------------------ trees

const NEWICKS = [
  '(A,B,C);', '((A:1,B:2):3,C:4);', '((A:1,B:1):1,(C:1,D:1):1);', '(A:0.1,B:0.2,(C:0.3,D:0.4)90:0.5);', "('a b':1,'c''d':2,E:3);", '((A,B)x,(C,D)y);',
  '(A:1e-3,B:2.5E2,C:-0.5);', '[comment](A,B,C)[another];', '((A,B),(C,D));\n((A,C),(B,D));', '(A,B,C', '(A,B,C));', '((A,B);', '(A:x,B);', '(,,);', '(A,A,B);', '', ';', '(A);', '((((A,B),C),D),E);', '(A:1,B:2)root:0;',
  `${'('.repeat(150)}A,B${'),C'.repeat(150)});`,
];

function randomMatrix(seed: number, n: number): DistanceMatrix {
  const rng = createRng(seed);
  const names = Array.from({ length: n }, (_, i) => `t${i}`);
  const rows = names.map(() => names.map(() => 0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = 1 + rng.nextInt(40) / 4; (rows[i] as number[])[j] = v; (rows[j] as number[])[i] = v; }
  return matrixFromRows(names, rows);
}

async function treeParity(checks: Check[]): Promise<void> {
  const mats: DistanceMatrix[] = [];
  for (let n = 3; n <= 16; n++) mats.push(randomMatrix(100 + n, n));
  mats.push(matrixFromRows(['a', 'b', 'c', 'd'], [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), matrixFromRows(['a', 'b', 'c', 'd', 'e'], [[0, 17, 21, 31, 23], [17, 0, 30, 34, 21], [21, 30, 0, 28, 39], [31, 34, 28, 0, 43], [23, 21, 39, 43, 0]]));
  const sat = randomMatrix(999, 5); sat.status[1] = 1; sat.status[5] = 1; mats.push(sat);
  mats.push(matrixFromRows(['a', 'b'], [[0, 1], [1, 0]]), randomMatrix(555, 60));
  const build = new Group(); const trees: Tree[] = [];
  for (const [k, m] of mats.entries()) {
    const [ts] = await build.compare(`matrix #${k} (n=${m.n})`, () => buildTreesAsync(m));
    if ('ok' in ts) { const r = ts.ok as Awaited<ReturnType<typeof buildTreesAsync>>; if (m.n <= 16) trees.push(r.upgma.tree, r.nj.tree); }
  }
  await build.compare('rows (teaching example)', () => buildTreesFromRowsAsync(['A', 'B', 'C', 'D'], [[0, 6.5, 6.5, 3.5], [6.5, 0, 3.5, 6.5], [6.5, 3.5, 0, 6.5], [3.5, 6.5, 6.5, 0]]));
  build.report(checks, 'UPGMA and neighbor-joining (trees, every recorded step)');

  const nw = new Group(); const writes = new Group(); const parsed: Tree[] = [];
  for (const [k, text] of NEWICKS.entries()) for (const validate of [false, true]) {
    const [ts] = await nw.compare(`newick #${k} validate=${String(validate)}`, () => parseNewickAsync(text, validate));
    if (!validate && 'ok' in ts) parsed.push((ts.ok as { tree: Tree }).tree);
  }
  for (const [k, t] of [...trees, ...parsed].entries()) for (const [includeLengths, includeSupport] of [[true, true], [false, false], [true, false]] as const) await writes.compare(`tree #${k} ${String(includeLengths)}/${String(includeSupport)}`, () => writeNewickMany([t], { includeLengths, includeSupport }));
  nw.report(checks, `Newick parsing (${NEWICKS.length} strings, valid and broken, with exact error messages)`);
  writes.report(checks, 'Newick writing');

  const edits = new Group();
  for (const [k, t] of [...trees.slice(0, 10), ...parsed.filter((p) => preorder(p).length < 40).slice(0, 8)].entries()) {
    const nodes = preorder(t);
    for (const [idx, node] of nodes.entries()) {
      await edits.compare(`tree #${k} rotate ${idx}`, () => editTreeAsync(t, { kind: 'rotate', index: idx }));
      await edits.compare(`tree #${k} reroot above ${idx}`, () => editTreeAsync(t, { kind: 'rerootAbove', index: idx, fraction: 0.5 }));
      if (node.children.length === 0 && node.name !== undefined) await edits.compare(`tree #${k} outgroup ${node.name}`, () => editTreeAsync(t, { kind: 'rerootAtLeaf', leaf: node.name as string }));
    }
    await edits.compare(`tree #${k} midpoint`, () => editTreeAsync(t, { kind: 'midpoint' }));
  }
  await edits.compare('outgroup that does not exist', () => editTreeAsync(trees[0] as Tree, { kind: 'rerootAtLeaf', leaf: 'nope' }));
  edits.report(checks, 'tree edits (rotate, re-root above each node, outgroup, midpoint root)');

  const cmp = new Group(); const dists = new Group();
  const pool = [...trees.slice(0, 12), ...parsed.filter((p) => preorder(p).length < 40).slice(0, 6)];
  for (const [a, ta] of pool.entries()) for (const [b, tb] of pool.entries()) if (a <= b && (a + b) % 3 === 0) await cmp.compare(`pair ${a},${b}`, () => compareTreesAsync(ta, tb));
  for (const [k, t] of pool.entries()) await dists.compare(`tree #${k}`, () => leafDistancesAsync(t));
  cmp.report(checks, 'tree comparison (Robinson-Foulds, shared/unique splits, red-branch indexes)');
  dists.report(checks, 'leaf-to-leaf distances');

  const curve = new Group(); const exportG = new Group();
  const ps = Array.from({ length: 401 }, (_, i) => i / 400);
  for (const model of ['jc', 'poisson'] as const) await curve.compare(`${model} curve`, () => correctDistancesAsync(model, ps), 2);
  for (const [k, m] of mats.entries()) for (const format of ['csv', 'phylip'] as const) await exportG.compare(`matrix #${k} ${format}`, () => distanceExportAsync(m, format));
  curve.report(checks, 'distance-correction curves (Jukes-Cantor, Poisson; logarithm results within 2 ulps)');
  exportG.report(checks, 'distance exports (CSV and PHYLIP)');
}

// ------------------------------------------------------------------------------------------------ multiple alignments

async function msaOpsParity(checks: Check[]): Promise<void> {
  const sets: { rows: string[]; alphabet: Alphabet }[] = [];
  const dnaRows = alignmentRows(31, 8, 60, DNA); dnaRows[2] = dnaRows[2]?.slice(0, 20) + '-----' + dnaRows[2]?.slice(25); dnaRows[5] = '-'.repeat(60);
  sets.push({ rows: dnaRows, alphabet: 'dna' });
  sets.push({ rows: alignmentRows(32, 30, 80, PROTEIN), alphabet: 'protein' });
  sets.push({ rows: alignmentRows(33, 50, 120, DNA), alphabet: 'dna' });
  sets.push({ rows: ['ACGT'], alphabet: 'dna' }, { rows: ['AC-T', 'AC-T'], alphabet: 'dna' }, { rows: ['A1', 'A2', 'B1'], alphabet: 'dna' }, { rows: [], alphabet: 'dna' }, { rows: ['AC', 'A'], alphabet: 'dna' });
  const g = new Group(); const csv = new Group();
  for (const [k, s] of sets.entries()) {
    for (const threshold of [0.5, 0.3, 1]) await g.compare(`set #${k} threshold ${threshold}`, () => conservationAsync(s.rows, s.alphabet, threshold), 2);
    await csv.compare(`set #${k}`, () => conservationCsvAsync(s.rows, s.alphabet));
  }
  g.report(checks, 'conservation statistics (identity, entropy, consensus; entropy within 2 ulps)');
  csv.report(checks, 'conservation CSV');
  const sop = new Group();
  const sc = dnaScoring({ kind: 'affine', open: 3, extend: 1 });
  // (Deliberate difference, not compared: Rust refuses rows of unequal length with a typed error; the TypeScript threw a bare RangeError.)
  for (const [k, s] of sets.entries()) if (s.alphabet === 'dna' && new Set(s.rows.map((r) => r.length)).size <= 1) await sop.compare(`set #${k}`, () => sumOfPairsAsync(s.rows, 'dna', sc));
  for (const seqs of [['ACTA', 'GATC', 'GCGTG'], ['ACGT', 'AGT'], ['AC', 'AC', 'AC', 'AC'], ['ACGTACGTACGT', 'A'], ['A', 'A', 'A', 'A', 'A']]) await sop.compare(`brute force ${seqs.join(',')}`, () => bruteForceAsync(seqs, 'dna', sc));
  sop.report(checks, 'sum of pairs and the exhaustive optimum');
}

/** The Checkpoint 6 checks. */
export async function runOpsParity(checks: Check[]): Promise<void> {
  await referenceData(checks);
  await fastaParity(checks);
  await alignPageParity(checks);
  await treeParity(checks);
  await msaOpsParity(checks);
}
