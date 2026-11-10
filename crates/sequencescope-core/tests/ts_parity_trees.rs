//! TypeScript-vs-Rust PARITY for Checkpoint 4: distances, UPGMA and neighbor-joining (every recorded step), tree utilities,
//! Newick (writing and parsing, including error positions), Robinson-Foulds, and the column bootstrap. tests/fixtures/parity/
//! *.json hold the TypeScript outputs on seeded inputs (npm run parity:generate); every number must match EXACTLY (the
//! logarithm is V8's, see jsnum.rs). Each test prints "N inputs, M mismatches" (run with --nocapture).

mod common;

use common::*;
use sequencescope_core::bootstrap::{
    BootstrapInput, BootstrapResult, TreeMethod, bootstrap, bootstrap_threads, replicate_weights,
};
use sequencescope_core::distance::{
    assert_tree_ready, distance_matrix_from_aligned, pairwise_distance_matrix, to_distance_csv, to_phylip,
};
use sequencescope_core::fasta::Sequence;
use sequencescope_core::newick::{WriteOptions, parse_newick, write_newick};
use sequencescope_core::nj::neighbor_joining;
use sequencescope_core::scoring::compile_scoring;
use sequencescope_core::tree::*;
use sequencescope_core::treecompare::{RfResult, robinson_foulds};
use sequencescope_core::types::{Alphabet, GapModel, ScoringSpec, SubstitutionSpec};
use sequencescope_core::upgma::upgma;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

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

/// Compares two JSON values after treating 1.0 and 1 as the same number (exact otherwise); returns a short diff on mismatch.
fn compare(got: &Value, want: &Value, context: &str) -> Option<String> {
    let (g, w) = (normalize_numbers(got), normalize_numbers(want));
    (g != w).then(|| {
        let short = |v: &Value| v.to_string().chars().take(500).collect::<String>();
        format!("{context}\n  ts:   {}\n  rust: {}", short(&w), short(&g))
    })
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect() // test code
}

#[test]
fn distance_matrices_exports_and_errors_match_typescript() {
    let fx = read_json("tests/fixtures/parity/distances-ts.json");
    let cases = fx["cases"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let (mut errors, mut ln_models) = (0, 0);
    for (k, c) in cases.iter().enumerate() {
        let (names, rows) = (strings(&c["names"]), strings(&c["rows"]));
        let (alphabet, model, policy) = (
            alphabet_from_str(c["alphabet"].as_str().expect("alphabet")),
            model_of(c["model"].as_str().expect("model")),
            policy_of(c["gapPolicy"].as_str().expect("policy")),
        ); // test code
        let weights: Option<Vec<i32>> = c["weights"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_i64().expect("weight") as i32).collect()); // test code
        let got = captured(
            distance_matrix_from_aligned(&names, &rows, alphabet, model, policy, weights.as_deref()),
            |m| {
                json!({
                    "matrix": matrix_json(&m),
                    "phylip": captured(to_phylip(&m), Value::String),
                    "csv": to_distance_csv(&m),
                    "ready": captured(assert_tree_ready(&m), |()| json!(true)),
                })
            },
        );
        if c["expected"].get("error").is_some() {
            errors += 1;
        } else if model.as_str() != "p" {
            ln_models += 1;
        }
        if let Some(d) = compare(
            &got,
            &c["expected"],
            &format!("case {k}: {alphabet:?} {model:?} {policy:?} {names:?} {rows:?}"),
        ) {
            mismatches.push(d);
        }
    }
    println!(
        "distance parity covers {errors} typed-error inputs and {ln_models} Jukes-Cantor/Poisson inputs (these use the logarithm)"
    );
    assert!(errors >= 20 && ln_models >= 60);
    report("distance matrix parity", cases.len(), &mismatches);
}

#[test]
fn pairwise_alignment_distance_matrices_match_typescript() {
    let fx = read_json("tests/fixtures/parity/distances-ts.json");
    let cases = fx["pairwise"].as_array().expect("pairwise"); // test code
    let sc = compile_scoring(
        &ScoringSpec {
            substitution: SubstitutionSpec::Simple {
                match_score: 2,
                mismatch_score: -3,
            },
            gaps: GapModel::Affine { open: 5, extend: 2 },
        },
        Alphabet::Dna,
    )
    .expect("valid"); // test code
    let mut mismatches = Vec::new();
    for (k, c) in cases.iter().enumerate() {
        let seqs: Vec<Sequence> = c["seqs"]
            .as_array()
            .expect("seqs") // test code
            .iter()
            .map(|s| Sequence {
                id: s["id"].as_str().expect("id").to_string(),
                description: String::new(),
                alphabet: Alphabet::Dna,
                residues: s["residues"].as_str().expect("residues").to_string(),
            }) // test code
            .collect();
        let got = captured(
            pairwise_distance_matrix(
                &seqs,
                &sc,
                model_of(c["model"].as_str().expect("model")),
                policy_of(c["gapPolicy"].as_str().expect("policy")),
                &mut |_| {},
                &mut || false,
            ),
            |m| m.map_or(Value::Null, |m| matrix_json(&m)),
        ); // test code
        if let Some(d) = compare(&got, &c["expected"], &format!("pairwise case {k}")) {
            mismatches.push(d);
        }
    }
    report("pairwise-alignment distance parity", cases.len(), &mismatches);
}

#[test]
fn upgma_and_neighbor_joining_trees_and_every_step_match_typescript() {
    let fx = read_json("tests/fixtures/parity/trees-ts.json");
    let cases = fx["cases"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let mut steps = 0;
    for (k, c) in cases.iter().enumerate() {
        let m = matrix_of(
            c["names"].as_array().expect("names"),
            c["rows"].as_array().expect("rows"),
        ); // test code
        let (u, j) = (
            upgma(&m).expect("tree-ready"),
            neighbor_joining(&m).expect("tree-ready"),
        ); // test code
        steps += u.steps.len() + j.steps.len();
        for (what, got, want) in [("UPGMA", upgma_json(&u), &c["upgma"]), ("NJ", nj_json(&j), &c["nj"])] {
            if let Some(d) = compare(&got, want, &format!("case {k} ({}) {what}", c["kind"])) {
                mismatches.push(d);
            }
        }
    }
    // typed errors
    for e in fx["errors"].as_array().expect("errors") {
        // test code
        let mut m = matrix_of(
            e["names"].as_array().expect("names"),
            e["rows"].as_array().expect("rows"),
        ); // test code
        for pair in e["saturated"].as_array().expect("saturated") {
            // test code
            let (i, j) = (
                pair[0].as_u64().expect("i") as usize,
                pair[1].as_u64().expect("j") as usize,
            ); // test code
            m.status[i * m.n + j] = 1;
            m.status[j * m.n + i] = 1;
        }
        for (what, got, want) in [
            ("UPGMA", captured(upgma(&m), |r| upgma_json(&r)), &e["upgma"]),
            ("NJ", captured(neighbor_joining(&m), |r| nj_json(&r)), &e["nj"]),
        ] {
            if let Some(d) = compare(&got, want, &format!("error case {} {what}", e["name"])) {
                mismatches.push(d);
            }
        }
    }
    println!("tree parity covers {steps} recorded steps (every matrix, Q matrix, branch length, and merged row)");
    report("UPGMA + NJ parity", cases.len() * 2 + 6, &mismatches);
}

/// Splits as the generator wrote them: entries [[key, side[]]...] and the sorted leaves.
fn splits_json(t: &Tree) -> Value {
    let s = nontrivial_splits(t).expect("valid leaves"); // test code
    json!({ "entries": s.splits.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(), "leaves": s.leaves })
}

#[test]
fn tree_utilities_match_typescript() {
    let fx = read_json("tests/fixtures/parity/tree-ops-ts.json");
    let ops = fx["ops"].as_array().expect("ops"); // test code
    let mut mismatches = Vec::new();
    let mut checks = 0;
    for o in ops {
        let id = o["id"].as_str().unwrap_or("?");
        let t = json_tree(&o["tree"]);
        let mut check = |what: &str, got: Value, want: &Value| {
            checks += 1;
            if let Some(d) = compare(&got, want, &format!("{id}: {what}")) {
                mismatches.push(d);
            }
        };
        check("leafNames", json!(leaf_names(&t)), &o["leafNames"]);
        check("orderedLeaves", json!(ordered_leaves(&t)), &o["orderedLeaves"]);
        check("totalLength", json!(total_length(&t)), &o["totalLength"]);
        check("hasNegative", json!(has_negative_branches(&t)), &o["hasNegative"]);
        check("splits", splits_json(&t), &o["splits"]);
        check(
            "edgeLengths",
            captured(edge_length_map(&t), |m| {
                json!(m.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>())
            }),
            &o["edgeLengths"],
        );
        check("ladderize", tree_json(&ladderize(&t)), &o["ladderized"]);
        for r in o["rotated"].as_array().expect("rotated") {
            // test code
            check(
                &format!("rotate {}", r["index"]),
                tree_json(&rotate_node(&t, r["index"].as_u64().expect("index") as usize)),
                &r["tree"],
            ); // test code
        }
        for r in o["rerooted"].as_array().expect("rerooted") {
            // test code
            let (i, f) = (
                r["index"].as_u64().expect("index") as usize,
                r["fraction"].as_f64().expect("fraction"),
            ); // test code
            check(
                &format!("reroot {i} @ {f}"),
                captured(reroot_above(&t, i, f), |x| tree_json(&x)),
                &json!(r["result"]),
            );
        }
        for r in o["rerootLeaf"].as_array().expect("rerootLeaf") {
            // test code
            check(
                &format!("reroot at leaf {}", r["name"]),
                captured(reroot_at_leaf(&t, r["name"].as_str().expect("name")), |x| tree_json(&x)),
                &r["result"],
            ); // test code
        }
        check(
            "midpoint",
            captured(midpoint_root(&t), |x| tree_json(&x)),
            &o["midpoint"],
        );
        let ld = leaf_distances(&t);
        check(
            "leafDistances",
            json!({ "names": ld.names, "dist": ld.dist }),
            &o["leafDistances"],
        );
        let percent: HashMap<String, f64> = o["percent"]
            .as_array()
            .expect("percent")
            .iter()
            .map(|e| (e[0].as_str().expect("key").to_string(), e[1].as_f64().expect("value")))
            .collect(); // test code
        check(
            "annotateSupport",
            tree_json(&annotate_support(&t, &percent)),
            &o["annotated"],
        );
    }
    report("tree utility parity", checks, &mismatches);
}

/// An RF result as JSON like the generator's `capture(robinsonFoulds)`.
fn rf_json(r: RfResult) -> Value {
    json!({ "distance": r.distance, "max": r.max, "shared": r.shared, "onlyInA": r.only_in_a, "onlyInB": r.only_in_b, "leafCount": r.leaf_count })
}

#[test]
fn robinson_foulds_matches_typescript() {
    let fx = read_json("tests/fixtures/parity/tree-ops-ts.json");
    let cases = fx["rf"].as_array().expect("rf"); // test code
    let mut mismatches = Vec::new();
    let mut errors = 0;
    for (k, c) in cases.iter().enumerate() {
        let got = captured(robinson_foulds(&json_tree(&c["a"]), &json_tree(&c["b"])), rf_json);
        if c["expected"].get("error").is_some() {
            errors += 1;
        }
        if let Some(d) = compare(&got, &c["expected"], &format!("pair {k}")) {
            mismatches.push(d);
        }
    }
    println!("RF parity covers {errors} different-leaf-set typed errors");
    assert!(cases.len() > 150);
    report("Robinson-Foulds parity", cases.len(), &mismatches);
}

/// Options from the generator ({} / includeSupport:false / includeLengths:false).
fn write_options(v: &Value) -> WriteOptions {
    WriteOptions {
        include_support: v["includeSupport"] != json!(false),
        include_lengths: v["includeLengths"] != json!(false),
    }
}

#[test]
fn newick_writing_matches_typescript_and_round_trips() {
    let fx = read_json("tests/fixtures/parity/newick-ts.json");
    let written = fx["written"].as_array().expect("written"); // test code
    let mut mismatches = Vec::new();
    for (k, w) in written.iter().enumerate() {
        let t = json_tree(&w["tree"]);
        let text = write_newick(&t, write_options(&w["options"]));
        if text != w["text"].as_str().expect("text") {
            // test code
            mismatches.push(format!("write case {k}\n  ts:   {}\n  rust: {text}", w["text"]));
        }
        if w["options"] == json!({}) {
            match parse_newick(&text) {
                Ok(back) if compare(&tree_json(&back.tree), &tree_json(&t), "roundtrip").is_none() => {}
                other => mismatches.push(format!(
                    "write -> read is not the identity for case {k}: {:?}",
                    other.map(|p| write_newick(&p.tree, WriteOptions::default()))
                )),
            }
        }
    }
    report("Newick writing parity (exact number text)", written.len(), &mismatches);
}

#[test]
fn newick_parsing_trees_and_error_positions_match_typescript() {
    let fx = read_json("tests/fixtures/parity/newick-ts.json");
    let parsed = fx["parsed"].as_array().expect("parsed"); // test code
    let mut mismatches = Vec::new();
    let (mut errors, mut oks) = (0, 0);
    for (k, p) in parsed.iter().enumerate() {
        let text = p["text"].as_str().expect("text"); // test code
        let got = match parse_newick(text) {
            Ok(r) => json!({ "ok": { "tree": tree_json(&r.tree), "extraTrees": r.extra_trees } }),
            Err(e) => {
                json!({ "error": { "code": "newick-syntax", "message": e.message, "position": e.position, "line": e.line, "column": e.column } })
            }
        };
        if got.get("error").is_some() {
            errors += 1
        } else {
            oks += 1
        }
        if let Some(d) = compare(&got, &p["expected"], &format!("parse case {k}: {text:?}")) {
            mismatches.push(d);
        }
    }
    println!(
        "Newick parse parity covers {oks} valid and {errors} invalid inputs (with exact error position, line, column, and message)"
    );
    assert!(errors >= 150 && oks >= 150);
    report("Newick parsing parity", parsed.len(), &mismatches);
}

/// Reads a bootstrap input from the generator's JSON.
fn bootstrap_input(v: &Value) -> BootstrapInput {
    BootstrapInput {
        names: strings(&v["names"]),
        rows: strings(&v["rows"]),
        alphabet: alphabet_from_str(v["alphabet"].as_str().expect("alphabet")), // test code
        model: model_of(v["model"].as_str().expect("model")),                   // test code
        gap_policy: policy_of(v["gapPolicy"].as_str().expect("policy")),        // test code
        method: TreeMethod::parse(v["method"].as_str().expect("method")).expect("known method"), // test code
        replicates: v["replicates"].as_u64().expect("replicates") as u32,       // test code
        seed: v["seed"].as_u64().expect("seed") as u32,                         // test code
    }
}

/// A bootstrap result as JSON like the generator's.
fn bootstrap_result_json(r: Option<BootstrapResult>) -> Value {
    match r {
        None => Value::Null,
        Some(r) => json!({
            "referenceTree": tree_json(&r.reference_tree),
            "supports": r.supports.iter().map(|s| json!({ "leaves": s.leaves, "count": s.count, "percent": s.percent })).collect::<Vec<_>>(),
            "replicates": r.replicates, "seed": r.seed, "failedReplicates": r.failed_replicates,
            "method": r.method.as_str(), "model": r.model.as_str(), "gapPolicy": r.gap_policy.as_str(),
        }),
    }
}

#[test]
fn bootstrap_results_weights_and_errors_match_typescript_single_and_multi_threaded() {
    let fx = read_json("tests/fixtures/parity/bootstrap-ts.json");
    let cases = fx["cases"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let (mut errors, mut with_failures) = (0, 0);
    for (k, c) in cases.iter().enumerate() {
        let inp = bootstrap_input(&c["input"]);
        let single = captured(bootstrap(&inp, &mut |_| {}, &mut || false), bootstrap_result_json);
        let multi = captured(
            bootstrap_threads(&inp, 4, &mut |_| {}, &AtomicBool::new(false)),
            bootstrap_result_json,
        );
        if c["expected"].get("error").is_some() {
            errors += 1;
        } else if c["expected"]["ok"]["failedReplicates"].as_u64().unwrap_or(0) > 0 {
            with_failures += 1;
        }
        for (what, got) in [("single-threaded", &single), ("4 threads", &multi)] {
            if let Some(d) = compare(got, &c["expected"], &format!("bootstrap case {k} ({what})")) {
                mismatches.push(d);
            }
        }
    }
    for w in fx["weights"].as_array().expect("weights") {
        // test code
        let got = replicate_weights(
            w["columns"].as_u64().expect("columns") as usize,
            w["seed"].as_u64().expect("seed") as u32,
            w["r"].as_u64().expect("r") as u32,
        )
        .expect("valid"); // test code
        if let Some(d) = compare(
            &json!(got),
            &w["expected"],
            &format!("weights {} {} {}", w["columns"], w["seed"], w["r"]),
        ) {
            mismatches.push(d);
        }
    }
    println!(
        "bootstrap parity covers {errors} typed-error inputs and {with_failures} runs with failed replicates; each ran single-threaded and on 4 threads"
    );
    report("bootstrap parity", cases.len() * 2 + 30, &mismatches);
}
