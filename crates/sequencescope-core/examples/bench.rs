//! Compute-only benchmark of the core crate (no window, no IPC): the same scenarios and the same input sequences as the
//! in-window benchmark (src/tauri/bench.ts), so the three numbers (TypeScript, Rust through Tauri, Rust alone) can be
//! compared. Run in release mode:  cargo run --release -p sequencescope-core --example bench
//! Each scenario prints the same checksum as the in-window runs, which proves all three computed the same answer.

use sequencescope_core::bootstrap::{BootstrapInput, BootstrapResult, TreeMethod, bootstrap, bootstrap_threads};
use sequencescope_core::distance::{DistanceMatrix, DistanceModel, GapPolicy, pairwise_distance_matrix};
use sequencescope_core::error::BioError;
use sequencescope_core::fasta::Sequence;
use sequencescope_core::pairwise::{Tables, fill_matrix, traceback_all, traceback_first};
use sequencescope_core::rng::Rng;
use sequencescope_core::scoring::{CompiledScoring, compile_scoring};
use sequencescope_core::shuffle::{ShuffleOptions, ShuffleOutcome, run_shuffle_test};
use sequencescope_core::types::{AlignMode, Alphabet, GapModel, ScoringSpec, SubstitutionSpec};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

const DNA: &str = "ACGT";
const PROTEIN: &str = "ACDEFGHIKLMNPQRSTVWY";

/// A random sequence of `len` letters from `letters` with the seeded generator (same recipe as src/tauri/inputs.ts).
fn random_seq(seed: u32, len: usize, letters: &str) -> Result<String, BioError> {
    let chars: Vec<char> = letters.chars().collect();
    let mut rng = Rng::new(seed);
    let mut s = String::with_capacity(len);
    for _ in 0..len {
        s.push(chars[rng.next_int(chars.len() as u64)? as usize]);
    }
    Ok(s)
}

/// FNV-1a 32-bit hash (same function as the TypeScript side).
fn fnv1a32(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Median of a list of timings.
fn median(xs: &[f64]) -> f64 {
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// Times `reps` full alignments (fill + first traceback + enumeration up to 1000) and prints one line.
fn bench_align(
    name: &str,
    a: &str,
    b: &str,
    mode: AlignMode,
    scoring: &CompiledScoring,
    reps: usize,
) -> Result<(), BioError> {
    let mut runs = Vec::new();
    let mut checksum = String::new();
    for _ in 0..reps {
        let t0 = Instant::now();
        let dp = fill_matrix(a, b, mode, scoring)?;
        let first = traceback_first(&dp);
        let all = traceback_all(&dp, 1000)?;
        runs.push(t0.elapsed().as_secs_f64() * 1000.0);
        if checksum.is_empty() {
            let first_table = match &dp.tables {
                Tables::Linear { h, .. } => fnv1a32(h.iter().flat_map(|v| v.to_le_bytes())),
                Tables::Affine { m, .. } => fnv1a32(m.iter().flat_map(|v| v.to_le_bytes())),
            };
            let rows = fnv1a32(format!("{}|{}", first.row_a, first.row_b).bytes());
            checksum = format!(
                "{}:{rows}:{first_table}:{}{}",
                first.score,
                all.alignments.len(),
                if all.capped { "+" } else { "" }
            );
        }
    }
    let runs_text: Vec<String> = runs.iter().map(|r| format!("{r:.1}")).collect();
    println!(
        "{name} | runs ms [{}] | min {:.1} | median {:.1} | checksum {checksum}",
        runs_text.join(", "),
        runs.iter().cloned().fold(f64::INFINITY, f64::min),
        median(&runs)
    );
    Ok(())
}

/// Times `reps` shuffle tests and prints one line.
fn bench_shuffle(name: &str, req: &ShuffleOptions<'_>, reps: usize) -> Result<(), BioError> {
    let mut runs = Vec::new();
    let mut checksum = String::new();
    for _ in 0..reps {
        let t0 = Instant::now();
        let outcome = run_shuffle_test(req, &mut |_| {}, &mut || false)?;
        runs.push(t0.elapsed().as_secs_f64() * 1000.0);
        if let (true, ShuffleOutcome::Done(r)) = (checksum.is_empty(), outcome) {
            let scores = fnv1a32(r.scores.iter().flat_map(|v| v.to_le_bytes()));
            checksum = format!(
                "{}:{scores}:{:016x}:{:016x}:{:016x}",
                r.real_score,
                r.mean.to_bits(),
                r.sd.to_bits(),
                r.p_value.to_bits()
            );
        }
    }
    let runs_text: Vec<String> = runs.iter().map(|r| format!("{r:.1}")).collect();
    println!(
        "{name} | runs ms [{}] | min {:.1} | median {:.1} | checksum {checksum}",
        runs_text.join(", "),
        runs.iter().cloned().fold(f64::INFINITY, f64::min),
        median(&runs)
    );
    Ok(())
}

/// An alignment of `n` related rows (same recipe as `alignmentRows` in src/tauri/inputs.ts): one random base row, each row
/// mutated at about 15% of sites.
fn alignment_rows(seed: u32, n: usize, len: usize, letters: &str) -> Result<Vec<String>, BioError> {
    let chars: Vec<char> = letters.chars().collect();
    let mut rng = Rng::new(seed);
    let mut base = Vec::with_capacity(len);
    for _ in 0..len {
        base.push(chars[rng.next_int(chars.len() as u64)? as usize]);
    }
    let mut rows = Vec::with_capacity(n);
    for _ in 0..n {
        let mut row = String::with_capacity(len);
        for &c in &base {
            row.push(if rng.next_int(100)? < 15 {
                chars[rng.next_int(chars.len() as u64)? as usize]
            } else {
                c
            });
        }
        rows.push(row);
    }
    Ok(rows)
}

/// Times a generic job `reps` times and prints one line with the checksum of the first result.
fn bench_job<R>(
    name: &str,
    reps: usize,
    mut run: impl FnMut() -> Result<R, BioError>,
    checksum: impl Fn(&R) -> String,
) -> Result<(), BioError> {
    let mut runs = Vec::new();
    let mut sum = String::new();
    for _ in 0..reps {
        let t0 = Instant::now();
        let r = run()?;
        runs.push(t0.elapsed().as_secs_f64() * 1000.0);
        if sum.is_empty() {
            sum = checksum(&r);
        }
    }
    let runs_text: Vec<String> = runs.iter().map(|r| format!("{r:.1}")).collect();
    println!(
        "{name} | runs ms [{}] | min {:.1} | median {:.1} | checksum {sum}",
        runs_text.join(", "),
        runs.iter().cloned().fold(f64::INFINITY, f64::min),
        median(&runs)
    );
    Ok(())
}

fn matrix_checksum(m: &DistanceMatrix) -> String {
    format!(
        "{}:{}:{}:{}",
        m.n,
        fnv1a32(m.values.iter().flat_map(|v| v.to_le_bytes())),
        fnv1a32(m.status.iter().copied()),
        fnv1a32(m.compared.iter().flat_map(|v| v.to_le_bytes()))
    )
}

fn bootstrap_checksum(r: &BootstrapResult) -> String {
    let counts: Vec<String> = r.supports.iter().map(|s| s.count.to_string()).collect();
    format!(
        "{}:{}:{}:{}",
        r.supports.len(),
        fnv1a32(counts.join(",").bytes()),
        r.failed_replicates,
        r.replicates
    )
}

fn bootstrap_input(seed: u32, n: usize, len: usize) -> Result<BootstrapInput, BioError> {
    Ok(BootstrapInput {
        names: (0..n).map(|i| format!("t{i}")).collect(),
        rows: alignment_rows(seed, n, len, DNA)?,
        alphabet: Alphabet::Dna,
        model: DistanceModel::P,
        gap_policy: GapPolicy::PairwiseDeletion,
        method: TreeMethod::Nj,
        replicates: 100,
        seed: 2026,
    })
}

fn main() -> Result<(), BioError> {
    let dna = |gaps| {
        compile_scoring(
            &ScoringSpec {
                substitution: SubstitutionSpec::Simple {
                    match_score: 2,
                    mismatch_score: -3,
                },
                gaps,
            },
            Alphabet::Dna,
        )
    };
    let blosum = |gaps| {
        compile_scoring(
            &ScoringSpec {
                substitution: SubstitutionSpec::Matrix {
                    name: "BLOSUM62".to_string(),
                },
                gaps,
            },
            Alphabet::Protein,
        )
    };
    let affine_dna = dna(GapModel::Affine { open: 5, extend: 1 })?;
    bench_align(
        "small: 200 x 200 DNA, affine, global",
        &random_seq(11, 200, DNA)?,
        &random_seq(12, 200, DNA)?,
        AlignMode::Global,
        &affine_dna,
        7,
    )?;
    let affine_protein = blosum(GapModel::Affine { open: 11, extend: 1 })?;
    bench_align(
        "medium: 1000 x 1000 protein BLOSUM62, affine, global",
        &random_seq(21, 1000, PROTEIN)?,
        &random_seq(22, 1000, PROTEIN)?,
        AlignMode::Global,
        &affine_protein,
        5,
    )?;
    let linear_dna = dna(GapModel::Linear { gap: 4 })?;
    bench_align(
        "largest: 5000 x 5000 DNA, linear, global",
        &random_seq(33, 5000, DNA)?,
        &random_seq(34, 5000, DNA)?,
        AlignMode::Global,
        &linear_dna,
        3,
    )?;
    bench_align(
        "largest: 5000 x 5000 protein BLOSUM62, affine, global",
        &random_seq(31, 5000, PROTEIN)?,
        &random_seq(32, 5000, PROTEIN)?,
        AlignMode::Global,
        &affine_protein,
        3,
    )?;
    let (a, b) = (random_seq(41, 300, DNA)?, random_seq(42, 300, DNA)?);
    let opts = ShuffleOptions {
        a: &a,
        b: &b,
        mode: AlignMode::Local,
        scoring: &affine_dna,
        shuffles: 1000,
        seed: 7,
    };
    bench_shuffle("shuffle test: 1000 shuffles of 300 x 300 DNA, local, affine", &opts, 3)?;

    // Checkpoint 4 scenarios (same inputs as src/tauri/inputs.ts)
    let seqs: Vec<Sequence> = alignment_rows(51, 30, 400, DNA)?
        .into_iter()
        .enumerate()
        .map(|(i, r)| Sequence {
            id: format!("s{i}"),
            description: String::new(),
            alphabet: Alphabet::Dna,
            residues: r,
        })
        .collect();
    bench_job(
        "distance matrix: 30 DNA sequences x 400, every pair aligned (435 alignments)",
        3,
        || {
            pairwise_distance_matrix(
                &seqs,
                &affine_dna,
                DistanceModel::P,
                GapPolicy::PairwiseDeletion,
                &mut |_| {},
                &mut || false,
            )?
            .ok_or_else(|| BioError::new(sequencescope_core::error::BioErrorCode::InvalidArgument, "cancelled"))
        },
        matrix_checksum,
    )?;
    for (label, n, len, seed) in [("10 x 1144", 10usize, 1144usize, 61u32), ("50 x 3000", 50, 3000, 62)] {
        let inp = bootstrap_input(seed, n, len)?;
        let single =
            || bootstrap(&inp, &mut |_| {}, &mut || false).map(|r| r.unwrap_or_else(|| unreachable_result(&inp)));
        bench_job(
            &format!("bootstrap: 100 replicates, {label} DNA, NJ (Rust, 1 thread)"),
            3,
            single,
            bootstrap_checksum,
        )?;
        let multi = || {
            bootstrap_threads(&inp, 8, &mut |_| {}, &AtomicBool::new(false))
                .map(|r| r.unwrap_or_else(|| unreachable_result(&inp)))
        };
        bench_job(
            &format!("bootstrap: 100 replicates, {label} DNA, NJ (Rust, 8 threads)"),
            3,
            multi,
            bootstrap_checksum,
        )?;
    }
    Ok(())
}

/// A placeholder for the impossible "cancelled" case (nothing cancels in this benchmark), so no `unwrap` is needed.
fn unreachable_result(inp: &BootstrapInput) -> BootstrapResult {
    BootstrapResult {
        reference_tree: sequencescope_core::tree::Tree {
            root: sequencescope_core::tree::TreeNode::default(),
        },
        supports: vec![],
        replicates: inp.replicates,
        seed: inp.seed,
        failed_replicates: 0,
        method: inp.method,
        model: inp.model,
        gap_policy: inp.gap_policy,
    }
}
