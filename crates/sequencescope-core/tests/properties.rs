//! proptest properties for the pairwise aligner (ALGORITHMS.md sections 1-5). Port of
//! tests/property/pairwise.property.test.ts, with the same strategies, scorings and run counts (200 cases each).

mod common;

use common::{aff, dna, lin, protein, seq_of};
use proptest::prelude::*;
use sequencescope_core::matrices::{STANDARD_AMINO_ACIDS, get_matrix, satisfies_self_alignment_condition};
use sequencescope_core::pairwise::{align, align_all, align_score_only, fill_matrix, traceback_first};
use sequencescope_core::types::{AlignMode, GapModel};
use sequencescope_core::verify::{score_aligned_rows, validate_alignment};

const DNA: &str = "ACGT";
const PROT: &str = "ACDEFGHIKLMNPQRSTVWY";

fn mode_strategy() -> impl Strategy<Value = AlignMode> {
    prop_oneof![Just(AlignMode::Global), Just(AlignMode::Local)]
}

/// Linear (0..=8) or affine (open 0..=12, extend 0..=6) gap models, like the TypeScript `gapArb`.
fn gap_strategy() -> impl Strategy<Value = GapModel> {
    prop_oneof![
        (0..=8i32).prop_map(lin),
        (0..=12i32, 0..=6i32).prop_map(|(o, e)| aff(o, e))
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // Re-scoring the returned alignment gives exactly the reported score; gap-free rows return the input.
    #[test]
    fn rescoring_gives_the_reported_score_dna(a in seq_of(DNA, 0, 40), b in seq_of(DNA, 0, 40), mode in mode_strategy(), g in gap_strategy()) {
        let sc = dna(2, -3, g);
        let r = align(&a, &b, mode, &sc).expect("align");
        prop_assert_eq!(validate_alignment(&r, &a, &b, &sc), Vec::<String>::new());
    }

    #[test]
    fn rescoring_gives_the_reported_score_protein(a in seq_of(PROT, 0, 30), b in seq_of(PROT, 0, 30), mode in mode_strategy(), g in gap_strategy()) {
        let sc = protein("BLOSUM62", g);
        let r = align(&a, &b, mode, &sc).expect("align");
        prop_assert_eq!(validate_alignment(&r, &a, &b, &sc), Vec::<String>::new());
    }

    // Swapping the two sequences gives the same score (symmetric scoring).
    #[test]
    fn swapping_the_sequences_keeps_the_score(a in seq_of(DNA, 0, 35), b in seq_of(DNA, 0, 35), mode in mode_strategy(), g in gap_strategy()) {
        let sc = dna(3, -2, g);
        prop_assert_eq!(align(&a, &b, mode, &sc).expect("align").score, align(&b, &a, mode, &sc).expect("align").score);
    }

    // Local score >= global score and local score >= 0.
    #[test]
    fn local_is_at_least_global_and_at_least_zero(a in seq_of(DNA, 0, 35), b in seq_of(DNA, 0, 35), g in gap_strategy()) {
        let sc = dna(2, -2, g);
        let local = align(&a, &b, AlignMode::Local, &sc).expect("align").score;
        prop_assert!(local >= 0);
        prop_assert!(local >= align(&a, &b, AlignMode::Global, &sc).expect("align").score);
    }

    // Self-alignment (DNA): global score is the sum of diagonal scores, and the rows are identical with no gaps
    // (which is what "identity 100%" means for standard residues).
    #[test]
    fn self_alignment_dna(a in seq_of(DNA, 1, 40), g in gap_strategy()) {
        let sc = dna(2, -3, g);
        let r = align(&a, &a, AlignMode::Global, &sc).expect("align");
        prop_assert_eq!(r.score, 2 * a.len() as i32);
        prop_assert_eq!(&r.row_a, &a);
        prop_assert_eq!(&r.row_b, &a);
    }

    // Affine with open = extend equals linear (score).
    #[test]
    fn affine_with_open_equal_extend_is_linear(a in seq_of(DNA, 0, 35), b in seq_of(DNA, 0, 35), mode in mode_strategy(), g in 0..=9i32) {
        prop_assert_eq!(
            align(&a, &b, mode, &dna(2, -1, aff(g, g))).expect("align").score,
            align(&a, &b, mode, &dna(2, -1, lin(g))).expect("align").score
        );
    }

    // Making gaps costlier never improves the score.
    #[test]
    fn costlier_gaps_never_help(a in seq_of(DNA, 0, 30), b in seq_of(DNA, 0, 30), mode in mode_strategy(), o in 0..=8i32, e in 0..=5i32, d_open in 0..=5i32, d_ext in 0..=5i32) {
        let base = align(&a, &b, mode, &dna(2, -2, aff(o, e))).expect("align").score;
        prop_assert!(align(&a, &b, mode, &dna(2, -2, aff(o + d_open, e + d_ext))).expect("align").score <= base);
    }

    // Deterministic: same inputs give identical output, including tie-breaking.
    #[test]
    fn deterministic_including_ties(a in seq_of("AC", 0, 25), b in seq_of("AC", 0, 25), mode in mode_strategy(), g in gap_strategy()) {
        let sc = dna(1, -1, g);
        prop_assert_eq!(align(&a, &b, mode, &sc).expect("align"), align(&a, &b, mode, &sc).expect("align"));
        prop_assert_eq!(align_all(&a, &b, mode, &sc, 50).expect("all"), align_all(&a, &b, mode, &sc, 50).expect("all"));
    }

    // Score-only (two-row) mode equals the full fill, and the matrix traceback equals align().
    #[test]
    fn score_only_equals_full_fill_and_traceback_equals_align(a in seq_of(DNA, 0, 40), b in seq_of(DNA, 0, 40), mode in mode_strategy(), g in gap_strategy()) {
        let sc = dna(2, -3, g);
        let dp = fill_matrix(&a, &b, mode, &sc).expect("fill");
        prop_assert_eq!(align_score_only(&a, &b, mode, &sc).expect("score only"), dp.score);
        prop_assert_eq!(traceback_first(&dp), align(&a, &b, mode, &sc).expect("align"));
    }

    // Every enumerated co-optimal alignment is valid, distinct, optimal, and the first equals align().
    #[test]
    fn enumerated_alignments_are_valid_distinct_and_optimal(a in seq_of("AC", 0, 9), b in seq_of("AC", 0, 9), mode in mode_strategy(), g in gap_strategy()) {
        let sc = dna(1, -1, g);
        let all = align_all(&a, &b, mode, &sc, 200).expect("all");
        prop_assert_eq!(&all.alignments[0], &align(&a, &b, mode, &sc).expect("align"));
        let mut seen = std::collections::HashSet::new();
        for x in &all.alignments {
            prop_assert_eq!(x.score, all.score);
            prop_assert_eq!(validate_alignment(x, &a, &b, &sc), Vec::<String>::new());
            seen.insert((x.row_a.clone(), x.row_b.clone(), x.start_a, x.start_b));
        }
        prop_assert_eq!(seen.len(), all.alignments.len());
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(80))]

    // Self-alignment with the BLOSUM matrices: score is the sum of diagonal scores, rows identical.
    #[test]
    fn self_alignment_protein(a in seq_of(PROT, 1, 40), g in gap_strategy(), which in 0..3usize) {
        let name = ["BLOSUM45", "BLOSUM62", "BLOSUM80"][which];
        let sc = protein(name, g);
        let diag: i32 = a.chars().map(|c| sc.char_score(c, c).expect("scorable")).sum();
        let r = align(&a, &a, AlignMode::Global, &sc).expect("align");
        prop_assert_eq!(r.score, diag);
        prop_assert_eq!(&r.row_a, &r.row_b);
    }
}

#[test]
fn blosum_matrices_satisfy_the_self_alignment_precondition() {
    for name in ["BLOSUM45", "BLOSUM62", "BLOSUM80"] {
        assert!(
            satisfies_self_alignment_condition(get_matrix(name).expect("bundled"), STANDARD_AMINO_ACIDS),
            "{name}"
        ); // test code
    }
}

#[test]
fn score_aligned_rows_matches_a_hand_computed_value() {
    let sc = dna(2, -3, aff(5, 1));
    // A C - - T over A G T T T : match(2) + mismatch(-3) + gap run of 2 (5+1) + match(2)
    assert_eq!(score_aligned_rows("AC--T", "AGTTT", &sc), Ok(2 - 3 - 6 + 2));
}
