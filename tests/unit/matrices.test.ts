// Substitution matrices: provenance, shape, symmetry, and agreement with the raw NCBI files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMatrix, listMatrices, satisfiesSelfAlignmentCondition } from '../../src/bio/matrices';

/** Independent parser of the raw NCBI file (different code path from tools/gen-matrices.mjs). */
function parseRaw(name: string): Map<string, number> {
  const rows = readFileSync(`data/matrices/${name}`, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  const header = rows[0] ?? [];
  const m = new Map<string, number>();
  for (const r of rows.slice(1)) header.forEach((col, k) => m.set(`${r[0]}${col}`, Number(r[k + 1])));
  return m;
}

describe.each(['BLOSUM45', 'BLOSUM62', 'BLOSUM80'])('%s', (name) => {
  const mat = getMatrix(name);
  const raw = parseRaw(name);
  it('every cell equals the raw NCBI file; checksum matches the file on disk', () => {
    expect(raw.size).toBe(24 * 24);
    for (const [k, v] of raw) expect(mat.get(k.charAt(0), k.charAt(1))).toBe(v);
    expect(mat.sha256).toBe(createHash('sha256').update(readFileSync(`data/matrices/${name}`)).digest('hex'));
  });
  it('is symmetric, and satisfies the self-alignment condition', () => {
    for (const x of mat.letters) for (const y of mat.letters) expect(mat.get(x, y)).toBe(mat.get(y, x));
    expect(satisfiesSelfAlignmentCondition(mat)).toBe(true);
  });
  it('carries its citation', () => { expect(mat.citation).toContain('Henikoff'); });
});

describe('registry', () => {
  it('lists the three verified matrices', () => { expect(listMatrices()).toEqual(['BLOSUM45', 'BLOSUM62', 'BLOSUM80']); });
  it('throws a typed error for an unknown name', () => { expect(() => getMatrix('PAM250')).toThrow(/Unknown substitution matrix/); });
  it('spot values cross-checked against Biopython in Phase 1 (B/D = 4, X/A = 0, */A = -4 for BLOSUM62)', () => {
    const m = getMatrix('BLOSUM62');
    expect([m.get('B', 'D'), m.get('X', 'A'), m.get('*', 'A'), m.get('*', '*')]).toEqual([4, 0, -4, 1]);
  });
});
