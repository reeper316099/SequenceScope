// Newick: round trips, quoting, scientific notation, internal labels, and error messages with positions.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NewickError, parseNewick, writeNewick } from '../../src/bio/newick';
import { leafNames } from '../../src/bio/tree';
import { randomAdditive, randomUltrametric } from '../helpers/trees';

interface Fixtures { good: { id: string; text: string; leaves: string[]; extraTrees?: number }[]; bad: { id: string; text: string; contains: string; line?: number; column?: number }[] }
const fx = JSON.parse(readFileSync('tests/fixtures/newick/cases.json', 'utf8')) as Fixtures;

describe('good fixtures', () => {
  for (const g of fx.good) {
    it(`${g.id}: parses, and write -> read gives an identical tree`, () => {
      const r = parseNewick(g.text);
      expect(leafNames(r.tree)).toEqual(g.leaves);
      expect(r.extraTrees).toBe(g.extraTrees ?? 0);
      const again = parseNewick(writeNewick(r.tree));
      expect(again.tree).toEqual(r.tree);
      expect(writeNewick(again.tree)).toBe(writeNewick(r.tree));
    });
  }
});

describe('specific parsing rules', () => {
  it('quoted labels with spaces, parentheses and doubled quotes', () => {
    const t = parseNewick("('Homo sapiens (human)':1,'it''s':2,(C,D));").tree;
    expect(leafNames(t)).toEqual(['Homo sapiens (human)', "it's", 'C', 'D']);
    expect(writeNewick(t)).toBe("('Homo sapiens (human)':1,'it''s':2,(C,D));");
  });
  it('scientific-notation and negative lengths are exact', () => {
    const t = parseNewick('(A:1e-3,B:2.5E+2,(C:-1.5e-2,D:.5):3.);').tree;
    expect(t.root.children[0]?.length).toBe(0.001);
    expect(t.root.children[1]?.length).toBe(250);
    expect(t.root.children[2]?.children[0]?.length).toBe(-0.015);
    expect(t.root.children[2]?.children[1]?.length).toBe(0.5);
    expect(t.root.children[2]?.length).toBe(3);
  });
  it('numeric internal labels become support; other internal labels stay labels; missing lengths stay undefined', () => {
    const t = parseNewick('((A:1,B:1)95:0.5,(C:1,D:1)clade_x:0.5,E)root;').tree;
    expect(t.root.children[0]?.support).toBe(95);
    expect(t.root.children[0]?.label).toBeUndefined();
    expect(t.root.children[1]?.label).toBe('clade_x');
    expect(t.root.label).toBe('root');
    expect(t.root.children[2]?.length).toBeUndefined();
  });
  it('a quoted numeric internal label stays a label and survives a round trip', () => {
    const t = parseNewick("((A,B)'95',C,D);").tree;
    expect(t.root.children[0]?.label).toBe('95');
    expect(t.root.children[0]?.support).toBeUndefined();
    expect(parseNewick(writeNewick(t)).tree).toEqual(t);
  });
  it('underscores in unquoted labels are kept (not turned into spaces)', () => {
    expect(leafNames(parseNewick('(HBA_HUMAN,B,C);').tree)).toEqual(['HBA_HUMAN', 'B', 'C']);
  });
  it('support values can be written or left out', () => {
    const t = parseNewick('((A:1,B:1)95:0.5,C:1,D:1);').tree;
    expect(writeNewick(t)).toBe('((A:1,B:1)95:0.5,C:1,D:1);');
    expect(writeNewick(t, { includeSupport: false })).toBe('((A:1,B:1):0.5,C:1,D:1);');
    expect(writeNewick(t, { includeLengths: false })).toBe('((A,B)95,C,D);');
  });
  it('a very deep tree is refused with a clear message instead of overflowing the stack', () => {
    const deep = '('.repeat(4000) + 'A' + ',B)'.repeat(4000) + ';';
    expect(() => parseNewick(deep)).toThrow(/nested more than/);
  });
});

describe('bad fixtures give clear errors with positions', () => {
  for (const b of fx.bad) {
    it(`${b.id}`, () => {
      try {
        parseNewick(b.text);
        throw new Error('expected a NewickError');
      } catch (e) {
        expect(e).toBeInstanceOf(NewickError);
        const err = e as NewickError;
        expect(err.message).toContain(b.contains);
        expect(err.code).toBe('newick-syntax');
        if (b.line !== undefined) expect(err.line).toBe(b.line);
        if (b.column !== undefined) expect(err.column).toBe(b.column);
      }
    });
  }
});

describe('properties', () => {
  it('write -> read is the identity on random trees (rooted and unrooted forms)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 3, max: 25 }), (seed, n) => {
      for (const t of [randomUltrametric(seed, n), randomAdditive(seed, n)]) {
        const back = parseNewick(writeNewick(t)).tree;
        expect(back).toEqual(t);
      }
    }), { numRuns: 100 });
  });
  it('writing is stable: write(read(write(t))) === write(t)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
      const s = writeNewick(randomAdditive(seed, 12));
      expect(writeNewick(parseNewick(s).tree)).toBe(s);
    }), { numRuns: 50 });
  });
  it('arbitrary leaf names survive quoting', () => {
    fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(...'ab (),:;[]\' _1.') }), { minLength: 3, maxLength: 6 }), (names) => {
      const uniq = [...new Set(names)];
      if (uniq.length < 3) return;
      const t = { root: { children: uniq.map((name) => ({ name, length: 1, children: [] })) } };
      expect(leafNames(parseNewick(writeNewick(t)).tree)).toEqual(uniq);
    }), { numRuns: 100 });
  });
});
