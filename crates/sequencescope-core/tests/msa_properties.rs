//! Independent checks of the progressive aligner that do not use the TypeScript at all (ALGORITHMS.md section 11):
//!  * the profile-profile DP finds the BEST merge: an exhaustive search over every way to interleave the two sets of
//!    columns (with the gap-run costs counted from first principles) gives the same optimum;
//!  * the reported merge score is the score of the alignment it returns;
//!  * "once a gap, always a gap": removing the inserted all-gap columns gives back each input profile;
//!  * the final alignment keeps every sequence, has no all-gap column, and its sum-of-pairs equals the independent scorer;
//!  * for two sequences it equals the optimal pairwise global score from `pairwise.rs`;
//!  * a progressive alignment never beats the exhaustive sum-of-pairs optimum.

mod common;

use common::{aff, dna, lin, protein};
use proptest::prelude::*;
use sequencescope_core::fasta::Sequence;
use sequencescope_core::msa::{
    GuideMethod, brute_force_optimum_sp, merge_profiles, progressive_align, sum_of_pairs_score,
};
use sequencescope_core::pairwise::align;
use sequencescope_core::scoring::CompiledScoring;
use sequencescope_core::tree::leaf_names;
use sequencescope_core::types::{AlignMode, Alphabet, GapModel};

const DNA: &str = "ACGT";
const PROT: &str = "ACDEFGHIKLMNPQRSTVWY";

/// A gap model: linear (1..=6) or affine (open 1..=10, extend 0..=4).
fn gap_strategy() -> impl Strategy<Value = GapModel> {
    prop_oneof![
        (1..=6i32).prop_map(lin),
        (1..=10i32, 0..=4i32).prop_map(|(o, e)| aff(o, e))
    ]
}

/// A profile of `rows` x `cols` where every column has at least one residue (no all-gap column).
fn profile(letters: &'static str, rows: usize, cols: usize) -> impl Strategy<Value = Vec<String>> {
    let chars: Vec<char> = letters.chars().collect();
    let cell = prop_oneof![3 => prop::sample::select(chars).prop_map(Some), 1 => Just(None)];
    prop::collection::vec(prop::collection::vec(cell, rows), cols).prop_map(move |columns| {
        let mut out = vec![String::new(); rows];
        for col in columns {
            let anchor = col.iter().position(Option::is_some).unwrap_or(0);
            for (r, cell) in col.iter().enumerate() {
                out[r].push(match cell {
                    Some(ch) => *ch,
                    None if r == anchor => 'A', // keep at least one residue in the column ('A' exists in both alphabets)
                    None => '-',
                });
            }
        }
        out
    })
}

/// Mean substitution score of column `i` of A against column `j` of B, from `char_score` (not the class table).
fn column_score(a: &[Vec<char>], b: &[Vec<char>], i: usize, j: usize, sc: &CompiledScoring) -> f64 {
    let mut total = 0.0;
    for ra in a {
        for rb in b {
            if ra[i] != '-' && rb[j] != '-' {
                total += f64::from(sc.char_score(ra[i], rb[j]).expect("scorable"));
            }
        }
    }
    total / (a.len() * b.len()) as f64
}

/// The best score over EVERY alignment of the two column sequences. A maximal run of k gap columns of one kind costs
/// open + (k-1) * extend; a switch from one gap kind to the other starts a new run.
fn exhaustive_merge_optimum(a: &[Vec<char>], b: &[Vec<char>], sc: &CompiledScoring) -> f64 {
    // last: 0 = start or a substitution column, 1 = gap in B (A column alone), 2 = gap in A (B column alone)
    fn go(a: &[Vec<char>], b: &[Vec<char>], sc: &CompiledScoring, i: usize, j: usize, last: u8) -> f64 {
        if i == a[0].len() && j == b[0].len() {
            return 0.0;
        }
        let (open, ext) = (f64::from(sc.gap_open), f64::from(sc.gap_extend));
        let mut best = f64::NEG_INFINITY;
        if i < a[0].len() && j < b[0].len() {
            best = best.max(column_score(a, b, i, j, sc) + go(a, b, sc, i + 1, j + 1, 0));
        }
        if i < a[0].len() {
            best = best.max(-(if last == 1 { ext } else { open }) + go(a, b, sc, i + 1, j, 1));
        }
        if j < b[0].len() {
            best = best.max(-(if last == 2 { ext } else { open }) + go(a, b, sc, i, j + 1, 2));
        }
        best
    }
    go(a, b, sc, 0, 0, 0)
}

/// The score of a merged alignment, recomputed from the output rows: columns that hold residues from both profiles are
/// substitution columns; columns where one side is all gaps are gap columns.
fn rescore_merged(rows: &[String], n_a: usize, sc: &CompiledScoring, a: &[Vec<char>], b: &[Vec<char>]) -> f64 {
    let chars: Vec<Vec<char>> = rows.iter().map(|r| r.chars().collect()).collect();
    let (mut ia, mut ib, mut total, mut last) = (0usize, 0usize, 0.0f64, 0u8);
    let (open, ext) = (f64::from(sc.gap_open), f64::from(sc.gap_extend));
    for c in 0..chars[0].len() {
        let a_has = chars[..n_a].iter().any(|r| r[c] != '-');
        let b_has = chars[n_a..].iter().any(|r| r[c] != '-');
        // Profiles here have no all-gap columns, so a side with no residues means that side has a gap column.
        match (a_has, b_has) {
            (true, true) => {
                total += column_score(a, b, ia, ib, sc);
                ia += 1;
                ib += 1;
                last = 0;
            }
            (true, false) => {
                total -= if last == 1 { ext } else { open };
                ia += 1;
                last = 1;
            }
            (false, true) => {
                total -= if last == 2 { ext } else { open };
                ib += 1;
                last = 2;
            }
            (false, false) => panic!("all-gap column in the merged alignment"),
        }
    }
    total
}

fn to_chars(rows: &[String]) -> Vec<Vec<char>> {
    rows.iter().map(|r| r.chars().collect()).collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // The DP's merge score is the exhaustive optimum, and the rows it returns achieve that score.
    #[test]
    fn profile_merge_is_optimal_and_self_consistent_dna(
        a in (1usize..=3, 1usize..=5).prop_flat_map(|(r, c)| profile(DNA, r, c)),
        b in (1usize..=3, 1usize..=5).prop_flat_map(|(r, c)| profile(DNA, r, c)),
        g in gap_strategy(), m in 1..=4i32, mm in -4..=0i32,
    ) {
        let sc = dna(m, mm, g);
        let (ca, cb) = (to_chars(&a), to_chars(&b));
        let merged = merge_profiles(&a, &b, &sc).expect("merge");
        let best = exhaustive_merge_optimum(&ca, &cb, &sc);
        prop_assert!((merged.score - best).abs() < 1e-9, "DP {} vs exhaustive {}", merged.score, best);
        prop_assert!((rescore_merged(&merged.rows, a.len(), &sc, &ca, &cb) - merged.score).abs() < 1e-9);
    }

    #[test]
    fn profile_merge_is_optimal_and_self_consistent_protein(
        a in (1usize..=3, 1usize..=4).prop_flat_map(|(r, c)| profile(PROT, r, c)),
        b in (1usize..=3, 1usize..=4).prop_flat_map(|(r, c)| profile(PROT, r, c)),
        g in gap_strategy(),
    ) {
        let sc = protein("BLOSUM62", g);
        let (ca, cb) = (to_chars(&a), to_chars(&b));
        let merged = merge_profiles(&a, &b, &sc).expect("merge");
        prop_assert!((merged.score - exhaustive_merge_optimum(&ca, &cb, &sc)).abs() < 1e-9);
        prop_assert!((rescore_merged(&merged.rows, a.len(), &sc, &ca, &cb) - merged.score).abs() < 1e-9);
    }

    // Once a gap, always a gap: dropping the columns that are all gaps in A's rows (resp. B's) gives A (resp. B) back.
    #[test]
    fn merging_only_inserts_gap_columns(
        a in (1usize..=4, 1usize..=12).prop_flat_map(|(r, c)| profile(DNA, r, c)),
        b in (1usize..=4, 1usize..=12).prop_flat_map(|(r, c)| profile(DNA, r, c)),
        g in gap_strategy(),
    ) {
        let sc = dna(2, -1, g);
        let merged = merge_profiles(&a, &b, &sc).expect("merge");
        let keep = |rows: &[String], original: &[String]| {
            let ch = to_chars(rows);
            let kept: Vec<usize> = (0..ch[0].len()).filter(|&c| ch.iter().any(|r| r[c] != '-')).collect();
            let back: Vec<String> = ch.iter().map(|r| kept.iter().map(|&c| r[c]).collect()).collect();
            back == original
        };
        prop_assert!(keep(&merged.rows[..a.len()], &a));
        prop_assert!(keep(&merged.rows[a.len()..], &b));
        prop_assert_eq!(merged.rows.len(), a.len() + b.len());
    }
}

/// Builds sequences s1..sn.
fn seqs(rows: &[String], alphabet: Alphabet) -> Vec<Sequence> {
    rows.iter()
        .enumerate()
        .map(|(k, r)| Sequence {
            id: format!("s{}", k + 1),
            description: String::new(),
            alphabet,
            residues: r.clone(),
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // Structure of a progressive alignment (both guide-tree methods).
    #[test]
    fn progressive_alignment_keeps_every_sequence_and_scores_consistently(
        input in prop::collection::vec(prop::collection::vec(prop::sample::select(DNA.chars().collect::<Vec<_>>()), 1..=14), 1..=6),
        g in gap_strategy(), nj in any::<bool>(),
    ) {
        let rows: Vec<String> = input.iter().map(|v| v.iter().collect()).collect();
        let sc = dna(2, -1, g);
        let guide = if nj { GuideMethod::Nj } else { GuideMethod::Upgma };
        let r = progressive_align(&seqs(&rows, Alphabet::Dna), &sc, guide, &mut |_| {}, &mut || false)
            .expect("valid").expect("not cancelled");
        let width = r.rows[0].chars().count();
        prop_assert!(r.rows.iter().all(|x| x.chars().count() == width));
        for (row, original) in r.rows.iter().zip(&rows) {
            prop_assert_eq!(&row.replace('-', ""), original);
        }
        let longest = rows.iter().map(|x| x.len()).max().unwrap_or(0);
        prop_assert!(width >= longest && width <= rows.iter().map(|x| x.len()).sum::<usize>());
        let ch = to_chars(&r.rows);
        prop_assert!((0..width).all(|c| ch.iter().any(|x| x[c] != '-')), "an all-gap column");
        prop_assert_eq!(r.steps.len(), rows.len() - 1);
        prop_assert_eq!(r.sum_of_pairs, sum_of_pairs_score(&r.rows, &sc).expect("score"));
        let mut leaves = leaf_names(&r.guide_tree);
        leaves.sort();
        let mut want: Vec<String> = r.ids.clone();
        want.sort();
        prop_assert_eq!(leaves, want);
        // the last merge contains every sequence
        if let Some(last) = r.steps.last() {
            prop_assert_eq!(last.ids.len(), rows.len());
        }
    }

    // With two sequences the profile DP is the ordinary pairwise global alignment.
    #[test]
    fn two_sequences_equal_the_pairwise_global_optimum(
        a in prop::collection::vec(prop::sample::select(PROT.chars().collect::<Vec<_>>()), 1..=25),
        b in prop::collection::vec(prop::sample::select(PROT.chars().collect::<Vec<_>>()), 1..=25),
        g in gap_strategy(),
    ) {
        let (a, b): (String, String) = (a.into_iter().collect(), b.into_iter().collect());
        let sc = protein("BLOSUM62", g);
        let pairwise = align(&a, &b, AlignMode::Global, &sc).expect("align");
        let msa = progressive_align(&seqs(&[a, b], Alphabet::Protein), &sc, GuideMethod::Upgma, &mut |_| {}, &mut || false)
            .expect("valid").expect("not cancelled");
        prop_assert_eq!(msa.sum_of_pairs, i64::from(pairwise.score));
        prop_assert_eq!(msa.steps[0].score, f64::from(pairwise.score));
    }

    // The heuristic never beats the true optimum.
    #[test]
    fn progressive_never_beats_the_exhaustive_optimum(
        input in prop::collection::vec(prop::collection::vec(prop::sample::select(vec!['A', 'C', 'G']), 1..=4), 3..=3),
        g in gap_strategy(),
    ) {
        let rows: Vec<String> = input.iter().map(|v| v.iter().collect()).collect();
        let sc = dna(2, -1, g);
        let (best, best_rows) = brute_force_optimum_sp(&rows, &sc).expect("small");
        prop_assert_eq!(best, sum_of_pairs_score(&best_rows, &sc).expect("score"));
        for guide in [GuideMethod::Upgma, GuideMethod::Nj] {
            let r = progressive_align(&seqs(&rows, Alphabet::Dna), &sc, guide, &mut |_| {}, &mut || false)
                .expect("valid").expect("not cancelled");
            prop_assert!(r.sum_of_pairs <= best, "progressive {} beat exhaustive {}", r.sum_of_pairs, best);
        }
    }
}
