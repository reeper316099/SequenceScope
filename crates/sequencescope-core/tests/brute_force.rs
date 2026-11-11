//! THE most important test: the DP score equals the true maximum found by enumerating every alignment.
//! Port of tests/unit/pairwise-bruteforce.test.ts (fast-check -> proptest), including the exhaustive tiny-alphabet sweep.

mod common;

use common::{aff, brute_force, dna, lin, protein, seq_of};
use proptest::prelude::*;
use sequencescope_core::pairwise::{align, align_all, align_score_only};
use sequencescope_core::types::{AlignMode, GapModel};

/// The gap models the TypeScript test uses, including the odd ones (open cheaper than extend, all-zero, free gaps).
fn gap_models() -> Vec<(&'static str, GapModel)> {
    vec![
        ("linear 2", lin(2)),
        ("linear 0", lin(0)),
        ("linear 7", lin(7)),
        ("affine 5/1", aff(5, 1)),
        ("affine 3/3", aff(3, 3)),
        ("affine 1/4 (open cheaper than extend)", aff(1, 4)),
        ("affine 0/0", aff(0, 0)),
        ("affine 10/2", aff(10, 2)),
    ]
}

/// Runs one proptest property for one (mode, gap model) pair: DP score, align(), and score-only all equal the brute force.
fn dna_property(mode: AlignMode, gaps: GapModel, max_len: usize, cases: u32) {
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(cases));
    let strategy = (
        seq_of("ACGT", 0, max_len),
        seq_of("ACGT", 0, max_len),
        1..=5i32,
        -5..=3i32,
    );
    runner
        .run(&strategy, |(a, b, m, mm)| {
            let sc = dna(m, mm, gaps);
            let expected = brute_force(&a, &b, mode, &sc);
            prop_assert_eq!(align_all(&a, &b, mode, &sc, 5).expect("align_all").score, expected);
            prop_assert_eq!(align(&a, &b, mode, &sc).expect("align").score, expected);
            prop_assert_eq!(align_score_only(&a, &b, mode, &sc).expect("score only"), expected);
            Ok(())
        })
        .expect("property holds"); // test code: a failure here is the test failing
}

#[test]
fn dna_global_score_equals_the_maximum_over_all_alignments() {
    for (name, gaps) in gap_models() {
        println!("global {name}");
        dna_property(AlignMode::Global, gaps, 6, 150);
    }
}

#[test]
fn dna_local_score_equals_the_maximum_over_all_alignments() {
    for (name, gaps) in gap_models() {
        println!("local {name}");
        dna_property(AlignMode::Local, gaps, 5, 60);
    }
}

#[test]
fn binary_alphabet_many_ties() {
    for (mode, cases) in [(AlignMode::Global, 100), (AlignMode::Local, 40)] {
        let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(cases));
        runner
            .run(&(seq_of("AC", 0, 6), seq_of("AC", 0, 6)), |(a, b)| {
                for (_, gaps) in gap_models() {
                    let sc = dna(1, -1, gaps);
                    prop_assert_eq!(
                        align(&a, &b, mode, &sc).expect("align").score,
                        brute_force(&a, &b, mode, &sc)
                    );
                }
                Ok(())
            })
            .expect("property holds"); // test code
    }
}

#[test]
fn protein_blosum62_subset_alphabet() {
    for (mode, cases) in [(AlignMode::Global, 80), (AlignMode::Local, 30)] {
        let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(cases));
        runner
            .run(&(seq_of("ARNDW", 0, 5), seq_of("ARNDW", 0, 5)), |(a, b)| {
                for gaps in [lin(4), aff(11, 1), aff(6, 3)] {
                    let sc = protein("BLOSUM62", gaps);
                    prop_assert_eq!(
                        align(&a, &b, mode, &sc).expect("align").score,
                        brute_force(&a, &b, mode, &sc)
                    );
                }
                Ok(())
            })
            .expect("property holds"); // test code
    }
}

#[test]
fn every_pair_up_to_length_3_over_a_c_all_modes_and_gap_models() {
    let mut all = vec![String::new()];
    for len in 1..=3u32 {
        for k in 0..(1u32 << len) {
            all.push(
                (0..len)
                    .rev()
                    .map(|bit| if (k >> bit) & 1 == 0 { 'A' } else { 'C' })
                    .collect(),
            );
        }
    }
    assert_eq!(all.len(), 15);
    let mut checked = 0;
    for a in &all {
        for b in &all {
            for mode in [AlignMode::Global, AlignMode::Local] {
                for (_, gaps) in gap_models() {
                    let sc = dna(2, -1, gaps);
                    assert_eq!(
                        align(a, b, mode, &sc).expect("align").score,
                        brute_force(a, b, mode, &sc),
                        "{a} {b} {mode:?}"
                    ); // test code
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 15 * 15 * 2 * gap_models().len());
}
