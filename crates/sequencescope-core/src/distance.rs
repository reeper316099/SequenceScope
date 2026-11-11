//! Distances between sequences (ALGORITHMS.md section 6): p-distance, Jukes-Cantor, Poisson correction, with an explicit
//! gap policy and explicit "saturated"/"undefined" states (never NaN or Infinity). Port of `src/bio/distance.ts`; the
//! values, the order of operations, and every message are identical to the TypeScript.

use crate::alphabet::{js_len, standard_letters};
use crate::error::{BioError, BioErrorCode};
use crate::fasta::Sequence;
use crate::jsnum::{js_ln, js_number_to_string, js_to_fixed};
use crate::pairwise::align;
use crate::scoring::CompiledScoring;
use crate::types::{AlignMode, Alphabet};
use std::collections::HashSet;

/// Distance matrices / trees: at most 100 sequences.
pub const MAX_TREE_TAXA: usize = 100;
/// Sum over pairs of (len_i+1)*(len_j+1): keeps pairwise-distance runs to about a minute.
pub const MAX_PAIRWISE_WORK: f64 = 1_500_000_000.0;
/// Replicates * pairs * columns.
pub const MAX_BOOTSTRAP_WORK: f64 = 5_000_000_000.0;

const GAP: u8 = 254; // code for '-'
const AMBIG: u8 = 255; // code for an ambiguity code (treated like missing data for that pair)

/// Status of one distance cell.
pub const DIST_OK: u8 = 0;
pub const DIST_SATURATED: u8 = 1;
pub const DIST_UNDEFINED: u8 = 2;

/// Distance models: p-distance, Jukes-Cantor (DNA/RNA), Poisson correction (protein).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceModel {
    P,
    Jc,
    Poisson,
}

impl DistanceModel {
    /// "p" / "jc" / "poisson".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P => "p",
            Self::Jc => "jc",
            Self::Poisson => "poisson",
        }
    }

    /// Parses the lower-case name.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "p" => Some(Self::P),
            "jc" => Some(Self::Jc),
            "poisson" => Some(Self::Poisson),
            _ => None,
        }
    }
}

/// What to do with alignment columns containing a gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapPolicy {
    PairwiseDeletion,
    GapsAsDifferences,
}

impl GapPolicy {
    /// "pairwise-deletion" / "gaps-as-differences".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PairwiseDeletion => "pairwise-deletion",
            Self::GapsAsDifferences => "gaps-as-differences",
        }
    }

    /// Parses the kebab-case name.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pairwise-deletion" => Some(Self::PairwiseDeletion),
            "gaps-as-differences" => Some(Self::GapsAsDifferences),
            _ => None,
        }
    }
}

/// Symmetric distance matrix with a status per cell, so NaN/Infinity never appear.
#[derive(Debug, Clone, PartialEq)]
pub struct DistanceMatrix {
    pub names: Vec<String>,
    pub n: usize,
    /// n*n values; only meaningful where status is DIST_OK.
    pub values: Vec<f64>,
    /// n*n statuses.
    pub status: Vec<u8>,
    /// n*n number of compared sites for each pair.
    pub compared: Vec<u32>,
    pub model: DistanceModel,
    pub gap_policy: GapPolicy,
}

/// Models that make sense for an alphabet.
pub fn models_for(alphabet: Alphabet) -> [DistanceModel; 2] {
    if alphabet == Alphabet::Protein {
        [DistanceModel::P, DistanceModel::Poisson]
    } else {
        [DistanceModel::P, DistanceModel::Jc]
    }
}

/// Asserts the model is valid for the alphabet (Jukes-Cantor is for nucleotides, Poisson for protein).
pub fn assert_model(model: DistanceModel, alphabet: Alphabet) -> Result<(), BioError> {
    if !models_for(alphabet).contains(&model) {
        let name = match model {
            DistanceModel::Jc => "Jukes–Cantor",
            DistanceModel::Poisson => "Poisson",
            DistanceModel::P => "p-distance",
        };
        return Err(BioError::new(
            BioErrorCode::IncompatibleModel,
            format!("The {name} model cannot be used for {} sequences.", alphabet.as_str()),
        ));
    }
    Ok(())
}

/// Largest p for which the correction is defined (exclusive): JC 3/4, Poisson 1.
pub fn saturation_limit(model: DistanceModel) -> f64 {
    match model {
        DistanceModel::Jc => 0.75,
        DistanceModel::Poisson => 1.0,
        DistanceModel::P => f64::INFINITY,
    }
}

/// Applies the correction to p. JC (Eq. 6.2): d = -(3/4) ln(1 - 4p/3), defined for p < 3/4. Poisson (Eq. 6.3):
/// d = -ln(1 - p), defined for p < 1. Returns None when p is at or above the limit ("saturated").
/// The logarithm is `js_ln` (V8's), so results equal the TypeScript implementation on every platform.
pub fn correct_distance(p: f64, model: DistanceModel) -> Option<f64> {
    if p == 0.0 {
        return Some(0.0);
    }
    if model == DistanceModel::P {
        return Some(p);
    }
    if p >= saturation_limit(model) {
        return None;
    }
    let d = if model == DistanceModel::Jc {
        -0.75 * js_ln(1.0 - (4.0 * p) / 3.0)
    } else {
        -js_ln(1.0 - p)
    };
    d.is_finite().then_some(d)
}

/// Encodes aligned residues: standard residues -> 0..K-1, '-' -> 254, anything else (ambiguity) -> 255. One code per
/// UTF-16 unit, like the TypeScript.
pub fn encode_aligned(row: &str, alphabet: Alphabet) -> Vec<u8> {
    let std = standard_letters(alphabet);
    row.encode_utf16()
        .map(|unit| {
            if unit == u16::from(b'-') {
                GAP
            } else if unit < 128 {
                std.find(char::from(unit as u8)).map_or(AMBIG, |i| i as u8)
            } else {
                AMBIG
            }
        })
        .collect()
}

/// Compared sites and differences for one pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairStats {
    pub compared: i64,
    pub differences: i64,
}

/// Counts compared sites and differences for two encoded rows, with optional column weights (bootstrap multiplicities).
/// Columns where both are gaps never count. Ambiguity codes are skipped for that pair. Policy 'pairwise-deletion': a gap in
/// either row skips the column. 'gaps-as-differences': gap vs residue is a difference.
pub fn pair_stats(a: &[u8], b: &[u8], policy: GapPolicy, weights: Option<&[i32]>) -> PairStats {
    let (mut compared, mut differences) = (0i64, 0i64);
    for k in 0..a.len() {
        let w = weights.map_or(1, |w| i64::from(w[k]));
        if w == 0 {
            continue;
        }
        let (x, y) = (a[k], b[k]);
        if x == GAP && y == GAP {
            continue;
        }
        if x == GAP || y == GAP {
            if policy == GapPolicy::GapsAsDifferences && x != AMBIG && y != AMBIG {
                compared += w;
                differences += w;
            }
            continue;
        }
        if x == AMBIG || y == AMBIG {
            continue;
        }
        compared += w;
        if x != y {
            differences += w;
        }
    }
    PairStats { compared, differences }
}

/// Allocates an empty matrix with zero diagonal.
fn empty_matrix(names: Vec<String>, model: DistanceModel, gap_policy: GapPolicy) -> DistanceMatrix {
    let n = names.len();
    DistanceMatrix {
        names,
        n,
        values: vec![0.0; n * n],
        status: vec![0; n * n],
        compared: vec![0; n * n],
        model,
        gap_policy,
    }
}

/// Writes one symmetric cell from pair statistics.
pub fn set_cell(m: &mut DistanceMatrix, i: usize, j: usize, stats: PairStats) {
    let (mut status, mut value) = (DIST_OK, 0.0);
    if stats.compared == 0 {
        status = DIST_UNDEFINED;
    } else {
        match correct_distance(stats.differences as f64 / stats.compared as f64, m.model) {
            None => status = DIST_SATURATED,
            Some(d) => value = d,
        }
    }
    for k in [i * m.n + j, j * m.n + i] {
        m.values[k] = value;
        m.status[k] = status;
        m.compared[k] = stats.compared as u32;
    }
}

/// Distance matrix from rows that are ALREADY aligned (equal length).
pub fn distance_matrix_from_aligned(
    names: &[String],
    rows: &[String],
    alphabet: Alphabet,
    model: DistanceModel,
    gap_policy: GapPolicy,
    weights: Option<&[i32]>,
) -> Result<DistanceMatrix, BioError> {
    assert_model(model, alphabet)?;
    if names.len() != rows.len() {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            "Names and rows must have the same length.",
        ));
    }
    let len = rows.first().map_or(0, |r| js_len(r));
    for (k, r) in rows.iter().enumerate() {
        if js_len(r) != len {
            return Err(BioError::new(
                BioErrorCode::NotAligned,
                format!(
                    "Sequence \"{}\" has {} columns but the first has {len}: the input is not an alignment.",
                    names[k],
                    js_len(r)
                ),
            ));
        }
    }
    let codes: Vec<Vec<u8>> = rows.iter().map(|r| encode_aligned(r, alphabet)).collect();
    Ok(distance_matrix_from_codes(names, &codes, model, gap_policy, weights))
}

/// Distance matrix from pre-encoded rows (fast path used by bootstrap).
pub fn distance_matrix_from_codes(
    names: &[String],
    codes: &[Vec<u8>],
    model: DistanceModel,
    gap_policy: GapPolicy,
    weights: Option<&[i32]>,
) -> DistanceMatrix {
    let mut m = empty_matrix(names.to_vec(), model, gap_policy);
    for i in 0..m.n {
        for j in (i + 1)..m.n {
            let stats = pair_stats(&codes[i], &codes[j], gap_policy, weights);
            set_cell(&mut m, i, j, stats);
        }
    }
    m
}

/// Distance matrix from UNALIGNED sequences: every pair is aligned globally with `scoring`, then the distance is computed
/// from that pairwise alignment. `on_progress` gets the completed fraction; `should_cancel` is polled before each pair.
/// Returns `Ok(None)` if cancelled.
pub fn pairwise_distance_matrix(
    seqs: &[Sequence],
    scoring: &CompiledScoring,
    model: DistanceModel,
    gap_policy: GapPolicy,
    on_progress: &mut dyn FnMut(f64),
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<Option<DistanceMatrix>, BioError> {
    let alphabet = scoring.alphabet;
    assert_model(model, alphabet)?;
    if seqs.len() > MAX_TREE_TAXA {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!("At most {MAX_TREE_TAXA} sequences are supported (got {}).", seqs.len()),
        ));
    }
    let mut work = 0.0f64;
    for i in 0..seqs.len() {
        for j in (i + 1)..seqs.len() {
            work += (js_len(&seqs[i].residues) as f64 + 1.0) * (js_len(&seqs[j].residues) as f64 + 1.0);
        }
    }
    if work > MAX_PAIRWISE_WORK {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "Aligning every pair needs about {} billion cell updates; the limit is {} billion. Use fewer or shorter sequences, or provide an alignment.",
                js_to_fixed(work / 1e9, 1),
                js_number_to_string(MAX_PAIRWISE_WORK / 1e9)
            ),
        ));
    }
    let mut m = empty_matrix(seqs.iter().map(|s| s.id.clone()).collect(), model, gap_policy);
    let total = (seqs.len() * seqs.len().saturating_sub(1)) as f64 / 2.0;
    let mut done = 0.0;
    for i in 0..seqs.len() {
        for j in (i + 1)..seqs.len() {
            if should_cancel() {
                return Ok(None);
            }
            let aln = align(&seqs[i].residues, &seqs[j].residues, AlignMode::Global, scoring)?;
            set_cell(
                &mut m,
                i,
                j,
                pair_stats(
                    &encode_aligned(&aln.row_a, alphabet),
                    &encode_aligned(&aln.row_b, alphabet),
                    gap_policy,
                    None,
                ),
            );
            done += 1.0;
            on_progress(done / total);
        }
    }
    Ok(Some(m))
}

/// The distance for one cell, or None if saturated/undefined.
pub fn cell_value(m: &DistanceMatrix, i: usize, j: usize) -> Option<f64> {
    (m.status[i * m.n + j] == DIST_OK).then(|| m.values[i * m.n + j])
}

/// A pair that cannot be used for tree building.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnusablePair {
    pub i: usize,
    pub j: usize,
    /// "saturated" or "undefined".
    pub status: &'static str,
}

/// Lists the pairs that cannot be used for tree building (saturated or undefined).
pub fn unusable_pairs(m: &DistanceMatrix) -> Vec<UnusablePair> {
    let mut out = Vec::new();
    for i in 0..m.n {
        for j in (i + 1)..m.n {
            let s = m.status[i * m.n + j];
            if s != DIST_OK {
                out.push(UnusablePair {
                    i,
                    j,
                    status: if s == DIST_SATURATED { "saturated" } else { "undefined" },
                });
            }
        }
    }
    out
}

/// Returns a typed error that names the bad pairs if the matrix cannot be used to build a tree.
pub fn assert_tree_ready(m: &DistanceMatrix) -> Result<(), BioError> {
    if m.n < 3 {
        return Err(BioError::new(
            BioErrorCode::TooFewSequences,
            format!("Tree building needs at least 3 sequences (got {}).", m.n),
        ));
    }
    if m.names.iter().collect::<HashSet<_>>().len() != m.names.len() {
        return Err(BioError::new(
            BioErrorCode::DuplicateNames,
            "Sequence names must be unique to build a tree. Rename the duplicates first.",
        ));
    }
    let bad = unusable_pairs(m);
    if !bad.is_empty() {
        let shown: Vec<String> = bad
            .iter()
            .take(4)
            .map(|b| format!("{} / {} ({})", m.names[b.i], m.names[b.j], b.status))
            .collect();
        let more = if bad.len() > 4 { "; …" } else { "" };
        return Err(BioError::new(
            BioErrorCode::SaturatedDistances,
            format!(
                "{} pair(s) have no usable distance: {}{more}. Saturated means the sequences differ so much that the {} formula is undefined (too many multiple substitutions to count). Try the p-distance, a different gap policy, or remove the most divergent sequences.",
                bad.len(),
                shown.join("; "),
                if m.model == DistanceModel::P { "" } else { "correction" }
            ),
        ));
    }
    Ok(())
}

/// Nested-array copy of the usable values (used by tree builders); requires a tree-ready matrix.
pub fn to_rows(m: &DistanceMatrix) -> Result<Vec<Vec<f64>>, BioError> {
    assert_tree_ready(m)?;
    Ok((0..m.n)
        .map(|i| (0..m.n).map(|j| m.values[i * m.n + j]).collect())
        .collect())
}

/// The first `n` UTF-16 units of a string (JavaScript `slice(0, n)`).
fn js_prefix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// PHYLIP square distance matrix text. Strict PHYLIP names are 10 characters, so names are sanitised, truncated, and made unique.
pub fn to_phylip(m: &DistanceMatrix) -> Result<String, BioError> {
    assert_tree_ready(m)?;
    let mut used: HashSet<String> = HashSet::new();
    let mut labels = Vec::new();
    for full in &m.names {
        let cleaned: String = full
            .chars()
            .map(|c| {
                if crate::alphabet::is_js_whitespace(c) || "(),:;[]'".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let base = js_prefix(&cleaned, 10);
        let mut name = base.clone();
        let mut t = 1usize;
        while used.contains(&name) {
            let suffix = t.to_string();
            name = format!("{}{suffix}", js_prefix(&base, 10usize.saturating_sub(suffix.len())));
            t += 1;
        }
        used.insert(name.clone());
        let pad = 10usize.saturating_sub(js_len(&name));
        labels.push(format!("{name}{}", " ".repeat(pad)));
    }
    let mut lines = vec![m.n.to_string()];
    for (i, label) in labels.iter().enumerate() {
        let cells: Vec<String> = (0..m.n).map(|j| js_to_fixed(m.values[i * m.n + j], 6)).collect();
        lines.push(format!("{label} {}", cells.join(" ")));
    }
    Ok(lines.join("\n") + "\n")
}

/// CSV with names; saturated/undefined cells are written as the words "saturated" / "undefined".
pub fn to_distance_csv(m: &DistanceMatrix) -> String {
    let q = |s: &str| {
        if s.contains(['"', ',', '\n']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    let mut header = vec![String::new()];
    header.extend(m.names.iter().cloned());
    let mut rows = vec![header.iter().map(|s| q(s)).collect::<Vec<_>>().join(",")];
    for i in 0..m.n {
        let mut cells = vec![q(&m.names[i])];
        for j in 0..m.n {
            cells.push(match m.status[i * m.n + j] {
                DIST_OK => js_number_to_string(m.values[i * m.n + j]),
                DIST_SATURATED => "saturated".to_string(),
                _ => "undefined".to_string(),
            });
        }
        rows.push(cells.join(","));
    }
    rows.join("\n") + "\n"
}

/// Builds a (status-OK) distance matrix from a nested array; used for worked examples and teaching.
pub fn matrix_from_rows(names: &[String], rows: &[Vec<f64>], model: DistanceModel) -> DistanceMatrix {
    let n = names.len();
    let mut m = empty_matrix(names.to_vec(), model, GapPolicy::PairwiseDeletion);
    for (i, row) in rows.iter().enumerate().take(n) {
        for (j, &v) in row.iter().enumerate().take(n) {
            m.values[i * n + j] = v;
            m.compared[i * n + j] = 1;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }
    fn dna(a: &str, b: &str, model: DistanceModel, policy: GapPolicy) -> DistanceMatrix {
        distance_matrix_from_aligned(&names(&["a", "b"]), &names(&[a, b]), Alphabet::Dna, model, policy, None)
            .expect("valid input") // test code
    }
    fn p(a: &str, b: &str) -> DistanceMatrix {
        dna(a, b, DistanceModel::P, GapPolicy::PairwiseDeletion)
    }

    // Ported from tests/unit/distance.test.ts.
    #[test]
    fn p_distance_hand_computed() {
        assert_eq!(cell_value(&p("ACGTACGT", "ACGAACGA"), 0, 1), Some(0.25));
        assert_eq!(
            cell_value(
                &dna("ACGT", "ACGT", DistanceModel::Jc, GapPolicy::PairwiseDeletion),
                0,
                1
            ),
            Some(0.0)
        );
        let prot = distance_matrix_from_aligned(
            &names(&["a", "b"]),
            &names(&["MKV", "MKV"]),
            Alphabet::Protein,
            DistanceModel::Poisson,
            GapPolicy::PairwiseDeletion,
            None,
        )
        .expect("valid"); // test code
        assert_eq!(cell_value(&prot, 0, 1), Some(0.0));
    }

    #[test]
    fn gap_policies() {
        let m = p("AC-GT", "ACAGA");
        assert_eq!(m.compared[1], 4);
        assert_eq!(cell_value(&m, 0, 1), Some(0.25));
        let g = dna("AC-GT", "ACAGT", DistanceModel::P, GapPolicy::GapsAsDifferences);
        assert_eq!((g.compared[1], cell_value(&g, 0, 1)), (5, Some(0.2)));
        for policy in [GapPolicy::PairwiseDeletion, GapPolicy::GapsAsDifferences] {
            let both = dna("AC-GT", "AC-GA", DistanceModel::P, policy);
            assert_eq!(
                (both.compared[1], cell_value(&both, 0, 1)),
                (4, Some(0.25)),
                "a gap in BOTH never counts"
            );
        }
        let amb = p("ACNGT", "ACAGA");
        assert_eq!(
            (amb.compared[1], cell_value(&amb, 0, 1)),
            (4, Some(0.25)),
            "ambiguity codes are skipped"
        );
        let none = p("ACGT", "----");
        assert_eq!(none.status[1], DIST_UNDEFINED);
        assert_eq!(cell_value(&none, 0, 1), None);
        assert_eq!(
            unusable_pairs(&none),
            vec![UnusablePair {
                i: 0,
                j: 1,
                status: "undefined"
            }]
        );
    }

    #[test]
    fn corrections_and_saturation() {
        assert!((correct_distance(0.5, DistanceModel::Jc).expect("defined") - 0.75 * 3f64.ln()).abs() < 1e-12);
        assert!(
            (correct_distance(0.5, DistanceModel::Poisson).expect("defined") - std::f64::consts::LN_2).abs() < 1e-12
        );
        assert_eq!(correct_distance(0.3, DistanceModel::P), Some(0.3));
        for model in [DistanceModel::Jc, DistanceModel::Poisson] {
            let d = correct_distance(0.0, model).expect("p = 0 is defined");
            assert!(d == 0.0 && d.is_sign_positive(), "p = 0 gives exactly +0, never -0");
            let limit = saturation_limit(model);
            for p in [limit, limit + 0.1, 1.5] {
                assert_eq!(correct_distance(p, model), None);
            }
            assert!(
                correct_distance(limit - 1e-9, model)
                    .expect("below the limit")
                    .is_finite()
            );
        }
        assert_eq!(
            dna("ACGT", "CATG", DistanceModel::Jc, GapPolicy::PairwiseDeletion).status[1],
            DIST_SATURATED
        );
        let m2 = dna("AAAA", "CCCA", DistanceModel::Jc, GapPolicy::PairwiseDeletion);
        assert_eq!(m2.status[1], DIST_SATURATED);
        assert_eq!(
            assert_tree_ready(&m2).expect_err("not ready").code,
            BioErrorCode::TooFewSequences
        );
    }

    #[test]
    fn corrected_distance_is_at_least_p_increasing_and_finite_below_the_limit() {
        let mut x = 0.0;
        while x < 0.7499 {
            for model in [DistanceModel::Jc, DistanceModel::Poisson] {
                let (dx, dy) = (
                    correct_distance(x, model).expect("defined"),
                    correct_distance(x + 0.0005, model).expect("defined"),
                );
                assert!(dx.is_finite() && dx >= x - 1e-12 && dx <= dy, "{model:?} {x}");
            }
            x += 0.0005;
        }
    }

    #[test]
    fn matrix_is_symmetric_with_zero_diagonal_and_never_nan() {
        let rows = names(&["ACGT-ACGT-", "ACGTTACGAA", "-CGTTACGAN", "ACCT-ACGT-"]);
        let m = distance_matrix_from_aligned(
            &names(&["a", "b", "c", "d"]),
            &rows,
            Alphabet::Dna,
            DistanceModel::Jc,
            GapPolicy::GapsAsDifferences,
            None,
        )
        .expect("valid"); // test code
        for i in 0..m.n {
            assert_eq!((m.values[i * m.n + i], m.status[i * m.n + i]), (0.0, DIST_OK));
            for j in 0..m.n {
                assert_eq!(m.values[i * m.n + j], m.values[j * m.n + i]);
                assert_eq!(m.status[i * m.n + j], m.status[j * m.n + i]);
                assert!(m.values[i * m.n + j].is_finite());
            }
        }
    }

    #[test]
    fn typed_errors() {
        let e = distance_matrix_from_aligned(
            &names(&["a", "b"]),
            &names(&["ACGT", "ACG"]),
            Alphabet::Dna,
            DistanceModel::P,
            GapPolicy::PairwiseDeletion,
            None,
        )
        .expect_err("unequal rows"); // test code
        assert_eq!(e.code, BioErrorCode::NotAligned);
        assert!(e.message.contains("\"b\""));
        let e = distance_matrix_from_aligned(
            &names(&["a", "b"]),
            &names(&["MK", "MK"]),
            Alphabet::Protein,
            DistanceModel::Jc,
            GapPolicy::PairwiseDeletion,
            None,
        )
        .expect_err("wrong model"); // test code
        assert_eq!(
            e.message,
            "The Jukes–Cantor model cannot be used for protein sequences."
        );
        assert_eq!(
            models_for(Alphabet::Protein),
            [DistanceModel::P, DistanceModel::Poisson]
        );
        assert_eq!(models_for(Alphabet::Dna), [DistanceModel::P, DistanceModel::Jc]);
    }

    #[test]
    fn pair_stats_with_weights_behaves_like_repeated_columns() {
        let (a, b) = (
            encode_aligned("ACGT", Alphabet::Dna),
            encode_aligned("AGGT", Alphabet::Dna),
        );
        assert_eq!(
            pair_stats(&a, &b, GapPolicy::PairwiseDeletion, None),
            PairStats {
                compared: 4,
                differences: 1
            }
        );
        assert_eq!(
            pair_stats(&a, &b, GapPolicy::PairwiseDeletion, Some(&[2, 0, 1, 3])),
            PairStats {
                compared: 6,
                differences: 0
            }
        );
        assert_eq!(
            pair_stats(&a, &b, GapPolicy::PairwiseDeletion, Some(&[0, 5, 0, 0])),
            PairStats {
                compared: 5,
                differences: 5
            }
        );
    }

    #[test]
    fn exports_phylip_names_are_unique_ten_characters_and_csv_marks_saturation() {
        let rows = names(&["ACGTACGTAC", "ACGTACGTAA", "ACGAACGTAC"]);
        let m = distance_matrix_from_aligned(
            &names(&["a_very_long_name_1", "a_very_long_name_2", "short name"]),
            &rows,
            Alphabet::Dna,
            DistanceModel::P,
            GapPolicy::PairwiseDeletion,
            None,
        )
        .expect("valid"); // test code
        let text = to_phylip(&m).expect("tree-ready"); // test code
        let lines: Vec<&str> = text.trim().split('\n').collect();
        assert_eq!(lines[0], "3");
        let labels: Vec<String> = lines[1..].iter().map(|l| l.chars().take(10).collect()).collect();
        assert_eq!(labels.iter().collect::<HashSet<_>>().len(), 3);
        assert_eq!(labels[2], "short_name");
        assert!(lines[1].contains("0.100000"), "{}", lines[1]);
        let sat = dna("AAAA", "CCCA", DistanceModel::Jc, GapPolicy::PairwiseDeletion);
        assert_eq!(to_distance_csv(&sat), ",a,b\na,0,saturated\nb,saturated,0\n");
    }

    #[test]
    fn tree_ready_errors_name_the_pairs() {
        let mut m = matrix_from_rows(
            &names(&["a", "b", "c"]),
            &[vec![0.0, 1.0, 2.0], vec![1.0, 0.0, 2.0], vec![2.0, 2.0, 0.0]],
            DistanceModel::P,
        );
        m.status[1] = DIST_SATURATED;
        m.status[3] = DIST_SATURATED;
        let e = assert_tree_ready(&m).expect_err("saturated pair"); // test code
        assert_eq!(e.code, BioErrorCode::SaturatedDistances);
        assert!(e.message.contains("a / b (saturated)"));
        assert!(
            e.message.contains("the  formula"),
            "double space for the p model, exactly as in the TypeScript text"
        );
        let dup = matrix_from_rows(
            &names(&["a", "a", "b"]),
            &[vec![0.0, 1.0, 2.0], vec![1.0, 0.0, 2.0], vec![2.0, 2.0, 0.0]],
            DistanceModel::P,
        );
        assert_eq!(
            assert_tree_ready(&dup).expect_err("duplicates").code,
            BioErrorCode::DuplicateNames
        );
    }
}
