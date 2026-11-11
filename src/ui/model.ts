// Pure (DOM-free) logic behind the Align view: input analysis, alphabet resolution, scoring presets and wording.
import type { Alphabet, AlphabetChoice, GapModel, ScoringSpec } from '../shared/types';
import { detectAlphabetAsync, parseFastaAsync } from '../backend/api';
import type { Detection } from '../shared/results';
import type { FastaIssue } from '../shared/results';

export interface AnalyzedSequence {
  id: string;
  residues: string;
  /** 'unknown' when nothing could be detected and no alphabet was chosen. */
  alphabet: Alphabet | 'unknown';
  detection: Detection | null;
  issues: FastaIssue[];
  recordCount: number;
  empty: boolean;
  /** True if any issue is an error (the sequence cannot be aligned as is). */
  hasError: boolean;
}

/** Parses and validates what the user typed or pasted (raw residues or FASTA). Never throws. */
export async function analyzeSequenceText(text: string, choice: AlphabetChoice): Promise<AnalyzedSequence> {
  const parsed = await parseFastaAsync(text, { alphabet: choice });
  const first = parsed.records[0];
  const noRecords = parsed.issues.find((i) => i.code === 'no-records');
  if (first === undefined) {
    // An entirely empty box is "empty", not an error.
    return { id: '', residues: '', alphabet: 'unknown', detection: null, issues: noRecords && text.trim() !== '' ? parsed.issues : [], recordCount: 0, empty: true, hasError: false };
  }
  // A missing ">" header is normal for pasted raw sequence, so it is not shown as a message here.
  const issues = parsed.issues.filter((i) => i.code !== 'no-header');
  if (parsed.records.length > 1) {
    issues.push({ severity: 'warning', code: 'duplicate-id', recordIndex: null, recordId: null, message: `${parsed.records.length} FASTA records were found; only the first ("${first.id}") is used here. Use the Distances view for sets.` });
  }
  const undetected = issues.some((i) => i.code === 'undetected-alphabet');
  const detection = choice === 'auto' ? await detectAlphabetAsync(first.residues) : null;
  return {
    id: first.id,
    residues: first.residues,
    alphabet: undetected ? 'unknown' : first.alphabet,
    detection,
    issues,
    recordCount: parsed.records.length,
    empty: first.residues === '',
    hasError: issues.some((i) => i.severity === 'error'),
  };
}

/** What analyzeSequenceText returns for an empty box (available synchronously, for initial state). */
export function emptyAnalysis(): AnalyzedSequence {
  return { id: '', residues: '', alphabet: 'unknown', detection: null, issues: [], recordCount: 0, empty: true, hasError: false };
}

export type PairCheck = { ok: true; alphabet: Alphabet } | { ok: false; message: string };

/** Decides whether the two analyzed sequences can be aligned together, and with which alphabet. */
export function checkPair(a: AnalyzedSequence, b: AnalyzedSequence, choice: AlphabetChoice): PairCheck {
  if (a.empty && b.empty) return { ok: false, message: 'Enter or open two sequences to align.' };
  if (a.empty) return { ok: false, message: 'Sequence A is empty.' };
  if (b.empty) return { ok: false, message: 'Sequence B is empty.' };
  if (a.hasError || b.hasError) return { ok: false, message: 'Fix the problems listed under the sequences first (nothing is changed silently).' };
  if (a.alphabet === 'unknown' || b.alphabet === 'unknown') return { ok: false, message: 'Could not tell DNA, RNA, or protein; choose the alphabet manually.' };
  if (a.alphabet !== b.alphabet) {
    return { ok: false, message: `Sequence A looks like ${a.alphabet} but sequence B looks like ${b.alphabet}. Choose one alphabet manually (or fix the input) to align them.` };
  }
  void choice;
  return { ok: true, alphabet: a.alphabet };
}

export interface Preset {
  id: string;
  label: string;
  molecules: 'nucleotide' | 'protein';
  description: string;
  scoring: ScoringSpec;
}

export const PRESETS: readonly Preset[] = [
  { id: 'dna-linear', label: 'DNA: match +2, mismatch −3, linear gap 4', molecules: 'nucleotide', description: 'Simple teaching setup: every gap position costs the same.', scoring: { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'linear', gap: 4 } } },
  { id: 'dna-affine', label: 'DNA: match +2, mismatch −3, affine gap 5/2', molecules: 'nucleotide', description: 'Opening a gap costs 5, each extra gap position 2: long gaps are cheaper per position, like real insertions/deletions.', scoring: { substitution: { kind: 'simple', match: 2, mismatch: -3 }, gaps: { kind: 'affine', open: 5, extend: 2 } } },
  { id: 'prot-linear', label: 'Protein: BLOSUM62, linear gap 6', molecules: 'protein', description: 'BLOSUM62 scores amino-acid pairs by how often they substitute in related proteins.', scoring: { substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: { kind: 'linear', gap: 6 } } },
  { id: 'prot-affine', label: 'Protein: BLOSUM62, affine gap 11/1', molecules: 'protein', description: 'The common BLAST-style default: opening a gap costs 11, each extra position 1.', scoring: { substitution: { kind: 'matrix', name: 'BLOSUM62' }, gaps: { kind: 'affine', open: 11, extend: 1 } } },
];

/** The preset used when an alphabet is first detected (or changes between nucleotide and protein). */
export function defaultPreset(alphabet: Alphabet): Preset {
  const id = alphabet === 'protein' ? 'prot-affine' : 'dna-linear';
  return PRESETS.find((p) => p.id === id) ?? (PRESETS[0] as Preset); // safe: PRESETS is a non-empty constant list
}

/** One sentence that spells out how a gap of length 3 is charged, with the current numbers. */
export function gapCostText(g: GapModel): string {
  if (g.kind === 'linear') return `Linear gaps: a gap of length k costs k × gap. With gap = ${g.gap}, a gap of length 3 costs 3 × ${g.gap} = ${3 * g.gap}.`;
  return `Affine gaps: a gap of length k costs open + (k − 1) × extend. With open = ${g.open} and extend = ${g.extend}, a gap of length 3 costs ${g.open} + 2 × ${g.extend} = ${g.open + 2 * g.extend}.`;
}

/** Short human description of the whole scoring choice (shown in stats and exports). */
export function describeScoring(s: ScoringSpec): string {
  const sub = s.substitution.kind === 'simple' ? `match ${s.substitution.match}, mismatch ${s.substitution.mismatch}` : s.substitution.name;
  const gap = s.gaps.kind === 'linear' ? `linear gap ${s.gaps.gap}` : `affine gap open ${s.gaps.open} / extend ${s.gaps.extend}`;
  return `${sub}; ${gap}`;
}
