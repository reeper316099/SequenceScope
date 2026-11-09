// Conservation statistics and the documented consensus rule, on hand-built columns.
import { describe, expect, it } from 'vitest';
import { BioError } from '../../src/bio/errors';
import { columnStat, conservation, conservationCsv } from '../../src/bio/conservation';

describe('columnStat (hand computed)', () => {
  it('fully conserved column: identity 1, entropy 0, conservation 1, consensus = the residue', () => {
    const c = columnStat('AAAA', 'dna');
    expect(c).toMatchObject({ gaps: 0, residues: 4, top: 'A', identity: 1, entropy: 0, conservation: 1, consensus: 'A' });
    expect(Object.is(c.entropy, 0)).toBe(true);
  });
  it('two residues 50/50: entropy 1 bit; conservation 1 - 1/log2(4) = 0.5 for DNA', () => {
    const c = columnStat('AACC', 'dna');
    expect(c.entropy).toBeCloseTo(1, 12);
    expect(c.identity).toBe(0.5);
    expect(c.conservation).toBeCloseTo(0.5, 12);
    expect(c.consensus).toBe('A'); // tie -> alphabetically first; identity 0.5 >= threshold 0.5
  });
  it('maximum DNA entropy: all four bases equally common gives 2 bits and conservation 0', () => {
    const c = columnStat('ACGT', 'dna');
    expect(c.entropy).toBeCloseTo(2, 12);
    expect(c.conservation).toBeCloseTo(0, 12);
    expect(c.consensus).toBe('.'); // identity 0.25 < 0.5: no consensus
  });
  it('protein uses log2(20) as the maximum entropy', () => {
    const c = columnStat('ACDE', 'protein');
    expect(c.entropy).toBeCloseTo(2, 12);
    expect(c.conservation).toBeCloseTo(1 - 2 / Math.log2(20), 12);
  });
  it('gaps lower identity (they count in the denominator) and scale conservation; they do not enter the entropy', () => {
    const c = columnStat('AAA-', 'dna');
    expect(c).toMatchObject({ gaps: 1, residues: 3, identity: 0.75, entropy: 0, consensus: 'A' });
    expect(c.conservation).toBeCloseTo(0.75, 12);
  });
  it('consensus is "-" when MORE than half the sequences have a gap, and "." below the identity threshold', () => {
    expect(columnStat('A---', 'dna').consensus).toBe('-');
    expect(columnStat('AA--', 'dna').consensus).toBe('A'); // exactly half gaps is not "more than half"; identity 0.5 >= 0.5
    expect(columnStat('AAC-G', 'dna').consensus).toBe('.'); // identity 2/5 = 0.4
    expect(columnStat('AAC-G', 'dna', 0.4).consensus).toBe('A'); // custom threshold
    expect(columnStat('----', 'dna').consensus).toBe('-');
    expect(columnStat('----', 'dna')).toMatchObject({ residues: 0, entropy: 0, conservation: 0, top: '' });
  });
  it('ties between equally common residues resolve alphabetically, deterministically', () => {
    expect(columnStat('GGTT', 'dna').top).toBe('G');
    expect(columnStat('TTGG', 'dna').top).toBe('G');
  });
  it('a single sequence is its own consensus', () => { expect(columnStat('K', 'protein')).toMatchObject({ identity: 1, consensus: 'K' }); });
  it('an empty column is a typed error', () => { expect(() => columnStat('', 'dna')).toThrow(BioError); });
});

describe('conservation of a whole alignment', () => {
  const rows = ['ACGT-A', 'ACGTTA', 'ACCT-A', 'AC-TTA'];
  it('per-column values, consensus string, mean identity, and fully conserved count', () => {
    const c = conservation(rows, 'dna');
    expect(c.columns.map((x) => x.identity)).toEqual([1, 1, 0.5, 1, 0.5, 1]);
    expect(c.consensus).toBe('ACGTTA'); // column 3: G x2, C, gap -> G (identity 0.5); column 5: T x2 and 2 gaps -> T (not MORE than half gaps)
    expect(c.fullyConserved).toBe(4);
    expect(c.meanIdentity).toBeCloseTo((1 + 1 + 0.5 + 1 + 0.5 + 1) / 6, 12);
  });
  it('unequal rows are a typed "not-aligned" error', () => {
    try { conservation(['AC', 'A'], 'dna'); throw new Error('no throw'); } catch (e) { expect((e as BioError).code).toBe('not-aligned'); }
  });
  it('CSV has one line per column', () => {
    const lines = conservationCsv(rows, 'dna').trim().split('\n');
    expect(lines[0]).toBe('column,consensus,identity,entropy_bits,conservation,gaps');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe('1,A,1.0000,0.0000,1.0000,0');
  });
});
