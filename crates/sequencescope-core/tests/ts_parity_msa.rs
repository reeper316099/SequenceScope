//! TypeScript-vs-Rust PARITY for Checkpoint 5: V8's `Math.log2`, the progressive multiple alignment (every merge step, the guide
//! tree and the scores), profile merging, the sum-of-pairs scorer, the exhaustive optimum, and conservation statistics.
//! tests/fixtures/parity/msa-ts.json holds the TypeScript outputs on seeded inputs (npm run parity:generate); every number
//! must match EXACTLY. Each test prints "N inputs, M mismatches" (run with --nocapture).

mod common;

use common::*;
use sequencescope_core::conservation::{ColumnStat, column_stat, conservation, conservation_csv};
use sequencescope_core::fasta::Sequence;
use sequencescope_core::jsnum::js_log2;
use sequencescope_core::msa::{
    GuideMethod, brute_force_optimum_sp, merge_profiles, progressive_align, sum_of_pairs_score,
};
use sequencescope_core::rng::Rng;
use sequencescope_core::scoring::compile_scoring;
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

/// Compares two JSON values after treating 1.0 and 1 as the same number (exact otherwise); returns a short diff on mismatch.
fn compare(got: &Value, want: &Value, context: &str) -> Option<String> {
    let (g, w) = (normalize_numbers(got), normalize_numbers(want));
    (g != w).then(|| {
        let short = |v: &Value| v.to_string().chars().take(600).collect::<String>();
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

/// Hash of strings joined by newlines (same function as the generator).
fn hash_strings(xs: &[String]) -> String {
    fnv1a32(xs.join("\n").bytes())
}

/// An exact power of two (the generator builds the same value by repeated doubling or halving).
fn pow2(e: i32) -> f64 {
    f64::from_bits(((1023 + i64::from(e)) as u64) << 52)
}

#[test]
fn js_log2_is_bit_identical_to_v8_math_log2() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let l = &fx["log2"];
    let bits = |x: f64| format!("{:016x}", x.to_bits());
    // every fraction c/n the entropy can take the logarithm of
    let max_n = l["fractions"]["maxN"].as_u64().expect("maxN") as usize; // test code
    let (mut out_a, mut firsts_a, mut libm_diff_a, mut total) = (Vec::new(), Vec::new(), 0usize, 0usize);
    for n in 1..=max_n {
        for c in 1..=n {
            let x = c as f64 / n as f64;
            let y = js_log2(x);
            out_a.push(bits(y));
            if firsts_a.len() < 1500 {
                firsts_a.push((bits(x), bits(y)));
            }
            libm_diff_a += usize::from(x.log2().to_bits() != y.to_bits());
            total += 1;
        }
    }
    assert_eq!(out_a.len() as u64, l["fractions"]["count"].as_u64().expect("count")); // test code
    for (k, pair) in l["fractions"]["first"].as_array().expect("first").iter().enumerate() {
        assert_eq!(
            (firsts_a[k].0.as_str(), firsts_a[k].1.as_str()),
            (pair[0].as_str().expect("x"), pair[1].as_str().expect("y")), // test code
            "fraction #{k}"
        );
    }
    assert_eq!(
        hash_strings(&out_a),
        l["fractions"]["hash"].as_str().expect("hash"), // test code
        "js_log2 differs from V8 on some fraction c/n"
    );
    // seeded doubles over a wide range
    let r = &l["random"];
    let mut rng = Rng::new(r["seed"].as_u64().expect("seed") as u32); // test code
    let count = r["count"].as_u64().expect("count") as usize; // test code
    let (mut out_b, mut firsts_b, mut libm_diff_b) = (Vec::with_capacity(count), Vec::new(), 0usize);
    for k in 0..count {
        let u = rng.next_float();
        let x = match k % 3 {
            0 => u,
            1 => u * 8.0 + 0.001,
            _ => (0.5 + u) * pow2(rng.next_int(201).expect("bound") as i32 - 100),
        };
        let y = js_log2(x);
        out_b.push(bits(y));
        if k < 1500 {
            firsts_b.push((bits(x), bits(y)));
        }
        libm_diff_b += usize::from(x.log2().to_bits() != y.to_bits());
    }
    for (k, pair) in r["first"].as_array().expect("first").iter().enumerate() {
        assert_eq!(
            (firsts_b[k].0.as_str(), firsts_b[k].1.as_str()),
            (pair[0].as_str().expect("x"), pair[1].as_str().expect("y")), // test code
            "random #{k}"
        );
    }
    assert_eq!(
        hash_strings(&out_b),
        r["hash"].as_str().expect("hash"), // test code
        "js_log2 differs from V8 on some seeded double"
    );
    assert_eq!(bits(js_log2(20.0)), l["twenty"].as_str().expect("twenty")); // test code
    println!(
        "log2 parity: {} inputs, 0 mismatches against V8; the C library's log2 (f64::log2) differs on {} of them",
        total + count,
        libm_diff_a + libm_diff_b
    );
}

/// A `Sequence` from a fixture entry.
fn sequence(v: &Value, alphabet: Alphabet) -> Sequence {
    Sequence {
        id: v["id"].as_str().expect("id").to_string(), // test code
        description: String::new(),
        alphabet,
        residues: v["residues"].as_str().expect("residues").to_string(), // test code
    }
}

#[test]
fn progressive_alignment_matches_typescript_step_by_step() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["msa"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let (mut errors, mut steps, mut upgma_cases, mut nj_cases) = (0usize, 0usize, 0usize, 0usize);
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let guide = GuideMethod::parse(case["guide"].as_str().expect("guide")).expect("known guide"); // test code
        let seqs: Vec<Sequence> = case["seqs"]
            .as_array()
            .expect("seqs") // test code
            .iter()
            .map(|s| sequence(s, alphabet))
            .collect();
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet).and_then(|sc| {
                progressive_align(&seqs, &sc, guide, &mut |_| {}, &mut || false).map(|r| r.expect("not cancelled")) // test code
            }),
            |r| {
                steps += r.steps.len();
                json!({
                    "ids": r.ids, "rows": r.rows, "alphabet": r.alphabet.as_str(), "guideTree": tree_json(&r.guide_tree),
                    "guide": r.guide.as_str(), "sumOfPairs": r.sum_of_pairs,
                    "steps": r.steps.iter().map(|s| json!({
                        "ids": s.ids, "leftIds": s.left_ids, "rightIds": s.right_ids, "rows": s.rows, "score": s.score
                    })).collect::<Vec<_>>(),
                })
            },
        );
        errors += usize::from(case["expected"].get("error").is_some());
        match guide {
            GuideMethod::Upgma => upgma_cases += 1,
            GuideMethod::Nj => nj_cases += 1,
        }
        if let Some(d) = compare(&got, &case["expected"], &format!("msa case #{k}")) {
            mismatches.push(d);
        }
    }
    println!(
        "  ({errors} typed errors, {steps} merge steps compared, {upgma_cases} UPGMA and {nj_cases} NJ guide trees)"
    );
    report("progressive alignment", cases.len(), &mismatches);
}

#[test]
fn profile_merging_matches_typescript() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["merges"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let (a, b) = (strings(&case["a"]), strings(&case["b"]));
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet).and_then(|sc| merge_profiles(&a, &b, &sc)),
            |m| json!({ "rows": m.rows, "score": m.score }),
        );
        if let Some(d) = compare(&got, &case["expected"], &format!("merge case #{k}")) {
            mismatches.push(d);
        }
    }
    report("profile merging", cases.len(), &mismatches);
}

#[test]
fn sum_of_pairs_matches_typescript() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["sops"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let rows = strings(&case["rows"]);
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet).and_then(|sc| sum_of_pairs_score(&rows, &sc)),
            |s| json!(s),
        );
        if let Some(d) = compare(&got, &case["expected"], &format!("sum-of-pairs case #{k}")) {
            mismatches.push(d);
        }
    }
    report("sum of pairs", cases.len(), &mismatches);
}

#[test]
fn exhaustive_optimum_matches_typescript() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["brute"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let seqs = strings(&case["seqs"]);
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet)
                .and_then(|sc| brute_force_optimum_sp(&seqs, &sc)),
            |(score, rows)| json!({ "score": score, "rows": rows }),
        );
        if let Some(d) = compare(&got, &case["expected"], &format!("exhaustive case #{k}")) {
            mismatches.push(d);
        }
    }
    report("exhaustive optimum", cases.len(), &mismatches);
}

/// A column's statistics as JSON, in the shape the generator wrote.
fn stat_json(c: &ColumnStat) -> Value {
    json!({
        "gaps": c.gaps, "residues": c.residues,
        "counts": c.counts.iter().map(|(ch, n)| json!([ch.to_string(), n])).collect::<Vec<_>>(),
        "top": c.top.map_or(String::new(), |t| t.to_string()),
        "identity": c.identity, "entropy": c.entropy, "conservation": c.conservation, "consensus": c.consensus.to_string(),
    })
}

#[test]
fn column_statistics_match_typescript() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["columns"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let mut errors = 0usize;
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let threshold = case["threshold"].as_f64().expect("threshold"); // test code
        let got = captured(
            column_stat(case["column"].as_str().expect("column"), alphabet, threshold), // test code
            |c| stat_json(&c),
        );
        errors += usize::from(got.get("error").is_some());
        if let Some(d) = compare(&got, &case["expected"], &format!("column case #{k}")) {
            mismatches.push(d);
        }
    }
    println!("  ({errors} typed errors)");
    report("column statistics", cases.len(), &mismatches);
}

#[test]
fn whole_alignment_conservation_and_csv_match_typescript() {
    let fx = read_json("tests/fixtures/parity/msa-ts.json");
    let cases = fx["alignments"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let threshold = case["threshold"].as_f64().expect("threshold"); // test code
        let rows = strings(&case["rows"]);
        let got = captured(conservation(&rows, alphabet, threshold), |c| {
            json!({
                "columns": c.columns.iter().map(stat_json).collect::<Vec<_>>(), "consensus": c.consensus,
                "meanIdentity": c.mean_identity, "fullyConserved": c.fully_conserved,
            })
        });
        if let Some(d) = compare(&got, &case["expected"], &format!("alignment case #{k}")) {
            mismatches.push(d);
        }
        let csv = captured(conservation_csv(&rows, alphabet), |s| json!(s));
        if let Some(d) = compare(&csv, &case["csv"], &format!("conservation CSV case #{k}")) {
            mismatches.push(d);
        }
    }
    report("whole-alignment conservation and CSV", cases.len() * 2, &mismatches);
}
