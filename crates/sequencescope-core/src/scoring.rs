//! Turns a `ScoringSpec` into fast lookup tables for the DP, plus an independent char-level scorer.
//! Port of `src/bio/scoring.ts`.
//!
//! Ambiguity policy (ALGORITHMS.md section 4):
//!  * DNA/RNA with simple scores: A,C,G,T/U score match/mismatch; any other IUPAC code scores 0 against anything
//!    (including itself) and is never counted as an identity.
//!  * Protein with a matrix: letters in the matrix (incl. B, Z, X, *) use matrix values; J, U, O are treated as X.
//!  * Protein with simple scores: the 20 amino acids use match/mismatch; every other code scores 0.

use crate::alphabet::{allowed_letters, standard_letters};
use crate::error::{BioError, BioErrorCode};
use crate::matrices::{SubstitutionMatrix, get_matrix};
use crate::types::{Alphabet, GapModel, ScoringSpec, SubstitutionSpec};

/// |match| and |mismatch| limit (keeps the 32-bit DP safe).
pub const MAX_ABS_SCORE: i32 = 1000;
pub const MAX_GAP_PENALTY: i32 = 10_000;

/// Scoring tables ready for the DP loops.
#[derive(Debug, Clone)]
pub struct CompiledScoring {
    pub spec: ScoringSpec,
    pub alphabet: Alphabet,
    /// Number of residue classes (rows/columns of `table`).
    pub classes: usize,
    /// classes x classes substitution scores, row-major.
    pub table: Vec<i32>,
    /// ASCII code (0..127) -> class index, or -1 if the letter is not valid for this alphabet.
    pub class_of: [i8; 128],
    /// Positive penalties: the first gap column costs `gap_open`, each further column costs `gap_extend` (linear: equal).
    pub gap_open: i32,
    pub gap_extend: i32,
    pub affine: bool,
    matrix: Option<&'static SubstitutionMatrix>,
    standard: &'static str,
    simple: Option<(i32, i32)>,
}

/// Validates an integer range or returns an `invalid-scoring` error with the same wording as the TypeScript code.
fn check_int(name: &str, v: i32, min: i32, max: i32) -> Result<(), BioError> {
    if v < min || v > max {
        return Err(BioError::new(
            BioErrorCode::InvalidScoring,
            format!("{name} must be a whole number between {min} and {max}, got {v}."),
        ));
    }
    Ok(())
}

/// Maps the protein letters that BLOSUM lacks (J, U, O) to X, like the TypeScript code.
fn alias(ch: char) -> char {
    if "JUO".contains(ch) { 'X' } else { ch }
}

impl CompiledScoring {
    /// Independent char-level substitution score (does NOT use `table`); used by the re-scorer and the tests.
    /// Errors only for a protein letter the matrix does not contain.
    pub fn char_score(&self, a: char, b: char) -> Result<i32, BioError> {
        if let Some((m, mm)) = self.simple {
            return Ok(if !self.standard.contains(a) || !self.standard.contains(b) {
                0
            } else if a == b {
                m
            } else {
                mm
            });
        }
        let name = self.matrix.map_or("", |m| m.name);
        self.matrix
            .and_then(|m| m.get(alias(a), alias(b)))
            .ok_or_else(|| BioError::new(BioErrorCode::InvalidResidue, format!("No score for {a}/{b} in {name}.")))
    }

    /// True if the letter is an ambiguity code that never counts as an identity.
    pub fn is_ambiguous(&self, ch: char) -> bool {
        !self.standard.contains(ch)
    }
}

/// Builds the lookup tables. Errors: `invalid-scoring`, `unknown-matrix`, `alphabet-mismatch`.
pub fn compile_scoring(spec: &ScoringSpec, alphabet: Alphabet) -> Result<CompiledScoring, BioError> {
    let (gap_open, gap_extend, affine) = match spec.gaps {
        GapModel::Linear { gap } => (gap, gap, false),
        GapModel::Affine { open, extend } => (open, extend, true),
    };
    check_int("Gap penalty (open)", gap_open, 0, MAX_GAP_PENALTY)?;
    check_int("Gap penalty (extend)", gap_extend, 0, MAX_GAP_PENALTY)?;
    let nucleotide = alphabet != Alphabet::Protein;
    let standard = standard_letters(alphabet);
    let mut class_of = [-1i8; 128];

    let (letters, matrix, simple): (String, Option<&'static SubstitutionMatrix>, Option<(i32, i32)>) =
        match &spec.substitution {
            SubstitutionSpec::Simple {
                match_score,
                mismatch_score,
            } => {
                check_int("Match score", *match_score, -MAX_ABS_SCORE, MAX_ABS_SCORE)?;
                check_int("Mismatch score", *mismatch_score, -MAX_ABS_SCORE, MAX_ABS_SCORE)?;
                for (k, ch) in standard.chars().enumerate() {
                    class_of[ch as usize] = k as i8;
                }
                for ch in allowed_letters(alphabet).chars().filter(|c| !standard.contains(*c)) {
                    class_of[ch as usize] = standard.len() as i8; // the last class collects every ambiguity code
                }
                (format!("{standard}?"), None, Some((*match_score, *mismatch_score)))
            }
            SubstitutionSpec::Matrix { name } => {
                if nucleotide {
                    return Err(BioError::new(
                        BioErrorCode::AlphabetMismatch,
                        "Substitution matrices are for protein; use match/mismatch scores for DNA or RNA.",
                    ));
                }
                let m = get_matrix(name)?;
                for ch in allowed_letters(Alphabet::Protein).chars() {
                    if let Some(k) = m.letters.find(alias(ch)) {
                        class_of[ch as usize] = k as i8;
                    }
                }
                (m.letters.clone(), Some(m), None)
            }
        };

    let k = letters.chars().count();
    let mut scoring = CompiledScoring {
        spec: spec.clone(),
        alphabet,
        classes: k,
        table: vec![0; k * k],
        class_of,
        gap_open,
        gap_extend,
        affine,
        matrix,
        standard,
        simple,
    };
    // The table is filled with the same char-level scorer the tests use, so the two paths cannot drift apart silently
    // (the class letter '?' is in no alphabet, so it scores 0 under simple scoring).
    let class_letters: Vec<char> = letters.chars().collect();
    for (i, &x) in class_letters.iter().enumerate() {
        for (j, &y) in class_letters.iter().enumerate() {
            scoring.table[i * k + j] = scoring.char_score(x, y)?;
        }
    }
    Ok(scoring)
}

/// Encodes residues into class indices; the error carries the 1-based position of the first bad letter.
pub fn encode_residues(residues: &str, scoring: &CompiledScoring) -> Result<Vec<u8>, BioError> {
    let mut out = Vec::with_capacity(residues.len());
    let mut position = 0usize; // 1-based, counted in UTF-16 units like JavaScript
    for ch in residues.chars() {
        position += ch.len_utf16();
        let class = if (ch as u32) < 128 {
            scoring.class_of[ch as usize]
        } else {
            -1
        };
        if class < 0 {
            return Err(BioError::new(
                BioErrorCode::InvalidResidue,
                format!(
                    "Letter \"{}\" at position {} is not valid for {}.",
                    ch,
                    position - ch.len_utf16() + 1,
                    scoring.alphabet.as_str()
                ),
            ));
        }
        out.push(class as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple(m: i32, mm: i32, gaps: GapModel) -> ScoringSpec {
        ScoringSpec {
            substitution: SubstitutionSpec::Simple {
                match_score: m,
                mismatch_score: mm,
            },
            gaps,
        }
    }
    fn matrix(name: &str, gaps: GapModel) -> ScoringSpec {
        ScoringSpec {
            substitution: SubstitutionSpec::Matrix { name: name.to_string() },
            gaps,
        }
    }
    const LIN: GapModel = GapModel::Linear { gap: 1 };

    #[test]
    fn dna_simple_scores_and_ambiguity_policy() {
        let sc = compile_scoring(&simple(2, -3, LIN), Alphabet::Dna).expect("valid"); // test code
        assert_eq!(sc.char_score('A', 'A'), Ok(2));
        assert_eq!(sc.char_score('A', 'C'), Ok(-3));
        assert_eq!(
            sc.char_score('N', 'N'),
            Ok(0),
            "ambiguity codes score 0, even against themselves"
        );
        assert_eq!(sc.char_score('A', 'N'), Ok(0));
        assert!(sc.is_ambiguous('N') && !sc.is_ambiguous('A'));
        assert_eq!(sc.classes, 5);
    }

    #[test]
    fn protein_matrix_values_and_j_u_o_map_to_x() {
        let sc = compile_scoring(&matrix("BLOSUM62", LIN), Alphabet::Protein).expect("valid"); // test code
        assert_eq!(sc.char_score('B', 'D'), Ok(4));
        assert_eq!(sc.char_score('J', 'A'), sc.char_score('X', 'A'));
        assert_eq!(sc.char_score('U', 'O'), sc.char_score('X', 'X'));
        assert_eq!(sc.classes, 24);
    }

    #[test]
    fn the_table_agrees_with_the_independent_scorer_for_every_letter_pair() {
        for (alphabet, spec) in [
            (Alphabet::Dna, simple(3, -2, LIN)),
            (Alphabet::Protein, matrix("BLOSUM80", LIN)),
            (Alphabet::Protein, simple(1, -1, LIN)),
        ] {
            let sc = compile_scoring(&spec, alphabet).expect("valid"); // test code
            let letters = allowed_letters(alphabet);
            for x in letters.chars() {
                for y in letters.chars() {
                    let (cx, cy) = (sc.class_of[x as usize] as usize, sc.class_of[y as usize] as usize);
                    assert_eq!(
                        Ok(sc.table[cx * sc.classes + cy]),
                        sc.char_score(x, y),
                        "{x}{y} {alphabet:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn invalid_scoring_is_rejected_with_typed_errors() {
        let code = |spec: ScoringSpec, a: Alphabet| compile_scoring(&spec, a).expect_err("should fail").code; // test code
        assert_eq!(
            code(simple(1, -1, GapModel::Linear { gap: -1 }), Alphabet::Dna),
            BioErrorCode::InvalidScoring
        );
        assert_eq!(
            code(
                simple(
                    1,
                    -1,
                    GapModel::Affine {
                        open: 5,
                        extend: 10_001
                    }
                ),
                Alphabet::Dna
            ),
            BioErrorCode::InvalidScoring
        );
        assert_eq!(code(simple(1001, -1, LIN), Alphabet::Dna), BioErrorCode::InvalidScoring);
        assert_eq!(code(simple(1, -1001, LIN), Alphabet::Dna), BioErrorCode::InvalidScoring);
        assert_eq!(
            code(matrix("BLOSUM62", LIN), Alphabet::Dna),
            BioErrorCode::AlphabetMismatch
        );
        assert_eq!(
            code(matrix("PAM250", LIN), Alphabet::Protein),
            BioErrorCode::UnknownMatrix
        );
    }

    #[test]
    fn error_message_wording_matches_typescript() {
        let e = compile_scoring(&simple(1, -1, GapModel::Linear { gap: -1 }), Alphabet::Dna).expect_err("should fail"); // test code
        assert_eq!(
            e.message,
            "Gap penalty (open) must be a whole number between 0 and 10000, got -1."
        );
    }

    #[test]
    fn encode_reports_the_position_of_the_first_bad_letter() {
        let sc = compile_scoring(&simple(1, -1, LIN), Alphabet::Dna).expect("valid"); // test code
        assert_eq!(encode_residues("ACGT", &sc), Ok(vec![0, 1, 2, 3]));
        let e = encode_residues("AC#T", &sc).expect_err("bad letter"); // test code
        assert_eq!(e.code, BioErrorCode::InvalidResidue);
        assert!(e.message.contains("position 3"), "{}", e.message);
        assert!(encode_residues("ACU", &sc).is_err(), "DNA rejects U");
        let rna = compile_scoring(&simple(1, -1, LIN), Alphabet::Rna).expect("valid"); // test code
        assert!(encode_residues("ACGU", &rna).is_ok() && encode_residues("ACGT", &rna).is_err());
        assert!(encode_residues("é", &sc).is_err(), "non-ASCII letters are never valid");
    }

    #[test]
    fn rna_uses_u() {
        let sc = compile_scoring(&simple(1, -1, LIN), Alphabet::Rna).expect("valid"); // test code
        assert_eq!(sc.char_score('U', 'U'), Ok(1));
        assert_eq!(
            sc.char_score('T', 'T'),
            Ok(0),
            "T is not an RNA residue, so it is treated as ambiguous"
        );
    }
}
