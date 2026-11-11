//! Cross-checks against EXTERNAL answers: the stored Biopython reference cases (tests/fixtures/reference/pairwise.json,
//! made by tools/gen_alignment_refs.py) and worked examples from public sources (tests/fixtures/worked-examples/textbook.json).
//! Port of tests/unit/crosscheck-textbook.test.ts: same comparisons, same conditions.

mod common;

use common::{alphabet_from_str, gaps_from_json, mode_from_str, read_json};
use sequencescope_core::pairwise::{align, align_all};
use sequencescope_core::scoring::compile_scoring;
use sequencescope_core::types::{GapModel, ScoringSpec, SubstitutionSpec};
use sequencescope_core::verify::{score_aligned_rows, validate_alignment};
use serde_json::Value;

/// Builds our scoring from a Biopython fixture case (their gap scores are negative; our penalties are positive).
fn reference_spec(c: &Value, use_linear: bool) -> ScoringSpec {
    let int = |key: &str| c[key].as_f64().unwrap_or_else(|| panic!("number field {key}")) as i32; // test code
    let gaps = if use_linear {
        GapModel::Linear { gap: -int("gap_open") }
    } else {
        GapModel::Affine {
            open: -int("gap_open"),
            extend: -int("gap_extend"),
        }
    };
    let substitution = if c["alphabet"] == "dna" {
        SubstitutionSpec::Simple {
            match_score: int("match"),
            mismatch_score: int("mismatch"),
        }
    } else {
        SubstitutionSpec::Matrix {
            name: c["matrix"].as_str().expect("matrix").to_string(),
        } // test code
    };
    ScoringSpec { substitution, gaps }
}

#[test]
fn biopython_reference_cases_match_exactly() {
    let reference = read_json("tests/fixtures/reference/pairwise.json");
    let cases = reference["cases"].as_array().expect("cases array"); // test code
    assert!(cases.len() >= 40, "fixture should hold at least 40 cases");
    let (mut compared_scores, mut compared_rows, mut compared_counts, mut compared_local_rows) = (0, 0, 0, 0);
    for c in cases {
        let id = c["id"].as_str().unwrap_or("?");
        let (a, b) = (c["a"].as_str().expect("a"), c["b"].as_str().expect("b")); // test code
        let alphabet = alphabet_from_str(c["alphabet"].as_str().expect("alphabet")); // test code
        let mode = mode_from_str(c["mode"].as_str().expect("mode")); // test code
        let score = c["score"].as_f64().expect("score") as i32; // test code
        let n_optimal = c["n_optimal"].as_u64().expect("n_optimal") as usize; // test code
        let n_capped = c["n_optimal_capped"].as_bool().expect("n_optimal_capped"); // test code
        let rows = (
            c["example_rows"][0].as_str().expect("row"),
            c["example_rows"][1].as_str().expect("row"),
        ); // test code
        let linear_equivalent = c["gap_open"] == c["gap_extend"];
        for use_linear in if linear_equivalent {
            vec![true, false]
        } else {
            vec![false]
        } {
            let sc = compile_scoring(&reference_spec(c, use_linear), alphabet).expect("valid scoring"); // test code
            let ours = align(a, b, mode, &sc).expect("align"); // test code
            assert_eq!(ours.score, score, "{id}: score differs from Biopython");
            compared_scores += 1;
            assert_eq!(
                validate_alignment(&ours, a, b, &sc),
                Vec::<String>::new(),
                "{id}: our alignment is invalid"
            );
            let all = align_all(a, b, mode, &sc, 1000).expect("align_all"); // test code
            if n_optimal == 1 && mode.as_str() == "global" {
                assert_eq!(
                    (ours.row_a.as_str(), ours.row_b.as_str()),
                    rows,
                    "{id}: unique optimum, rows must match Biopython"
                );
                compared_rows += 1;
            }
            if mode.as_str() == "global" && !n_capped && !all.capped {
                assert_eq!(
                    all.alignments.len(),
                    n_optimal,
                    "{id}: number of co-optimal global alignments"
                );
                compared_counts += 1;
            }
            if mode.as_str() == "local" && score > 0 && !all.capped && !n_capped && n_optimal == all.alignments.len() {
                // Biopython's local rows are the aligned region: one of our enumerated alignments must equal them.
                assert!(
                    all.alignments.iter().any(|x| x.row_a == rows.0 && x.row_b == rows.1),
                    "{id}: Biopython's local rows not among ours"
                );
                compared_local_rows += 1;
            }
        }
    }
    println!(
        "Biopython reference: {} cases; {compared_scores} score checks, {compared_rows} unique-optimum row checks, {compared_counts} co-optimal count checks, {compared_local_rows} local-row checks; 0 mismatches",
        cases.len()
    );
    assert!(compared_scores >= 40 && compared_rows > 0 && compared_counts > 0);
}

#[test]
fn worked_examples_from_public_sources() {
    let textbook = read_json("tests/fixtures/worked-examples/textbook.json");
    let examples = textbook["examples"].as_array().expect("examples"); // test code
    assert!(examples.len() >= 3);
    for ex in examples {
        let id = ex["id"].as_str().unwrap_or("?");
        let alphabet = alphabet_from_str(ex["alphabet"].as_str().expect("alphabet")); // test code
        let mode = mode_from_str(ex["mode"].as_str().expect("mode")); // test code
        let substitution = if alphabet.as_str() == "dna" {
            SubstitutionSpec::Simple {
                match_score: ex["match"].as_i64().unwrap_or(0) as i32,
                mismatch_score: ex["mismatch"].as_i64().unwrap_or(0) as i32,
            }
        } else {
            SubstitutionSpec::Matrix {
                name: ex["matrix"].as_str().expect("matrix").to_string(),
            } // test code
        };
        let sc = compile_scoring(
            &ScoringSpec {
                substitution,
                gaps: gaps_from_json(&ex["gaps"]),
            },
            alphabet,
        )
        .expect("valid scoring"); // test code
        let (a, b) = (ex["a"].as_str().expect("a"), ex["b"].as_str().expect("b")); // test code
        let expected = ex["expectedScore"].as_i64().expect("expectedScore") as i32; // test code
        assert_eq!(align(a, b, mode, &sc).expect("align").score, expected, "{id}"); // test code
        let all = align_all(a, b, mode, &sc, 1000).expect("align_all"); // test code
        let mut sources: Vec<&Value> = ex["sourceAlignments"]
            .as_array()
            .map(|v| v.iter().collect())
            .unwrap_or_default();
        if !ex["sourceAlignment"].is_null() {
            sources.push(&ex["sourceAlignment"]);
        }
        for pair in sources {
            let (ra, rb) = (pair[0].as_str().expect("row"), pair[1].as_str().expect("row")); // test code
            assert_eq!(
                score_aligned_rows(ra, rb, &sc),
                Ok(expected),
                "{id}: the source's alignment must re-score to the expected score"
            );
            assert!(
                all.alignments.iter().any(|x| x.row_a == ra && x.row_b == rb),
                "{id}: the source's alignment must be among the co-optimal ones"
            );
        }
    }
}
