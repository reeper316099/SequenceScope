//! Multiple-alignment operations behind `bio_op`: per-column conservation (and its CSV), the sum-of-pairs score of an
//! alignment, and the exhaustive optimum for tiny sets (the Learn view). Results are shaped like the TypeScript objects.

use crate::dto::{ScoringDto, parse_alphabet};
use crate::jobs::JobError;
use sequencescope_core::conservation::{ColumnStat, conservation, conservation_csv};
use sequencescope_core::msa::{brute_force_optimum_sp, sum_of_pairs_score};
use sequencescope_core::scoring::compile_scoring;
use serde_json::{Value, json};

/// Most rows and most total characters a request may carry.
const MAX_ROWS: usize = 1000;
const MAX_CHARS: usize = 50 * 1024 * 1024;

/// Refuses oversized alignments.
fn check_rows(rows: &[String]) -> Result<(), JobError> {
    let chars: usize = rows.iter().map(String::len).sum();
    if rows.len() > MAX_ROWS || chars > MAX_CHARS {
        return Err(JobError::new(
            "too-large",
            format!(
                "At most {MAX_ROWS} rows and {} MB of residues are supported.",
                MAX_CHARS / 1_048_576
            ),
        ));
    }
    Ok(())
}

/// One column's statistics as JSON (`counts` is an object, like the TypeScript record).
fn stat_json(c: &ColumnStat) -> Value {
    let counts: serde_json::Map<String, Value> = c.counts.iter().map(|(ch, n)| (ch.to_string(), json!(n))).collect();
    json!({
        "gaps": c.gaps, "residues": c.residues, "counts": counts, "top": c.top.map_or(String::new(), |t| t.to_string()),
        "identity": c.identity, "entropy": c.entropy, "conservation": c.conservation, "consensus": c.consensus.to_string(),
    })
}

/// Statistics for every column of an alignment.
pub fn conservation_op(rows: &[String], alphabet: &str, threshold: f64) -> Result<Value, JobError> {
    check_rows(rows)?;
    if !threshold.is_finite() {
        return Err(JobError::new(
            "invalid-argument",
            "The consensus threshold must be a number.",
        ));
    }
    let c = conservation(rows, parse_alphabet(alphabet)?, threshold)?;
    Ok(json!({
        "columns": c.columns.iter().map(stat_json).collect::<Vec<_>>(), "consensus": c.consensus,
        "meanIdentity": c.mean_identity, "fullyConserved": c.fully_conserved,
    }))
}

/// Conservation as CSV text.
pub fn conservation_csv_op(rows: &[String], alphabet: &str) -> Result<Value, JobError> {
    check_rows(rows)?;
    Ok(json!(conservation_csv(rows, parse_alphabet(alphabet)?)?))
}

/// Sum of pairs of an alignment.
pub fn sum_of_pairs_op(rows: &[String], alphabet: &str, scoring: &ScoringDto) -> Result<Value, JobError> {
    check_rows(rows)?;
    let sc = compile_scoring(&scoring.to_core()?, parse_alphabet(alphabet)?)?;
    Ok(json!(sum_of_pairs_score(rows, &sc)?))
}

/// The exhaustive sum-of-pairs optimum (at most 4 sequences of at most 6 residues).
pub fn brute_force_op(seqs: &[String], alphabet: &str, scoring: &ScoringDto) -> Result<Value, JobError> {
    check_rows(seqs)?;
    let sc = compile_scoring(&scoring.to_core()?, parse_alphabet(alphabet)?)?;
    let (score, rows) = brute_force_optimum_sp(seqs, &sc)?;
    Ok(json!({ "score": score, "rows": rows }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::parse_request;

    fn dna_scoring() -> ScoringDto {
        parse_request(json!({ "substitution": { "kind": "simple", "match": 2, "mismatch": -2 }, "gaps": { "kind": "affine", "open": 3, "extend": 1 } })).expect("valid") // test code
    }

    #[test]
    fn conservation_has_the_typescript_shape() {
        let rows: Vec<String> = ["ACGT", "ACGA", "A-GT"].iter().map(|s| s.to_string()).collect();
        let v = conservation_op(&rows, "dna", 0.5).expect("runs"); // test code
        assert_eq!(v["consensus"], "ACGT");
        assert_eq!(v["fullyConserved"], 2);
        assert_eq!(v["columns"][0]["counts"]["A"], 3);
        assert_eq!(v["columns"][1]["top"], "C");
        assert!(
            conservation_csv_op(&rows, "dna")
                .expect("csv")
                .as_str()
                .is_some_and(|s| s.starts_with("column,consensus,"))
        );
        let ragged = vec!["AC".to_string(), "A".to_string()];
        assert_eq!(
            conservation_op(&ragged, "dna", 0.5).expect_err("ragged").code,
            "not-aligned"
        );
    }

    #[test]
    fn sum_of_pairs_and_the_exhaustive_optimum_agree() {
        let seqs: Vec<String> = ["ACGT", "AGT", "ACT"].iter().map(|s| s.to_string()).collect();
        let best = brute_force_op(&seqs, "dna", &dna_scoring()).expect("small"); // test code
        let rows: Vec<String> = serde_json::from_value(best["rows"].clone()).expect("rows"); // test code
        assert_eq!(
            sum_of_pairs_op(&rows, "dna", &dna_scoring()).expect("score"),
            best["score"]
        );
        let too_many: Vec<String> = vec!["A".to_string(); 5];
        assert_eq!(
            brute_force_op(&too_many, "dna", &dna_scoring())
                .expect_err("limit")
                .code,
            "too-large"
        );
    }
}
