//! Bootstrap support for ALIGNED input (ALGORITHMS.md section 10): resample alignment COLUMNS with replacement (same number
//! of columns), recompute distances with the same model and gap policy, rebuild the tree, and count how often each split
//! of the reference tree reappears. Support = count / replicates * 100. Port of `src/bio/bootstrap.ts`.
//!
//! A bootstrap value measures STABILITY under resampling, NOT the probability that a branch is true.
//!
//! Reproducibility: replicate r uses its own PRNG stream derived from (seed, r), so results do not depend on how replicates
//! are split across threads; `bootstrap_range` computes any slice and `merge_bootstrap` combines slices exactly. Rust uses
//! this to run replicates on several threads (`bootstrap_threads`) with results identical to the single-threaded run.

use crate::alphabet::js_len;
use crate::distance::{
    DistanceModel, GapPolicy, MAX_BOOTSTRAP_WORK, MAX_TREE_TAXA, assert_model, distance_matrix_from_codes,
    encode_aligned, unusable_pairs,
};
use crate::error::{BioError, BioErrorCode};
use crate::jsnum::{group_thousands, js_number_to_string, js_to_fixed};
use crate::nj::neighbor_joining;
use crate::rng::{Rng, derive_seed};
use crate::tree::{Tree, annotate_support, nontrivial_splits};
use crate::types::Alphabet;
use crate::upgma::upgma;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

pub const MAX_REPLICATES: u32 = 1000;
pub const MAX_COLUMNS: usize = 50_000;

/// Which tree builder to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeMethod {
    Upgma,
    Nj,
}

impl TreeMethod {
    /// "upgma" / "nj".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upgma => "upgma",
            Self::Nj => "nj",
        }
    }

    /// Parses the lower-case name.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "upgma" => Some(Self::Upgma),
            "nj" => Some(Self::Nj),
            _ => None,
        }
    }
}

/// Everything a bootstrap run needs.
#[derive(Debug, Clone)]
pub struct BootstrapInput {
    pub names: Vec<String>,
    /// Aligned, equal length.
    pub rows: Vec<String>,
    pub alphabet: Alphabet,
    pub model: DistanceModel,
    pub gap_policy: GapPolicy,
    pub method: TreeMethod,
    pub replicates: u32,
    pub seed: u32,
}

/// Split counts for a slice of replicates.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootstrapCounts {
    /// split key -> number of replicates (in this slice) containing it.
    pub counts: HashMap<String, u32>,
    /// Replicates in this slice whose distance matrix could not be turned into a tree.
    pub failed: u32,
    /// Replicates covered by this slice.
    pub done: u32,
}

/// Support for one split of the reference tree.
#[derive(Debug, Clone, PartialEq)]
pub struct BootstrapSplitSupport {
    pub leaves: Vec<String>,
    pub count: u32,
    pub percent: f64,
}

/// The finished bootstrap.
#[derive(Debug, Clone, PartialEq)]
pub struct BootstrapResult {
    /// With support values attached.
    pub reference_tree: Tree,
    /// One entry per non-trivial split of the reference tree.
    pub supports: Vec<BootstrapSplitSupport>,
    pub replicates: u32,
    pub seed: u32,
    pub failed_replicates: u32,
    pub method: TreeMethod,
    pub model: DistanceModel,
    pub gap_policy: GapPolicy,
}

/// Checks sizes and model before any work starts.
pub fn validate_bootstrap_input(inp: &BootstrapInput) -> Result<(), BioError> {
    assert_model(inp.model, inp.alphabet)?;
    if inp.names.len() < 3 {
        return Err(BioError::new(
            BioErrorCode::TooFewSequences,
            format!("Bootstrap needs at least 3 sequences (got {}).", inp.names.len()),
        ));
    }
    if inp.names.len() > MAX_TREE_TAXA {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!("At most {MAX_TREE_TAXA} sequences are supported."),
        ));
    }
    if inp.names.iter().collect::<HashSet<_>>().len() != inp.names.len() {
        return Err(BioError::new(
            BioErrorCode::DuplicateNames,
            "Sequence names must be unique.",
        ));
    }
    let len = inp.rows.first().map_or(0, |r| js_len(r));
    if len == 0 {
        return Err(BioError::new(BioErrorCode::NotAligned, "The alignment has no columns."));
    }
    for (k, r) in inp.rows.iter().enumerate() {
        if js_len(r) != len {
            let name = inp.names.get(k).map_or_else(|| k.to_string(), Clone::clone);
            return Err(BioError::new(
                BioErrorCode::NotAligned,
                format!(
                    "Sequence \"{name}\" has {} columns but the first has {len}. Bootstrap needs an alignment (all rows the same length) because it resamples columns.",
                    js_len(r)
                ),
            ));
        }
    }
    if len > MAX_COLUMNS {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "At most {} alignment columns are supported (got {}).",
                group_thousands(MAX_COLUMNS as u64),
                group_thousands(len as u64)
            ),
        ));
    }
    if inp.replicates < 1 || inp.replicates > MAX_REPLICATES {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Replicates must be a whole number from 1 to {MAX_REPLICATES}."),
        ));
    }
    let n = inp.names.len() as f64;
    let work = f64::from(inp.replicates) * ((n * (n - 1.0)) / 2.0) * len as f64;
    if work > MAX_BOOTSTRAP_WORK {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "This bootstrap needs about {} billion column comparisons; the limit is {} billion. Use fewer replicates or fewer sequences.",
                js_to_fixed(work / 1e9, 1),
                js_number_to_string(MAX_BOOTSTRAP_WORK / 1e9)
            ),
        ));
    }
    Ok(())
}

/// Builds the tree for a given matrix with the chosen method; None if the matrix has unusable pairs.
fn build(
    method: TreeMethod,
    names: &[String],
    codes: &[Vec<u8>],
    model: DistanceModel,
    policy: GapPolicy,
    weights: Option<&[i32]>,
) -> Result<Option<Tree>, BioError> {
    let m = distance_matrix_from_codes(names, codes, model, policy, weights);
    if !unusable_pairs(&m).is_empty() {
        return Ok(None);
    }
    Ok(Some(match method {
        TreeMethod::Nj => neighbor_joining(&m)?.tree,
        TreeMethod::Upgma => upgma(&m)?.tree,
    }))
}

/// The reference tree from the original (unresampled) alignment.
pub fn reference_tree(inp: &BootstrapInput) -> Result<Tree, BioError> {
    validate_bootstrap_input(inp)?;
    let codes: Vec<Vec<u8>> = inp.rows.iter().map(|r| encode_aligned(r, inp.alphabet)).collect();
    build(inp.method, &inp.names, &codes, inp.model, inp.gap_policy, None)?.ok_or_else(|| {
        BioError::new(
            BioErrorCode::SaturatedDistances,
            "The original alignment has pairs with no usable distance (saturated or no comparable sites), so no reference tree can be built. Try the p-distance or another gap policy.",
        )
    })
}

/// Column multiplicities for replicate r: how many times each column was drawn (sums to the number of columns).
pub fn replicate_weights(columns: usize, seed: u32, r: u32) -> Result<Vec<i32>, BioError> {
    let mut rng = Rng::new(derive_seed(seed, r));
    let mut w = vec![0i32; columns];
    for _ in 0..columns {
        let c = rng.next_int(columns as u64)? as usize;
        w[c] += 1;
    }
    Ok(w)
}

/// Computes replicates [from, to) and returns the split counts of that slice. Slices merge exactly (see `merge_bootstrap`).
/// `on_done(k)` is called after the k-th replicate of the slice; `should_cancel` is polled before each replicate.
pub fn bootstrap_range(
    inp: &BootstrapInput,
    from: u32,
    to: u32,
    on_done: &mut dyn FnMut(u32),
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<Option<BootstrapCounts>, BioError> {
    validate_bootstrap_input(inp)?;
    let codes: Vec<Vec<u8>> = inp.rows.iter().map(|r| encode_aligned(r, inp.alphabet)).collect();
    let columns = codes.first().map_or(0, Vec::len);
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut failed = 0;
    for r in from..to {
        if should_cancel() {
            return Ok(None);
        }
        let weights = replicate_weights(columns, inp.seed, r)?;
        match build(
            inp.method,
            &inp.names,
            &codes,
            inp.model,
            inp.gap_policy,
            Some(&weights),
        )? {
            None => failed += 1,
            Some(t) => {
                for key in nontrivial_splits(&t)?.splits.keys() {
                    *counts.entry(key.clone()).or_insert(0) += 1;
                }
            }
        }
        on_done(r - from + 1);
    }
    Ok(Some(BootstrapCounts {
        counts,
        failed,
        done: to.saturating_sub(from),
    }))
}

/// Adds slice results together (order does not matter).
pub fn merge_bootstrap(parts: &[BootstrapCounts]) -> BootstrapCounts {
    let mut merged = BootstrapCounts::default();
    for p in parts {
        merged.failed += p.failed;
        merged.done += p.done;
        for (k, v) in &p.counts {
            *merged.counts.entry(k.clone()).or_insert(0) += v;
        }
    }
    merged
}

/// Turns merged counts into the final result: support percentages on the reference tree's splits.
pub fn finish_bootstrap(inp: &BootstrapInput, counts: &BootstrapCounts) -> Result<BootstrapResult, BioError> {
    let reference = reference_tree(inp)?;
    let ref_splits = nontrivial_splits(&reference)?.splits;
    let mut percent_by_key: HashMap<String, f64> = HashMap::new();
    let mut supports = Vec::new();
    for (key, leaves) in ref_splits.iter() {
        let count = counts.counts.get(key).copied().unwrap_or(0);
        let percent = (f64::from(count) / f64::from(inp.replicates)) * 100.0; // failed replicates count as NOT containing the split
        percent_by_key.insert(key.clone(), percent);
        supports.push(BootstrapSplitSupport {
            leaves: leaves.clone(),
            count,
            percent,
        });
    }
    Ok(BootstrapResult {
        reference_tree: annotate_support(&reference, &percent_by_key),
        supports,
        replicates: inp.replicates,
        seed: inp.seed,
        failed_replicates: counts.failed,
        method: inp.method,
        model: inp.model,
        gap_policy: inp.gap_policy,
    })
}

/// Full bootstrap in one call on the calling thread. `on_progress` gets the completed fraction. `Ok(None)` if cancelled.
pub fn bootstrap(
    inp: &BootstrapInput,
    on_progress: &mut dyn FnMut(f64),
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<Option<BootstrapResult>, BioError> {
    validate_bootstrap_input(inp)?;
    let total = f64::from(inp.replicates);
    let part = bootstrap_range(
        inp,
        0,
        inp.replicates,
        &mut |d| on_progress(f64::from(d) / total),
        should_cancel,
    )?;
    part.map(|p| finish_bootstrap(inp, &p)).transpose()
}

/// Same result as `bootstrap`, bit for bit, but the replicates run on up to `threads` threads. The calling thread reports
/// progress about every 2 ms (so small jobs finish promptly; callers throttle what they forward); setting `cancel` stops all threads. `Ok(None)` if cancelled.
pub fn bootstrap_threads(
    inp: &BootstrapInput,
    threads: usize,
    on_progress: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> Result<Option<BootstrapResult>, BioError> {
    validate_bootstrap_input(inp)?;
    let parts = threads.clamp(1, inp.replicates as usize);
    let bounds: Vec<u32> = (0..=parts)
        .map(|k| ((k as f64 * f64::from(inp.replicates)) / parts as f64).round() as u32)
        .collect();
    let done = AtomicU32::new(0);
    let total = f64::from(inp.replicates);
    let results: Vec<Result<Option<BootstrapCounts>, BioError>> = std::thread::scope(|scope| {
        let handles: Vec<_> = bounds
            .windows(2)
            .map(|w| {
                let (from, to) = (w[0], w[1]);
                let done = &done;
                scope.spawn(move || {
                    bootstrap_range(
                        inp,
                        from,
                        to,
                        &mut |_| {
                            done.fetch_add(1, Ordering::Relaxed);
                        },
                        &mut || cancel.load(Ordering::Relaxed),
                    )
                })
            })
            .collect();
        while handles.iter().any(|h| !h.is_finished()) {
            on_progress(f64::from(done.load(Ordering::Relaxed)) / total);
            std::thread::sleep(Duration::from_millis(2));
        }
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    Err(BioError::new(
                        BioErrorCode::InvalidArgument,
                        "A bootstrap thread failed.",
                    ))
                })
            })
            .collect()
    });
    let mut counts = Vec::new();
    for r in results {
        match r? {
            Some(c) => counts.push(c),
            None => return Ok(None),
        }
    }
    on_progress(1.0);
    Ok(Some(finish_bootstrap(inp, &merge_bootstrap(&counts))?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fasta::{AlphabetChoice, ParseOptions, parse_fasta};
    use crate::tree::preorder;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn base(names: &[&str], rows: &[&str]) -> BootstrapInput {
        BootstrapInput {
            names: s(names),
            rows: s(rows),
            alphabet: Alphabet::Dna,
            model: DistanceModel::P,
            gap_policy: GapPolicy::PairwiseDeletion,
            method: TreeMethod::Nj,
            replicates: 100,
            seed: 42,
        }
    }
    fn run(inp: &BootstrapInput) -> BootstrapResult {
        bootstrap(inp, &mut |_| {}, &mut || false)
            .expect("valid")
            .expect("not cancelled") // test code
    }
    fn perfect() -> BootstrapInput {
        base(
            &["A", "B", "C", "D", "E"],
            &[
                &"A".repeat(40),
                &"A".repeat(40),
                &"C".repeat(40),
                &"C".repeat(40),
                &"G".repeat(40),
            ],
        )
    }
    /// 30 columns say (A,B)|(C,D) and 10 columns say (A,C)|(B,D) (hand-built conflict).
    fn conflict() -> BootstrapInput {
        let mut rows = [String::new(), String::new(), String::new(), String::new()];
        let mut add = |a: &str, b: &str, c: &str, d: &str, times: usize| {
            for _ in 0..times {
                rows[0] += a;
                rows[1] += b;
                rows[2] += c;
                rows[3] += d;
            }
        };
        add("A", "A", "C", "C", 18);
        add("A", "C", "A", "C", 12);
        add("G", "G", "T", "T", 6);
        add("G", "T", "G", "T", 4);
        BootstrapInput {
            names: s(&["A", "B", "C", "D"]),
            rows: rows.to_vec(),
            replicates: 200,
            seed: 7,
            ..base(&[], &[])
        }
    }

    // Ported from tests/unit/bootstrap.test.ts.
    #[test]
    fn weights_are_reproducible_distinct_per_stream_and_sum_to_the_column_count() {
        assert_eq!(
            replicate_weights(50, 9, 3).expect("ok"),
            replicate_weights(50, 9, 3).expect("ok")
        );
        assert_ne!(
            replicate_weights(50, 9, 3).expect("ok"),
            replicate_weights(50, 9, 4).expect("ok")
        );
        assert_ne!(
            replicate_weights(50, 9, 3).expect("ok"),
            replicate_weights(50, 10, 3).expect("ok")
        );
        assert_eq!(replicate_weights(77, 5, 0).expect("ok").iter().sum::<i32>(), 77);
        assert_eq!(
            replicate_weights(0, 1, 0).expect("ok"),
            Vec::<i32>::new(),
            "no columns: nothing to draw (the input validation rejects such alignments earlier)"
        );
    }

    #[test]
    fn same_seed_same_result_different_seed_different_result() {
        let a = run(&conflict());
        assert_eq!(a, run(&conflict()));
        assert_ne!(a.supports, run(&BootstrapInput { seed: 8, ..conflict() }).supports);
    }

    #[test]
    fn results_do_not_depend_on_how_replicates_are_split_or_on_threads() {
        let inp = conflict();
        let whole = bootstrap_range(&inp, 0, inp.replicates, &mut |_| {}, &mut || false)
            .expect("ok")
            .expect("not cancelled"); // test code
        for parts in [1u32, 2, 3, 7] {
            let bounds: Vec<u32> = (0..=parts)
                .map(|k| ((f64::from(k) * f64::from(inp.replicates)) / f64::from(parts)).round() as u32)
                .collect();
            let mut slices: Vec<BootstrapCounts> = bounds
                .windows(2)
                .map(|w| {
                    bootstrap_range(&inp, w[0], w[1], &mut |_| {}, &mut || false)
                        .expect("ok")
                        .expect("not cancelled")
                })
                .collect(); // test code
            for _ in 0..2 {
                let merged = merge_bootstrap(&slices);
                assert_eq!(merged.counts, whole.counts);
                assert_eq!(merged.done, inp.replicates);
                assert_eq!(
                    finish_bootstrap(&inp, &merged).expect("ok").supports,
                    finish_bootstrap(&inp, &whole).expect("ok").supports
                );
                slices.reverse();
            }
        }
        let single = run(&inp);
        for threads in [1usize, 2, 3, 8] {
            let multi = bootstrap_threads(&inp, threads, &mut |_| {}, &AtomicBool::new(false))
                .expect("ok")
                .expect("not cancelled"); // test code
            assert_eq!(multi, single, "{threads} threads must give the identical result");
        }
    }

    #[test]
    fn perfect_alignment_gives_100_percent_for_every_split_with_both_methods() {
        for method in [TreeMethod::Nj, TreeMethod::Upgma] {
            let r = run(&BootstrapInput {
                method,
                replicates: 60,
                ..perfect()
            });
            assert!(!r.supports.is_empty());
            assert!(r.supports.iter().all(|s| s.percent == 100.0));
            for (idx, n) in preorder(&r.reference_tree).iter().enumerate() {
                if idx > 0 && !n.is_leaf() {
                    assert_eq!(n.support, Some(100.0));
                }
            }
        }
    }

    #[test]
    fn conflicting_data_gives_support_strictly_between_55_and_100() {
        let r = run(&conflict());
        assert_eq!(r.supports.len(), 1);
        assert!(
            r.supports[0].percent > 55.0 && r.supports[0].percent < 100.0,
            "{}",
            r.supports[0].percent
        );
        assert_eq!(r.failed_replicates, 0);
        let r40 = run(&BootstrapInput {
            replicates: 40,
            ..conflict()
        });
        for sp in &r40.supports {
            assert!((sp.percent - (f64::from(sp.count) / 40.0) * 100.0).abs() < 1e-12 && sp.percent <= 100.0);
        }
    }

    #[test]
    fn records_replicates_seed_and_settings_in_the_result() {
        let r = run(&BootstrapInput {
            replicates: 20,
            seed: 123,
            ..conflict()
        });
        assert_eq!(
            (
                r.replicates,
                r.seed,
                r.method,
                r.model,
                r.gap_policy,
                r.failed_replicates
            ),
            (
                20,
                123,
                TreeMethod::Nj,
                DistanceModel::P,
                GapPolicy::PairwiseDeletion,
                0
            )
        );
    }

    #[test]
    fn real_data_alpha_globins_completes_and_is_reproducible() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/globin_alpha_vertebrates/aligned.fasta"
        ))
        .expect("example file"); // test code
        let parsed = parse_fasta(
            &text,
            ParseOptions {
                alphabet: AlphabetChoice::Fixed(Alphabet::Protein),
                allow_gaps: true,
            },
        );
        let inp = BootstrapInput {
            names: parsed.records.iter().map(|r| r.id.clone()).collect(),
            rows: parsed.records.iter().map(|r| r.residues.clone()).collect(),
            alphabet: Alphabet::Protein,
            model: DistanceModel::Poisson,
            gap_policy: GapPolicy::PairwiseDeletion,
            method: TreeMethod::Nj,
            replicates: 100,
            seed: 2026,
        };
        let (a, b) = (run(&inp), run(&inp));
        assert_eq!(a, b);
        assert_eq!(
            a.supports.len(),
            nontrivial_splits(&reference_tree(&inp).expect("ref"))
                .expect("splits")
                .splits
                .len()
        );
        assert!(a.supports.iter().all(|s| (0.0..=100.0).contains(&s.percent)));
    }

    #[test]
    fn failed_replicates_never_count_as_support() {
        // Jukes-Cantor saturates at p >= 0.75. Search seeded random 12-column alignments for one whose ORIGINAL matrix is usable
        // but whose resamples sometimes saturate.
        let mut found = None;
        for seed in 1..=300u32 {
            let mut rng = Rng::new(seed);
            let rows: Vec<String> = (0..4)
                .map(|_| {
                    (0..12)
                        .map(|_| {
                            "ACGT"
                                .chars()
                                .nth(rng.next_int(4).expect("bound") as usize)
                                .expect("letter")
                        })
                        .collect()
                })
                .collect(); // test code
            let cand = BootstrapInput {
                names: s(&["A", "B", "C", "D"]),
                rows,
                model: DistanceModel::Jc,
                replicates: 200,
                seed: 3,
                method: TreeMethod::Nj,
                ..base(&[], &[])
            };
            if reference_tree(&cand).is_err() {
                continue;
            }
            let r = run(&cand);
            if r.failed_replicates > 0 {
                found = Some(r);
                break;
            }
        }
        let r = found.expect("a failing-replicate example exists in the first 300 seeds"); // test code
        assert!(r.failed_replicates > 0);
        assert!(r.supports.iter().all(|sp| sp.count <= 200 - r.failed_replicates));
        let saturated = BootstrapInput {
            names: s(&["A", "B", "C", "D"]),
            rows: s(&["AAAAAAAAAAAA", "CCCCCCCCCCCC", "GGGGGGGGGGGG", "TTTTTTTTTTTT"]),
            model: DistanceModel::Jc,
            replicates: 10,
            ..base(&[], &[])
        };
        let e = bootstrap(&saturated, &mut |_| {}, &mut || false).expect_err("saturated reference"); // test code
        assert!(e.message.contains("no usable distance"));
    }

    #[test]
    fn cancellation_returns_none_and_progress_reaches_one() {
        let mut calls = 0;
        assert_eq!(
            bootstrap(&conflict(), &mut |_| {}, &mut || {
                calls += 1;
                calls > 3
            })
            .expect("ok"),
            None
        );
        let mut seen = Vec::new();
        bootstrap(
            &BootstrapInput {
                replicates: 10,
                ..conflict()
            },
            &mut |f| seen.push(f),
            &mut || false,
        )
        .expect("ok"); // test code
        assert_eq!(seen.last(), Some(&1.0));
        let cancel = AtomicBool::new(true);
        assert_eq!(
            bootstrap_threads(&conflict(), 4, &mut |_| {}, &cancel).expect("ok"),
            None
        );
    }

    #[test]
    fn validation_gives_typed_errors() {
        let code = |inp: &BootstrapInput| validate_bootstrap_input(inp).err().map(|e| e.code);
        let c = conflict;
        assert_eq!(
            code(&BootstrapInput {
                rows: s(&["ACGT", "ACG", "ACGT", "ACGT"]),
                ..c()
            }),
            Some(BioErrorCode::NotAligned)
        );
        assert!(
            validate_bootstrap_input(&BootstrapInput {
                rows: s(&["ACGT", "ACG", "ACGT", "ACGT"]),
                ..c()
            })
            .expect_err("bad")
            .message
            .contains("Bootstrap needs an alignment")
        );
        assert_eq!(
            code(&BootstrapInput {
                names: s(&["A", "B"]),
                rows: s(&["AC", "AC"]),
                ..c()
            }),
            Some(BioErrorCode::TooFewSequences)
        );
        assert_eq!(
            code(&BootstrapInput {
                names: s(&["A", "A", "B", "C"]),
                ..c()
            }),
            Some(BioErrorCode::DuplicateNames)
        );
        assert_eq!(
            code(&BootstrapInput { replicates: 0, ..c() }),
            Some(BioErrorCode::InvalidArgument)
        );
        assert_eq!(
            code(&BootstrapInput {
                replicates: 1001,
                ..c()
            }),
            Some(BioErrorCode::InvalidArgument)
        );
        assert_eq!(
            code(&BootstrapInput {
                alphabet: Alphabet::Protein,
                model: DistanceModel::Jc,
                ..c()
            }),
            Some(BioErrorCode::IncompatibleModel)
        );
        assert_eq!(
            code(&BootstrapInput {
                rows: s(&["", "", "", ""]),
                ..c()
            }),
            Some(BioErrorCode::NotAligned)
        );
        let wide = "A".repeat(60_000);
        assert_eq!(
            code(&BootstrapInput {
                rows: vec![wide.clone(), wide.clone(), wide.clone(), wide],
                ..c()
            }),
            Some(BioErrorCode::TooLarge)
        );
        let many = BootstrapInput {
            names: (0..101).map(|k| format!("s{k}")).collect(),
            rows: vec!["ACGT".to_string(); 101],
            ..c()
        };
        assert_eq!(code(&many), Some(BioErrorCode::TooLarge));
        assert_eq!(code(&conflict()), None);
    }
}
