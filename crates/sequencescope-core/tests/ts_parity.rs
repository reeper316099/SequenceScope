//! TypeScript-vs-Rust PARITY. tests/fixtures/parity/*.json were produced by running the TypeScript reference
//! implementation on a fixed, seeded input set (npm run parity:generate). These tests replay every input through the Rust
//! code and demand IDENTICAL output: scores, gapped rows, coordinates, co-optimal counts and order, the TIE-BREAKING, a
//! hash of every DP table (so each cell and traceback pointer matches), typed errors with their messages, and FASTA issue
//! lists with their message texts. Each test prints "N inputs, M mismatches" (run with --nocapture to see it).

mod common;

use common::{
    alignment_json, alphabet_from_str, mode_from_str, normalize_numbers, read_json, spec_from_json, table_hashes,
};
use sequencescope_core::alphabet::{clean_sequence_text, detect_alphabet, find_invalid};
use sequencescope_core::error::BioError;
use sequencescope_core::fasta::{
    AlphabetChoice, FastaIssue, ParseOptions, ParsedFasta, Sequence, parse_fasta, write_fasta,
};
use sequencescope_core::matrices::{get_matrix, list_matrices};
use sequencescope_core::pairwise::{align_score_only, fill_matrix, traceback_all, traceback_first};
use sequencescope_core::rng::{Rng, derive_seed};
use sequencescope_core::scoring::compile_scoring;
use sequencescope_core::shuffle::{ShuffleOptions, ShuffleOutcome, run_shuffle_test, shuffle_residues};
use sequencescope_core::types::Alphabet;
use serde_json::{Value, json};

/// Prints the parity summary and fails with the first few differences if there are any.
fn report(label: &str, total: usize, mismatches: &[String]) {
    println!("{label}: {total} inputs, {} mismatches", mismatches.len());
    assert!(
        mismatches.is_empty(),
        "{label}: {} of {total} differ. First:\n{}",
        mismatches.len(),
        mismatches.iter().take(3).cloned().collect::<Vec<_>>().join("\n---\n")
    );
}

/// Runs one pairwise case through Rust and builds the same JSON shape the TypeScript generator wrote.
fn rust_pairwise(case: &Value) -> Result<Value, BioError> {
    let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
    let mode = mode_from_str(case["mode"].as_str().expect("mode")); // test code
    let (a, b) = (case["a"].as_str().expect("a"), case["b"].as_str().expect("b")); // test code
    let sc = compile_scoring(&spec_from_json(&case["scoring"]), alphabet)?;
    let dp = fill_matrix(a, b, mode, &sc)?;
    let first = traceback_first(&dp);
    let big = traceback_all(&dp, 1000)?;
    let small = traceback_all(&dp, 4)?;
    Ok(json!({
        "score": dp.score,
        "alignment": alignment_json(&first),
        "endsCount": dp.ends.len(),
        "endsFirst": dp.ends.iter().take(10).collect::<Vec<_>>(),
        "hashes": table_hashes(&dp.tables),
        "allCount": big.alignments.len(),
        "allCapped": big.capped,
        "first4": small.alignments.iter().map(alignment_json).collect::<Vec<_>>(),
        "first4Capped": small.capped,
        "scoreOnly": align_score_only(a, b, mode, &sc)?,
    }))
}

#[test]
fn pairwise_dp_tables_alignments_enumeration_and_errors_match_typescript() {
    let cases = read_json("tests/fixtures/parity/pairwise-ts.json");
    let cases = cases.as_array().expect("array"); // test code
    let (mut mismatches, mut errors, mut capped, mut tie_heavy) = (Vec::new(), 0, 0, 0);
    for case in cases {
        let expected = &case["expected"];
        let got = match rust_pairwise(case) {
            Ok(v) => v,
            Err(e) => json!({ "error": { "code": e.code.as_str(), "message": e.message } }),
        };
        if expected.get("error").is_some() {
            errors += 1;
        }
        if expected["allCapped"] == true {
            capped += 1;
        }
        if expected["allCount"].as_u64().unwrap_or(0) > 1 {
            tie_heavy += 1;
        }
        if &got != expected {
            let short = |v: &Value| v.to_string().chars().take(400).collect::<String>();
            mismatches.push(format!(
                "{} (alphabet {}, mode {}, a={}, b={})\n  ts:   {}\n  rust: {}",
                case["id"],
                case["alphabet"],
                case["mode"],
                case["a"],
                case["b"],
                short(expected),
                short(&got)
            ));
        }
    }
    println!(
        "pairwise parity covers {errors} typed-error inputs, {capped} capped enumerations, {tie_heavy} inputs with several co-optimal alignments"
    );
    assert!(cases.len() >= 2000 && errors >= 10 && capped >= 20 && tie_heavy >= 100);
    report("pairwise parity", cases.len(), &mismatches);
}

/// Converts a parse result to the JSON the TypeScript generator wrote (absent `positions` stay absent).
fn parsed_json(p: &ParsedFasta) -> Value {
    let issue = |i: &FastaIssue| {
        let mut v = json!({ "severity": i.severity.as_str(), "code": i.code.as_str(), "recordIndex": i.record_index, "recordId": i.record_id, "message": i.message });
        if let Some(pos) = &i.positions {
            v["positions"] = json!(pos);
        }
        v
    };
    let rec = |r: &Sequence| json!({ "id": r.id, "description": r.description, "alphabet": r.alphabet.as_str(), "residues": r.residues });
    json!({ "records": p.records.iter().map(rec).collect::<Vec<_>>(), "issues": p.issues.iter().map(issue).collect::<Vec<_>>() })
}

#[test]
fn fasta_parsing_issues_and_messages_match_typescript() {
    let fixture = read_json("tests/fixtures/parity/fasta-ts.json");
    let cases = fixture["parseCases"].as_array().expect("parseCases"); // test code
    let mut mismatches = Vec::new();
    for c in cases {
        let alphabet = match c["options"]["alphabet"].as_str() {
            None | Some("auto") => AlphabetChoice::Auto,
            Some(s) => AlphabetChoice::Fixed(Alphabet::parse(s).expect("alphabet")), // test code
        };
        let options = ParseOptions {
            alphabet,
            allow_gaps: c["options"]["allowGaps"].as_bool().unwrap_or(false),
        };
        let got = parsed_json(&parse_fasta(c["text"].as_str().expect("text"), options)); // test code
        if got != c["expected"] {
            mismatches.push(format!(
                "{} options {}\n  text: {:?}\n  ts:   {}\n  rust: {}",
                c["name"], c["options"], c["text"], c["expected"], got
            ));
        }
    }
    assert!(cases.len() > 500);
    report("FASTA parse parity", cases.len(), &mismatches);
}

#[test]
fn alphabet_helpers_match_typescript() {
    let fixture = read_json("tests/fixtures/parity/fasta-ts.json");
    let cases = fixture["helperCases"].as_array().expect("helperCases"); // test code
    let mut mismatches = Vec::new();
    for c in cases {
        let raw = c["raw"].as_str().expect("raw"); // test code
        let cleaned = clean_sequence_text(raw);
        let det = detect_alphabet(&cleaned.residues);
        let invalid = |a: Alphabet, gaps: bool| {
            json!(
                find_invalid(&cleaned.residues, a, gaps)
                    .iter()
                    .map(|b| json!({ "index": b.index, "char": b.ch.to_string() }))
                    .collect::<Vec<_>>()
            )
        };
        let got = json!({
            "clean": { "residues": cleaned.residues, "removedWhitespace": cleaned.removed_whitespace, "removedDigits": cleaned.removed_digits },
            "detect": { "alphabet": det.alphabet.map_or("unknown", Alphabet::as_str), "confidence": det.confidence.as_str(), "reason": det.reason },
            "invalidDna": invalid(Alphabet::Dna, false),
            "invalidProteinGaps": invalid(Alphabet::Protein, true),
        });
        let expected = json!({ "clean": c["clean"], "detect": c["detect"], "invalidDna": c["invalidDna"], "invalidProteinGaps": c["invalidProteinGaps"] });
        if got != expected {
            mismatches.push(format!("{raw:?}\n  ts:   {expected}\n  rust: {got}"));
        }
    }
    assert!(cases.len() > 400);
    report("alphabet helper parity", cases.len(), &mismatches);
}

#[test]
fn fasta_writing_matches_typescript() {
    let fixture = read_json("tests/fixtures/parity/fasta-ts.json");
    for c in fixture["writeCases"].as_array().expect("writeCases") {
        // test code
        let records: Vec<Sequence> = c["records"]
            .as_array()
            .expect("records") // test code
            .iter()
            .map(|r| Sequence {
                id: r["id"].as_str().expect("id").to_string(), // test code
                description: r["description"].as_str().expect("description").to_string(), // test code
                alphabet: Alphabet::parse(r["alphabet"].as_str().expect("alphabet")).expect("known alphabet"), // test code
                residues: r["residues"].as_str().expect("residues").to_string(), // test code
            })
            .collect();
        let width = c["width"].as_u64().expect("width") as usize; // test code
        assert_eq!(write_fasta(&records, width), c["expected"].as_str().expect("expected")); // test code
    }
}

#[test]
fn substitution_matrices_match_typescript_values_and_checksums() {
    let fixture = read_json("tests/fixtures/parity/matrices-ts.json");
    let ts = fixture.as_array().expect("array"); // test code
    assert_eq!(ts.len(), list_matrices().len());
    let mut cells = 0;
    for m in ts {
        let rust = get_matrix(m["name"].as_str().expect("name")).expect("bundled matrix"); // test code
        assert_eq!(rust.letters, m["letters"].as_str().expect("letters"), "{}", rust.name); // test code
        assert_eq!(
            rust.sha256,
            m["sha256"].as_str().expect("sha256"),
            "{}: checksum",
            rust.name
        ); // test code
        let values: Vec<i64> = m["values"]
            .as_array()
            .expect("values")
            .iter()
            .map(|v| v.as_i64().expect("int"))
            .collect(); // test code
        assert_eq!(
            rust.values.iter().map(|&v| i64::from(v)).collect::<Vec<_>>(),
            values,
            "{}: values",
            rust.name
        );
        cells += values.len();
    }
    println!("matrix parity: {cells} cells, 0 mismatches");
}

#[test]
fn prng_streams_and_derived_seeds_match_typescript_exactly() {
    let fixture = read_json("tests/fixtures/parity/rng-shuffle-ts.json");
    let cases = fixture["rngCases"].as_array().expect("rngCases"); // test code
    let mut values = 0;
    for c in cases {
        let seed = c["seed"].as_u64().expect("seed") as u32; // test code
        let mut r = Rng::new(seed);
        let u32s: Vec<u32> = (0..30).map(|_| r.next_u32()).collect();
        assert_eq!(json!(u32s), c["u32"], "seed {seed}: uint32 stream");
        let mut r = Rng::new(seed);
        let floats: Vec<f64> = (0..10).map(|_| r.next_float()).collect();
        assert_eq!(json!(floats), c["floats"], "seed {seed}: floats are bit-identical");
        for entry in c["ints"].as_array().expect("ints") {
            // test code
            let bound = entry["bound"].as_u64().expect("bound"); // test code
            let mut r = Rng::new(seed);
            let got: Vec<u32> = (0..20).map(|_| r.next_int(bound).expect("valid bound")).collect(); // test code
            assert_eq!(json!(got), entry["values"], "seed {seed} bound {bound}");
        }
        for d in c["derived"].as_array().expect("derived") {
            // test code
            let stream = d["stream"].as_u64().expect("stream") as u32; // test code
            assert_eq!(
                json!(derive_seed(seed, stream)),
                d["seed"],
                "seed {seed} stream {stream}"
            );
        }
        values += 30 + 10 + 9 * 20 + 7;
    }
    println!("PRNG parity: {} seeds, {values} values, 0 mismatches", cases.len());
}

#[test]
fn shuffling_matches_typescript() {
    let fixture = read_json("tests/fixtures/parity/rng-shuffle-ts.json");
    let cases = fixture["shuffleCases"].as_array().expect("shuffleCases"); // test code
    let mut mismatches = Vec::new();
    for c in cases {
        let seed = c["seed"].as_u64().expect("seed") as u32; // test code
        let got = shuffle_residues(&mut Rng::new(seed), c["input"].as_str().expect("input")).expect("shuffle"); // test code
        if json!(got) != c["expected"] {
            mismatches.push(format!(
                "seed {seed} input {}: ts {} rust {got}",
                c["input"], c["expected"]
            ));
        }
    }
    report("shuffle parity", cases.len(), &mismatches);
}

/// Runs one shuffle-test case in Rust and builds the same JSON shape as the TypeScript generator.
fn rust_shuffle_test(c: &Value) -> Value {
    let alphabet = alphabet_from_str(c["alphabet"].as_str().expect("alphabet")); // test code
    let mode = mode_from_str(c["mode"].as_str().expect("mode")); // test code
    let sc = compile_scoring(&spec_from_json(&c["scoring"]), alphabet).expect("valid scoring"); // test code
    let opts = ShuffleOptions {
        a: c["a"].as_str().expect("a"), // test code
        b: c["b"].as_str().expect("b"), // test code
        mode,
        scoring: &sc,
        shuffles: c["shuffles"].as_u64().expect("shuffles") as u32, // test code
        seed: c["seed"].as_u64().expect("seed") as u32,             // test code
    };
    match run_shuffle_test(&opts, &mut |_| {}, &mut || false) {
        Ok(ShuffleOutcome::Done(r)) => {
            json!({ "realScore": r.real_score, "scores": r.scores, "mean": r.mean, "sd": r.sd, "z": r.z, "atLeastAsGood": r.at_least_as_good, "pValue": r.p_value })
        }
        Ok(ShuffleOutcome::Cancelled { .. }) => json!({ "error": "unexpected cancel" }),
        Err(e) => json!({ "error": { "code": e.code.as_str(), "message": e.message } }),
    }
}

#[test]
fn shuffle_significance_test_matches_typescript_including_floats() {
    let fixture = read_json("tests/fixtures/parity/rng-shuffle-ts.json");
    let cases = fixture["testCases"].as_array().expect("testCases"); // test code
    let mut mismatches = Vec::new();
    let mut errors = 0;
    for c in cases {
        if c["expected"].get("error").is_some() {
            errors += 1;
        }
        let got = normalize_numbers(&rust_shuffle_test(c));
        if got != normalize_numbers(&c["expected"]) {
            mismatches.push(format!(
                "shuffles {} seed {} a={} b={}\n  ts:   {}\n  rust: {}",
                c["shuffles"], c["seed"], c["a"], c["b"], c["expected"], got
            ));
        }
    }
    assert!(errors >= 3, "the fixture must include typed-error cases");
    report(
        "shuffle-test parity (every score, mean, sd, z, p-value bit-identical)",
        cases.len(),
        &mismatches,
    );
}
