//! Tests ported from the TypeScript unit tests before those were removed (Checkpoint 6c): the hand-counted alignment statistics, the match
//! line, the re-scorer, the validator, the pinned Learn-view example, and the agreement with MAFFT on the bundled example sets.

use sequencescope_core::alignstats::{alignment_stats, match_line};
use sequencescope_core::fasta::{AlphabetChoice, ParseOptions, Sequence, parse_fasta};
use sequencescope_core::msa::{GuideMethod, brute_force_optimum_sp, progressive_align, sum_of_pairs_score};
use sequencescope_core::scoring::{CompiledScoring, compile_scoring};
use sequencescope_core::types::{AlignMode, Alphabet, GapModel, PairwiseAlignment, ScoringSpec, SubstitutionSpec};
use sequencescope_core::verify::{score_aligned_rows, validate_alignment};

fn simple(alphabet: Alphabet, m: i32, mm: i32, gaps: GapModel) -> CompiledScoring {
    compile_scoring(
        &ScoringSpec {
            substitution: SubstitutionSpec::Simple {
                match_score: m,
                mismatch_score: mm,
            },
            gaps,
        },
        alphabet,
    )
    .expect("valid scoring") // test code
}

fn blosum(gaps: GapModel) -> CompiledScoring {
    compile_scoring(
        &ScoringSpec {
            substitution: SubstitutionSpec::Matrix {
                name: "BLOSUM62".to_string(),
            },
            gaps,
        },
        Alphabet::Protein,
    )
    .expect("valid scoring") // test code
}

/// An alignment with the given rows (coordinates derived from the rows).
fn mk(row_a: &str, row_b: &str, score: i32, mode: AlignMode) -> PairwiseAlignment {
    PairwiseAlignment {
        mode,
        score,
        row_a: row_a.to_string(),
        row_b: row_b.to_string(),
        start_a: 0,
        end_a: row_a.replace('-', "").len(),
        start_b: 0,
        end_b: row_b.replace('-', "").len(),
    }
}

const AFF: GapModel = GapModel::Affine { open: 5, extend: 1 };

#[test]
fn stats_count_identities_mismatches_gap_columns_and_openings() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    // ACG--TTA over AGGCCT-A: identities A,G,T,A = 4; mismatch C/G = 1; gap columns 3 (a run of 2 in A, one in B)
    let s = alignment_stats(&mk("ACG--TTA", "AGGCCT-A", 0, AlignMode::Global), &sc).expect("stats");
    assert_eq!(
        (
            s.length,
            s.identities,
            s.mismatches,
            s.gap_columns,
            s.gap_opens,
            s.gaps_in_a,
            s.gaps_in_b,
            s.aligned_columns
        ),
        (8, 4, 1, 3, 2, 2, 1, 5)
    );
    assert_eq!(s.identity_pct, Some((4.0 / 8.0) * 100.0));
}

#[test]
fn an_empty_alignment_has_no_percentages_not_nan() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    let s = alignment_stats(&mk("", "", 0, AlignMode::Local), &sc).expect("stats");
    assert_eq!((s.length, s.identity_pct, s.similarity_pct), (0, None, None));
}

#[test]
fn similarity_counts_positive_scoring_non_identical_pairs_under_a_matrix() {
    let sc = blosum(GapModel::Linear { gap: 5 });
    let s = alignment_stats(&mk("ILK", "VLR", 0, AlignMode::Global), &sc).expect("stats"); // I/V = 3, L/L identity, K/R = 2
    assert_eq!((s.identities, s.positives), (1, 2));
    assert_eq!(s.similarity_pct, Some(100.0));
}

#[test]
fn adjacent_gaps_in_opposite_rows_count_as_two_openings() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    assert_eq!(
        alignment_stats(&mk("A-C", "AGC", 0, AlignMode::Global), &sc)
            .expect("stats")
            .gap_opens,
        1
    );
    assert_eq!(
        alignment_stats(&mk("A-CG", "AG-G", 0, AlignMode::Global), &sc)
            .expect("stats")
            .gap_opens,
        2
    );
}

#[test]
fn match_line_symbols() {
    let sc = blosum(GapModel::Linear { gap: 5 });
    // A/A identity, I/V positive, S/T positive, A/C = 0, A/W = -3, gap
    assert_eq!(
        match_line(&mk("AISAA-", "AVTCWA", 0, AlignMode::Global), &sc).expect("line"),
        "|::.  "
    );
}

#[test]
fn a_switch_between_the_two_gap_rows_pays_a_fresh_open() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    assert_eq!(score_aligned_rows("A-", "-C", &sc), Ok(-10));
    assert_eq!(score_aligned_rows("A--", "-CC", &sc), Ok(-5 - 5 - 1));
}

#[test]
fn the_re_scorer_rejects_unequal_rows_and_double_gap_columns() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    assert!(score_aligned_rows("AC", "A", &sc).is_err());
    assert!(
        score_aligned_rows("A-", "A-", &sc)
            .expect_err("double gap")
            .contains("two gaps")
    );
}

#[test]
fn the_validator_catches_broken_alignments() {
    let sc = simple(Alphabet::Dna, 2, -3, GapModel::Linear { gap: 4 });
    let good = mk("ACGT", "ACGT", 8, AlignMode::Global);
    assert!(validate_alignment(&good, "ACGT", "ACGT", &sc).is_empty());
    let wrong_score = PairwiseAlignment {
        score: 9,
        ..good.clone()
    };
    assert!(
        validate_alignment(&wrong_score, "ACGT", "ACGT", &sc)
            .join(" ")
            .contains("Re-scoring")
    );
    assert!(
        validate_alignment(&mk("ACGA", "ACGT", 5, AlignMode::Global), "ACGT", "ACGT", &sc)
            .join(" ")
            .contains("Row A")
    );
    assert!(
        validate_alignment(&mk("ACGT", "ACGA", 5, AlignMode::Global), "ACGT", "ACGT", &sc)
            .join(" ")
            .contains("Row B")
    );
    assert!(
        validate_alignment(&mk("ACG", "AC", 0, AlignMode::Global), "ACG", "AC", &sc)
            .join(" ")
            .contains("different lengths")
    );
    assert!(
        validate_alignment(&mk("A-C", "A-C", 0, AlignMode::Global), "AC", "AC", &sc)
            .join(" ")
            .contains("two gaps")
    );
    let incomplete = PairwiseAlignment {
        end_a: 3,
        row_a: "ACG".to_string(),
        row_b: "ACG".to_string(),
        ..good
    };
    assert!(
        validate_alignment(&incomplete, "ACGT", "ACGT", &sc)
            .join(" ")
            .contains("cover both")
    );
}

fn dna_seq(id: &str, residues: &str) -> Sequence {
    Sequence {
        id: id.to_string(),
        description: String::new(),
        alphabet: Alphabet::Dna,
        residues: residues.to_string(),
    }
}

#[test]
fn the_pinned_learn_view_example_is_worse_than_the_exhaustive_optimum() {
    let rows = ["ACTA", "GATC", "GCGTG"];
    let sc = simple(Alphabet::Dna, 2, -2, GapModel::Affine { open: 3, extend: 1 });
    let seqs: Vec<Sequence> = rows
        .iter()
        .enumerate()
        .map(|(k, r)| dna_seq(&format!("s{}", k + 1), r))
        .collect();
    let prog = progressive_align(&seqs, &sc, GuideMethod::Upgma, &mut |_| {}, &mut || false)
        .expect("valid")
        .expect("not cancelled"); // test code
    let owned: Vec<String> = rows.iter().map(ToString::to_string).collect();
    let (best_score, best_rows) = brute_force_optimum_sp(&owned, &sc).expect("small input"); // test code
    assert_eq!((prog.sum_of_pairs, best_score), (-14, -10));
    assert_eq!(sum_of_pairs_score(&best_rows, &sc).expect("rows"), -10); // test code
    assert_eq!(best_rows.iter().map(|r| r.replace('-', "")).collect::<Vec<_>>(), owned);
}

#[test]
fn the_exhaustive_search_refuses_large_inputs() {
    let sc = simple(Alphabet::Dna, 2, -3, AFF);
    for set in [vec!["AAAAAAA", "A"], vec!["A", "A", "A", "A", "A"]] {
        let owned: Vec<String> = set.iter().map(ToString::to_string).collect();
        assert!(
            brute_force_optimum_sp(&owned, &sc)
                .expect_err("too large")
                .message
                .contains("limited to")
        );
    }
}

/// Fraction of MAFFT's aligned residue pairs (over all sequence pairs) that our alignment also aligns.
fn agreement(ours: &[String], theirs: &[String]) -> f64 {
    let index = |rows: &[String]| -> Vec<Vec<i64>> {
        rows.iter()
            .map(|r| {
                let mut k = 0;
                r.chars()
                    .map(|c| {
                        if c == '-' {
                            -1
                        } else {
                            k += 1;
                            k - 1
                        }
                    })
                    .collect()
            })
            .collect()
    };
    let (a, b) = (index(ours), index(theirs));
    let (mut shared, mut total) = (0usize, 0usize);
    for i in 0..ours.len() {
        for j in (i + 1)..ours.len() {
            let pairs: std::collections::HashSet<(i64, i64)> = a[i]
                .iter()
                .zip(&a[j])
                .filter(|(x, y)| **x >= 0 && **y >= 0)
                .map(|(x, y)| (*x, *y))
                .collect();
            for (x, y) in b[i].iter().zip(&b[j]) {
                if *x >= 0 && *y >= 0 {
                    total += 1;
                    shared += usize::from(pairs.contains(&(*x, *y)));
                }
            }
        }
    }
    if total == 0 { 1.0 } else { shared as f64 / total as f64 }
}

#[test]
fn our_progressive_alignment_agrees_with_mafft_on_most_aligned_residue_pairs() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let sets: [(&str, Alphabet, CompiledScoring); 2] = [
        (
            "globin_alpha_vertebrates",
            Alphabet::Protein,
            blosum(GapModel::Affine { open: 11, extend: 1 }),
        ),
        (
            "mito_cytb_mammals",
            Alphabet::Dna,
            simple(Alphabet::Dna, 2, -3, GapModel::Affine { open: 5, extend: 2 }),
        ),
    ];
    for (name, alphabet, scoring) in sets {
        let read = |file: &str, gaps: bool| {
            let text = std::fs::read_to_string(root.join(format!("examples/{name}/{file}"))).expect("example file"); // test code
            parse_fasta(
                &text,
                ParseOptions {
                    alphabet: AlphabetChoice::Fixed(alphabet),
                    allow_gaps: gaps,
                },
            )
            .records
        };
        let (orig, maf) = (read("sequences.fasta", false), read("aligned.fasta", true));
        let ours = progressive_align(&orig, &scoring, GuideMethod::Upgma, &mut |_| {}, &mut || false)
            .expect("valid")
            .expect("not cancelled"); // test code
        let theirs: Vec<String> = orig
            .iter()
            .map(|o| maf.iter().find(|m| m.id == o.id).expect("same ids").residues.clone())
            .collect(); // test code
        let ag = agreement(&ours.rows, &theirs);
        println!(
            "{name}: {:.2} % of MAFFT's aligned residue pairs are also aligned by our progressive alignment",
            100.0 * ag
        );
        assert!(ag > 0.9, "{name}: {ag}");
    }
}

// ---- the measurements quoted in the Learn view (73 %, 19 %, 61 %) and the "never worse than padding" check ----

/// Random related sets: a base sequence with a few substitutions and indels per member (same recipe and generator as the TypeScript test).
fn related(seed: u32, n: usize, len: usize) -> Vec<String> {
    use sequencescope_core::rng::Rng;
    let mut rng = Rng::new(seed);
    let mut int = |bound: usize| rng.next_int(bound as u64).expect("positive bound") as usize; // test code
    let acgt: Vec<char> = "ACGT".chars().collect();
    let base: String = (0..len).map(|_| acgt[int(4)]).collect();
    (0..n)
        .map(|_| {
            let mut s: Vec<char> = base.chars().collect();
            for _ in 0..4 {
                let p = int(s.len());
                let t = int(3);
                if t == 0 {
                    s[p] = acgt[int(4)];
                } else if t == 1 {
                    let end = (p + 1 + int(3)).min(s.len());
                    s.drain(p..end);
                } else {
                    let ins: Vec<char> = acgt[..1 + int(3)].to_vec();
                    s.splice(p..p, ins);
                }
            }
            if s.is_empty() {
                "A".to_string()
            } else {
                s.into_iter().collect()
            }
        })
        .collect()
}

fn set(rows: &[String]) -> Vec<Sequence> {
    rows.iter()
        .enumerate()
        .map(|(k, r)| dna_seq(&format!("s{k}"), r))
        .collect()
}

fn sp(rows: &[String], sc: &CompiledScoring, guide: GuideMethod) -> i64 {
    progressive_align(&set(rows), sc, guide, &mut |_| {}, &mut || false)
        .expect("valid")
        .expect("not cancelled")
        .sum_of_pairs // test code
}

#[test]
fn progressive_is_never_worse_than_the_trivially_padded_alignment_on_200_related_sets() {
    let sc = simple(Alphabet::Dna, 2, -3, GapModel::Affine { open: 5, extend: 2 });
    for seed in 1..=200u32 {
        let rows = related(seed, 3 + (seed as usize % 4), 20 + (seed as usize % 15));
        let width = rows.iter().map(|r| r.chars().count()).max().expect("rows"); // test code
        let padded: Vec<String> = rows
            .iter()
            .map(|r| format!("{r}{}", "-".repeat(width - r.chars().count())))
            .collect();
        let guide = if seed % 2 == 0 {
            GuideMethod::Upgma
        } else {
            GuideMethod::Nj
        };
        assert!(
            sp(&rows, &sc, guide) >= sum_of_pairs_score(&padded, &sc).expect("rows"),
            "seed {seed}"
        ); // test code
    }
}

#[test]
fn shuffling_the_input_order_gives_comparable_scores_73_percent_identical() {
    use sequencescope_core::rng::Rng;
    let sc = simple(Alphabet::Dna, 2, -3, GapModel::Affine { open: 5, extend: 2 });
    let (mut equal, mut total, mut max_rel) = (0, 0, 0f64);
    for seed in 1..=150u32 {
        let rows = related(seed, 4 + (seed as usize % 3), 25);
        let mut rng = Rng::new(seed + 999);
        let mut perm: Vec<usize> = (0..rows.len()).collect();
        for i in (1..perm.len()).rev() {
            let j = rng.next_int(i as u64 + 1).expect("positive bound") as usize; // test code
            perm.swap(i, j);
        }
        let a = sp(&rows, &sc, GuideMethod::Upgma);
        let shuffled: Vec<Sequence> = perm.iter().map(|&p| dna_seq(&format!("s{p}"), &rows[p])).collect();
        let b = progressive_align(&shuffled, &sc, GuideMethod::Upgma, &mut |_| {}, &mut || false)
            .expect("valid")
            .expect("not cancelled")
            .sum_of_pairs; // test code
        total += 1;
        equal += usize::from(a == b);
        let pairs = (rows.len() * (rows.len() - 1)) as f64 / 2.0;
        max_rel = max_rel.max((a - b).abs() as f64 / (pairs * 2.0 * 25.0));
    }
    println!(
        "permutation: identical in {equal} of {total} ({:.1} %), largest difference {:.2} %",
        100.0 * equal as f64 / total as f64,
        100.0 * max_rel
    );
    assert_eq!(100 * equal / total, 73, "the Learn view quotes 73 %");
    assert!(
        (100.0 * max_rel).round() == 19.0,
        "the Learn view quotes about 19 %: {max_rel}"
    );
}

#[test]
fn two_sequences_are_order_independent() {
    let sc = simple(Alphabet::Dna, 2, -3, GapModel::Affine { open: 5, extend: 2 });
    for seed in 1..=100u32 {
        let r = related(seed, 2, 22);
        assert_eq!(
            sp(&r, &sc, GuideMethod::Upgma),
            sp(&[r[1].clone(), r[0].clone()], &sc, GuideMethod::Upgma),
            "seed {seed}"
        );
    }
}

#[test]
fn progressive_never_exceeds_the_optimum_and_reaches_it_in_61_percent_of_150_cases() {
    use sequencescope_core::rng::Rng;
    let sc = simple(Alphabet::Dna, 2, -2, GapModel::Affine { open: 3, extend: 1 });
    let mut rng = Rng::new(2026);
    let (mut reached, n) = (0, 150);
    for _ in 0..n {
        let rows: Vec<String> = (0..3)
            .map(|_| {
                let len = 2 + rng.next_int(3).expect("bound") as usize; // test code
                (0..len)
                    .map(|_| ['A', 'C', 'G'][rng.next_int(3).expect("bound") as usize])
                    .collect() // test code
            })
            .collect();
        let prog = sp(&rows, &sc, GuideMethod::Upgma);
        let (opt, _) = brute_force_optimum_sp(&rows, &sc).expect("small input"); // test code
        assert!(prog <= opt, "{rows:?}");
        reached += usize::from(prog == opt);
    }
    println!("progressive reached the optimum in {reached} of {n}");
    assert_eq!(100 * reached / n, 61, "the Learn view quotes 61 %");
}
