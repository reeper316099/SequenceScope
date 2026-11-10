// DOM-free logic behind the Distances and Trees views: set analysis, layouts, keyboard navigation, step forests, table sorting.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadReferenceData } from '../../src/backend/api';
import { distanceMatrixFromAligned } from '../../src/bio/distance';
import { neighborJoining } from '../../src/bio/nj';
import { parseNewick, writeNewick } from '../../src/bio/newick';
import { preorder } from '../../src/bio/tree';
import { upgma } from '../../src/bio/upgma';
import { analyzeSet, sortOrder, uniquifyNames } from '../../src/ui/sequenceSet';
import { cladeNodeKey, collapsibleKeys, layoutRadial, layoutRectangular, navigate } from '../../src/ui/treeLayout';
import { forestAfter } from '../../src/ui/treeSteps';
import { matrixOf } from '../helpers/trees';

beforeAll(loadReferenceData);

const nw = (s: string) => parseNewick(s).tree;
const none = new Set<string>();

describe('analyzeSet', () => {
  const dna = (n: number, extra = ''): string => Array.from({ length: n }, (_, k) => `>s${k}\nACGTACGTACGTACGTACGT${extra}`).join('\n');
  it('suggests "aligned" only when all rows have equal length AND contain gap characters', async () => {
    expect(await analyzeSet('>a\nACGT-ACGTACGTACGTACG\n>b\nACGTTACGTACGTACGTACG\n>c\nACGTTACGTACGTACG-ACG', 'auto', 'auto')).toMatchObject({ suggestedMode: 'aligned', mode: 'aligned', blocking: null });
    expect(await analyzeSet(dna(4), 'auto', 'auto')).toMatchObject({ suggestedMode: 'unaligned', mode: 'unaligned', equalLength: true });
  });
  it('aligned mode with unequal lengths is blocked with a message naming the sequence', async () => {
    const a = await analyzeSet('>a\nACGTACGTAC\n>b\nACGTACG\n>c\nACGTACGTAC', 'auto', 'aligned');
    expect(a.blocking).toContain('"b" has 7 columns');
  });
  it('gaps in unaligned mode are reported as invalid characters (with positions), not dropped', async () => {
    const a = await analyzeSet('>a\nACGTACGTAC-GTACGT\n>b\nACGTACGTACGGTACGT\n>c\nACGTACGTACGGTACGA', 'auto', 'unaligned');
    expect(a.issues.some((i) => i.code === 'invalid-characters' && i.positions?.includes(11))).toBe(true);
    expect(a.blocking).toContain('Fix the problems');
  });
  it('empty input, a single sequence, too many sequences, and duplicate names', async () => {
    expect((await analyzeSet('', 'auto', 'auto')).blocking).toContain('Load or paste');
    expect((await analyzeSet(dna(1), 'auto', 'auto')).blocking).toContain('at least 2');
    expect((await analyzeSet(dna(101), 'auto', 'auto')).blocking).toContain('At most 100');
    const dup = await analyzeSet('>x\nACGTACGTACGTACGTACGT\n>x\nACGTACGTACGTACGTACGA\n>y\nACGTACGTACGTACGTACGC', 'auto', 'auto');
    expect(dup.duplicateNames).toBe(true);
    expect(dup.notes.join()).toContain('unique names');
    expect((await analyzeSet(dna(2), 'auto', 'auto')).notes.join()).toContain('at least 3');
  });
  it('uniquifyNames only renames the second and later copies', async () => {
    const r = uniquifyNames((await analyzeSet('>x\nACGT\n>x\nACGT\n>y\nACGT\n>x\nACGT', 'dna', 'auto')).records);
    expect(r.map((s) => s.id)).toEqual(['x', 'x_2', 'y', 'x_3']);
  });
});

describe('rectangular layout', () => {
  const t = nw('((A:1,B:2):1,C:4);');
  it('phylogram: x is the distance from the root; leaves occupy consecutive rows; internal nodes are centred', () => {
    const l = layoutRectangular(t, { cladogram: false, collapsed: none });
    const by = (name: string) => l.nodes.find((n) => n.label === name);
    expect(by('A')).toMatchObject({ x: 2, y: 0 });
    expect(by('B')).toMatchObject({ x: 3, y: 1 });
    expect(by('C')).toMatchObject({ x: 4, y: 2 });
    const inner = l.nodes.find((n) => !n.isLeaf && n.index !== 0);
    expect(inner).toMatchObject({ x: 1, y: 0.5 });
    expect(l.nodes[0]).toMatchObject({ x: 0, y: 1.25 }); // mean of child rows 0.5 and 2
    expect(l.leafRows).toBe(3);
  });
  it('cladogram: all leaves line up at the same x, ignoring branch lengths', () => {
    const l = layoutRectangular(t, { cladogram: true, collapsed: none });
    const leafX = new Set(l.nodes.filter((n) => n.isLeaf).map((n) => n.x));
    expect(leafX.size).toBe(1);
    expect(l.nodes[0]?.x).toBe(0);
  });
  it('collapsing a clade draws it as one block and keeps pre-order indices stable', () => {
    const keys = collapsibleKeys(t);
    expect(keys).toEqual([cladeNodeKey(['A', 'B'])]);
    const l = layoutRectangular(t, { cladogram: false, collapsed: new Set(keys) });
    expect(l.leafRows).toBe(2);
    const block = l.nodes.find((n) => n.collapsed);
    expect(block).toMatchObject({ taxa: 2, isLeaf: false, index: 1 });
    expect(block?.label).toBe('clade (2 taxa)');
    expect(l.nodes.map((n) => n.index)).toEqual([0, 1, 4]);
    expect(preorder(t).length).toBe(5);
  });
  it('negative branch lengths are laid out as given and flagged', () => {
    const l = layoutRectangular(nw('(A:-0.5,B:1,C:1);'), { cladogram: false, collapsed: none });
    const a = l.nodes.find((n) => n.label === 'A');
    expect(a).toMatchObject({ x: -0.5, negative: true });
    expect(l.xMin).toBe(-0.5);
  });
});

describe('radial layout', () => {
  it('a star tree spreads leaves at equal angles with radius = branch length', () => {
    const l = layoutRadial(nw('(A:1,B:1,C:1,D:1);'), { cladogram: false, collapsed: none });
    const leaves = l.nodes.filter((n) => n.isLeaf);
    expect(leaves.map((n) => n.angle)).toEqual([Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]);
    for (const n of leaves) expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 12);
    expect(l.nodes[0]).toMatchObject({ x: 0, y: 0 });
  });
  it('wedges are proportional to the number of taxa', () => {
    const l = layoutRadial(nw('((A:1,B:1,C:1):1,D:1);'), { cladogram: false, collapsed: none });
    const inner = l.nodes.find((n) => !n.isLeaf && n.index !== 0);
    expect(inner?.angle).toBeCloseTo(((0 + 1.5 * Math.PI) / 2), 12); // 3 of 4 leaves: wedge [0, 3π/2]
  });
});

describe('keyboard navigation', () => {
  const layout = layoutRectangular(nw('((A,B),(C,D));'), { cladogram: false, collapsed: none });
  it('Down/Up walk the visible pre-order; Left goes to the parent; Right to the first child; clamped at the ends', () => {
    expect(navigate(layout, null, 'ArrowDown')).toBe(0);
    expect(navigate(layout, 0, 'ArrowDown')).toBe(1);
    expect(navigate(layout, 1, 'ArrowRight')).toBe(2);
    expect(navigate(layout, 2, 'ArrowLeft')).toBe(1);
    expect(navigate(layout, 0, 'ArrowLeft')).toBe(0);
    expect(navigate(layout, 0, 'ArrowUp')).toBe(0);
    expect(navigate(layout, 6, 'ArrowDown')).toBe(6);
    expect(navigate(layout, 2, 'ArrowRight')).toBe(2); // a leaf has no child
  });
});

describe('step forests', () => {
  const m = matrixOf(['a', 'b', 'c', 'd', 'e'], [[0, 5, 9, 9, 8], [5, 0, 10, 10, 9], [9, 10, 0, 8, 7], [9, 10, 8, 0, 3], [8, 9, 7, 3, 0]]);
  it('k = 0 is just the leaves; the last step gives exactly the final tree (UPGMA and NJ)', () => {
    for (const r of [upgma(m), neighborJoining(m)]) {
      expect(forestAfter(r.steps, r.names, 0).clusters.map((c) => c.node.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
      const last = forestAfter(r.steps, r.names, r.steps.length).clusters;
      expect(last).toHaveLength(1);
      expect(writeNewick({ root: (last[0] as { node: typeof r.tree.root }).node })).toBe(writeNewick(r.tree));
    }
  });
  it('the cluster count shrinks by one per UPGMA step', () => {
    const r = upgma(m);
    r.steps.forEach((_, k) => expect(forestAfter(r.steps, r.names, k).clusters).toHaveLength(5 - k));
  });
});

describe('sortOrder', () => {
  it('sorts by a column with unusable cells last, or by name', () => {
    const m = distanceMatrixFromAligned(['b', 'a', 'c'], ['ACGTACGT', 'ACGAACGT', 'AAAAAAAA'], 'dna', 'jc', 'pairwise-deletion');
    expect(sortOrder(m, { by: 'name' }, 'asc')).toEqual([1, 0, 2]);
    expect(sortOrder(m, { by: 'name' }, 'desc')).toEqual([2, 0, 1]);
    const order = sortOrder(m, { by: 'column', col: 0 }, 'asc');
    expect(order[0]).toBe(0); // distance 0 to itself comes first
    expect(order).toHaveLength(3);
    m.status[2 * 3 + 0] = 1; // make row c unusable in column 0
    expect(sortOrder(m, { by: 'column', col: 0 }, 'asc').at(-1)).toBe(2);
    expect(sortOrder(m, { by: 'column', col: 0 }, 'desc').at(-1)).toBe(2);
  });
});
