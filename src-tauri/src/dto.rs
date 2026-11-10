//! The JSON shapes exchanged with the page for alignment and shuffle jobs, and their conversion to/from the core crate's
//! types. The request shapes mirror `AlignRequest` / `ShuffleRequest` in `src/shared/types.ts`; the response shapes mirror
//! `AlignResult` / `ShuffleSummary`. The page is untrusted, so numbers arrive as f64 and are checked to be whole numbers
//! in range, with the SAME error messages the TypeScript code produces.

use crate::jobs::JobError;
use sequencescope_core::bootstrap::{BootstrapInput, BootstrapResult, TreeMethod};
use sequencescope_core::distance::{DistanceModel, GapPolicy};
use sequencescope_core::error::{BioError, BioErrorCode};
use sequencescope_core::fasta::Sequence;
use sequencescope_core::msa::{GuideMethod, MsaResult};
use sequencescope_core::pairwise::MAX_ENUMERATED_ALIGNMENTS;
use sequencescope_core::rng::check_seed;
use sequencescope_core::shuffle::{MAX_SHUFFLES, ShuffleSummary};
use sequencescope_core::tree::{Tree, TreeNode};
use sequencescope_core::types::{AlignMode, Alphabet, GapModel, PairwiseAlignment, ScoringSpec, SubstitutionSpec};
use serde::{Deserialize, Serialize};

/// `{ kind: 'simple', match, mismatch }` or `{ kind: 'matrix', name }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SubstitutionDto {
    Simple {
        #[serde(rename = "match")]
        match_score: f64,
        mismatch: f64,
    },
    Matrix {
        name: String,
    },
}

/// `{ kind: 'linear', gap }` or `{ kind: 'affine', open, extend }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GapsDto {
    Linear { gap: f64 },
    Affine { open: f64, extend: f64 },
}

/// The scoring choice.
#[derive(Debug, Deserialize)]
pub struct ScoringDto {
    pub substitution: SubstitutionDto,
    pub gaps: GapsDto,
}

/// An alignment job (`type: 'align'` is ignored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignRequestDto {
    pub a: String,
    pub b: String,
    pub alphabet: String,
    pub mode: String,
    pub scoring: ScoringDto,
    pub enumerate_cap: f64,
}

/// A shuffle-test job (`type: 'shuffle'` is ignored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShuffleRequestDto {
    pub a: String,
    pub b: String,
    pub alphabet: String,
    pub mode: String,
    pub scoring: ScoringDto,
    pub shuffles: f64,
    pub seed: f64,
}

/// Checks that a number is a whole number in [min, max] and converts it; the message matches the TypeScript wording.
fn whole(name: &str, v: f64, min: i32, max: i32) -> Result<i32, BioError> {
    if v.fract() != 0.0 || v < f64::from(min) || v > f64::from(max) {
        return Err(BioError::new(
            BioErrorCode::InvalidScoring,
            format!("{name} must be a whole number between {min} and {max}, got {v}."),
        ));
    }
    Ok(v as i32)
}

impl ScoringDto {
    /// Converts to the core scoring spec (range checks happen again, authoritatively, in `compile_scoring`).
    pub fn to_core(&self) -> Result<ScoringSpec, BioError> {
        let substitution = match &self.substitution {
            SubstitutionDto::Simple { match_score, mismatch } => SubstitutionSpec::Simple {
                match_score: whole("Match score", *match_score, -1000, 1000)?,
                mismatch_score: whole("Mismatch score", *mismatch, -1000, 1000)?,
            },
            SubstitutionDto::Matrix { name } => SubstitutionSpec::Matrix { name: name.clone() },
        };
        let gaps = match &self.gaps {
            GapsDto::Linear { gap } => GapModel::Linear {
                gap: whole("Gap penalty (open)", *gap, 0, 10_000)?,
            },
            GapsDto::Affine { open, extend } => GapModel::Affine {
                open: whole("Gap penalty (open)", *open, 0, 10_000)?,
                extend: whole("Gap penalty (extend)", *extend, 0, 10_000)?,
            },
        };
        Ok(ScoringSpec { substitution, gaps })
    }
}

/// Parses the alphabet name sent by the page.
pub fn parse_alphabet(s: &str) -> Result<Alphabet, BioError> {
    Alphabet::parse(s).ok_or_else(|| BioError::new(BioErrorCode::InvalidArgument, format!("Unknown alphabet \"{s}\".")))
}

/// Parses the alignment mode sent by the page.
pub fn parse_mode(s: &str) -> Result<AlignMode, BioError> {
    AlignMode::parse(s).ok_or_else(|| {
        BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Unknown alignment mode \"{s}\"."),
        )
    })
}

impl AlignRequestDto {
    /// The enumeration cap as a count: a whole number >= 1 (huge values mean "no practical limit").
    pub fn cap(&self) -> Result<usize, BioError> {
        if self.enumerate_cap.fract() != 0.0 || self.enumerate_cap < 1.0 {
            return Err(BioError::new(
                BioErrorCode::InvalidArgument,
                "Enumeration cap must be a positive integer.",
            ));
        }
        Ok(self.enumerate_cap.min(MAX_ENUMERATED_ALIGNMENTS as f64 * 1000.0) as usize)
    }
}

impl ShuffleRequestDto {
    /// Validated (shuffles, seed): the same limits and wording as the TypeScript shuffle test.
    pub fn counts(&self) -> Result<(u32, u32), BioError> {
        if self.shuffles.fract() != 0.0 || self.shuffles < 1.0 || self.shuffles > f64::from(MAX_SHUFFLES) {
            return Err(BioError::new(
                BioErrorCode::InvalidArgument,
                format!("Number of shuffles must be a whole number from 1 to {MAX_SHUFFLES}."),
            ));
        }
        Ok((self.shuffles as u32, check_seed(self.seed)?))
    }
}

/// One alignment, shaped like the TypeScript `PairwiseAlignment`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentDto {
    pub mode: &'static str,
    pub score: i32,
    pub row_a: String,
    pub row_b: String,
    pub start_a: usize,
    pub end_a: usize,
    pub start_b: usize,
    pub end_b: usize,
}

impl From<&PairwiseAlignment> for AlignmentDto {
    /// Copies the alignment into its JSON form.
    fn from(a: &PairwiseAlignment) -> Self {
        Self {
            mode: a.mode.as_str(),
            score: a.score,
            row_a: a.row_a.clone(),
            row_b: a.row_b.clone(),
            start_a: a.start_a,
            end_a: a.end_a,
            start_b: a.start_b,
            end_b: a.end_b,
        }
    }
}

/// The non-table parts of the DP snapshot (the tables travel as binary).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DpMetaDto {
    pub kind: &'static str,
    pub mode: &'static str,
    pub rows: usize,
    pub cols: usize,
    pub score: i32,
    pub ends: Vec<usize>,
}

/// Where the time went inside Rust (milliseconds), so the benchmark can separate computing from transferring. Building
/// and sending the frame happens after this header is written, so the page measures that part as the remainder.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimingsDto {
    pub fill_ms: f64,
    pub traceback_ms: f64,
}

/// The JSON header of the binary result frame.
#[derive(Debug, Serialize)]
pub struct AlignHeaderDto {
    pub alignment: AlignmentDto,
    pub all: Vec<AlignmentDto>,
    pub capped: bool,
    pub dp: DpMetaDto,
    pub timings: TimingsDto,
}

/// The shuffle-test result, shaped like the TypeScript `ShuffleSummary`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShuffleSummaryDto {
    pub seed: u32,
    pub shuffles: u32,
    pub real_score: i32,
    pub scores: Vec<i32>,
    pub mean: f64,
    pub sd: f64,
    pub z: Option<f64>,
    pub at_least_as_good: u32,
    pub p_value: f64,
}

impl From<ShuffleSummary> for ShuffleSummaryDto {
    /// Moves the finished summary into its JSON form.
    fn from(s: ShuffleSummary) -> Self {
        Self {
            seed: s.seed,
            shuffles: s.shuffles,
            real_score: s.real_score,
            scores: s.scores,
            mean: s.mean,
            sd: s.sd,
            z: s.z,
            at_least_as_good: s.at_least_as_good,
            p_value: s.p_value,
        }
    }
}

/// One sequence of an unaligned distance request.
#[derive(Debug, Deserialize)]
pub struct SeqDto {
    pub id: String,
    #[serde(default)]
    pub description: String,
    pub residues: String,
}

/// A distance-matrix job: from rows that are already aligned, or from unaligned sequences (every pair aligned).
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DistancesRequestDto {
    Aligned {
        names: Vec<String>,
        rows: Vec<String>,
        alphabet: String,
        model: String,
        #[serde(rename = "gapPolicy")]
        gap_policy: String,
    },
    Unaligned {
        seqs: Vec<SeqDto>,
        alphabet: String,
        model: String,
        #[serde(rename = "gapPolicy")]
        gap_policy: String,
        scoring: ScoringDto,
    },
}

impl SeqDto {
    /// Converts to a core sequence of the given alphabet.
    pub fn to_core(&self, alphabet: sequencescope_core::types::Alphabet) -> Sequence {
        Sequence {
            id: self.id.clone(),
            description: self.description.clone(),
            alphabet,
            residues: self.residues.clone(),
        }
    }
}

/// Parses a distance model name.
pub fn parse_model(s: &str) -> Result<DistanceModel, BioError> {
    DistanceModel::parse(s).ok_or_else(|| {
        BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Unknown distance model \"{s}\"."),
        )
    })
}

/// Parses a gap policy name.
pub fn parse_policy(s: &str) -> Result<GapPolicy, BioError> {
    GapPolicy::parse(s)
        .ok_or_else(|| BioError::new(BioErrorCode::InvalidArgument, format!("Unknown gap policy \"{s}\".")))
}

/// The bootstrap settings as the page sends them (numbers arrive as f64 and are checked).
#[derive(Debug, Deserialize)]
pub struct BootstrapInputDto {
    pub names: Vec<String>,
    pub rows: Vec<String>,
    pub alphabet: String,
    pub model: String,
    #[serde(rename = "gapPolicy")]
    pub gap_policy: String,
    pub method: String,
    pub replicates: f64,
    pub seed: f64,
}

/// A bootstrap job (`type: 'bootstrap'` is ignored).
#[derive(Debug, Deserialize)]
pub struct BootstrapRequestDto {
    pub input: BootstrapInputDto,
}

impl BootstrapInputDto {
    /// Converts to the core input. A replicate count that is not a whole number in range becomes 0, which the core's
    /// validation rejects with the same message at the same point as the TypeScript code.
    pub fn to_core(&self) -> Result<BootstrapInput, BioError> {
        let replicates = if self.replicates.fract() == 0.0 && (1.0..=1000.0).contains(&self.replicates) {
            self.replicates as u32
        } else {
            0
        };
        Ok(BootstrapInput {
            names: self.names.clone(),
            rows: self.rows.clone(),
            alphabet: parse_alphabet(&self.alphabet)?,
            model: parse_model(&self.model)?,
            gap_policy: parse_policy(&self.gap_policy)?,
            method: TreeMethod::parse(&self.method).ok_or_else(|| {
                BioError::new(
                    BioErrorCode::InvalidArgument,
                    format!("Unknown tree method \"{}\".", self.method),
                )
            })?,
            replicates,
            seed: check_seed(self.seed)?,
        })
    }
}

/// A tree node as JSON, shaped like the TypeScript `TreeNode` (fields that are absent are left out).
#[derive(Debug, Serialize)]
pub struct TreeNodeDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<f64>,
    pub children: Vec<TreeNodeDto>,
}

impl From<&TreeNode> for TreeNodeDto {
    /// Copies a node and its subtree.
    fn from(n: &TreeNode) -> Self {
        Self {
            name: n.name.clone(),
            label: n.label.clone(),
            length: n.length,
            support: n.support,
            children: n.children.iter().map(Self::from).collect(),
        }
    }
}

/// A tree as JSON (`{ root }`).
#[derive(Debug, Serialize)]
pub struct TreeDto {
    pub root: TreeNodeDto,
}

impl From<&Tree> for TreeDto {
    /// Copies a tree.
    fn from(t: &Tree) -> Self {
        Self {
            root: TreeNodeDto::from(&t.root),
        }
    }
}

/// Support for one split.
#[derive(Debug, Serialize)]
pub struct SupportDto {
    pub leaves: Vec<String>,
    pub count: u32,
    pub percent: f64,
}

/// The bootstrap result, shaped like the TypeScript `BootstrapResult`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResultDto {
    pub reference_tree: TreeDto,
    pub supports: Vec<SupportDto>,
    pub replicates: u32,
    pub seed: u32,
    pub failed_replicates: u32,
    pub method: &'static str,
    pub model: &'static str,
    pub gap_policy: &'static str,
}

impl From<&BootstrapResult> for BootstrapResultDto {
    /// Copies the finished bootstrap into its JSON form.
    fn from(r: &BootstrapResult) -> Self {
        Self {
            reference_tree: TreeDto::from(&r.reference_tree),
            supports: r
                .supports
                .iter()
                .map(|s| SupportDto {
                    leaves: s.leaves.clone(),
                    count: s.count,
                    percent: s.percent,
                })
                .collect(),
            replicates: r.replicates,
            seed: r.seed,
            failed_replicates: r.failed_replicates,
            method: r.method.as_str(),
            model: r.model.as_str(),
            gap_policy: r.gap_policy.as_str(),
        }
    }
}

/// A progressive multiple-alignment job (`type: 'msa'` is ignored).
#[derive(Debug, Deserialize)]
pub struct MsaRequestDto {
    pub seqs: Vec<SeqDto>,
    pub alphabet: String,
    pub scoring: ScoringDto,
    pub guide: String,
}

/// Parses the guide-tree method sent by the page ("upgma" or "nj").
pub fn parse_guide(s: &str) -> Result<GuideMethod, BioError> {
    GuideMethod::parse(s).ok_or_else(|| {
        BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Unknown guide-tree method \"{s}\"."),
        )
    })
}

/// One profile merge, shaped like the TypeScript `MsaStep`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MsaStepDto {
    pub ids: Vec<String>,
    pub left_ids: Vec<String>,
    pub right_ids: Vec<String>,
    pub rows: Vec<String>,
    pub score: f64,
}

/// The multiple alignment, shaped like the TypeScript `MsaResult`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MsaResultDto {
    pub ids: Vec<String>,
    pub rows: Vec<String>,
    pub alphabet: &'static str,
    pub guide_tree: TreeDto,
    pub guide: &'static str,
    pub steps: Vec<MsaStepDto>,
    pub sum_of_pairs: i64,
}

impl From<&MsaResult> for MsaResultDto {
    /// Copies the finished alignment into its JSON form.
    fn from(r: &MsaResult) -> Self {
        Self {
            ids: r.ids.clone(),
            rows: r.rows.clone(),
            alphabet: r.alphabet.as_str(),
            guide_tree: TreeDto::from(&r.guide_tree),
            guide: r.guide.as_str(),
            steps: r
                .steps
                .iter()
                .map(|s| MsaStepDto {
                    ids: s.ids.clone(),
                    left_ids: s.left_ids.clone(),
                    right_ids: s.right_ids.clone(),
                    rows: s.rows.clone(),
                    score: s.score,
                })
                .collect(),
            sum_of_pairs: r.sum_of_pairs,
        }
    }
}

/// The header of a distance-matrix frame (the three tables travel as binary: values V, status S, compared C).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixHeaderDto {
    pub names: Vec<String>,
    pub n: usize,
    pub model: &'static str,
    pub gap_policy: &'static str,
}

/// A progress message (`fraction` is 0..1).
#[derive(Debug, Serialize, Clone, Copy)]
pub struct ProgressDto {
    pub fraction: f64,
}

/// Parses a request value, mapping a malformed request to an error the page can show.
pub fn parse_request<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, JobError> {
    serde_json::from_value(value).map_err(|e| JobError::new("invalid-argument", format!("Malformed request: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn align_request(scoring: serde_json::Value) -> serde_json::Value {
        json!({ "type": "align", "a": "ACGT", "b": "ACGT", "alphabet": "dna", "mode": "global", "scoring": scoring, "enumerateCap": 1000 })
    }

    #[test]
    fn parses_the_typescript_request_shapes() {
        let simple = json!({ "substitution": { "kind": "simple", "match": 2, "mismatch": -3 }, "gaps": { "kind": "affine", "open": 5, "extend": 1 } });
        let req: AlignRequestDto = parse_request(align_request(simple)).expect("valid"); // test code
        assert_eq!(
            req.scoring.to_core().expect("scoring"),
            ScoringSpec {
                substitution: SubstitutionSpec::Simple {
                    match_score: 2,
                    mismatch_score: -3
                },
                gaps: GapModel::Affine { open: 5, extend: 1 }
            }
        ); // test code
        let matrix =
            json!({ "substitution": { "kind": "matrix", "name": "BLOSUM62" }, "gaps": { "kind": "linear", "gap": 4 } });
        let req: AlignRequestDto = parse_request(align_request(matrix)).expect("valid"); // test code
        assert_eq!(
            req.scoring.to_core().expect("scoring"),
            ScoringSpec {
                substitution: SubstitutionSpec::Matrix {
                    name: "BLOSUM62".into()
                },
                gaps: GapModel::Linear { gap: 4 }
            }
        ); // test code
        assert_eq!(req.cap(), Ok(1000));
    }

    #[test]
    fn non_whole_or_out_of_range_numbers_get_the_typescript_wording() {
        let bad = |v: serde_json::Value| {
            let req: AlignRequestDto = parse_request(align_request(v)).expect("shape ok"); // test code
            req.scoring.to_core().expect_err("should be rejected").message // test code
        };
        assert_eq!(
            bad(
                json!({ "substitution": { "kind": "simple", "match": 2.5, "mismatch": -3 }, "gaps": { "kind": "linear", "gap": 1 } })
            ),
            "Match score must be a whole number between -1000 and 1000, got 2.5."
        );
        assert_eq!(
            bad(
                json!({ "substitution": { "kind": "simple", "match": 2, "mismatch": -3 }, "gaps": { "kind": "linear", "gap": -1 } })
            ),
            "Gap penalty (open) must be a whole number between 0 and 10000, got -1."
        );
        assert_eq!(
            bad(
                json!({ "substitution": { "kind": "simple", "match": 2, "mismatch": -3 }, "gaps": { "kind": "affine", "open": 5, "extend": 10001 } })
            ),
            "Gap penalty (extend) must be a whole number between 0 and 10000, got 10001."
        );
    }

    #[test]
    fn malformed_requests_are_invalid_argument_errors() {
        let e = parse_request::<AlignRequestDto>(json!({ "a": "A" })).expect_err("missing fields"); // test code
        assert_eq!(e.code, "invalid-argument");
        let e = parse_request::<AlignRequestDto>(align_request(
            json!({ "substitution": { "kind": "weird" }, "gaps": { "kind": "linear", "gap": 1 } }),
        ))
        .expect_err("unknown kind"); // test code
        assert_eq!(e.code, "invalid-argument");
    }

    #[test]
    fn enumeration_cap_must_be_a_positive_whole_number() {
        let mut req: AlignRequestDto = parse_request(align_request(json!({ "substitution": { "kind": "simple", "match": 1, "mismatch": -1 }, "gaps": { "kind": "linear", "gap": 1 } }))).expect("valid"); // test code
        for bad in [0.0, -3.0, 1.5] {
            req.enumerate_cap = bad;
            assert_eq!(req.cap().expect_err("bad cap").code, BioErrorCode::InvalidArgument);
        }
        req.enumerate_cap = 1e300;
        assert!(req.cap().is_ok(), "an absurdly large cap is clamped, not an error");
    }

    #[test]
    fn shuffle_counts_and_seed_validation_matches_typescript() {
        let make = |shuffles: f64, seed: f64| ShuffleRequestDto {
            a: "A".into(),
            b: "A".into(),
            alphabet: "dna".into(),
            mode: "global".into(),
            scoring: ScoringDto {
                substitution: SubstitutionDto::Simple {
                    match_score: 1.0,
                    mismatch: -1.0,
                },
                gaps: GapsDto::Linear { gap: 1.0 },
            },
            shuffles,
            seed,
        };
        assert_eq!(make(100.0, 4_294_967_295.0).counts(), Ok((100, u32::MAX)));
        assert_eq!(
            make(0.0, 1.0).counts().expect_err("zero").message,
            "Number of shuffles must be a whole number from 1 to 5000."
        );
        assert_eq!(
            make(5001.0, 1.0).counts().expect_err("too many").code,
            BioErrorCode::InvalidArgument
        );
        assert_eq!(
            make(1.5, 1.0).counts().expect_err("fraction").code,
            BioErrorCode::InvalidArgument
        );
        assert_eq!(
            make(5.0, -1.0).counts().expect_err("bad seed").message,
            "Seed must be an integer from 0 to 4294967295, got -1."
        );
    }

    #[test]
    fn unknown_alphabet_and_mode_are_rejected() {
        assert!(parse_alphabet("dna").is_ok() && parse_alphabet("DNA").is_err());
        assert!(parse_mode("local").is_ok() && parse_mode("semi").is_err());
    }
}
