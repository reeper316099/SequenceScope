//! Helpers shared by the integration tests: scoring constructors, the brute-force oracle, proptest strategies,
//! the FNV table hash used by the TypeScript parity fixture, and JSON fixture readers.
#![allow(dead_code)] // each test file uses a different subset of these helpers

use proptest::prelude::*;
use sequencescope_core::pairwise::Tables;
use sequencescope_core::scoring::{CompiledScoring, compile_scoring};
use sequencescope_core::types::{AlignMode, Alphabet, GapModel, PairwiseAlignment, ScoringSpec, SubstitutionSpec};
use serde_json::{Value, json};
use std::path::PathBuf;

/// DNA (or RNA) scoring with simple match/mismatch and the given gap model.
pub fn dna(m: i32, mm: i32, gaps: GapModel) -> CompiledScoring {
    dna_as(m, mm, gaps, Alphabet::Dna)
}

/// Like `dna` but with an explicit nucleotide alphabet.
pub fn dna_as(m: i32, mm: i32, gaps: GapModel, alphabet: Alphabet) -> CompiledScoring {
    let spec = ScoringSpec {
        substitution: SubstitutionSpec::Simple {
            match_score: m,
            mismatch_score: mm,
        },
        gaps,
    };
    compile_scoring(&spec, alphabet).expect("valid test scoring") // test code
}

/// Protein scoring with a named matrix and the given gap model.
pub fn protein(name: &str, gaps: GapModel) -> CompiledScoring {
    let spec = ScoringSpec {
        substitution: SubstitutionSpec::Matrix { name: name.to_string() },
        gaps,
    };
    compile_scoring(&spec, Alphabet::Protein).expect("valid test scoring") // test code
}

pub fn lin(gap: i32) -> GapModel {
    GapModel::Linear { gap }
}

pub fn aff(open: i32, extend: i32) -> GapModel {
    GapModel::Affine { open, extend }
}

/// Brute-force oracle: ENUMERATES every possible global alignment (no DP) and keeps the best score. Gap runs follow the
/// documented convention independently of pairwise.rs: a run of length k costs open + (k-1)*extend, and a switch between
/// the two gap rows starts a new run.
pub fn brute_global(a: &[u8], b: &[u8], sc: &CompiledScoring) -> i32 {
    /// The inputs of one brute-force search plus the best score found so far.
    struct Search<'a> {
        a: &'a [u8],
        b: &'a [u8],
        sc: &'a CompiledScoring,
        best: i32,
    }
    impl Search<'_> {
        /// Tries every column choice from cell (i, j); `last` = 0 pair/start, 1 = gap in B (A residue alone), 2 = gap in A.
        fn rec(&mut self, i: usize, j: usize, last: u8, acc: i32) {
            if i == self.a.len() && j == self.b.len() {
                self.best = self.best.max(acc);
                return;
            }
            if i < self.a.len() && j < self.b.len() {
                let s = self
                    .sc
                    .char_score(self.a[i] as char, self.b[j] as char)
                    .expect("scorable"); // test code
                self.rec(i + 1, j + 1, 0, acc + s);
            }
            if i < self.a.len() {
                let cost = if last == 1 {
                    self.sc.gap_extend
                } else {
                    self.sc.gap_open
                };
                self.rec(i + 1, j, 1, acc - cost);
            }
            if j < self.b.len() {
                let cost = if last == 2 {
                    self.sc.gap_extend
                } else {
                    self.sc.gap_open
                };
                self.rec(i, j + 1, 2, acc - cost);
            }
        }
    }
    let mut search = Search {
        a,
        b,
        sc,
        best: i32::MIN,
    };
    search.rec(0, 0, 0, 0);
    search.best
}

/// Best local score: the maximum over every pair of substrings (including empty) of the best global score, and 0.
pub fn brute_local(a: &[u8], b: &[u8], sc: &CompiledScoring) -> i32 {
    let mut best = 0;
    for i1 in 0..=a.len() {
        for i2 in i1..=a.len() {
            for j1 in 0..=b.len() {
                for j2 in j1..=b.len() {
                    best = best.max(brute_global(&a[i1..i2], &b[j1..j2], sc));
                }
            }
        }
    }
    best
}

/// Brute-force optimum for the given mode.
pub fn brute_force(a: &str, b: &str, mode: AlignMode, sc: &CompiledScoring) -> i32 {
    match mode {
        AlignMode::Global => brute_global(a.as_bytes(), b.as_bytes(), sc),
        AlignMode::Local => brute_local(a.as_bytes(), b.as_bytes(), sc),
    }
}

/// proptest strategy: a random string over `letters` with length in [min, max].
pub fn seq_of(letters: &'static str, min: usize, max: usize) -> impl Strategy<Value = String> {
    let chars: Vec<char> = letters.chars().collect();
    prop::collection::vec(prop::sample::select(chars), min..=max).prop_map(|v| v.into_iter().collect())
}

/// FNV-1a 32-bit hash of raw bytes (the same function as tools/ts-parity/gen.test.ts).
pub fn fnv1a32(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Hashes every table of a DP (values and pointers) with little-endian element bytes, like the TypeScript generator.
pub fn table_hashes(tables: &Tables) -> Value {
    let i32s = |v: &Vec<i32>| fnv1a32(v.iter().flat_map(|x| x.to_le_bytes()));
    match tables {
        Tables::Linear { h, p } => json!({ "H": i32s(h), "P": fnv1a32(p.iter().copied()) }),
        Tables::Affine { m, x, y, p } => {
            json!({ "M": i32s(m), "X": i32s(x), "Y": i32s(y), "P": fnv1a32(p.iter().flat_map(|v| v.to_le_bytes())) })
        }
    }
}

/// The repository root (two levels above this crate).
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Reads and parses a JSON file relative to the repository root.
pub fn read_json(relative: &str) -> Value {
    let path = repo_root().join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display())); // test code
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display())) // test code
}

/// Builds a gap model from the JSON shape used by the TypeScript fixtures.
pub fn gaps_from_json(v: &Value) -> GapModel {
    let int = |key: &str| i32::try_from(v[key].as_i64().expect("integer gap field")).expect("gap fits i32"); // test code
    match v["kind"].as_str() {
        Some("linear") => GapModel::Linear { gap: int("gap") },
        Some("affine") => GapModel::Affine {
            open: int("open"),
            extend: int("extend"),
        },
        other => panic!("unknown gap kind {other:?}"), // test code
    }
}

/// Builds a scoring spec from the JSON shape used by the TypeScript fixtures.
pub fn spec_from_json(v: &Value) -> ScoringSpec {
    let sub = &v["substitution"];
    let substitution = match sub["kind"].as_str() {
        Some("simple") => SubstitutionSpec::Simple {
            match_score: i32::try_from(sub["match"].as_i64().expect("match")).expect("fits"), // test code
            mismatch_score: i32::try_from(sub["mismatch"].as_i64().expect("mismatch")).expect("fits"), // test code
        },
        Some("matrix") => SubstitutionSpec::Matrix {
            name: sub["name"].as_str().expect("matrix name").to_string(),
        }, // test code
        other => panic!("unknown substitution kind {other:?}"), // test code
    };
    ScoringSpec {
        substitution,
        gaps: gaps_from_json(&v["gaps"]),
    }
}

/// Parses "dna" / "rna" / "protein".
pub fn alphabet_from_str(s: &str) -> Alphabet {
    Alphabet::parse(s).unwrap_or_else(|| panic!("unknown alphabet {s}")) // test code
}

/// Parses "global" / "local".
pub fn mode_from_str(s: &str) -> AlignMode {
    AlignMode::parse(s).unwrap_or_else(|| panic!("unknown mode {s}")) // test code
}

/// An alignment as JSON with the same keys as the TypeScript `PairwiseAlignment`.
pub fn alignment_json(a: &PairwiseAlignment) -> Value {
    json!({ "mode": a.mode.as_str(), "score": a.score, "rowA": a.row_a, "rowB": a.row_b, "startA": a.start_a, "endA": a.end_a, "startB": a.start_b, "endB": a.end_b })
}
