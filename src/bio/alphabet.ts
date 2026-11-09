// Alphabets (DNA / RNA / protein), IUPAC ambiguity codes, input cleaning, and alphabet detection.
import type { Alphabet } from '../shared/types';

export const DNA_STANDARD = 'ACGT';
export const RNA_STANDARD = 'ACGU';
export const NUCLEOTIDE_AMBIGUITY = 'RYSWKMBDHVN'; // IUPAC ambiguity codes shared by DNA and RNA
export const PROTEIN_STANDARD = 'ACDEFGHIKLMNPQRSTVWY';
export const PROTEIN_AMBIGUITY = 'BZXJUO*'; // B=D/N, Z=E/Q, X=any, J=I/L, U=selenocysteine, O=pyrrolysine, *=stop

/** Letters allowed in a given alphabet (standard residues plus ambiguity codes). */
export function allowedLetters(alphabet: Alphabet): string {
  if (alphabet === 'dna') return DNA_STANDARD + NUCLEOTIDE_AMBIGUITY;
  if (alphabet === 'rna') return RNA_STANDARD + NUCLEOTIDE_AMBIGUITY;
  return PROTEIN_STANDARD + PROTEIN_AMBIGUITY;
}

/** True if `ch` is one of the unambiguous residues of the alphabet (A,C,G,T / A,C,G,U / the 20 amino acids). */
export function isStandardResidue(ch: string, alphabet: Alphabet): boolean {
  const std = alphabet === 'dna' ? DNA_STANDARD : alphabet === 'rna' ? RNA_STANDARD : PROTEIN_STANDARD;
  return ch.length === 1 && std.includes(ch);
}

export interface CleanedText {
  residues: string; // uppercase, whitespace and digits removed
  removedWhitespace: number;
  removedDigits: number;
}

/** Removes whitespace and digits (line numbers) from pasted text and uppercases it; counts what was removed. */
export function cleanSequenceText(raw: string): CleanedText {
  let removedWhitespace = 0;
  let removedDigits = 0;
  let out = '';
  for (const ch of raw) {
    if (/\s/.test(ch)) removedWhitespace++;
    else if (ch >= '0' && ch <= '9') removedDigits++;
    else out += ch.toUpperCase();
  }
  return { residues: out, removedWhitespace, removedDigits };
}

export interface InvalidChar {
  index: number; // 0-based position in the cleaned residue string
  char: string;
}

/** Lists characters not allowed in the alphabet (optionally allowing gap characters '-' and '.'). */
export function findInvalid(residues: string, alphabet: Alphabet, allowGaps = false): InvalidChar[] {
  const ok = allowedLetters(alphabet);
  const bad: InvalidChar[] = [];
  for (let i = 0; i < residues.length; i++) {
    const ch = residues.charAt(i);
    if (ok.includes(ch)) continue;
    if (allowGaps && (ch === '-' || ch === '.')) continue;
    bad.push({ index: i, char: ch });
  }
  return bad;
}

export interface Detection {
  alphabet: Alphabet | 'unknown';
  confidence: 'high' | 'low';
  reason: string;
}

/**
 * Guesses the alphabet from residues. Rule: if >= 90% of letters are A/C/G/T/U/N it is nucleotide (RNA if U
 * is present and T is not), else protein if every letter is a protein letter, else unknown. Short or
 * all-ACGT sequences are flagged low confidence because they are also valid protein text (A, C, G, T are amino acids).
 */
export function detectAlphabet(residues: string): Detection {
  const letters = residues.replace(/[-.]/g, '');
  if (letters.length === 0) return { alphabet: 'unknown', confidence: 'low', reason: 'No residues to examine.' };
  let nuc = 0;
  let hasT = false;
  let hasU = false;
  let proteinOnly = false;
  for (const ch of letters) {
    if ('ACGTUN'.includes(ch)) nuc++;
    if (ch === 'T') hasT = true;
    if (ch === 'U') hasU = true;
    if ('DEFHIKLMPQRSVWY'.includes(ch)) proteinOnly = true;
  }
  if (nuc / letters.length >= 0.9) {
    const low = letters.length < 20;
    if (hasU && !hasT) return { alphabet: 'rna', confidence: low ? 'low' : 'high', reason: 'Mostly A/C/G/U with U present.' };
    return {
      alphabet: 'dna',
      confidence: low ? 'low' : 'high',
      reason: hasU && hasT ? 'Mostly A/C/G/T/U but both T and U occur; treated as DNA.' : 'Mostly A/C/G/T.',
    };
  }
  if (findInvalid(letters, 'protein').length === 0) {
    return { alphabet: 'protein', confidence: proteinOnly ? 'high' : 'low', reason: 'Letters match the protein alphabet.' };
  }
  return { alphabet: 'unknown', confidence: 'low', reason: 'Contains characters that fit no supported alphabet.' };
}
