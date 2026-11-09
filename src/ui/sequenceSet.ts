// Pure analysis of a pasted/loaded FASTA SET for the Distances and Trees views (aligned or unaligned, caps, names).
import type { Alphabet, AlphabetChoice, DistanceMatrix, Sequence } from '../shared/types';
import { parseFasta } from '../bio/fasta';
import type { FastaIssue } from '../bio/fasta';
import { MAX_TREE_TAXA } from '../bio/distance';

export type SetMode = 'aligned' | 'unaligned';

export interface AnalyzedSet {
  records: Sequence[];
  issues: FastaIssue[];
  alphabet: Alphabet | 'unknown';
  equalLength: boolean;
  hasGaps: boolean;
  /** What the app would pick without user input: aligned only if all rows have equal length AND contain gap characters. */
  suggestedMode: SetMode;
  mode: SetMode;
  duplicateNames: boolean;
  /** A message when the set cannot be used as is (null if fine). */
  blocking: string | null;
  /** Extra caution shown beside results (e.g. fewer than 3 sequences can't make a tree). */
  notes: string[];
}

/** Parses and checks a set of sequences. `mode` 'auto' uses the suggestion. Never throws. */
export function analyzeSet(text: string, choice: AlphabetChoice, mode: SetMode | 'auto'): AnalyzedSet {
  const first = parseFasta(text, { alphabet: choice, allowGaps: true });
  const records = first.records;
  const hasGaps = records.some((r) => r.residues.includes('-'));
  const equalLength = records.length > 0 && records.every((r) => r.residues.length === (records[0]?.residues.length ?? -1));
  const suggestedMode: SetMode = equalLength && hasGaps ? 'aligned' : 'unaligned';
  const finalMode: SetMode = mode === 'auto' ? suggestedMode : mode;
  // In unaligned mode gap characters are not allowed: re-parse strictly so they are reported with positions.
  const parsed = finalMode === 'unaligned' && hasGaps ? parseFasta(text, { alphabet: choice, allowGaps: false }) : first;
  const issues = parsed.issues;
  const alphabet: Alphabet | 'unknown' = issues.some((i) => i.code === 'undetected-alphabet') ? 'unknown' : (records[0]?.alphabet ?? 'unknown');
  const names = records.map((r) => r.id);
  const duplicateNames = new Set(names).size !== names.length;
  const notes: string[] = [];
  let blocking: string | null = null;
  if (records.length === 0) blocking = text.trim() === '' ? 'Load or paste a set of sequences (FASTA) to begin.' : (issues.find((i) => i.severity === 'error')?.message ?? 'No sequences found.');
  else if (issues.some((i) => i.severity === 'error')) blocking = 'Fix the problems listed below first (nothing is changed silently).';
  else if (records.length > MAX_TREE_TAXA) blocking = `At most ${MAX_TREE_TAXA} sequences are supported (this set has ${records.length}).`;
  else if (records.length < 2) blocking = 'Distances need at least 2 sequences.';
  else if (finalMode === 'aligned' && !equalLength) {
    const len0 = records[0]?.residues.length ?? 0;
    const bad = records.find((r) => r.residues.length !== len0);
    blocking = `Aligned input needs every sequence to have the same length, but "${bad?.id ?? ''}" has ${bad?.residues.length ?? 0} columns and "${records[0]?.id ?? ''}" has ${len0}. Choose "Not aligned" to align every pair, or provide a proper alignment.`;
  }
  if (blocking === null && records.length < 3) notes.push('Tree building needs at least 3 sequences.');
  if (blocking === null && duplicateNames) notes.push('Some names are used twice. Distances work, but tree building needs unique names.');
  if (blocking === null && finalMode === 'unaligned' && alphabet === 'unknown') blocking = 'Could not tell DNA, RNA, or protein; choose the alphabet manually.';
  return { records, issues, alphabet, equalLength, hasGaps, suggestedMode, mode: finalMode, duplicateNames, blocking, notes };
}

/** Renames duplicate names by appending _2, _3, … (an explicit user action; never done silently). */
export function uniquifyNames(records: readonly Sequence[]): Sequence[] {
  const seen = new Map<string, number>();
  return records.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id}_${n}` };
  });
}

/** Order of rows for the sortable table: by name, or by the distance in column `col` (unusable cells last). */
export function sortOrder(m: DistanceMatrix, key: { by: 'name' } | { by: 'column'; col: number }, dir: 'asc' | 'desc'): number[] {
  const idx = Array.from({ length: m.n }, (_, k) => k);
  const sign = dir === 'asc' ? 1 : -1;
  idx.sort((a, b) => {
    if (key.by === 'name') return sign * (m.names[a] ?? '').localeCompare(m.names[b] ?? '');
    const ua = m.status[a * m.n + key.col] !== 0;
    const ub = m.status[b * m.n + key.col] !== 0;
    if (ua !== ub) return ua ? 1 : -1; // unusable cells always last
    return sign * ((m.values[a * m.n + key.col] as number) - (m.values[b * m.n + key.col] as number)) || a - b;
  });
  return idx;
}
