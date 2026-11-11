//! FASTA parsing and writing. Nothing is silently dropped or changed: every cleanup and problem is reported as an issue.
//! Port of `src/bio/fasta.ts`; the issue codes, order, and message texts are identical to the TypeScript ones.

use crate::alphabet::{Confidence, clean_sequence_text, detect_alphabet, find_invalid, is_js_whitespace};
use crate::types::Alphabet;
use std::collections::HashMap;

/// One biological sequence (residues are upper-case, whitespace and digits already removed by the parser).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sequence {
    pub id: String,
    pub description: String,
    pub alphabet: Alphabet,
    pub residues: String,
}

/// How serious a parsing issue is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    /// "error" / "warning" / "info".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
        }
    }
}

/// What kind of issue was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FastaIssueCode {
    NoRecords,
    NoHeader,
    EmptyHeader,
    EmptyRecord,
    DuplicateId,
    InvalidCharacters,
    DigitsRemoved,
    WhitespaceRemoved,
    GapsNormalized,
    CommentLine,
    UndetectedAlphabet,
    LowConfidenceAlphabet,
}

impl FastaIssueCode {
    /// The kebab-case string the TypeScript side uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoRecords => "no-records",
            Self::NoHeader => "no-header",
            Self::EmptyHeader => "empty-header",
            Self::EmptyRecord => "empty-record",
            Self::DuplicateId => "duplicate-id",
            Self::InvalidCharacters => "invalid-characters",
            Self::DigitsRemoved => "digits-removed",
            Self::WhitespaceRemoved => "whitespace-removed",
            Self::GapsNormalized => "gaps-normalized",
            Self::CommentLine => "comment-line",
            Self::UndetectedAlphabet => "undetected-alphabet",
            Self::LowConfidenceAlphabet => "low-confidence-alphabet",
        }
    }
}

/// One reported problem or cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastaIssue {
    pub severity: Severity,
    pub code: FastaIssueCode,
    /// 0-based index of the record, or None for whole-input issues.
    pub record_index: Option<usize>,
    pub record_id: Option<String>,
    pub message: String,
    /// 1-based residue positions (for invalid characters).
    pub positions: Option<Vec<usize>>,
}

/// Parsed records plus every issue found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFasta {
    pub records: Vec<Sequence>,
    pub issues: Vec<FastaIssue>,
}

/// Alphabet choice for parsing: detect automatically over all records together, or force one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AlphabetChoice {
    #[default]
    Auto,
    Fixed(Alphabet),
}

/// Parsing options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParseOptions {
    pub alphabet: AlphabetChoice,
    /// Accept '-' and '.' (aligned FASTA); '.' is normalised to '-' and reported.
    pub allow_gaps: bool,
}

/// A record before cleaning: header pieces and the raw sequence lines.
struct RawRecord {
    id: String,
    description: String,
    lines: Vec<String>,
}

/// Builds an issue with no position list.
fn issue(
    severity: Severity,
    code: FastaIssueCode,
    record_index: Option<usize>,
    record_id: Option<&str>,
    message: String,
) -> FastaIssue {
    FastaIssue {
        severity,
        code,
        record_index,
        record_id: record_id.map(str::to_string),
        message,
        positions: None,
    }
}

/// JavaScript's `String.trim()` (strips exactly the JS whitespace set).
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// The first `n` UTF-16 units of a string, like JavaScript's `slice(0, n)`.
fn js_prefix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// Splits a (trimmed, non-empty) header into id and description: the first whitespace-free run, then the rest.
fn split_header(header: &str) -> (String, String) {
    let id_end = header.find(is_js_whitespace).unwrap_or(header.len());
    let (id, rest) = header.split_at(id_end);
    (id.to_string(), rest.trim_start_matches(is_js_whitespace).to_string())
}

/// Parses pasted text or a FASTA file into records plus a full list of issues (see `FastaIssueCode`).
pub fn parse_fasta(text: &str, options: ParseOptions) -> ParsedFasta {
    let mut issues: Vec<FastaIssue> = Vec::new();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut raw: Vec<RawRecord> = Vec::new();
    for line in normalized.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        if line.starts_with(';') {
            issues.push(issue(
                Severity::Info,
                FastaIssueCode::CommentLine,
                None,
                None,
                format!("Ignored comment line: \"{}\"", js_prefix(line, 60)),
            ));
            continue;
        }
        if let Some(header) = line.strip_prefix('>') {
            let header = js_trim(header);
            let (id, description) = if header.is_empty() {
                (String::new(), String::new())
            } else {
                split_header(header)
            };
            raw.push(RawRecord {
                id,
                description,
                lines: Vec::new(),
            });
        } else {
            if raw.is_empty() {
                // Sequence text before any header.
                raw.push(RawRecord {
                    id: String::new(),
                    description: String::new(),
                    lines: Vec::new(),
                });
                issues.push(issue(
                    Severity::Info,
                    FastaIssueCode::NoHeader,
                    Some(0),
                    None,
                    "Input has no \">\" header line; treated as one sequence named \"sequence1\".".to_string(),
                ));
            }
            if let Some(current) = raw.last_mut() {
                current.lines.push(line.to_string());
            }
        }
    }
    if raw.is_empty() {
        issues.push(issue(
            Severity::Error,
            FastaIssueCode::NoRecords,
            None,
            None,
            "No sequence found in the input.".to_string(),
        ));
        return ParsedFasta {
            records: Vec::new(),
            issues,
        };
    }

    struct Cleaned {
        id: String,
        description: String,
        residues: String,
    }
    let mut cleaned: Vec<Cleaned> = Vec::new();
    for (idx, r) in raw.iter().enumerate() {
        let id = if r.id.is_empty() {
            format!("sequence{}", idx + 1)
        } else {
            r.id.clone()
        };
        let covered_by_no_header = issues
            .iter()
            .any(|i| i.code == FastaIssueCode::NoHeader && i.record_index == Some(idx));
        if r.id.is_empty() && !r.lines.is_empty() && !covered_by_no_header {
            issues.push(issue(
                Severity::Warning,
                FastaIssueCode::EmptyHeader,
                Some(idx),
                Some(&id),
                format!("Record {} has an empty header; named \"{}\".", idx + 1, id),
            ));
        }
        let c = clean_sequence_text(&r.lines.join(""));
        let mut residues = c.residues;
        if options.allow_gaps && residues.contains('.') {
            residues = residues.replace('.', "-");
            issues.push(issue(
                Severity::Info,
                FastaIssueCode::GapsNormalized,
                Some(idx),
                Some(&id),
                format!("\".\" gap characters in {id} were written as \"-\"."),
            ));
        }
        if c.removed_digits > 0 {
            issues.push(issue(
                Severity::Info,
                FastaIssueCode::DigitsRemoved,
                Some(idx),
                Some(&id),
                format!("Removed {} digit(s) from {} (e.g. line numbers).", c.removed_digits, id),
            ));
        }
        if c.removed_whitespace > 0 {
            issues.push(issue(
                Severity::Info,
                FastaIssueCode::WhitespaceRemoved,
                Some(idx),
                Some(&id),
                format!("Removed {} space/tab character(s) from {}.", c.removed_whitespace, id),
            ));
        }
        cleaned.push(Cleaned {
            id,
            description: r.description.clone(),
            residues,
        });
    }

    // Alphabet: forced by the caller, or detected over all residues together so one set stays consistent.
    let alphabet = match options.alphabet {
        AlphabetChoice::Fixed(a) => a,
        AlphabetChoice::Auto => {
            let all: String = cleaned.iter().map(|c| c.residues.as_str()).collect();
            let det = detect_alphabet(&all);
            match det.alphabet {
                None => {
                    issues.push(issue(
                        Severity::Error,
                        FastaIssueCode::UndetectedAlphabet,
                        None,
                        None,
                        format!(
                            "Could not detect DNA, RNA, or protein: {} Choose the alphabet manually.",
                            det.reason
                        ),
                    ));
                    Alphabet::Protein // so invalid characters below are still listed with positions
                }
                Some(a) => {
                    if det.confidence == Confidence::Low {
                        issues.push(issue(
                            Severity::Info,
                            FastaIssueCode::LowConfidenceAlphabet,
                            None,
                            None,
                            format!(
                                "Detected {} with low confidence ({}). Override it manually if wrong.",
                                a.as_str(),
                                det.reason
                            ),
                        ));
                    }
                    a
                }
            }
        }
    };

    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut records = Vec::new();
    for (idx, c) in cleaned.into_iter().enumerate() {
        if c.residues.is_empty() {
            issues.push(issue(
                Severity::Error,
                FastaIssueCode::EmptyRecord,
                Some(idx),
                Some(&c.id),
                format!("Record \"{}\" has no residues.", c.id),
            ));
        }
        let bad = find_invalid(&c.residues, alphabet, options.allow_gaps);
        if !bad.is_empty() {
            let shown: Vec<String> = bad
                .iter()
                .take(8)
                .map(|b| format!("{} at {}", b.ch, b.index + 1))
                .collect();
            let more = if bad.len() > 8 { ", …" } else { "" };
            let mut i = issue(
                Severity::Error,
                FastaIssueCode::InvalidCharacters,
                Some(idx),
                Some(&c.id),
                format!(
                    "Record \"{}\" has {} character(s) not valid for {}: {}{}.",
                    c.id,
                    bad.len(),
                    alphabet.as_str(),
                    shown.join(", "),
                    more
                ),
            );
            i.positions = Some(bad.iter().map(|b| b.index + 1).collect());
            issues.push(i);
        }
        match seen.get(&c.id) {
            Some(prior) => issues.push(issue(
                Severity::Warning,
                FastaIssueCode::DuplicateId,
                Some(idx),
                Some(&c.id),
                format!(
                    "Name \"{}\" is used by records {} and {}. Tree building needs unique names.",
                    c.id,
                    prior + 1,
                    idx + 1
                ),
            )),
            None => {
                seen.insert(c.id.clone(), idx);
            }
        }
        records.push(Sequence {
            id: c.id,
            description: c.description,
            alphabet,
            residues: c.residues,
        });
    }
    ParsedFasta { records, issues }
}

/// True if any issue is an error (the caller should refuse to run algorithms on this input).
pub fn has_errors(issues: &[FastaIssue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

/// Writes records as FASTA text with lines wrapped at `width` columns (the UI uses 60).
pub fn write_fasta(records: &[Sequence], width: usize) -> String {
    let width = width.max(1);
    let mut out: Vec<String> = Vec::new();
    for r in records {
        out.push(if r.description.is_empty() {
            format!(">{}", r.id)
        } else {
            format!(">{} {}", r.id, r.description)
        });
        let chars: Vec<char> = r.residues.chars().collect();
        for chunk in chars.chunks(width) {
            out.push(chunk.iter().collect());
        }
        if r.residues.is_empty() {
            out.push(String::new());
        }
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(p: &ParsedFasta) -> Vec<&'static str> {
        p.issues.iter().map(|i| i.code.as_str()).collect()
    }

    #[test]
    fn parses_a_simple_two_record_file() {
        let p = parse_fasta(
            ">s1 first sequence\nACGTACGTACGTACGTACGT\nACGT\n>s2\nACGTACGTACGTACGTACGTACGT\n",
            ParseOptions::default(),
        );
        assert_eq!(p.records.len(), 2);
        assert_eq!(p.records[0].id, "s1");
        assert_eq!(p.records[0].description, "first sequence");
        assert_eq!(p.records[0].residues, "ACGTACGTACGTACGTACGTACGT");
        assert_eq!(p.records[0].alphabet, Alphabet::Dna);
        assert!(!has_errors(&p.issues));
    }

    #[test]
    fn no_header_input_is_one_named_sequence() {
        let p = parse_fasta("ACGTACGTACGTACGTACGTAC\n", ParseOptions::default());
        assert_eq!(p.records.len(), 1);
        assert_eq!(p.records[0].id, "sequence1");
        assert!(codes(&p).contains(&"no-header"));
    }

    #[test]
    fn empty_input_is_an_error() {
        let p = parse_fasta("  \n\n", ParseOptions::default());
        assert!(p.records.is_empty());
        assert_eq!(codes(&p), vec!["no-records"]);
        assert!(has_errors(&p.issues));
    }

    #[test]
    fn reports_invalid_characters_with_positions() {
        let p = parse_fasta(
            ">s\nACGTACGTAC!TACGTACGTACGT\n",
            ParseOptions {
                alphabet: AlphabetChoice::Fixed(Alphabet::Dna),
                allow_gaps: false,
            },
        );
        let bad = p
            .issues
            .iter()
            .find(|i| i.code == FastaIssueCode::InvalidCharacters)
            .expect("an invalid-characters issue");
        assert_eq!(bad.positions, Some(vec![11]));
        assert!(bad.message.contains("! at 11"));
    }

    #[test]
    fn crlf_line_endings_and_digits_are_cleaned_and_reported() {
        let p = parse_fasta(">s\r\n1 ACGT ACGT\r\n21 ACGT ACGTACGT\r\n", ParseOptions::default());
        assert_eq!(p.records[0].residues, "ACGTACGTACGTACGTACGT");
        assert!(codes(&p).contains(&"digits-removed") && codes(&p).contains(&"whitespace-removed"));
    }

    #[test]
    fn duplicate_names_empty_records_and_comments_are_reported() {
        let p = parse_fasta(
            "; note\n>x\nACGTACGTACGTACGTACGTAC\n>x\n>y\nACGTACGTACGTACGTACGTAC\n",
            ParseOptions::default(),
        );
        let c = codes(&p);
        assert!(c.contains(&"comment-line") && c.contains(&"duplicate-id") && c.contains(&"empty-record"));
        assert_eq!(p.records.len(), 3);
    }

    #[test]
    fn dots_become_dashes_when_gaps_are_allowed() {
        let p = parse_fasta(
            ">a\nAC.GT\n>b\nACAGT\n",
            ParseOptions {
                alphabet: AlphabetChoice::Fixed(Alphabet::Dna),
                allow_gaps: true,
            },
        );
        assert_eq!(p.records[0].residues, "AC-GT");
        assert!(codes(&p).contains(&"gaps-normalized"));
    }

    #[test]
    fn write_fasta_wraps_at_the_width_and_round_trips() {
        let seq = "ACGT".repeat(40);
        let text = write_fasta(
            &[Sequence {
                id: "x".into(),
                description: "d".into(),
                alphabet: Alphabet::Dna,
                residues: seq.clone(),
            }],
            60,
        );
        assert_eq!(text.split('\n').nth(1).map(str::len), Some(60));
        let back = parse_fasta(&text, ParseOptions::default());
        assert_eq!(
            back.records,
            vec![Sequence {
                id: "x".into(),
                description: "d".into(),
                alphabet: Alphabet::Dna,
                residues: seq
            }]
        );
    }

    #[test]
    fn header_split_takes_the_first_word_as_the_id() {
        assert_eq!(
            split_header("sp|P1|NAME_HUMAN  some   words"),
            ("sp|P1|NAME_HUMAN".to_string(), "some   words".to_string())
        );
        assert_eq!(split_header("only"), ("only".to_string(), String::new()));
    }
}
