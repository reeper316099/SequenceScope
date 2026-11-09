// Maps a residue letter to a CSS class used for colouring (letters are ALWAYS shown too, so colour is never the only signal).
import type { Alphabet } from '../shared/types';

/** Protein property groups (hydrophobic / polar / positive / negative / special). */
const PROTEIN_GROUP: Record<string, string> = {
  A: 'hydrophobic', V: 'hydrophobic', L: 'hydrophobic', I: 'hydrophobic', M: 'hydrophobic', F: 'hydrophobic', W: 'hydrophobic',
  S: 'polar', T: 'polar', N: 'polar', Q: 'polar', Y: 'polar',
  K: 'positive', R: 'positive', H: 'positive',
  D: 'negative', E: 'negative',
  C: 'special', G: 'special', P: 'special',
};

/** CSS class for one residue (or '-' for a gap). */
export function residueClass(ch: string, alphabet: Alphabet): string {
  if (ch === '-') return 'r-gap';
  if (alphabet === 'protein') return `r-${PROTEIN_GROUP[ch] ?? 'other'}`;
  if ('ACG'.includes(ch)) return `r-${ch}`;
  if (ch === 'T' || ch === 'U') return 'r-T';
  return 'r-other';
}
