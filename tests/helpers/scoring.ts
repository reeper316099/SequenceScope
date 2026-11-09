// Small constructors used across tests to keep scoring setup short and readable.
import type { Alphabet, GapModel, ScoringSpec } from '../../src/shared/types';
import { compileScoring } from '../../src/bio/scoring';
import type { CompiledScoring } from '../../src/bio/scoring';

/** DNA scoring with simple match/mismatch and the given gap model. */
export function dna(match: number, mismatch: number, gaps: GapModel, alphabet: Alphabet = 'dna'): CompiledScoring {
  const spec: ScoringSpec = { substitution: { kind: 'simple', match, mismatch }, gaps };
  return compileScoring(spec, alphabet);
}

/** Protein scoring with a named matrix and the given gap model. */
export function protein(matrix: string, gaps: GapModel): CompiledScoring {
  return compileScoring({ substitution: { kind: 'matrix', name: matrix }, gaps }, 'protein');
}

/** Affine gap model shorthand (positive penalties). */
export const affine = (open: number, extend: number): GapModel => ({ kind: 'affine', open, extend });
/** Linear gap model shorthand (positive penalty). */
export const linear = (gap: number): GapModel => ({ kind: 'linear', gap });
