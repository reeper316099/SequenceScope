// Turns a serializable ScoringSpec into fast lookup tables for the DP code, plus an independent char-level scorer.
//
// Ambiguity policy (ALGORITHMS.md section 4):
//  * DNA/RNA with simple scores: A,C,G,T/U score match/mismatch; any other IUPAC code scores 0 against anything
//    (including itself) and is never counted as an identity.
//  * Protein with a matrix: letters in the matrix (incl. B, Z, X, *) use matrix values; J, U, O are treated as X.
//  * Protein with simple scores: the 20 amino acids use match/mismatch; every other code scores 0.
import type { Alphabet, ScoringSpec } from '../shared/types';
import { allowedLetters } from './alphabet';
import { BioError } from './errors';
import { getMatrix } from './matrices';
import type { SubstitutionMatrix } from './matrices';

export const MAX_ABS_SCORE = 1000; // |match|, |mismatch| limit (keeps Int32 DP safe)
export const MAX_GAP_PENALTY = 10000;

export interface CompiledScoring {
  spec: ScoringSpec;
  alphabet: Alphabet;
  /** Number of residue classes (rows/columns of `table`). */
  classes: number;
  /** classes x classes substitution scores, row-major. */
  table: Int32Array;
  /** char code (0..127) -> class index, or -1 if the letter is not valid for this alphabet. */
  classOf: Int8Array;
  /** Positive penalties: first gap column costs gapOpen, each further column costs gapExtend. Linear: equal. */
  gapOpen: number;
  gapExtend: number;
  affine: boolean;
  /** Independent char-level score (does NOT use `table`); used by the re-scorer and tests. */
  charScore(a: string, b: string): number;
  /** True if the letter is an ambiguity code that never counts as an identity. */
  isAmbiguous(ch: string): boolean;
  matrix?: SubstitutionMatrix;
}

/** Validates an integer in [min, max] or throws invalid-scoring. */
function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new BioError('invalid-scoring', `${name} must be a whole number between ${min} and ${max}, got ${v}.`);
  }
}

/** Builds lookup tables for the DP. Throws BioError('invalid-scoring' | 'unknown-matrix' | 'alphabet-mismatch'). */
export function compileScoring(spec: ScoringSpec, alphabet: Alphabet): CompiledScoring {
  const g = spec.gaps;
  const gapOpen = g.kind === 'linear' ? g.gap : g.open;
  const gapExtend = g.kind === 'linear' ? g.gap : g.extend;
  checkInt('Gap penalty (open)', gapOpen, 0, MAX_GAP_PENALTY);
  checkInt('Gap penalty (extend)', gapExtend, 0, MAX_GAP_PENALTY);
  const nucleotide = alphabet !== 'protein';

  let letters: string; // class letters, in table order
  let sub: (a: string, b: string) => number; // char-level substitution on class letters (independent path)
  let matrix: SubstitutionMatrix | undefined;
  const classOf = new Int8Array(128).fill(-1);
  const standard = nucleotide ? (alphabet === 'dna' ? 'ACGT' : 'ACGU') : 'ACDEFGHIKLMNPQRSTVWY';

  if (spec.substitution.kind === 'simple') {
    const { match, mismatch } = spec.substitution;
    checkInt('Match score', match, -MAX_ABS_SCORE, MAX_ABS_SCORE);
    checkInt('Mismatch score', mismatch, -MAX_ABS_SCORE, MAX_ABS_SCORE);
    letters = standard + '?'; // the last class ('?' is in no alphabet) collects every ambiguity code
    sub = (a, b) => (!standard.includes(a) || !standard.includes(b) ? 0 : a === b ? match : mismatch);
    for (const ch of standard) classOf[ch.charCodeAt(0)] = standard.indexOf(ch);
    for (const ch of allowedLetters(alphabet)) if (!standard.includes(ch)) classOf[ch.charCodeAt(0)] = standard.length;
  } else {
    if (nucleotide) throw new BioError('alphabet-mismatch', 'Substitution matrices are for protein; use match/mismatch scores for DNA or RNA.');
    matrix = getMatrix(spec.substitution.name);
    letters = matrix.letters;
    const alias = (ch: string): string => ('JUO'.includes(ch) ? 'X' : ch); // J, U, O are not in BLOSUM: use X
    sub = (a, b) => {
      const v = matrix?.get(alias(a), alias(b));
      if (v === undefined) throw new BioError('invalid-residue', `No score for ${a}/${b} in ${spec.substitution.kind === 'matrix' ? spec.substitution.name : ''}.`);
      return v;
    };
    for (const ch of allowedLetters('protein')) classOf[ch.charCodeAt(0)] = letters.indexOf(alias(ch));
  }

  const k = letters.length;
  const table = new Int32Array(k * k);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) table[i * k + j] = sub(letters.charAt(i), letters.charAt(j));

  const ambiguous = (ch: string): boolean => !standard.includes(ch);
  const base = {
    spec, alphabet, classes: k, table, classOf, gapOpen, gapExtend, affine: g.kind === 'affine',
    charScore: (a: string, b: string): number => sub(a, b),
    isAmbiguous: ambiguous,
  };
  return matrix === undefined ? base : { ...base, matrix };
}

/** Encodes residues into class indices; throws invalid-residue with the 1-based position of the first bad letter. */
export function encodeResidues(residues: string, scoring: CompiledScoring): Uint8Array {
  const out = new Uint8Array(residues.length);
  for (let i = 0; i < residues.length; i++) {
    const code = residues.charCodeAt(i);
    const cls = code < 128 ? (scoring.classOf[code] ?? -1) : -1;
    if (cls < 0) {
      throw new BioError('invalid-residue', `Letter "${residues.charAt(i)}" at position ${i + 1} is not valid for ${scoring.alphabet}.`);
    }
    out[i] = cls;
  }
  return out;
}
