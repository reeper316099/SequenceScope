//! The independent alignment re-scorer and validity checker. It deliberately does NOT use the DP tables: it walks the
//! two gapped rows column by column with the char-level scorer, so it can catch bugs in the DP. Port of
//! `scoreAlignedRows` and `validateAlignment` from `src/bio/alignstats.ts` (the statistics half stays for later).

use crate::scoring::CompiledScoring;
use crate::types::{AlignMode, PairwiseAlignment};

/// Scores two gapped rows: substitution per aligned pair; a gap run of length k costs open + (k-1)*extend.
pub fn score_aligned_rows(row_a: &str, row_b: &str, sc: &CompiledScoring) -> Result<i32, String> {
    let (a, b): (Vec<char>, Vec<char>) = (row_a.chars().collect(), row_b.chars().collect());
    if a.len() != b.len() {
        return Err("Alignment rows must have equal length.".to_string());
    }
    let mut total = 0i32;
    let (mut in_gap_a, mut in_gap_b) = (false, false); // inside a run of gaps in row A / row B
    for (&x, &y) in a.iter().zip(&b) {
        if x == '-' && y == '-' {
            return Err("A column of two gaps is not a valid alignment column.".to_string());
        }
        if x == '-' {
            total -= if in_gap_a { sc.gap_extend } else { sc.gap_open }; // continuing a run pays extend; a new run pays open
            (in_gap_a, in_gap_b) = (true, false);
        } else if y == '-' {
            total -= if in_gap_b { sc.gap_extend } else { sc.gap_open };
            (in_gap_b, in_gap_a) = (true, false);
        } else {
            total += sc.char_score(x, y).map_err(|e| e.message)?;
            (in_gap_a, in_gap_b) = (false, false);
        }
    }
    Ok(total)
}

/// Checks an alignment against the original sequences: gap-free rows equal the aligned substrings, the coordinates
/// make sense, and the score re-computes. Returns the list of problems (empty = valid).
pub fn validate_alignment(aln: &PairwiseAlignment, a: &str, b: &str, sc: &CompiledScoring) -> Vec<String> {
    let mut problems = Vec::new();
    let slice = |s: &str, from: usize, to: usize| -> Option<String> { s.get(from..to).map(str::to_string) };
    if aln.row_a.chars().count() != aln.row_b.chars().count() {
        problems.push("Rows have different lengths.".to_string());
    }
    let strip = |s: &str| s.replace('-', "");
    if Some(strip(&aln.row_a)) != slice(a, aln.start_a, aln.end_a) {
        problems.push("Row A without gaps is not the stated substring of sequence A.".to_string());
    }
    if Some(strip(&aln.row_b)) != slice(b, aln.start_b, aln.end_b) {
        problems.push("Row B without gaps is not the stated substring of sequence B.".to_string());
    }
    if aln.mode == AlignMode::Global
        && (aln.start_a != 0 || aln.end_a != a.len() || aln.start_b != 0 || aln.end_b != b.len())
    {
        problems.push("A global alignment must cover both sequences completely.".to_string());
    }
    if aln.row_a.chars().count() == aln.row_b.chars().count() {
        match score_aligned_rows(&aln.row_a, &aln.row_b, sc) {
            Ok(rescored) if rescored != aln.score => problems.push(format!(
                "Re-scoring gives {rescored}, but the reported score is {}.",
                aln.score
            )),
            Ok(_) => {}
            Err(message) => problems.push(message),
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoring::compile_scoring;
    use crate::types::{Alphabet, GapModel, ScoringSpec, SubstitutionSpec};

    fn dna_affine(m: i32, mm: i32, open: i32, ext: i32) -> CompiledScoring {
        let spec = ScoringSpec {
            substitution: SubstitutionSpec::Simple {
                match_score: m,
                mismatch_score: mm,
            },
            gaps: GapModel::Affine { open, extend: ext },
        };
        compile_scoring(&spec, Alphabet::Dna).expect("valid") // test code
    }

    #[test]
    fn hand_computed_value() {
        let sc = dna_affine(2, -3, 5, 1);
        // A C - - T over A G T T T : match(2) + mismatch(-3) + gap run of 2 (5+1) + match(2) = -5
        assert_eq!(score_aligned_rows("AC--T", "AGTTT", &sc), Ok(2 - 3 - 6 + 2));
    }

    #[test]
    fn a_switch_between_the_two_gap_rows_starts_a_new_run() {
        let sc = dna_affine(2, -3, 5, 1);
        assert_eq!(score_aligned_rows("A-", "-C", &sc), Ok(-10));
    }

    #[test]
    fn rejects_unequal_rows_and_double_gap_columns() {
        let sc = dna_affine(2, -3, 5, 1);
        assert!(score_aligned_rows("AC", "A", &sc).is_err());
        assert!(score_aligned_rows("A-", "A-", &sc).is_err());
    }

    #[test]
    fn validate_flags_a_wrong_score_and_wrong_rows() {
        let sc = dna_affine(2, -3, 5, 1);
        let good = PairwiseAlignment {
            mode: AlignMode::Global,
            score: 4,
            row_a: "AC".into(),
            row_b: "AC".into(),
            start_a: 0,
            end_a: 2,
            start_b: 0,
            end_b: 2,
        };
        assert!(validate_alignment(&good, "AC", "AC", &sc).is_empty());
        let bad_score = PairwiseAlignment {
            score: 5,
            ..good.clone()
        };
        assert_eq!(validate_alignment(&bad_score, "AC", "AC", &sc).len(), 1);
        let bad_rows = PairwiseAlignment {
            row_a: "AG".into(),
            ..good
        };
        assert!(!validate_alignment(&bad_rows, "AC", "AC", &sc).is_empty());
    }
}
