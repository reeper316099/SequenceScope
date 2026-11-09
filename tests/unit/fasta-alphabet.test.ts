// FASTA parsing, cleaning, alphabet detection (Phase 3 parsing requirements). Nothing may be silently dropped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanSequenceText, detectAlphabet, findInvalid } from '../../src/bio/alphabet';
import { hasErrors, parseFasta, writeFasta } from '../../src/bio/fasta';

const fx = (name: string): string => readFileSync(`tests/fixtures/fasta/${name}`, 'utf8');
const codes = (t: string, o = {}) => parseFasta(t, o).issues.map((i) => i.code);

describe('parseFasta', () => {
  it('multi-record file with Windows line endings, wrapped lines, blank lines, lowercase, digits', () => {
    const r = parseFasta(fx('good_multi_crlf.fasta'));
    expect(r.records.map((x) => x.id)).toEqual(['seq1', 'seq2']);
    expect(r.records[0]?.description).toBe('first sequence');
    expect(r.records[0]?.residues).toBe('ACGTACGTACGTACGTACGT');
    expect(r.records[1]?.residues).toBe('ACGTACGTACGTACGTACGT'); // lowercased input uppercased, digits removed
    expect(r.records.every((x) => x.alphabet === 'dna')).toBe(true);
    expect(codes(fx('good_multi_crlf.fasta'))).toContain('digits-removed'); // reported, not silent
    expect(r.issues.some((i) => i.code === 'whitespace-removed')).toBe(true);
    expect(hasErrors(r.issues)).toBe(false);
  });
  it('input without a header becomes sequence1 and says so', () => {
    const r = parseFasta(fx('no_header.fasta'));
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.id).toBe('sequence1');
    expect(r.records[0]?.residues).toBe('ACGTACGTACGTACGTACGTACGTACGTAC');
    expect(codes(fx('no_header.fasta'))).toContain('no-header');
  });
  it('empty record is reported as an error and kept (not dropped)', () => {
    const r = parseFasta(fx('empty_record.fasta'));
    expect(r.records.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.records[1]?.residues).toBe('');
    const issue = r.issues.find((i) => i.code === 'empty-record');
    expect(issue?.recordId).toBe('b');
    expect(hasErrors(r.issues)).toBe(true);
  });
  it('duplicate names are reported, not renamed', () => {
    const r = parseFasta(fx('duplicate_names.fasta'));
    expect(r.records.map((x) => x.id)).toEqual(['x', 'x']);
    expect(r.issues.find((i) => i.code === 'duplicate-id')?.recordIndex).toBe(1);
  });
  it('invalid characters are reported with 1-based positions and the residues are kept', () => {
    const r = parseFasta(fx('invalid_chars.fasta'), { alphabet: 'dna' });
    const issue = r.issues.find((i) => i.code === 'invalid-characters');
    expect(issue?.positions).toEqual([15, 22]);
    expect(issue?.severity).toBe('error');
    expect(r.records[0]?.residues).toContain('!');
    expect(r.records[0]?.residues).toContain('?');
  });
  it('empty input gives a no-records error', () => {
    const r = parseFasta(fx('empty.fasta'));
    expect(r.records).toEqual([]);
    expect(r.issues[0]?.code).toBe('no-records');
    expect(parseFasta('   \n\r\n').issues[0]?.code).toBe('no-records');
  });
  it('detects protein across records; honours a manual alphabet override', () => {
    expect(parseFasta(fx('protein_ok.fasta')).records.every((x) => x.alphabet === 'protein')).toBe(true);
    const forced = parseFasta('>s\nACGTACGTAC\n', { alphabet: 'protein' });
    expect(forced.records[0]?.alphabet).toBe('protein');
  });
  it('aligned FASTA: gaps rejected unless allowGaps; "." is normalised to "-" and reported', () => {
    expect(codes('>a\nAC-GT\n>b\nACGGT\n')).toContain('invalid-characters');
    const ok = parseFasta('>a\nAC.GT\n>b\nACGGT\n', { allowGaps: true });
    expect(ok.records[0]?.residues).toBe('AC-GT');
    expect(ok.issues.map((i) => i.code)).toContain('gaps-normalized');
    expect(hasErrors(ok.issues)).toBe(false);
  });
  it('an undetectable alphabet is an error asking for manual choice', () => {
    expect(codes('>s\n@@@@####$$$$\n')).toContain('undetected-alphabet');
  });
  it('ignores ";" comment lines but reports them', () => {
    const r = parseFasta('; a comment\n>s\nACGTACGTACGTACGTACGTAC\n');
    expect(r.records).toHaveLength(1);
    expect(r.issues.map((i) => i.code)).toContain('comment-line');
  });
  it('writeFasta wraps at 60 columns and round-trips', () => {
    const seq = 'ACGT'.repeat(40);
    const text = writeFasta([{ id: 'x', description: 'd', alphabet: 'dna', residues: seq }]);
    expect(text.split('\n')[1]).toHaveLength(60);
    const back = parseFasta(text);
    expect(back.records[0]).toEqual({ id: 'x', description: 'd', alphabet: 'dna', residues: seq });
  });
});

describe('alphabet helpers', () => {
  it('cleanSequenceText strips whitespace/digits, uppercases, and counts', () => {
    expect(cleanSequenceText(' ac gt\n12 N')).toEqual({ residues: 'ACGTN', removedWhitespace: 4, removedDigits: 2 });
  });
  it.each([
    ['ACGTACGTACGTACGTACGTACGT', 'dna', 'high'],
    ['ACGUACGUACGUACGUACGUACGU', 'rna', 'high'],
    ['MVLSPADKTNVKAAWGKVGAHAGE', 'protein', 'high'],
    ['ACGT', 'dna', 'low'], // short: also a valid protein string
    ['ACGTNNRYACGTACGTACGTAC', 'dna', 'high'], // ambiguity codes
    ['ACGTUACGTUACGTUACGTUACGT', 'dna', 'high'], // mixed T and U: treated as DNA (with a reason)
  ] as const)('detects %s as %s (%s confidence)', (s, alpha, conf) => {
    const d = detectAlphabet(s);
    expect(d.alphabet).toBe(alpha);
    expect(d.confidence).toBe(conf);
  });
  it('unknown for junk and empty', () => {
    expect(detectAlphabet('@@@@').alphabet).toBe('unknown');
    expect(detectAlphabet('').alphabet).toBe('unknown');
  });
  it('findInvalid lists positions', () => {
    expect(findInvalid('ACXGT', 'dna')).toEqual([{ index: 2, char: 'X' }]);
    expect(findInvalid('AC-GT', 'dna')).toHaveLength(1);
    expect(findInvalid('AC-GT', 'dna', true)).toHaveLength(0);
  });
});
