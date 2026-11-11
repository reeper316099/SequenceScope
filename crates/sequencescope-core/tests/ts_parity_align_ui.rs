//! TypeScript-vs-Rust PARITY for what the Align view shows: alignment statistics, match lines of every co-optimal alignment,
//! the pre-check (scoring errors and the memory cap), and the explanation of individual DP cells, read from the Rust tables
//! exactly the way the page reads them. tests/fixtures/parity/align-ui-ts.json holds the TypeScript outputs
//! (npm run parity:generate). Every number and message must match EXACTLY.

mod common;

use common::*;
use sequencescope_core::alignstats::{CellInfo, CellValues, alignment_stats, cell_info, match_line};
use sequencescope_core::pairwise::{Dp, Tables, assert_within_cap, fill_matrix, traceback_all, traceback_first};
use sequencescope_core::scoring::compile_scoring;
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

/// Compares two JSON values (numbers as doubles); returns a short diff on mismatch.
fn compare(got: &Value, want: &Value, context: &str) -> Option<String> {
    let (g, w) = (normalize_numbers(got), normalize_numbers(want));
    (g != w).then(|| {
        let short = |v: &Value| v.to_string().chars().take(500).collect::<String>();
        format!("{context}\n  ts:   {}\n  rust: {}", short(&w), short(&g))
    })
}

/// The table entries around cell (i, j): what the page gathers from the typed arrays it already holds.
fn values_around(dp: &Dp, i: usize, j: usize) -> CellValues {
    let (w, idx) = (dp.cols, i * dp.cols + j);
    let at = |k: Option<usize>, t: &[i32]| k.map_or(0, |k| t[k]);
    let diag = (i > 0 && j > 0).then(|| idx - w - 1);
    let up = (i > 0).then(|| idx - w);
    let left = (j > 0).then(|| idx - 1);
    match &dp.tables {
        Tables::Linear { h, p } => CellValues::Linear {
            diag: at(diag, h),
            up: at(up, h),
            left: at(left, h),
            here: h[idx],
            pointer: p[idx],
        },
        Tables::Affine { m, x, y, p } => {
            let tri = |k: Option<usize>| [at(k, m), at(k, x), at(k, y)];
            CellValues::Affine {
                diag: tri(diag),
                up: tri(up),
                left: tri(left),
                here: tri(Some(idx)),
                pointer: p[idx],
            }
        }
    }
}

/// A cell explanation as JSON in the TypeScript shape.
fn info_json(info: &CellInfo) -> Value {
    match info {
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
    }
}

#[test]
fn stats_match_lines_and_cell_explanations_match_typescript() {
    let fx = read_json("tests/fixtures/parity/align-ui-ts.json");
    let cases = fx["cases"].as_array().expect("cases"); // test code
    let mut mismatches = Vec::new();
    let (mut errors, mut cells, mut lines) = (0usize, 0usize, 0usize);
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let mode = mode_from_str(case["mode"].as_str().expect("mode")); // test code
        let (a, b) = (case["a"].as_str().expect("a"), case["b"].as_str().expect("b")); // test code
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet).and_then(|sc| {
                let dp = fill_matrix(a, b, mode, &sc)?;
                let first = traceback_first(&dp);
                let all = traceback_all(&dp, 25)?;
                let stats = alignment_stats(&first, &sc)?;
                let match_lines = all
                    .alignments
                    .iter()
                    .map(|x| match_line(x, &sc))
                    .collect::<Result<Vec<_>, _>>()?;
                // the cells the generator inspected: re-explain each from the Rust tables
                let mut cell_json = Vec::new();
                for c in case["expected"]["ok"]["cells"]
                    .as_array()
                    .map_or(&[][..], |v| v.as_slice())
                {
                    let (i, j) = (
                        c["i"].as_u64().expect("i") as usize,
                        c["j"].as_u64().expect("j") as usize,
                    ); // test code
                    let letters = (i > 0 && j > 0)
                        .then(|| (a.chars().nth(i - 1).unwrap_or(' '), b.chars().nth(j - 1).unwrap_or(' ')));
                    let info = cell_info(mode, i, j, letters, &sc, &values_around(&dp, i, j))?;
                    cell_json.push(json!({ "i": i, "j": j, "info": info_json(&info) }));
                }
                Ok((stats, match_lines, cell_json))
            }),
            |(stats, match_lines, cell_json)| {
                cells += cell_json.len();
                lines += match_lines.len();
                json!({
                    "stats": {
                        "length": stats.length, "identities": stats.identities, "mismatches": stats.mismatches,
                        "positives": stats.positives, "gapColumns": stats.gap_columns, "gapOpens": stats.gap_opens,
                        "gapsInA": stats.gaps_in_a, "gapsInB": stats.gaps_in_b, "ambiguousColumns": stats.ambiguous_columns,
                        "identityPct": stats.identity_pct, "similarityPct": stats.similarity_pct, "alignedColumns": stats.aligned_columns,
                    },
                    "matchLines": match_lines,
                    "cells": cell_json,
                })
            },
        );
        errors += usize::from(got.get("error").is_some());
        // compare with the TypeScript output, keeping only the fields Rust recomputes for the cells
        let mut want = case["expected"].clone();
        if let Some(cs) = want
            .get_mut("ok")
            .and_then(|o| o.get_mut("cells"))
            .and_then(Value::as_array_mut)
        {
            for c in cs.iter_mut() {
                *c = json!({ "i": c["i"], "j": c["j"], "info": c["info"] });
            }
        }
        if let Some(d) = compare(&got, &want, &format!("align-ui case #{k}")) {
            mismatches.push(d);
        }
    }
    println!("  ({errors} typed errors, {cells} cells explained, {lines} match lines)");
    report(
        "alignment statistics, match lines and cell explanations",
        cases.len(),
        &mismatches,
    );
}

#[test]
fn the_precheck_gives_the_same_scoring_errors_and_memory_cap_message() {
    let fx = read_json("tests/fixtures/parity/align-ui-ts.json");
    let cases = fx["pre"].as_array().expect("pre"); // test code
    let mut mismatches = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let alphabet = alphabet_from_str(case["alphabet"].as_str().expect("alphabet")); // test code
        let (m, n) = (
            case["lenA"].as_u64().expect("lenA") as usize,
            case["lenB"].as_u64().expect("lenB") as usize,
        ); // test code
        let got = captured(
            compile_scoring(&spec_from_json(&case["scoring"]), alphabet).and_then(|sc| {
                assert_within_cap(m, n, sc.affine)?;
                Ok(sc.affine)
            }),
            |affine| json!({ "affine": affine }),
        );
        if let Some(d) = compare(&got, &case["expected"], &format!("pre-check case #{k}")) {
            mismatches.push(d);
        }
    }
    report("pre-check", cases.len(), &mismatches);
}
