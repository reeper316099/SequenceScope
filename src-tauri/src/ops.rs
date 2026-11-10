//! The "small calculations" the page asks Rust for through the single `bio_op` command: reference data (limits and
//! substitution matrices), FASTA parsing and writing, and alphabet detection (more groups are added in later steps).
//! Each operation is a plain function on validated input, so it is unit-tested without a window. The request is a tagged
//! enum: anything that is not a known `op` with the right fields is refused, which keeps the permission surface to ONE
//! command. Results are shaped exactly like the values the TypeScript functions return, so the page can swap them.

use crate::dto::{ScoringDto, SeqDto, parse_alphabet, parse_mode};
use crate::jobs::JobError;
use crate::ops_msa;
use crate::ops_tree::{self, EditIn, MatrixIn, TreeIn};
use sequencescope_core::alignstats::{CellInfo, CellValues, cell_info};
use sequencescope_core::alphabet::{Confidence, detect_alphabet};
use sequencescope_core::bootstrap::MAX_REPLICATES;
use sequencescope_core::distance::{DistanceModel, MAX_TREE_TAXA, models_for};
use sequencescope_core::fasta::{AlphabetChoice, FastaIssue, ParseOptions, Sequence, parse_fasta, write_fasta};
use sequencescope_core::matrices::{MATRIX_CITATION, MATRIX_SOURCE, get_matrix, list_matrices};
use sequencescope_core::msa::{MAX_MSA_LENGTH, MAX_MSA_SEQS};
use sequencescope_core::pairwise::{MAX_DP_CELLS, MAX_ENUMERATED_ALIGNMENTS, assert_within_cap};
use sequencescope_core::scoring::compile_scoring;
use sequencescope_core::shuffle::MAX_SHUFFLES;
use sequencescope_core::types::Alphabet;
use serde::Deserialize;
use serde_json::{Value, json};

/// Largest text a single request may carry (the app refuses files over 10 MB, and an alignment export is smaller).
pub const MAX_TEXT_BYTES: usize = 50 * 1024 * 1024;

/// Every operation the page may ask for. Unknown operations and extra or missing fields are errors.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OpRequest {
    /// The size limits and the bundled substitution matrices (asked for once, at start-up).
    ReferenceData,
    /// Parse FASTA (or raw residues) into records plus every issue.
    FastaParse {
        text: String,
        alphabet: String,
        #[serde(default)]
        allow_gaps: bool,
    },
    /// Write records as FASTA with the given line width.
    FastaWrite { records: Vec<SeqDto>, width: f64 },
    /// Guess the alphabet of some residues.
    DetectAlphabet { residues: String },
    /// Check a scoring choice and the table size before an alignment starts (typed errors, like the job itself).
    AlignPrecheck {
        alphabet: String,
        scoring: ScoringDto,
        len_a: f64,
        len_b: f64,
    },
    /// Build the UPGMA and neighbor-joining trees (with every step) from a distance matrix.
    TreeBuild { matrix: MatrixIn },
    /// The same, from plain rows of numbers (teaching examples).
    TreeBuildRows { names: Vec<String>, rows: Vec<Vec<f64>> },
    /// Parse a Newick string (optionally requiring named, unique leaves).
    NewickParse {
        text: String,
        #[serde(default)]
        validate: bool,
    },
    /// Write several trees as Newick.
    NewickWrite {
        trees: Vec<TreeIn>,
        include_lengths: bool,
        include_support: bool,
    },
    /// Rotate a node, re-root, or midpoint-root a tree.
    TreeEdit { tree: TreeIn, edit: EditIn },
    /// Robinson-Foulds comparison plus the branches each tree lacks in the other.
    TreeCompare { a: TreeIn, b: TreeIn },
    /// Leaf names and the path distance between every pair of leaves.
    LeafDistances { tree: TreeIn },
    /// The corrected distance for each observed proportion.
    CorrectDistance { model: String, ps: Vec<f64> },
    /// A distance matrix as CSV or PHYLIP text.
    DistanceExport { matrix: MatrixIn, format: String },
    /// Per-column conservation statistics of an alignment.
    Conservation {
        rows: Vec<String>,
        alphabet: String,
        #[serde(default = "default_threshold")]
        threshold: f64,
    },
    /// Conservation as CSV text.
    ConservationCsv { rows: Vec<String>, alphabet: String },
    /// The sum-of-pairs score of an alignment.
    SumOfPairs {
        rows: Vec<String>,
        alphabet: String,
        scoring: ScoringDto,
    },
    /// The exhaustive sum-of-pairs optimum for a tiny set.
    BruteForce {
        seqs: Vec<String>,
        alphabet: String,
        scoring: ScoringDto,
    },
    /// Explain one DP cell from the table values around it.
    CellInfo {
        mode: String,
        i: f64,
        j: f64,
        letter_a: String,
        letter_b: String,
        alphabet: String,
        scoring: ScoringDto,
        values: CellValuesDto,
    },
}

/// The default consensus threshold (half of the sequences).
fn default_threshold() -> f64 {
    0.5
}

/// The table entries around a DP cell, as the page reads them from the tables it already holds.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CellValuesDto {
    Linear {
        diag: i32,
        up: i32,
        left: i32,
        here: i32,
        pointer: u8,
    },
    Affine {
        diag: [i32; 3],
        up: [i32; 3],
        left: [i32; 3],
        here: [i32; 3],
        pointer: u16,
    },
}

/// Runs one operation and returns its result as JSON.
pub fn run_op(req: OpRequest) -> Result<Value, JobError> {
    match req {
        OpRequest::Conservation {
            rows,
            alphabet,
            threshold,
        } => ops_msa::conservation_op(&rows, &alphabet, threshold),
        OpRequest::ConservationCsv { rows, alphabet } => ops_msa::conservation_csv_op(&rows, &alphabet),
        OpRequest::SumOfPairs {
            rows,
            alphabet,
            scoring,
        } => ops_msa::sum_of_pairs_op(&rows, &alphabet, &scoring),
        OpRequest::BruteForce {
            seqs,
            alphabet,
            scoring,
        } => ops_msa::brute_force_op(&seqs, &alphabet, &scoring),
        OpRequest::TreeBuild { matrix } => ops_tree::tree_build(&matrix),
        OpRequest::TreeBuildRows { names, rows } => ops_tree::tree_build_rows(&names, &rows),
        OpRequest::NewickParse { text, validate } => {
            check_text(&text)?;
            ops_tree::newick_parse(&text, validate)
        }
        OpRequest::NewickWrite {
            trees,
            include_lengths,
            include_support,
        } => ops_tree::newick_write(&trees, include_lengths, include_support),
        OpRequest::TreeEdit { tree, edit } => ops_tree::tree_edit(&tree, &edit),
        OpRequest::TreeCompare { a, b } => ops_tree::tree_compare(&a, &b),
        OpRequest::LeafDistances { tree } => ops_tree::leaf_dist(&tree),
        OpRequest::CorrectDistance { model, ps } => ops_tree::correct_curve(&model, &ps),
        OpRequest::DistanceExport { matrix, format } => ops_tree::distance_export(&matrix, &format),
        OpRequest::AlignPrecheck {
            alphabet,
            scoring,
            len_a,
            len_b,
        } => align_precheck(&alphabet, &scoring, len_a, len_b),
        OpRequest::CellInfo {
            mode,
            i,
            j,
            letter_a,
            letter_b,
            alphabet,
            scoring,
            values,
        } => cell_info_json(&mode, i, j, &letter_a, &letter_b, &alphabet, &scoring, &values),
        OpRequest::ReferenceData => reference_data(),
        OpRequest::FastaParse {
            text,
            alphabet,
            allow_gaps,
        } => fasta_parse(&text, &alphabet, allow_gaps),
        OpRequest::FastaWrite { records, width } => fasta_write(&records, width),
        OpRequest::DetectAlphabet { residues } => {
            check_text(&residues)?;
            Ok(detection_json(&residues))
        }
    }
}

/// Refuses text over the size limit.
fn check_text(text: &str) -> Result<(), JobError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(JobError::new(
            "too-large",
            format!("The text is larger than {} MB.", MAX_TEXT_BYTES / 1_048_576),
        ));
    }
    Ok(())
}

/// The limits and the matrices (name, letters, values, checksum, citation, source).
fn reference_data() -> Result<Value, JobError> {
    let mut matrices = Vec::new();
    for name in list_matrices() {
        let m = get_matrix(name)?;
        matrices.push(json!({
            "name": m.name, "letters": m.letters, "values": m.values, "sha256": m.sha256,
            "citation": MATRIX_CITATION, "source": MATRIX_SOURCE,
        }));
    }
    Ok(json!({
        "limits": {
            "maxDpCells": MAX_DP_CELLS, "maxEnumeratedAlignments": MAX_ENUMERATED_ALIGNMENTS,
            "maxTreeTaxa": MAX_TREE_TAXA, "maxMsaSeqs": MAX_MSA_SEQS, "maxMsaLength": MAX_MSA_LENGTH,
            "maxReplicates": MAX_REPLICATES, "maxShuffles": MAX_SHUFFLES,
        },
        "matrices": matrices,
        "modelsFor": {
            "dna": models_for(Alphabet::Dna).map(DistanceModel::as_str),
            "rna": models_for(Alphabet::Rna).map(DistanceModel::as_str),
            "protein": models_for(Alphabet::Protein).map(DistanceModel::as_str),
        },
    }))
}

/// `{ id, description, alphabet, residues }`, like the TypeScript `Sequence`.
fn sequence_json(s: &Sequence) -> Value {
    json!({ "id": s.id, "description": s.description, "alphabet": s.alphabet.as_str(), "residues": s.residues })
}

/// One issue, like the TypeScript `FastaIssue` (`positions` only when present).
fn issue_json(i: &FastaIssue) -> Value {
    let mut o = json!({
        "severity": i.severity.as_str(), "code": i.code.as_str(), "recordIndex": i.record_index,
        "recordId": i.record_id, "message": i.message,
    });
    if let (Some(positions), Some(map)) = (&i.positions, o.as_object_mut()) {
        map.insert("positions".to_string(), json!(positions));
    }
    o
}

/// Parses an alphabet choice: "auto" or one alphabet.
pub fn parse_choice(s: &str) -> Result<AlphabetChoice, JobError> {
    if s == "auto" {
        return Ok(AlphabetChoice::Auto);
    }
    Ok(AlphabetChoice::Fixed(parse_alphabet(s)?))
}

/// FASTA text to records and issues.
fn fasta_parse(text: &str, alphabet: &str, allow_gaps: bool) -> Result<Value, JobError> {
    check_text(text)?;
    let options = ParseOptions {
        alphabet: parse_choice(alphabet)?,
        allow_gaps,
    };
    let parsed = parse_fasta(text, options);
    Ok(json!({
        "records": parsed.records.iter().map(sequence_json).collect::<Vec<_>>(),
        "issues": parsed.issues.iter().map(issue_json).collect::<Vec<_>>(),
    }))
}

/// Records to FASTA text. The width must be a whole number from 1 to 10,000,000 (the app uses 60 and a huge value for "one line").
fn fasta_write(records: &[SeqDto], width: f64) -> Result<Value, JobError> {
    if width.fract() != 0.0 || !(1.0..=10_000_000.0).contains(&width) {
        return Err(JobError::new(
            "invalid-argument",
            "The line width must be a whole number from 1 to 10,000,000.",
        ));
    }
    // The writer uses only the name, description and residues, so the alphabet field is a placeholder.
    let core: Vec<Sequence> = records.iter().map(|r| r.to_core(Alphabet::Dna)).collect();
    Ok(json!(write_fasta(&core, width as usize)))
}

/// The alphabet guess, like the TypeScript `Detection` ("unknown" when nothing fits).
fn detection_json(residues: &str) -> Value {
    let d = detect_alphabet(residues);
    json!({
        "alphabet": d.alphabet.map_or("unknown", |a| a.as_str()),
        "confidence": match d.confidence { Confidence::High => "high", Confidence::Low => "low" },
        "reason": d.reason,
    })
}

/// A whole, non-negative number below 1e9 (cell coordinates and sequence lengths).
fn count_field(name: &str, v: f64) -> Result<usize, JobError> {
    if v.fract() != 0.0 || !(0.0..=1e9).contains(&v) {
        return Err(JobError::new(
            "invalid-argument",
            format!("{name} must be a whole number from 0 to 1,000,000,000."),
        ));
    }
    Ok(v as usize)
}

/// Validates the scoring and the table size for an alignment of lengths m and n, like the TypeScript pre-check.
fn align_precheck(alphabet: &str, scoring: &ScoringDto, len_a: f64, len_b: f64) -> Result<Value, JobError> {
    let alphabet = parse_alphabet(alphabet)?;
    let sc = compile_scoring(&scoring.to_core()?, alphabet)?;
    assert_within_cap(
        count_field("Length A", len_a)?,
        count_field("Length B", len_b)?,
        sc.affine,
    )?;
    Ok(json!({ "affine": sc.affine }))
}

/// One cell's explanation as JSON, shaped like the TypeScript `CellInfo`.
#[allow(clippy::too_many_arguments)] // a flat set of request fields; grouping them would only move the same list elsewhere
fn cell_info_json(
    mode: &str,
    i: f64,
    j: f64,
    letter_a: &str,
    letter_b: &str,
    alphabet: &str,
    scoring: &ScoringDto,
    values: &CellValuesDto,
) -> Result<Value, JobError> {
    let mode = parse_mode(mode)?;
    let (i, j) = (count_field("Row", i)?, count_field("Column", j)?);
    let sc = compile_scoring(&scoring.to_core()?, parse_alphabet(alphabet)?)?;
    let one = |s: &str| -> Option<char> {
        let mut it = s.chars();
        it.next().filter(|_| it.next().is_none())
    };
    let letters = one(letter_a).zip(one(letter_b));
    let cv = match values {
        CellValuesDto::Linear {
            diag,
            up,
            left,
            here,
            pointer,
        } => CellValues::Linear {
            diag: *diag,
            up: *up,
            left: *left,
            here: *here,
            pointer: *pointer,
        },
        CellValuesDto::Affine {
            diag,
            up,
            left,
            here,
            pointer,
        } => CellValues::Affine {
            diag: *diag,
            up: *up,
            left: *left,
            here: *here,
            pointer: *pointer,
        },
    };
    Ok(match cell_info(mode, i, j, letters, &sc, &cv)? {
        CellInfo::Border { i, j, value, note } => {
            json!({ "kind": "border", "i": i, "j": j, "value": value, "note": note })
        }
        CellInfo::Linear {
            i,
            j,
            s,
            diag,
            up,
            left,
            zero_floor,
            value,
            chosen,
        } => json!({
            "kind": "linear", "i": i, "j": j, "s": s, "diag": diag, "up": up, "left": left,
            "zeroFloor": zero_floor, "value": value, "chosen": chosen,
        }),
        CellInfo::Affine { i, j, s, m, x, y } => json!({
            "kind": "affine", "i": i, "j": j, "s": s,
            "M": { "fromM": m.from_m, "fromX": m.from_x, "fromY": m.from_y, "startFresh": m.start_fresh, "value": m.value, "chosen": m.chosen },
            "X": { "openFromM": x.open_from_m, "extendX": x.extend_x, "openFromY": x.open_from_y, "value": x.value, "chosen": x.chosen },
            "Y": { "openFromM": y.open_from_m, "openFromX": y.open_from_x, "extendY": y.extend_y, "value": y.value, "chosen": y.chosen },
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::parse_request;

    fn run(v: Value) -> Result<Value, JobError> {
        run_op(parse_request::<OpRequest>(v)?)
    }

    #[test]
    fn unknown_operations_and_bad_fields_are_refused() {
        assert!(parse_request::<OpRequest>(json!({ "op": "deleteEverything" })).is_err());
        assert!(parse_request::<OpRequest>(json!({ "op": "fastaParse", "text": 5 })).is_err());
        assert!(parse_request::<OpRequest>(json!({ "op": "fastaParse" })).is_err());
    }

    #[test]
    fn reference_data_lists_limits_and_every_matrix() {
        let v = run(json!({ "op": "referenceData" })).expect("runs"); // test code
        assert_eq!(v["limits"]["maxDpCells"], 5001 * 5001);
        assert_eq!(v["limits"]["maxTreeTaxa"], 100);
        assert_eq!(v["limits"]["maxMsaSeqs"], 50);
        let names: Vec<&str> = v["matrices"]
            .as_array()
            .expect("array") // test code
            .iter()
            .map(|m| m["name"].as_str().expect("name")) // test code
            .collect();
        assert_eq!(names, list_matrices());
        let blosum = &v["matrices"][names.iter().position(|n| *n == "BLOSUM62").expect("has BLOSUM62")]; // test code
        let n = blosum["letters"].as_str().expect("letters").len(); // test code
        assert_eq!(blosum["values"].as_array().expect("values").len(), n * n); // test code
        assert!(blosum["citation"].as_str().expect("citation").contains("Henikoff")); // test code
    }

    #[test]
    fn fasta_parse_matches_the_typescript_shape() {
        let v = run(
            json!({ "op": "fastaParse", "text": ">a desc\nACGT\n>b\nAC-T\n", "alphabet": "auto", "allowGaps": true }),
        )
        .expect("runs"); // test code
        assert_eq!(
            v["records"][0],
            json!({ "id": "a", "description": "desc", "alphabet": "dna", "residues": "ACGT" })
        );
        assert_eq!(v["records"][1]["residues"], "AC-T");
        let bad = run(json!({ "op": "fastaParse", "text": ">a\nAC#T\n", "alphabet": "dna" })).expect("runs"); // test code
        let issue = &bad["issues"][0];
        assert_eq!(
            (issue["code"].as_str(), issue["severity"].as_str()),
            (Some("invalid-characters"), Some("error"))
        );
        assert_eq!(issue["positions"], json!([3]));
        assert!(issue["recordIndex"].is_number());
        let empty = run(json!({ "op": "fastaParse", "text": "", "alphabet": "auto" })).expect("runs"); // test code
        assert_eq!(empty["issues"][0]["code"], "no-records");
        assert!(
            empty["issues"][0].get("positions").is_none(),
            "positions only when present"
        );
        assert!(empty["issues"][0]["recordIndex"].is_null());
    }

    #[test]
    fn fasta_write_validates_the_width_and_round_trips() {
        let rec = json!([{ "id": "a", "description": "", "alphabet": "dna", "residues": "ACGTACGT" }]);
        let v = run(json!({ "op": "fastaWrite", "records": rec, "width": 4 })).expect("runs"); // test code
        assert_eq!(v, json!(">a\nACGT\nACGT\n"));
        assert_eq!(
            run(json!({ "op": "fastaWrite", "records": rec, "width": 0 }))
                .expect_err("bad width")
                .code,
            "invalid-argument"
        );
        assert!(run(json!({ "op": "fastaWrite", "records": rec, "width": 1_000_000 })).is_ok());
    }

    #[test]
    fn alphabet_detection_reports_unknown_and_confidence() {
        let v = run(json!({ "op": "detectAlphabet", "residues": "ACGUACGUACGUACGUAAAACCCCGGGGUUUU" })).expect("runs"); // test code
        assert_eq!(v["alphabet"], "rna");
        let none = run(json!({ "op": "detectAlphabet", "residues": "" })).expect("runs"); // test code
        assert_eq!(
            (none["alphabet"].as_str(), none["confidence"].as_str()),
            (Some("unknown"), Some("low"))
        );
    }
}
