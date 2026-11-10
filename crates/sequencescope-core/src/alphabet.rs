//! Alphabets (DNA / RNA / protein), IUPAC ambiguity codes, input cleaning, and alphabet detection.
//! Port of `src/bio/alphabet.ts`. JavaScript's notions of "whitespace" and "length" are reproduced on purpose
//! (see `is_js_whitespace` and `js_len`) so both implementations treat odd input the same way.

use crate::types::Alphabet;

pub const DNA_STANDARD: &str = "ACGT";
pub const RNA_STANDARD: &str = "ACGU";
/// IUPAC ambiguity codes shared by DNA and RNA.
pub const NUCLEOTIDE_AMBIGUITY: &str = "RYSWKMBDHVN";
pub const PROTEIN_STANDARD: &str = "ACDEFGHIKLMNPQRSTVWY";
/// B=D/N, Z=E/Q, X=any, J=I/L, U=selenocysteine, O=pyrrolysine, *=stop.
pub const PROTEIN_AMBIGUITY: &str = "BZXJUO*";

/// The unambiguous residues of an alphabet.
pub fn standard_letters(alphabet: Alphabet) -> &'static str {
    match alphabet {
        Alphabet::Dna => DNA_STANDARD,
        Alphabet::Rna => RNA_STANDARD,
        Alphabet::Protein => PROTEIN_STANDARD,
    }
}

/// Letters allowed in a given alphabet (standard residues followed by ambiguity codes).
pub fn allowed_letters(alphabet: Alphabet) -> String {
    let ambiguity = if alphabet == Alphabet::Protein {
        PROTEIN_AMBIGUITY
    } else {
        NUCLEOTIDE_AMBIGUITY
    };
    format!("{}{}", standard_letters(alphabet), ambiguity)
}

/// True if `ch` is one of the unambiguous residues of the alphabet.
pub fn is_standard_residue(ch: char, alphabet: Alphabet) -> bool {
    standard_letters(alphabet).contains(ch)
}

/// True for exactly the characters JavaScript's `\s` and `String.trim()` treat as whitespace
/// (Rust's `char::is_whitespace` differs: it includes U+0085 and excludes U+FEFF).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// JavaScript's `String.length`: the number of UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The result of cleaning pasted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanedText {
    /// Upper-case, with whitespace and digits removed.
    pub residues: String,
    pub removed_whitespace: usize,
    pub removed_digits: usize,
}

/// Removes whitespace and digits (line numbers) from pasted text and upper-cases it; counts what was removed.
pub fn clean_sequence_text(raw: &str) -> CleanedText {
    let mut removed_whitespace = 0;
    let mut removed_digits = 0;
    let mut residues = String::new();
    for ch in raw.chars() {
        if is_js_whitespace(ch) {
            removed_whitespace += 1;
        } else if ch.is_ascii_digit() {
            removed_digits += 1;
        } else {
            residues.extend(ch.to_uppercase());
        }
    }
    CleanedText {
        residues,
        removed_whitespace,
        removed_digits,
    }
}

/// A character that is not allowed in the alphabet, with its 0-based position (in UTF-16 units, like JavaScript).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidChar {
    pub index: usize,
    pub ch: char,
}

/// Lists characters not allowed in the alphabet (optionally allowing gap characters '-' and '.').
pub fn find_invalid(residues: &str, alphabet: Alphabet, allow_gaps: bool) -> Vec<InvalidChar> {
    let ok = allowed_letters(alphabet);
    let mut bad = Vec::new();
    for (index, unit) in residues.encode_utf16().enumerate() {
        let ch = char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}'); // a lone surrogate half has no char
        if unit < 128 && ok.contains(ch) {
            continue;
        }
        if allow_gaps && (ch == '-' || ch == '.') {
            continue;
        }
        bad.push(InvalidChar { index, ch });
    }
    bad
}

/// How sure the alphabet guess is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Low,
}

impl Confidence {
    /// "high" / "low".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Low => "low",
        }
    }
}

/// The guess made by `detect_alphabet`; `alphabet` is None when no supported alphabet fits ("unknown").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub alphabet: Option<Alphabet>,
    pub confidence: Confidence,
    pub reason: String,
}

/// Guesses the alphabet from residues. Rule: if >= 90% of letters are A/C/G/T/U/N it is nucleotide (RNA if U is
/// present and T is not), else protein if every letter is a protein letter, else unknown. Short sequences are flagged
/// low confidence because A, C, G, T are also amino acids.
pub fn detect_alphabet(residues: &str) -> Detection {
    let letters: String = residues.chars().filter(|&c| c != '-' && c != '.').collect();
    let total = js_len(&letters);
    if total == 0 {
        return Detection {
            alphabet: None,
            confidence: Confidence::Low,
            reason: "No residues to examine.".to_string(),
        };
    }
    let (mut nuc, mut has_t, mut has_u, mut protein_only) = (0usize, false, false, false);
    for ch in letters.chars() {
        if "ACGTUN".contains(ch) {
            nuc += 1;
        }
        has_t |= ch == 'T';
        has_u |= ch == 'U';
        protein_only |= "DEFHIKLMPQRSVWY".contains(ch);
    }
    if nuc as f64 / total as f64 >= 0.9 {
        let confidence = if total < 20 { Confidence::Low } else { Confidence::High };
        if has_u && !has_t {
            return Detection {
                alphabet: Some(Alphabet::Rna),
                confidence,
                reason: "Mostly A/C/G/U with U present.".to_string(),
            };
        }
        let reason = if has_u && has_t {
            "Mostly A/C/G/T/U but both T and U occur; treated as DNA."
        } else {
            "Mostly A/C/G/T."
        };
        return Detection {
            alphabet: Some(Alphabet::Dna),
            confidence,
            reason: reason.to_string(),
        };
    }
    if find_invalid(&letters, Alphabet::Protein, false).is_empty() {
        let confidence = if protein_only {
            Confidence::High
        } else {
            Confidence::Low
        };
        return Detection {
            alphabet: Some(Alphabet::Protein),
            confidence,
            reason: "Letters match the protein alphabet.".to_string(),
        };
    }
    Detection {
        alphabet: None,
        confidence: Confidence::Low,
        reason: "Contains characters that fit no supported alphabet.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/fasta-alphabet.test.ts ("alphabet helpers").
    #[test]
    fn clean_sequence_text_strips_whitespace_and_digits_uppercases_and_counts() {
        assert_eq!(
            clean_sequence_text(" ac gt\n12 N"),
            CleanedText {
                residues: "ACGTN".to_string(),
                removed_whitespace: 4,
                removed_digits: 2
            }
        );
    }

    #[test]
    fn detects_the_alphabets_like_the_typescript_tests() {
        let cases = [
            ("ACGTACGTACGTACGTACGTACGT", Some(Alphabet::Dna), Confidence::High),
            ("ACGUACGUACGUACGUACGUACGU", Some(Alphabet::Rna), Confidence::High),
            ("MVLSPADKTNVKAAWGKVGAHAGE", Some(Alphabet::Protein), Confidence::High),
            ("ACGT", Some(Alphabet::Dna), Confidence::Low), // short: also a valid protein string
            ("ACGTNNRYACGTACGTACGTAC", Some(Alphabet::Dna), Confidence::High), // ambiguity codes
            ("ACGTUACGTUACGTUACGTUACGT", Some(Alphabet::Dna), Confidence::High), // mixed T and U: DNA
        ];
        for (text, alphabet, confidence) in cases {
            let d = detect_alphabet(text);
            assert_eq!((d.alphabet, d.confidence), (alphabet, confidence), "{text}");
        }
    }

    #[test]
    fn unknown_for_junk_and_empty() {
        assert_eq!(detect_alphabet("@@@@").alphabet, None);
        assert_eq!(detect_alphabet("").alphabet, None);
        assert_eq!(
            detect_alphabet("---..").alphabet,
            None,
            "gap characters alone are no residues"
        );
    }

    #[test]
    fn find_invalid_lists_positions() {
        assert_eq!(
            find_invalid("ACXGT", Alphabet::Dna, false),
            vec![InvalidChar { index: 2, ch: 'X' }]
        );
        assert_eq!(find_invalid("AC-GT", Alphabet::Dna, false).len(), 1);
        assert_eq!(find_invalid("AC-GT", Alphabet::Dna, true).len(), 0);
        assert_eq!(find_invalid("AC.GT", Alphabet::Dna, true).len(), 0);
    }

    #[test]
    fn rna_rejects_t_and_dna_rejects_u() {
        assert_eq!(find_invalid("ACGT", Alphabet::Rna, false).len(), 1);
        assert_eq!(find_invalid("ACGU", Alphabet::Dna, false).len(), 1);
    }

    #[test]
    fn whitespace_matches_javascript_not_rust() {
        assert!(is_js_whitespace('\u{FEFF}'), "JavaScript trims the byte-order mark");
        assert!(
            !is_js_whitespace('\u{0085}'),
            "JavaScript does not treat NEL as whitespace"
        );
        assert!(is_js_whitespace('\u{00A0}') && is_js_whitespace('\u{3000}'));
        assert!(!is_js_whitespace('a') && !is_js_whitespace('5'));
    }

    #[test]
    fn js_length_counts_utf16_units() {
        assert_eq!(js_len("ACGT"), 4);
        assert_eq!(js_len("\u{1F9EC}"), 2);
    }

    #[test]
    fn allowed_letters_and_standard_residues() {
        assert_eq!(allowed_letters(Alphabet::Dna), "ACGTRYSWKMBDHVN");
        assert_eq!(allowed_letters(Alphabet::Protein), "ACDEFGHIKLMNPQRSTVWYBZXJUO*");
        assert!(is_standard_residue('A', Alphabet::Dna) && !is_standard_residue('N', Alphabet::Dna));
        assert!(is_standard_residue('U', Alphabet::Rna) && !is_standard_residue('T', Alphabet::Rna));
    }
}
