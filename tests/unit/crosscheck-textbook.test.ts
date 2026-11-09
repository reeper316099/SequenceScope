// Cross-checks against external answers: Biopython reference fixtures (tools/gen_alignment_refs.py) and worked
// examples from public sources (tests/fixtures/worked-examples/textbook.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreAlignedRows, validateAlignment } from '../../src/bio/alignstats';
import { align, alignAll } from '../../src/bio/pairwise';
import { compileScoring } from '../../src/bio/scoring';
import type { AlignMode, GapModel, ScoringSpec } from '../../src/shared/types';

interface RefCase {
  id: string; alphabet: 'dna' | 'protein'; mode: AlignMode; gap_open: number; gap_extend: number;
  match?: number; mismatch?: number; matrix?: string; a: string; b: string; score: number;
  n_optimal: number; n_optimal_capped: boolean; example_rows: [string, string];
}
const ref = JSON.parse(readFileSync('tests/fixtures/reference/pairwise.json', 'utf8')) as { meta: { biopython: string }; cases: RefCase[] };

/** Builds our scoring from a Biopython fixture case (their scores are negative; our penalties are positive). */
function specFor(c: RefCase, useLinear: boolean): ScoringSpec {
  const gaps: GapModel = useLinear ? { kind: 'linear', gap: -c.gap_open } : { kind: 'affine', open: -c.gap_open, extend: -c.gap_extend };
  const substitution = c.alphabet === 'dna' ? { kind: 'simple' as const, match: c.match ?? 0, mismatch: c.mismatch ?? 0 } : { kind: 'matrix' as const, name: c.matrix ?? '' };
  return { substitution, gaps };
}

describe(`Biopython ${ref.meta.biopython} reference cases (${ref.cases.length})`, () => {
  it('has at least 40 cases', () => { expect(ref.cases.length).toBeGreaterThanOrEqual(40); });
  for (const c of ref.cases) {
    it(`${c.id} ${c.alphabet} ${c.mode} gaps ${c.gap_open}/${c.gap_extend}: score ${c.score}`, () => {
      const linearEquivalent = c.gap_open === c.gap_extend;
      for (const useLinear of linearEquivalent ? [true, false] : [false]) {
        const sc = compileScoring(specFor(c, useLinear), c.alphabet);
        const ours = align(c.a, c.b, c.mode, sc);
        expect(ours.score).toBe(c.score); // exact score match
        expect(validateAlignment(ours, c.a, c.b, sc).problems).toEqual([]); // valid alignment
        const all = alignAll(c.a, c.b, c.mode, sc, 1000);
        if (c.n_optimal === 1 && c.mode === 'global') {
          expect([ours.rowA, ours.rowB]).toEqual(c.example_rows); // unique optimum: strings must match too
        }
        if (c.mode === 'global' && !c.n_optimal_capped && !all.capped) {
          expect(all.alignments.length).toBe(c.n_optimal); // same number of co-optimal global alignments
        }
        if (c.mode === 'local' && c.score > 0) {
          // Biopython's local rows are the aligned region: one of our enumerated co-optimal alignments must equal them
          // (unless the cap was hit on either side).
          const biopythonRowsFound = all.alignments.some((x) => x.rowA === c.example_rows[0] && x.rowB === c.example_rows[1]);
          if (!all.capped && !c.n_optimal_capped && c.n_optimal === all.alignments.length) expect(biopythonRowsFound).toBe(true);
        }
      }
    });
  }
});

interface Example {
  id: string; mode: AlignMode; alphabet: 'dna' | 'protein'; matrix?: string; match?: number; mismatch?: number;
  gaps: GapModel; a: string; b: string; expectedScore: number; sourceAlignment?: [string, string]; sourceAlignments?: [string, string][];
}
const textbook = JSON.parse(readFileSync('tests/fixtures/worked-examples/textbook.json', 'utf8')) as { examples: Example[] };

describe('worked examples from public sources', () => {
  for (const ex of textbook.examples) {
    it(`${ex.id}: score ${ex.expectedScore}, and the source's alignment(s) are valid optimal alignments`, () => {
      const substitution = ex.alphabet === 'dna' ? { kind: 'simple' as const, match: ex.match ?? 0, mismatch: ex.mismatch ?? 0 } : { kind: 'matrix' as const, name: ex.matrix ?? '' };
      const sc = compileScoring({ substitution, gaps: ex.gaps }, ex.alphabet);
      expect(align(ex.a, ex.b, ex.mode, sc).score).toBe(ex.expectedScore);
      const all = alignAll(ex.a, ex.b, ex.mode, sc, 1000);
      for (const [ra, rb] of [...(ex.sourceAlignments ?? []), ...(ex.sourceAlignment ? [ex.sourceAlignment] : [])]) {
        expect(scoreAlignedRows(ra, rb, sc)).toBe(ex.expectedScore); // source's alignment re-scores to the expected score
        expect(all.alignments.some((x) => x.rowA === ra && x.rowB === rb)).toBe(true); // and we find it among co-optimal ones
      }
    });
  }
  it('has at least 3 examples', () => { expect(textbook.examples.length).toBeGreaterThanOrEqual(3); });
});
