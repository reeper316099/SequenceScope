//! Substitution matrices (BLOSUM45 / 62 / 80). The values are NOT typed here: the original NCBI files in
//! `data/matrices/` are embedded at compile time and parsed at first use. Each matrix records the SHA-256 of its
//! file, and the tests compare the checksum with `data/matrices/SHA256SUMS` and every value with the TypeScript copy.
//! Port of `src/bio/matrices.ts`. See DATA-SOURCES.md for source and terms.

use crate::error::{BioError, BioErrorCode};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub const MATRIX_CITATION: &str = "Henikoff S, Henikoff JG (1992). Amino acid substitution matrices from protein blocks. Proc Natl Acad Sci USA 89(22):10915-10919. doi:10.1073/pnas.89.22.10915";
pub const MATRIX_SOURCE: &str =
    "NCBI BLAST matrices (https://ftp.ncbi.nlm.nih.gov/blast/matrices/); file header: \"Matrix made by matblas\".";

/// The raw files, embedded at compile time (paths are relative to this source file: crate -> crates -> repo root).
const RAW_FILES: [(&str, &str); 3] = [
    ("BLOSUM45", include_str!("../../../data/matrices/BLOSUM45")),
    ("BLOSUM62", include_str!("../../../data/matrices/BLOSUM62")),
    ("BLOSUM80", include_str!("../../../data/matrices/BLOSUM80")),
];

/// A parsed substitution matrix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubstitutionMatrix {
    pub name: &'static str,
    /// Row/column order, e.g. "ARNDCQEGHILKMFPSTWYVBZX*".
    pub letters: String,
    /// Flattened letters x letters scores.
    pub values: Vec<i32>,
    /// SHA-256 (hex) of the source file.
    pub sha256: String,
}

impl SubstitutionMatrix {
    /// Score for two residue letters, or None if either is not in the matrix.
    pub fn get(&self, a: char, b: char) -> Option<i32> {
        let n = self.letters.len();
        let i = self.letters.find(a)?;
        let j = self.letters.find(b)?;
        self.values.get(i * n + j).copied()
    }
}

/// Lower-case hex of a SHA-256 digest.
fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Parses one NCBI matrix file: skips '#' comment lines, reads the letter header and the labelled rows, and checks
/// that the matrix is square, integer, and symmetric.
fn parse_matrix(name: &'static str, text: &str) -> Result<SubstitutionMatrix, String> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect();
    let header: Vec<&str> = lines
        .first()
        .ok_or_else(|| format!("{name}: empty file"))?
        .split_whitespace()
        .collect();
    let n = header.len();
    if header.iter().any(|h| h.chars().count() != 1) {
        return Err(format!("{name}: header letters must be single characters"));
    }
    let mut values = Vec::with_capacity(n * n);
    for (r, label) in header.iter().enumerate() {
        let parts: Vec<&str> = lines
            .get(r + 1)
            .ok_or_else(|| format!("{name}: missing row {label}"))?
            .split_whitespace()
            .collect();
        if parts.first() != Some(label) {
            return Err(format!("{name}: row label mismatch at {label}"));
        }
        if parts.len() != n + 1 {
            return Err(format!(
                "{name}: row {label} has {} values, expected {n}",
                parts.len() - 1
            ));
        }
        for p in &parts[1..] {
            values.push(p.parse::<i32>().map_err(|_| format!("{name}: non-integer value {p}"))?);
        }
    }
    for r in 0..n {
        for c in 0..n {
            if values[r * n + c] != values[c * n + r] {
                return Err(format!("{name}: not symmetric at {}{}", header[r], header[c]));
            }
        }
    }
    Ok(SubstitutionMatrix {
        name,
        letters: header.concat(),
        values,
        sha256: hex_sha256(text.as_bytes()),
    })
}

/// All bundled matrices, parsed once. An Err means the embedded data is corrupt (the tests make sure it is not).
static REGISTRY: LazyLock<Result<Vec<SubstitutionMatrix>, String>> =
    LazyLock::new(|| RAW_FILES.iter().map(|(name, text)| parse_matrix(name, text)).collect());

/// Names of all bundled matrices, in display order.
pub fn list_matrices() -> Vec<&'static str> {
    RAW_FILES.iter().map(|(name, _)| *name).collect()
}

/// Looks up a bundled matrix by name or returns a typed error.
pub fn get_matrix(name: &str) -> Result<&'static SubstitutionMatrix, BioError> {
    let all = REGISTRY.as_ref().map_err(|e| {
        BioError::new(
            BioErrorCode::UnknownMatrix,
            format!("Bundled matrix data is corrupt: {e}"),
        )
    })?;
    all.iter().find(|m| m.name == name).ok_or_else(|| {
        BioError::new(
            BioErrorCode::UnknownMatrix,
            format!(
                "Unknown substitution matrix \"{name}\". Available: {}.",
                list_matrices().join(", ")
            ),
        )
    })
}

/// Checks the self-alignment condition (ALGORITHMS.md section 5): s(x,x) > 0 and s(x,y) <= (s(x,x)+s(y,y))/2 for all
/// the given letters. When it holds, aligning a sequence with itself uses the diagonal.
pub fn satisfies_self_alignment_condition(m: &SubstitutionMatrix, letters: &str) -> bool {
    for x in letters.chars() {
        let Some(sxx) = m.get(x, x) else { return false };
        if sxx <= 0 {
            return false;
        }
        for y in letters.chars() {
            let (Some(sxy), Some(syy)) = (m.get(x, y), m.get(y, y)) else {
                return false;
            };
            if f64::from(sxy) > f64::from(sxx + syy) / 2.0 {
                return false;
            }
        }
    }
    true
}

/// The 20 standard amino acids, the default letter set for the self-alignment check.
pub const STANDARD_AMINO_ACIDS: &str = "ACDEFGHIKLMNPQRSTVWY";

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads `data/matrices/SHA256SUMS` (format: "<hex>  <name>").
    fn recorded_checksums() -> Vec<(String, String)> {
        let text = include_str!("../../../data/matrices/SHA256SUMS");
        text.lines()
            .filter_map(|l| l.split_once("  "))
            .map(|(h, n)| (n.trim().to_string(), h.trim().to_string()))
            .collect()
    }

    #[test]
    fn lists_the_three_verified_matrices() {
        assert_eq!(list_matrices(), vec!["BLOSUM45", "BLOSUM62", "BLOSUM80"]);
    }

    #[test]
    fn every_matrix_is_24_by_24_symmetric_and_matches_its_recorded_checksum() {
        let sums = recorded_checksums();
        assert_eq!(sums.len(), 3);
        for name in list_matrices() {
            let m = get_matrix(name).expect("bundled matrix"); // test code
            assert_eq!(m.letters, "ARNDCQEGHILKMFPSTWYVBZX*", "{name}");
            assert_eq!(m.values.len(), 24 * 24);
            let recorded = sums.iter().find(|(n, _)| n == name).map(|(_, h)| h.as_str());
            assert_eq!(
                recorded,
                Some(m.sha256.as_str()),
                "{name}: embedded file differs from data/matrices/SHA256SUMS"
            );
            for x in m.letters.chars() {
                for y in m.letters.chars() {
                    assert_eq!(m.get(x, y), m.get(y, x));
                }
            }
        }
    }

    #[test]
    fn satisfies_the_self_alignment_condition() {
        for name in list_matrices() {
            let m = get_matrix(name).expect("bundled matrix"); // test code
            assert!(satisfies_self_alignment_condition(m, STANDARD_AMINO_ACIDS), "{name}");
        }
    }

    #[test]
    fn spot_values_cross_checked_against_biopython_in_phase_1() {
        let m = get_matrix("BLOSUM62").expect("bundled matrix"); // test code
        assert_eq!(
            [m.get('B', 'D'), m.get('X', 'A'), m.get('*', 'A'), m.get('*', '*')],
            [Some(4), Some(0), Some(-4), Some(1)]
        );
        assert_eq!(m.get('A', 'A'), Some(4));
        assert_eq!(
            m.get('J', 'A'),
            None,
            "J is not in BLOSUM; scoring maps it to X before lookup"
        );
    }

    #[test]
    fn unknown_matrix_is_a_typed_error() {
        let e = get_matrix("PAM250").expect_err("PAM250 is not bundled"); // test code
        assert_eq!(e.code, BioErrorCode::UnknownMatrix);
        assert!(e.message.contains("Unknown substitution matrix"));
    }

    #[test]
    fn parser_rejects_broken_files() {
        assert!(parse_matrix("X", "").is_err());
        assert!(parse_matrix("X", "A B\nA 1 2\nB 3 1\n").is_err(), "not symmetric");
        assert!(parse_matrix("X", "A B\nA 1 2\n").is_err(), "missing row");
        assert!(parse_matrix("X", "A B\nA 1 x\nB x 1\n").is_err(), "non-integer");
        assert!(parse_matrix("X", "A B\nB 1 2\nA 2 1\n").is_err(), "row label mismatch");
        assert!(parse_matrix("X", "# c\nA B\nA 1 2\nB 2 1\n").is_ok());
    }
}
