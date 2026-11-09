// UPGMA, neighbor-joining, tree utilities, Robinson-Foulds: exact recovery, textbook examples, Biopython, edge cases.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertTreeReady } from '../../src/bio/distance';
import { BioError } from '../../src/bio/errors';
import { neighborJoining, replayNj } from '../../src/bio/nj';
import { parseNewick, writeNewick } from '../../src/bio/newick';
import { createRng } from '../../src/bio/rng';
import { annotateSupport, cladeKey, edgeLengthMap, hasNegativeBranches, ladderize, leafDistances, leafNames, midpointRoot, nontrivialSplits, orderedLeaves, preorder, rerootAbove, rerootAtLeaf, rotateNode, totalLength } from '../../src/bio/tree';
import { robinsonFoulds } from '../../src/bio/treecompare';
import { replayUpgma, upgma } from '../../src/bio/upgma';
import { DIST_SATURATED } from '../../src/shared/types';
import type { Tree, TreeNode } from '../../src/shared/types';
import { matrixOf, matrixOfTree, randomAdditive, randomUltrametric, uniform } from '../helpers/trees';

const TOL = 1e-9;
const nw = (s: string): Tree => parseNewick(s).tree;
const cladeSet = (t: Tree): Set<string> => {
  const out = new Set<string>();
  const walk = (n: TreeNode): string[] => { const l = n.children.length === 0 ? [n.name ?? ''] : n.children.flatMap(walk); if (n.children.length > 0) out.add([...l].sort().join(',')); return l; };
  walk(t.root);
  return out;
};
const expectEdgesEqual = (a: Tree, b: Tree, tol = TOL): void => {
  const ea = edgeLengthMap(a); const eb = edgeLengthMap(b);
  expect([...ea.keys()].sort()).toEqual([...eb.keys()].sort());
  for (const [k, v] of ea) expect(Math.abs(v - (eb.get(k) as number))).toBeLessThan(tol);
};

describe('worked examples (Wikipedia)', () => {
  const ex = JSON.parse(readFileSync('tests/fixtures/worked-examples/trees.json', 'utf8')) as { upgma: { names: string[]; matrix: number[][]; merges: { distance: number; height: number }[]; clades: string[] }; nj: { names: string[]; matrix: number[][]; firstQ: Record<string, number>; firstBranches: Record<string, number>; secondMinQ: number; secondBranches: Record<string, number>; finalBranches: Record<string, number>; afterFirstJoin: Record<string, number> } };

  it('UPGMA: merge distances, node heights, ultrametric tree, and clades match the article', () => {
    const r = upgma(matrixOf(ex.upgma.names, ex.upgma.matrix));
    expect(r.steps.map((s) => s.distance)).toEqual(ex.upgma.merges.map((m) => m.distance));
    expect(r.steps.map((s) => s.height)).toEqual(ex.upgma.merges.map((m) => m.height));
    expect(r.steps[0]).toMatchObject({ branchA: 8.5, branchB: 8.5 });
    expect(r.steps[1]?.newRow).toEqual([30, 36]); // d(((a,b),e), c) = (25.5*2 + 39)/3 = 30 and d(((a,b),e), d) = (32.5*2 + 43)/3 = 36, as in the article's D3
    expect(r.steps[1]?.matrix.flat().filter((v) => v === 22)).toHaveLength(2); // the 22 = d((a,b), e) of the article's D2 (once per triangle)
    const depths = new Set<number>();
    const walk = (nd: TreeNode, d: number): void => { if (nd.children.length === 0) depths.add(Math.round(d * 1e9)); nd.children.forEach((c) => walk(c, d + (c.length ?? 0))); };
    walk(r.tree.root, 0);
    expect([...depths]).toEqual([16.5e9]); // every leaf is 16.5 from the root, as in the article
    expect(cladeSet(r.tree)).toEqual(new Set([...ex.upgma.clades, 'a,b,c,d,e']));
    expect(totalLength(r.tree)).toBeCloseTo(8.5 + 8.5 + 2.5 + 11 + 5.5 + 14 + 14 + 2.5, 12);
    expect(r.tree.root.children).toHaveLength(2);
  });

  it('NJ: Q1 values, first join, branch lengths, updated distances, second minimum, and final lengths match the article', () => {
    const r = neighborJoining(matrixOf(ex.nj.names, ex.nj.matrix));
    const s1 = r.steps[0];
    if (s1?.kind !== 'join') throw new Error('expected a join');
    for (const [pair, v] of Object.entries(ex.nj.firstQ)) {
      const [x, y] = pair.split(',') as [string, string];
      expect((s1.q[ex.nj.names.indexOf(x)] as number[])[ex.nj.names.indexOf(y)]).toBe(v);
    }
    expect(s1.qMin).toBe(-50);
    expect([s1.a, s1.b]).toEqual([0, 1]);
    expect([s1.branchA, s1.branchB]).toEqual([2, 3]);
    expect(s1.newRow).toEqual([7, 7, 6]); // d(u,c), d(u,d), d(u,e)
    const s2 = r.steps[1];
    if (s2?.kind !== 'join') throw new Error('expected a join');
    expect(s2.qMin).toBe(ex.nj.secondMinQ); // the article notes a tie between u-c and d-e; ours takes the first in scan order, u-c, like the article
    expect({ c: s2.branchA, u: s2.branchB }).toEqual({ c: 4, u: 3 }); // a = c, b = u in scan order; the article gives delta(u,v) = 3 and delta(c,v) = 4
    const f = r.steps[2];
    if (f?.kind !== 'final') throw new Error('expected the final step');
    expect([...f.branches].sort()).toEqual([1, 2, 2]);
    expect(nontrivialSplits(r.tree).splits.size).toBe(2);
    expect(totalLength(r.tree)).toBeCloseTo(2 + 3 + 3 + 4 + 2 + 2 + 1, 12);
  });
});

describe('exact recovery (the key tree tests)', () => {
  it('UPGMA recovers random ultrametric trees: same rooted clades and same branch lengths (200 trees, 3-14 taxa)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 12);
      const truth = randomUltrametric(seed, n);
      const got = upgma(matrixOfTree(truth)).tree;
      expect(cladeSet(got)).toEqual(cladeSet(truth));
      expectEdgesEqual(got, truth);
      // ultrametric: every leaf is the same distance from the root
      const depths = new Set<number>();
      const walk = (nd: TreeNode, d: number): void => { if (nd.children.length === 0) depths.add(Math.round(d * 1e8)); nd.children.forEach((c) => walk(c, d + (c.length ?? 0))); };
      walk(got.root, 0);
      expect(depths.size).toBe(1);
    }
  });
  it('NJ recovers random additive trees: same unrooted topology and branch lengths (200 trees, 3-14 taxa)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 12);
      const truth = randomAdditive(seed, n);
      const got = neighborJoining(matrixOfTree(truth)).tree;
      expect(robinsonFoulds(got, truth).distance).toBe(0);
      expectEdgesEqual(got, truth);
      expect(hasNegativeBranches(got)).toBe(false);
    }
  });
  it('NJ also recovers larger additive trees (40 taxa)', () => {
    const truth = randomAdditive(777, 40);
    const got = neighborJoining(matrixOfTree(truth)).tree;
    expect(robinsonFoulds(got, truth).distance).toBe(0);
    expectEdgesEqual(got, truth);
  });
});

describe('order invariance on tie-free matrices', () => {
  it('permuting taxon order does not change the unrooted topology (UPGMA and NJ)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 4, max: 9 }), (seed, n) => {
      const rng = createRng(seed);
      const names = Array.from({ length: n }, (_, k) => `s${k}`);
      const rows: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = uniform(rng, 0.1, 2); (rows[i] as number[])[j] = v; (rows[j] as number[])[i] = v; }
      const perm = [...names.keys()];
      for (let i = perm.length - 1; i > 0; i--) { const j = rng.nextInt(i + 1); [perm[i], perm[j]] = [perm[j] as number, perm[i] as number]; }
      const permRows = perm.map((a) => perm.map((b) => (rows[a] as number[])[b] as number));
      const m1 = matrixOf(names, rows);
      const m2 = matrixOf(perm.map((p) => names[p] as string), permRows);
      for (const build of [(m: typeof m1) => upgma(m).tree, (m: typeof m1) => neighborJoining(m).tree]) {
        expect(robinsonFoulds(build(m1), build(m2)).distance).toBe(0);
        expect(totalLength(build(m1))).toBeCloseTo(totalLength(build(m2)), 9);
      }
    }), { numRuns: 100 });
  });
});

describe('step traces', () => {
  it('replaying the recorded steps rebuilds the final tree exactly (UPGMA and NJ)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const n = 3 + (seed % 9);
      const rng = createRng(seed);
      const rows: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = uniform(rng, 0.1, 2); (rows[i] as number[])[j] = v; (rows[j] as number[])[i] = v; }
      const m = matrixOf(Array.from({ length: n }, (_, k) => `s${k}`), rows);
      const u = upgma(m); const j = neighborJoining(m);
      expect(replayUpgma(u.steps, u.names)).toEqual(u.tree);
      expect(replayNj(j.steps, j.names)).toEqual(j.tree);
      expect(u.steps).toHaveLength(n - 1);
      expect(j.steps).toHaveLength(n - 2); // n-3 joins + the final 3-way step
    }
  });
});

describe('reference cross-checks for UPGMA and NJ', () => {
  interface RefCase { id: string; names: string[]; matrix: number[][]; upgma: { newick: string; total_length: number }; nj: { newick: string; splits: string[][]; total_length: number } }
  const bio = JSON.parse(readFileSync('tests/fixtures/reference/trees.json', 'utf8')) as { meta: { biopython: string }; cases: RefCase[] };
  const sci = JSON.parse(readFileSync('tests/fixtures/reference/upgma_scipy.json', 'utf8')) as { meta: { scipy: string }; cases: { id: string; clades: string[][]; root_height: number; total_length: number }[] };

  /** Weighted-pair-group averaging (WPGMA) as implemented by Biopython's upgma(): unweighted mean of the two old distances. Test-only reference. */
  const wpgma = (names: string[], rows: number[][]): Tree => {
    const nodes: TreeNode[] = names.map((name) => ({ name, children: [] }));
    const height = names.map(() => 0);
    const d = new Map<string, number>();
    const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
    names.forEach((_, i) => names.forEach((__, j) => { if (i < j) d.set(key(i, j), (rows[i] as number[])[j] as number); }));
    let active = names.map((_, k) => k);
    while (active.length > 1) {
      let best = Infinity, bi = 0, bj = 1;
      for (let p = 0; p < active.length; p++) for (let q = p + 1; q < active.length; q++) { const v = d.get(key(active[p] as number, active[q] as number)) as number; if (v < best) { best = v; bi = p; bj = q; } }
      const a = active[bi] as number; const b = active[bj] as number; const id = nodes.length;
      (nodes[a] as TreeNode).length = best / 2 - (height[a] as number);
      (nodes[b] as TreeNode).length = best / 2 - (height[b] as number);
      nodes.push({ children: [nodes[a] as TreeNode, nodes[b] as TreeNode] }); height.push(best / 2);
      const rest = active.filter((_, k) => k !== bi && k !== bj);
      for (const k of rest) d.set(key(id, k), ((d.get(key(a, k)) as number) + (d.get(key(b, k)) as number)) / 2);
      active = [...rest, id];
    }
    return { root: nodes[nodes.length - 1] as TreeNode };
  };

  it('has at least 6 matrices from Biopython and SciPy', () => { expect(bio.cases.length).toBeGreaterThanOrEqual(6); expect(sci.cases.length).toBe(bio.cases.length); });
  for (const c of bio.cases) {
    const m = matrixOf(c.names, c.matrix);
    it(`${c.id}: NJ equals Biopython's NJ (RF = 0, total length within 1e-9)`, () => {
      const ours = neighborJoining(m).tree;
      const theirs = nw(c.nj.newick.replace(/Inner\d+/g, ''));
      expect(robinsonFoulds(ours, theirs).distance).toBe(0);
      expect(Math.abs(totalLength(ours) - c.nj.total_length)).toBeLessThan(1e-9);
      expectEdgesEqual(ours, theirs, 6e-6); // Biopython's Newick text has only 5 decimals, so per-edge comparison uses 6e-6
    });
    it(`${c.id}: UPGMA equals SciPy average linkage (same rooted clades, same total length and root height)`, () => {
      const s = sci.cases.find((x) => x.id === c.id) as { clades: string[][]; root_height: number; total_length: number };
      const ours = upgma(m).tree;
      expect(cladeSet(ours)).toEqual(new Set(s.clades.map((x) => [...x].sort().join(','))));
      expect(Math.abs(totalLength(ours) - s.total_length)).toBeLessThan(1e-9);
      const depth = (() => { let x = 0; let nd = ours.root; while (nd.children.length > 0) { nd = nd.children[0] as TreeNode; x += nd.length ?? 0; } return x; })();
      expect(Math.abs(depth - s.root_height)).toBeLessThan(1e-9);
    });
    it(`${c.id}: Biopython's "UPGMA" is WPGMA: it equals an unweighted-average reference exactly (documented difference)`, () => {
      const theirs = nw(c.upgma.newick.replace(/Inner\d+/g, ''));
      const ref = wpgma(c.names, c.matrix);
      expect(robinsonFoulds(ref, theirs).distance).toBe(0);
      expect(Math.abs(totalLength(ref) - c.upgma.total_length)).toBeLessThan(1e-9);
    });
  }
  it('on the ultrametric matrix all three UPGMA variants agree (cluster sizes do not matter there)', () => {
    const c = bio.cases.find((x) => x.id === 'ultrametric_5') as RefCase;
    const ours = upgma(matrixOf(c.names, c.matrix)).tree;
    expect(Math.abs(totalLength(ours) - c.upgma.total_length)).toBeLessThan(1e-9);
    expect(robinsonFoulds(ours, nw(c.upgma.newick.replace(/Inner\d+/g, ''))).distance).toBe(0);
  });
});

describe('edge cases', () => {
  it('fewer than 3 sequences is a typed error', () => {
    for (const n of [0, 1, 2]) {
      const m = matrixOf(Array.from({ length: n }, (_, k) => `s${k}`), Array.from({ length: n }, () => new Array<number>(n).fill(1)));
      expect(() => upgma(m)).toThrow(BioError);
      try { neighborJoining(m); throw new Error('no throw'); } catch (e) { expect((e as BioError).code).toBe('too-few-sequences'); }
    }
  });
  it('duplicate names are a typed error', () => {
    const m = matrixOf(['a', 'a', 'b'], [[0, 1, 2], [1, 0, 2], [2, 2, 0]]);
    try { upgma(m); throw new Error('no throw'); } catch (e) { expect((e as BioError).code).toBe('duplicate-names'); }
  });
  it('a saturated pair blocks tree building with an explanation that names the pair', () => {
    const m = matrixOf(['a', 'b', 'c'], [[0, 1, 2], [1, 0, 2], [2, 2, 0]]);
    m.status[1] = DIST_SATURATED; m.status[3] = DIST_SATURATED;
    try { assertTreeReady(m); throw new Error('no throw'); } catch (e) {
      expect((e as BioError).code).toBe('saturated-distances');
      expect((e as BioError).message).toContain('a / b (saturated)');
    }
  });
  it('identical sequences (all distances 0): a tree with zero-length branches is built, deterministically, never NaN', () => {
    const m = matrixOf(['a', 'b', 'c', 'd'], Array.from({ length: 4 }, () => new Array<number>(4).fill(0)));
    const u = upgma(m); const n = neighborJoining(m);
    for (const t of [u.tree, n.tree]) { expect(totalLength(t)).toBe(0); expect(preorder(t).every((x) => x.length === undefined || Number.isFinite(x.length))).toBe(true); }
    expect(writeNewick(upgma(m).tree)).toBe(writeNewick(u.tree)); // deterministic tie-breaking
    expect(leafNames(u.tree).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('NJ can give negative branch lengths on non-additive data (random matrix noisy_7 from the fixtures) and keeps them as computed', () => {
    const c = (JSON.parse(readFileSync('tests/fixtures/reference/trees.json', 'utf8')) as { cases: { id: string; names: string[]; matrix: number[][]; nj: { total_length: number } }[] }).cases.find((x) => x.id === 'noisy_7') as { names: string[]; matrix: number[][]; nj: { total_length: number } };
    const t = neighborJoining(matrixOf(c.names, c.matrix)).tree;
    expect(hasNegativeBranches(t)).toBe(true);
    expect(Math.min(...preorder(t).map((x) => x.length ?? 0))).toBeCloseTo(-0.08419, 4); // the same negative branch Biopython reports
    expect(Math.abs(totalLength(t) - c.nj.total_length)).toBeLessThan(1e-9); // nothing was clamped
  });
  it('3 taxa: UPGMA and NJ give the exact star / rooted tree', () => {
    const m = matrixOf(['a', 'b', 'c'], [[0, 4, 6], [4, 0, 8], [6, 8, 0]]);
    const nj = neighborJoining(m).tree;
    expect(nj.root.children.map((c) => c.length)).toEqual([1, 3, 5]); // (4+6-8)/2, (4+8-6)/2, (6+8-4)/2
    expect(nontrivialSplits(nj).splits.size).toBe(0);
  });
});

describe('tree utilities', () => {
  const t = nw('((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);');
  it('splits: non-trivial only, as unrooted, each stored as the side without the smallest leaf name', () => {
    const sp = nontrivialSplits(t).splits;
    expect([...sp.values()].map((x) => x.join(',')).sort()).toEqual(['C,D,E', 'C,D,E,F', 'D,E']);
  });
  it('re-rooting at any branch preserves unrooted splits, edge lengths, and total length', () => {
    const base = edgeLengthMap(t);
    preorder(t).forEach((_, idx) => {
      if (idx === 0) return;
      const r = rerootAbove(t, idx, 0.3);
      expect(robinsonFoulds(t, r).distance).toBe(0);
      expect(totalLength(r)).toBeCloseTo(totalLength(t), 12);
      const e = edgeLengthMap(r);
      for (const [k, v] of base) expect(e.get(k)).toBeCloseTo(v, 12);
      expect(r.root.children).toHaveLength(2);
    });
  });
  it('re-rooting random trees and re-rooting twice returns to the same unrooted tree', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const tr = randomAdditive(seed, 10);
      const idx = 1 + (seed % (preorder(tr).length - 1));
      const r = rerootAbove(tr, idx, 0.5);
      expect(robinsonFoulds(tr, r).distance).toBe(0);
      const r2 = rerootAbove(r, 1 + (seed % (preorder(r).length - 1)), 0.25);
      expect(robinsonFoulds(tr, r2).distance).toBe(0);
      expect(totalLength(r2)).toBeCloseTo(totalLength(tr), 9);
    }
  });
  it('outgroup rooting puts the root in the middle of the outgroup branch', () => {
    const r = rerootAtLeaf(t, 'F');
    expect(r.root.children.find((c) => c.name === 'F')?.length).toBe(4.5);
  });
  it('midpoint rooting: hand-built examples', () => {
    // A--1--x--5--y--1--B and C hanging off y with 1: longest path A..B = 7 (A-x 1, x-y 5, y-B 1), midpoint 3.5 from A = 2.5 along x-y
    const tr = nw('((A:1,C:3):5,B:1,D:0.5);'.replace('((A:1,C:3):5,B:1,D:0.5);', '(A:1,(B:1,C:1):5,D:0.5);'));
    const m = midpointRoot(tr);
    const d = leafDistances(m);
    const rootDepth = (name: string): number => { let out = -1; const walk = (nd: TreeNode, acc: number): void => { if (nd.children.length === 0 && nd.name === name) out = acc; nd.children.forEach((c) => walk(c, acc + (c.length ?? 0))); }; walk(m.root, 0); return out; };
    const [a, b] = ['A', 'B'];
    expect(rootDepth(a)).toBeCloseTo(rootDepth(b), 12);
    expect(rootDepth('A') + rootDepth('B')).toBeCloseTo(7, 12);
    expect(rootDepth('A')).toBeCloseTo(3.5, 12);
    expect(d.names.length).toBe(4);
    expect(robinsonFoulds(tr, m).distance).toBe(0);
  });
  it('midpoint rooting on random trees: root is equidistant from the two farthest leaves, splits unchanged', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const tr = randomAdditive(seed, 3 + (seed % 10));
      const m = midpointRoot(tr);
      const { dist } = leafDistances(tr);
      const longest = Math.max(...dist.flat());
      const depth: number[] = [];
      const walk = (nd: TreeNode, acc: number): void => { if (nd.children.length === 0) depth.push(acc); nd.children.forEach((c) => walk(c, acc + (c.length ?? 0))); };
      walk(m.root, 0);
      expect(Math.max(...depth)).toBeCloseTo(longest / 2, 9);
      expect(robinsonFoulds(tr, m).distance).toBe(0);
    }
  });
  it('midpoint rooting is deterministic when several paths tie, and does not depend on child order', () => {
    const sym = nw('((A:1,B:1):1,(C:1,D:1):1);');
    const one = writeNewick(midpointRoot(sym));
    expect(writeNewick(midpointRoot(sym))).toBe(one);
    expect(robinsonFoulds(midpointRoot(sym), midpointRoot(nw('((C:1,D:1):1,(A:1,B:1):1);'))).distance).toBe(0);
    const depths: number[] = [];
    const walk = (nd: TreeNode, acc: number): void => { if (nd.children.length === 0) depths.push(acc); nd.children.forEach((c) => walk(c, acc + (c.length ?? 0))); };
    walk(midpointRoot(sym).root, 0);
    expect(Math.max(...depths)).toBeCloseTo(2, 12); // longest leaf-to-leaf path is 4, so every leaf is within 2 of the root
  });
  it('leaf ordering is deterministic and independent of input child order', () => {
    expect(orderedLeaves(nw('((B,A),(D,(C,E)),F);'))).toEqual(orderedLeaves(nw('(F,((E,C),D),(A,B));')));
    expect(ladderize(nw('((B,A),C,D);')).root.children.map((c) => c.name ?? 'clade')).toEqual(['C', 'D', 'clade']);
  });
  it('rotateNode reverses one node’s children and leaves splits alone', () => {
    const r = rotateNode(t, 0);
    expect(r.root.children.map((c) => c.name ?? '(clade)')).toEqual(['F', '(clade)', '(clade)']);
    expect(robinsonFoulds(t, r).distance).toBe(0);
  });
  it('annotateSupport attaches percentages by split, whichever way the tree is rooted', () => {
    const splits = nontrivialSplits(t);
    const percent = new Map([...splits.splits.keys()].map((k, i) => [k, 10 * (i + 1)] as const));
    const a = annotateSupport(t, percent);
    const rooted = rerootAtLeaf(a, 'F');
    const b = annotateSupport(rooted, percent);
    const vals = (x: Tree): number[] => preorder(x).filter((n) => n.children.length > 0 && n.support !== undefined).map((n) => n.support as number).sort((p, q) => p - q);
    expect(vals(a)).toEqual([10, 20, 30]);
    expect(vals(b).filter((v, i, arr) => arr.indexOf(v) === i)).toEqual([10, 20, 30]);
    expect(cladeKey(['A', 'B'], ['A', 'B', 'C', 'D', 'E', 'F'])).toBe(cladeKey(['C', 'D', 'E', 'F'], ['A', 'B', 'C', 'D', 'E', 'F']));
  });
});

describe('Robinson-Foulds', () => {
  it('is 0 for identical trees and for the same tree with different rooting or child order', () => {
    const t = nw('((A,B),(C,D),(E,F));');
    expect(robinsonFoulds(t, t).distance).toBe(0);
    expect(robinsonFoulds(t, rerootAtLeaf(t, 'E')).distance).toBe(0);
    expect(robinsonFoulds(t, nw('((F,E),(D,C),(B,A));')).distance).toBe(0);
  });
  it('is correct on hand-built pairs and symmetric', () => {
    const a = nw('((A,B),(C,D),(E,F));'); // splits AB, CD, EF
    const b = nw('((A,B),(C,E),(D,F));'); // splits AB, CE, DF
    const r = robinsonFoulds(a, b);
    expect(r.distance).toBe(4); // CD,EF only in a; CE,DF only in b
    expect(r.shared).toHaveLength(1);
    expect(r.onlyInA).toHaveLength(2);
    expect(r.onlyInB).toHaveLength(2);
    expect(robinsonFoulds(b, a).distance).toBe(4);
    const star = nw('(A,B,C,D,E,F);');
    expect(robinsonFoulds(a, star).distance).toBe(3);
    expect(robinsonFoulds(a, star).max).toBe(3);
  });
  it('is symmetric and satisfies the triangle inequality on random trees', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const x = randomAdditive(seed, 9); const y = randomAdditive(seed + 1000, 9); const z = randomAdditive(seed + 2000, 9);
      expect(robinsonFoulds(x, y).distance).toBe(robinsonFoulds(y, x).distance);
      expect(robinsonFoulds(x, z).distance).toBeLessThanOrEqual(robinsonFoulds(x, y).distance + robinsonFoulds(y, z).distance);
    }
  });
  it('different leaf sets are a typed error naming the leaves', () => {
    try { robinsonFoulds(nw('(A,B,C,D);'), nw('(A,B,C,E);')); throw new Error('no throw'); } catch (e) { expect((e as BioError).message).toContain('Only in the first: D'); }
  });
});
