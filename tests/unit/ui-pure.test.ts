// Unit tests for the DOM-free UI logic: history, histogram, matrix geometry, input model, residue classes.
import { describe, expect, it } from 'vitest';
import { History } from '../../src/ui/history';
import { histogram } from '../../src/ui/histogram';
import { cellAt, fitView, mix, pathCells, visibleRange, zoomAt, parseHex } from '../../src/ui/matrixGeometry';
import { analyzeSequenceText, checkPair, defaultPreset, describeScoring, gapCostText, PRESETS } from '../../src/ui/model';
import { residueClass } from '../../src/ui/residueClass';
import { compileScoring } from '../../src/bio/scoring';
import { align } from '../../src/bio/pairwise';

describe('History', () => {
  it('undo/redo walk through states; a new push clears redo; identical pushes are ignored', () => {
    const h = new History<string>('a');
    h.push('b'); h.push('b'); h.push('c');
    expect(h.size).toBe(2);
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('b');
    h.push('x');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('b');
  });
  it('is bounded', () => {
    const h = new History<number>(0, 5);
    for (let i = 1; i <= 20; i++) h.push(i);
    expect(h.size).toBe(5);
    let steps = 0;
    while (h.undo() !== null) steps++;
    expect(steps).toBe(5);
  });
});

describe('histogram', () => {
  it('counts every score and includes the real score in range', () => {
    const h = histogram([1, 2, 2, 3, 3, 3], 10, 30);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(h.realBin).toBe(h.counts.length - 1);
    expect(h.labels[h.realBin]).toBe('10');
  });
  it('uses wider bins for large ranges and never exceeds maxBins', () => {
    const scores = Array.from({ length: 1000 }, (_, k) => k);
    const h = histogram(scores, 500, 30);
    expect(h.counts.length).toBeLessThanOrEqual(30);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(h.binWidth).toBeGreaterThan(1);
  });
});

describe('matrix geometry', () => {
  it('fitView fits and centres', () => {
    const v = fitView(10, 20, 400, 300);
    expect(v.cs).toBe(20);
    expect(v.oy).toBe(50);
  });
  it('cellAt is the inverse of the cell origin and rejects outside points', () => {
    const v = { cs: 10, ox: 5, oy: 7 };
    expect(cellAt(v, 5 + 3 * 10 + 1, 7 + 2 * 10 + 1, 10, 10)).toEqual({ i: 2, j: 3 });
    expect(cellAt(v, 2, 2, 10, 10)).toBeNull();
    expect(cellAt(v, 5 + 10 * 10 + 1, 20, 10, 10)).toBeNull();
  });
  it('zoomAt keeps the point under the cursor fixed', () => {
    const v = { cs: 12, ox: 30, oy: -10 };
    const px = 123, py = 88;
    const before = { x: (px - v.ox) / v.cs, y: (py - v.oy) / v.cs };
    const z = zoomAt(v, px, py, 1.7);
    expect((px - z.ox) / z.cs).toBeCloseTo(before.x, 9);
    expect((py - z.oy) / z.cs).toBeCloseTo(before.y, 9);
  });
  it('visibleRange covers exactly the cells in the plot', () => {
    expect(visibleRange({ cs: 10, ox: 0, oy: 0 }, 55, 35, 100, 100)).toEqual({ i0: 0, i1: 3, j0: 0, j1: 5 });
  });
  it('pathCells walks an alignment from its start to its end cell', () => {
    const sc = compileScoring({ substitution: { kind: 'simple', match: 1, mismatch: -1 }, gaps: { kind: 'linear', gap: 1 } }, 'dna');
    const aln = align('GCATGCG', 'GATTACA', 'global', sc);
    const cells = pathCells(aln);
    expect(cells[0]).toEqual([0, 0]);
    expect(cells[cells.length - 1]).toEqual([7, 7]);
    expect(cells.length).toBe(aln.rowA.length + 1);
  });
  it('colour helpers behave', () => {
    expect(parseHex('#ff0080')).toEqual([255, 0, 128]);
    expect(parseHex('nonsense')).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(mix([0, 0, 0], [100, 200, 50], 5)).toEqual([100, 200, 50]);
  });
});

describe('input model', () => {
  it('analyses raw DNA without showing a "no header" message', () => {
    const a = analyzeSequenceText(' acgt acgt\n12 acgtacgtacgtacgt ', 'auto');
    expect(a.residues).toBe('ACGTACGTACGTACGTACGTACGT');
    expect(a.alphabet).toBe('dna');
    expect(a.issues.map((i) => i.code)).not.toContain('no-header');
    expect(a.issues.map((i) => i.code)).toContain('digits-removed');
  });
  it('an empty box is empty (not an error); junk is an error', () => {
    expect(analyzeSequenceText('', 'auto')).toMatchObject({ empty: true, hasError: false });
    expect(analyzeSequenceText('@@@@##$$', 'auto').hasError).toBe(true);
  });
  it('warns when several FASTA records are pasted', () => {
    const a = analyzeSequenceText('>a\nACGTACGTACGTACGTACGT\n>b\nACGTACGTACGTACGTACGA\n', 'auto');
    expect(a.id).toBe('a');
    expect(a.issues.some((i) => i.message.includes('only the first'))).toBe(true);
  });
  it('checkPair gives clear reasons', () => {
    const dna = analyzeSequenceText('ACGTACGTACGTACGTACGT', 'auto');
    const prot = analyzeSequenceText('MVLSPADKTNVKAAWGKVGAHAGE', 'auto');
    const empty = analyzeSequenceText('', 'auto');
    expect(checkPair(dna, empty, 'auto')).toEqual({ ok: false, message: 'Sequence B is empty.' });
    expect(checkPair(dna, dna, 'auto')).toEqual({ ok: true, alphabet: 'dna' });
    const mismatch = checkPair(dna, prot, 'auto');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.message).toContain('dna');
    expect(checkPair(analyzeSequenceText('ACGT!ACGT', 'dna'), dna, 'dna').ok).toBe(false);
  });
  it('every preset compiles for its molecule type, and wording shows real numbers', () => {
    for (const p of PRESETS) expect(() => compileScoring(p.scoring, p.molecules === 'protein' ? 'protein' : 'dna')).not.toThrow();
    expect(defaultPreset('protein').id).toBe('prot-affine');
    expect(defaultPreset('rna').id).toBe('dna-linear');
    expect(gapCostText({ kind: 'affine', open: 11, extend: 1 })).toContain('11 + 2 × 1 = 13');
    expect(gapCostText({ kind: 'linear', gap: 4 })).toContain('3 × 4 = 12');
    expect(describeScoring(defaultPreset('protein').scoring)).toContain('BLOSUM62');
  });
});

describe('residueClass', () => {
  it('classifies protein groups, nucleotides, and gaps', () => {
    expect(residueClass('L', 'protein')).toBe('r-hydrophobic');
    expect(residueClass('K', 'protein')).toBe('r-positive');
    expect(residueClass('X', 'protein')).toBe('r-other');
    expect(residueClass('A', 'dna')).toBe('r-A');
    expect(residueClass('U', 'rna')).toBe('r-T');
    expect(residueClass('N', 'dna')).toBe('r-other');
    expect(residueClass('-', 'dna')).toBe('r-gap');
  });
});
