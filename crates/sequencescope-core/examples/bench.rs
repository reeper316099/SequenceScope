//! Compute-only benchmark of the core crate (no window, no IPC): the same scenarios and the same input sequences as the
//! in-window benchmark (src/tauri/bench.ts), so the three numbers (TypeScript, Rust through Tauri, Rust alone) can be
//! compared. Run in release mode:  cargo run --release -p sequencescope-core --example bench
//! Each scenario prints the same checksum as the in-window runs, which proves all three computed the same answer.

use sequencescope_core::error::BioError;
use sequencescope_core::pairwise::{Tables, fill_matrix, traceback_all, traceback_first};
use sequencescope_core::rng::Rng;
use sequencescope_core::scoring::{CompiledScoring, compile_scoring};
use sequencescope_core::shuffle::{ShuffleOptions, ShuffleOutcome, run_shuffle_test};
use sequencescope_core::types::{AlignMode, Alphabet, GapModel, ScoringSpec, SubstitutionSpec};
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
    bench_shuffle("shuffle test: 1000 shuffles of 300 x 300 DNA, local, affine", &opts, 3)
}
