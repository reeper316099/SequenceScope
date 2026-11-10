//! Shuffle-based significance check (ALGORITHMS.md section 12): shuffle sequence B (composition preserved), re-score,
//! and compare the real score with the shuffled scores. All randomness comes from the seeded PRNG. Port of
//! `src/bio/shuffle.ts`; results (every shuffled score, mean, sd, z, p-value) are identical to the TypeScript ones.

use crate::error::{BioError, BioErrorCode};
use crate::pairwise::align_score_only;
use crate::rng::Rng;
use crate::scoring::CompiledScoring;
use crate::types::AlignMode;

/// The most shuffles one test may run.
pub const MAX_SHUFFLES: u32 = 5000;

/// Fisher-Yates shuffle of a string's characters using the seeded generator (unbiased via `Rng::next_int`).
pub fn shuffle_residues(rng: &mut Rng, s: &str) -> Result<String, BioError> {
    let mut chars: Vec<char> = s.chars().collect();
    for i in (1..chars.len()).rev() {
        let j = rng.next_int(i as u64 + 1)? as usize;
        chars.swap(i, j);
    }
    Ok(chars.into_iter().collect())
}

/// What the caller wants run, plus two hooks: progress (called after each shuffle) and cancellation (polled between shuffles).
pub struct ShuffleOptions<'a> {
    pub a: &'a str,
    pub b: &'a str,
    pub mode: AlignMode,
    pub scoring: &'a CompiledScoring,
    pub shuffles: u32,
    pub seed: u32,
}

/// The finished test.
#[derive(Debug, Clone, PartialEq)]
pub struct ShuffleSummary {
    pub seed: u32,
    pub shuffles: u32,
    pub real_score: i32,
    pub scores: Vec<i32>,
    pub mean: f64,
    /// Sample standard deviation (n-1); 0 if all equal.
    pub sd: f64,
    /// None when sd is 0 (undefined, never NaN/Infinity).
    pub z: Option<f64>,
    /// Number of shuffled scores >= the real score.
    pub at_least_as_good: u32,
    /// (1 + at_least_as_good) / (shuffles + 1): never exactly 0.
    pub p_value: f64,
}

/// Finished or stopped early.
#[derive(Debug, Clone, PartialEq)]
pub enum ShuffleOutcome {
    Done(ShuffleSummary),
    Cancelled { completed: u32, seed: u32 },
}

/// Runs the shuffle test; deterministic for a given seed. `on_progress` gets the completed fraction after each shuffle;
/// `should_cancel` is polled before each shuffle and returns true to stop early.
pub fn run_shuffle_test(
    opts: &ShuffleOptions<'_>,
    on_progress: &mut dyn FnMut(f64),
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<ShuffleOutcome, BioError> {
    if opts.shuffles < 1 || opts.shuffles > MAX_SHUFFLES {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Number of shuffles must be a whole number from 1 to {MAX_SHUFFLES}."),
        ));
    }
    let mut rng = Rng::new(opts.seed);
    let real_score = align_score_only(opts.a, opts.b, opts.mode, opts.scoring)?;
    let mut scores = Vec::with_capacity(opts.shuffles as usize);
    for k in 0..opts.shuffles {
        if should_cancel() {
            return Ok(ShuffleOutcome::Cancelled {
                completed: k,
                seed: opts.seed,
            });
        }
        let shuffled = shuffle_residues(&mut rng, opts.b)?;
        scores.push(align_score_only(opts.a, &shuffled, opts.mode, opts.scoring)?);
        on_progress(f64::from(k + 1) / f64::from(opts.shuffles));
    }
    // Statistics in the same order as the TypeScript code, so the floating-point results are bit-identical.
    let n = f64::from(opts.shuffles);
    let mut sum = 0.0;
    let mut at_least_as_good = 0u32;
    for &s in &scores {
        sum += f64::from(s);
        if s >= real_score {
            at_least_as_good += 1;
        }
    }
    let mean = sum / n;
    let mut ss = 0.0;
    for &s in &scores {
        ss += (f64::from(s) - mean) * (f64::from(s) - mean);
    }
    let sd = if opts.shuffles > 1 {
        (ss / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    Ok(ShuffleOutcome::Done(ShuffleSummary {
        seed: opts.seed,
        shuffles: opts.shuffles,
        real_score,
        scores,
        mean,
        sd,
        z: if sd > 0.0 {
            Some((f64::from(real_score) - mean) / sd)
        } else {
            None
        },
        at_least_as_good,
        p_value: (1.0 + f64::from(at_least_as_good)) / (n + 1.0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoring::compile_scoring;
    use crate::types::{Alphabet, GapModel, ScoringSpec, SubstitutionSpec};

    fn dna(m: i32, mm: i32, gaps: GapModel) -> CompiledScoring {
        compile_scoring(
            &ScoringSpec {
                substitution: SubstitutionSpec::Simple {
                    match_score: m,
                    mismatch_score: mm,
                },
                gaps,
            },
            Alphabet::Dna,
        )
        .expect("valid") // test code
    }
    /// Random sequence of `n` letters from `letters` using the seeded generator (the same helper idea as the TS tests).
    fn rand(seed: u32, n: usize, letters: &str) -> String {
        let chars: Vec<char> = letters.chars().collect();
        let mut r = Rng::new(seed);
        (0..n)
            .map(|_| chars[r.next_int(chars.len() as u64).expect("bound") as usize])
            .collect() // test code
    }
    fn run(a: &str, b: &str, mode: AlignMode, sc: &CompiledScoring, shuffles: u32, seed: u32) -> ShuffleSummary {
        let opts = ShuffleOptions {
            a,
            b,
            mode,
            scoring: sc,
            shuffles,
            seed,
        };
        match run_shuffle_test(&opts, &mut |_| {}, &mut || false).expect("runs") {
            // test code
            ShuffleOutcome::Done(s) => s,
            ShuffleOutcome::Cancelled { .. } => panic!("unexpected cancel"), // test code
        }
    }
    const AFF: GapModel = GapModel::Affine { open: 5, extend: 2 };

    #[test]
    fn same_seed_same_distribution_different_seed_differs() {
        let (a, b) = (rand(1, 60, "ACGT"), rand(2, 60, "ACGT"));
        let sc = dna(2, -3, AFF);
        let r1 = run(&a, &b, AlignMode::Local, &sc, 100, 11);
        let r2 = run(&a, &b, AlignMode::Local, &sc, 100, 11);
        let r3 = run(&a, &b, AlignMode::Local, &sc, 100, 12);
        assert_eq!(r1.scores, r2.scores);
        assert_ne!(r1.scores, r3.scores);
    }

    #[test]
    fn a_clearly_related_pair_falls_far_in_the_tail() {
        let a = rand(5, 80, "ACGT");
        let r = run(&a, &a, AlignMode::Local, &dna(2, -3, AFF), 200, 1);
        assert_eq!(r.at_least_as_good, 0);
        assert!((r.p_value - 1.0 / 201.0).abs() < 1e-12);
        assert!(r.z.unwrap_or(0.0) > 5.0);
    }

    #[test]
    fn p_value_uses_the_plus_one_correction_and_z_is_none_when_all_scores_equal() {
        let r = run(
            "AAAA",
            "AAAA",
            AlignMode::Global,
            &dna(1, -1, GapModel::Linear { gap: 1 }),
            10,
            3,
        );
        assert_eq!((r.sd, r.z, r.p_value), (0.0, None, 1.0));
        let strong = run(
            "ACGTACGTAC",
            "ACGTACGTAC",
            AlignMode::Global,
            &dna(5, -4, GapModel::Linear { gap: 6 }),
            50,
            4,
        );
        assert!(strong.p_value > 0.0);
    }

    #[test]
    fn cancellation_stops_early_and_reports_how_many_finished() {
        let (a, b) = (rand(8, 30, "ACGT"), rand(9, 30, "ACGT"));
        let sc = dna(2, -3, AFF);
        let mut calls = 0;
        let opts = ShuffleOptions {
            a: &a,
            b: &b,
            mode: AlignMode::Global,
            scoring: &sc,
            shuffles: 100,
            seed: 1,
        };
        let outcome = run_shuffle_test(&opts, &mut |_| {}, &mut || {
            calls += 1;
            calls > 5
        })
        .expect("runs"); // test code
        assert_eq!(outcome, ShuffleOutcome::Cancelled { completed: 5, seed: 1 });
    }

    #[test]
    fn progress_reports_the_completed_fraction_after_each_shuffle() {
        let sc = dna(2, -3, AFF);
        let mut seen = Vec::new();
        let opts = ShuffleOptions {
            a: "ACGTAC",
            b: "ACGGAC",
            mode: AlignMode::Global,
            scoring: &sc,
            shuffles: 4,
            seed: 1,
        };
        run_shuffle_test(&opts, &mut |f| seen.push(f), &mut || false).expect("runs"); // test code
        assert_eq!(seen, vec![0.25, 0.5, 0.75, 1.0]);
    }

    #[test]
    fn invalid_shuffle_counts_are_typed_errors() {
        let sc = dna(2, -3, AFF);
        for n in [0u32, 5001] {
            let opts = ShuffleOptions {
                a: "A",
                b: "A",
                mode: AlignMode::Global,
                scoring: &sc,
                shuffles: n,
                seed: 1,
            };
            let e = run_shuffle_test(&opts, &mut |_| {}, &mut || false).expect_err("bad count"); // test code
            assert_eq!(e.code, BioErrorCode::InvalidArgument);
            assert!(e.message.contains("shuffles"));
        }
    }

    #[test]
    fn shuffle_preserves_composition_is_deterministic_and_empty_stays_empty() {
        let s = "AACCCGGGGTTTTT";
        let x = shuffle_residues(&mut Rng::new(3), s).expect("shuffle"); // test code
        let sorted = |t: &str| {
            let mut v: Vec<char> = t.chars().collect();
            v.sort_unstable();
            v
        };
        assert_eq!(sorted(&x), sorted(s));
        assert_eq!(shuffle_residues(&mut Rng::new(3), s).expect("shuffle"), x); // test code
        assert_eq!(shuffle_residues(&mut Rng::new(1), "").expect("shuffle"), ""); // test code
    }
}
