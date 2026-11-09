// FASTA parsing and writing. Nothing is silently dropped or changed: every cleanup and problem is reported as an issue.
import type { Alphabet, Sequence } from '../shared/types';
import { cleanSequenceText, detectAlphabet, findInvalid } from './alphabet';

export type FastaIssueCode =
  | 'no-records' | 'no-header' | 'empty-header' | 'empty-record' | 'duplicate-id' | 'invalid-characters'
  | 'digits-removed' | 'whitespace-removed' | 'gaps-normalized' | 'comment-line' | 'undetected-alphabet' | 'low-confidence-alphabet';

export interface FastaIssue {
  severity: 'error' | 'warning' | 'info';
  code: FastaIssueCode;
  recordIndex: number | null; // 0-based index of the record, or null for whole-input issues
  recordId: string | null;
  message: string;
  positions?: number[]; // 1-based residue positions (for invalid characters)
}

export interface ParsedFasta {
  records: Sequence[];
  issues: FastaIssue[];
}

export interface ParseOptions {
  alphabet?: Alphabet | 'auto'; // default 'auto' (detected over ALL records together)
  allowGaps?: boolean; // accept '-' and '.' (aligned FASTA); '.' is normalised to '-' and reported
}

interface RawRecord {
  id: string;
  description: string;
  lines: string[];
}

/** Parses pasted text or a FASTA file into records plus a full list of issues (see FastaIssueCode). */
export function parseFasta(text: string, options: ParseOptions = {}): ParsedFasta {
  const issues: FastaIssue[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const raw: RawRecord[] = [];
  let current: RawRecord | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.startsWith(';')) {
      issues.push({ severity: 'info', code: 'comment-line', recordIndex: null, recordId: null, message: `Ignored comment line: "${line.slice(0, 60)}"` });
      continue;
    }
    if (line.startsWith('>')) {
      const header = line.slice(1).trim();
      const m = /^(\S+)\s*(.*)$/.exec(header);
      current = { id: m?.[1] ?? '', description: m?.[2] ?? '', lines: [] };
      raw.push(current);
    } else {
      if (current === null) {
        current = { id: '', description: '', lines: [] }; // sequence text before any header
        raw.push(current);
        issues.push({ severity: 'info', code: 'no-header', recordIndex: 0, recordId: null, message: 'Input has no ">" header line; treated as one sequence named "sequence1".' });
      }
      current.lines.push(line);
    }
  }
  if (raw.length === 0) {
    issues.push({ severity: 'error', code: 'no-records', recordIndex: null, recordId: null, message: 'No sequence found in the input.' });
    return { records: [], issues };
  }

  const cleaned = raw.map((r, idx) => {
    const id = r.id === '' ? `sequence${idx + 1}` : r.id;
    if (r.id === '' && r.lines.length > 0 && issues.every((i) => i.code !== 'no-header' || i.recordIndex !== idx)) {
      issues.push({ severity: 'warning', code: 'empty-header', recordIndex: idx, recordId: id, message: `Record ${idx + 1} has an empty header; named "${id}".` });
    }
    const c = cleanSequenceText(r.lines.join(''));
    let residues = c.residues;
    if (options.allowGaps === true && residues.includes('.')) {
      residues = residues.replace(/\./g, '-');
      issues.push({ severity: 'info', code: 'gaps-normalized', recordIndex: idx, recordId: id, message: `"." gap characters in ${id} were written as "-".` });
    }
    if (c.removedDigits > 0) issues.push({ severity: 'info', code: 'digits-removed', recordIndex: idx, recordId: id, message: `Removed ${c.removedDigits} digit(s) from ${id} (e.g. line numbers).` });
    if (c.removedWhitespace > 0) issues.push({ severity: 'info', code: 'whitespace-removed', recordIndex: idx, recordId: id, message: `Removed ${c.removedWhitespace} space/tab character(s) from ${id}.` });
    return { id, description: r.description, residues };
  });

  // Alphabet: forced by the caller, or detected over all residues together so one set stays consistent.
  let alphabet: Alphabet;
  if (options.alphabet !== undefined && options.alphabet !== 'auto') {
    alphabet = options.alphabet;
  } else {
    const det = detectAlphabet(cleaned.map((c) => c.residues).join(''));
    if (det.alphabet === 'unknown') {
      issues.push({ severity: 'error', code: 'undetected-alphabet', recordIndex: null, recordId: null, message: `Could not detect DNA, RNA, or protein: ${det.reason} Choose the alphabet manually.` });
      alphabet = 'protein'; // so invalid characters below are still listed with positions
    } else {
      alphabet = det.alphabet;
      if (det.confidence === 'low') issues.push({ severity: 'warning', code: 'low-confidence-alphabet', recordIndex: null, recordId: null, message: `Detected ${det.alphabet} with low confidence (${det.reason}). Override it manually if wrong.` });
    }
  }

  const seen = new Map<string, number>();
  const records: Sequence[] = cleaned.map((c, idx) => {
    if (c.residues === '') issues.push({ severity: 'error', code: 'empty-record', recordIndex: idx, recordId: c.id, message: `Record "${c.id}" has no residues.` });
    const bad = findInvalid(c.residues, alphabet, options.allowGaps === true);
    if (bad.length > 0) {
      const shown = bad.slice(0, 8).map((b) => `${b.char} at ${b.index + 1}`).join(', ');
      issues.push({ severity: 'error', code: 'invalid-characters', recordIndex: idx, recordId: c.id, positions: bad.map((b) => b.index + 1), message: `Record "${c.id}" has ${bad.length} character(s) not valid for ${alphabet}: ${shown}${bad.length > 8 ? ', …' : ''}.` });
    }
    const prior = seen.get(c.id);
    if (prior !== undefined) issues.push({ severity: 'warning', code: 'duplicate-id', recordIndex: idx, recordId: c.id, message: `Name "${c.id}" is used by records ${prior + 1} and ${idx + 1}. Tree building needs unique names.` });
    else seen.set(c.id, idx);
    return { id: c.id, description: c.description, alphabet, residues: c.residues };
  });
  return { records, issues };
}

/** True if any issue is an error (the caller should refuse to run algorithms on this input). */
export function hasErrors(issues: readonly FastaIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Writes records as FASTA text with lines wrapped at `width` columns (default 60). */
export function writeFasta(records: readonly Sequence[], width = 60): string {
  const out: string[] = [];
  for (const r of records) {
    out.push(r.description === '' ? `>${r.id}` : `>${r.id} ${r.description}`);
    for (let i = 0; i < r.residues.length; i += width) out.push(r.residues.slice(i, i + width));
    if (r.residues === '') out.push('');
  }
  return out.join('\n') + '\n';
}
