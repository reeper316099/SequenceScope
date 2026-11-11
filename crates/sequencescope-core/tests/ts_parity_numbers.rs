//! JavaScript number behaviour parity: V8's `Math.log`, `String(number)`, and `toFixed`, replayed on the exact inputs the
//! TypeScript generator used (regenerated here from the same seeded PRNG, so the fixture only needs hashes).
//! Also quantifies how far the C library's `ln` (what plain `f64::ln` uses) is from V8 on the same inputs.

mod common;

use common::{fnv1a32, read_json};
use sequencescope_core::jsnum::{js_ln, js_number_to_string, js_to_fixed};
use sequencescope_core::rng::Rng;
use serde_json::Value;

/// Hash of strings joined by newlines (same function as the generator).
fn hash_strings(xs: &[String]) -> String {
    fnv1a32(xs.join("\n").bytes())
}

/// The next finite double built from two PRNG words (retrying on NaN/Infinity, like the generator).
fn next_double(q: &mut Rng) -> f64 {
    loop {
        let (hi, lo) = (q.next_u32(), q.next_u32());
        let x = f64::from_bits((u64::from(hi) << 32) | u64::from(lo));
        if x.is_finite() {
            return x;
        }
    }
}

#[test]
fn js_ln_is_bit_identical_to_v8_math_log_on_200000_inputs() {
    let fx = read_json("tests/fixtures/parity/numbers-ts.json");
    let ln = &fx["ln"];
    let mut r = Rng::new(ln["seed"].as_u64().expect("seed") as u32); // test code
    let count = ln["count"].as_u64().expect("count") as usize; // test code
    let (mut ours, mut libm_diff, mut max_ulp) = (Vec::with_capacity(count), 0usize, 0u64);
    let mut firsts: Vec<(u64, u64)> = Vec::new();
    for k in 0..count {
        let p = r.next_float() * 0.75;
        let x = if k % 2 == 0 { 1.0 - (4.0 * p) / 3.0 } else { 1.0 - p };
        let y = js_ln(x);
        ours.push(format!("{:016x}", y.to_bits()));
        let libm = x.ln();
        if libm.to_bits() != y.to_bits() {
            libm_diff += 1;
            max_ulp = max_ulp.max((libm.to_bits() as i64 - y.to_bits() as i64).unsigned_abs());
        }
        if k < 2000 {
            firsts.push((x.to_bits(), y.to_bits()));
        }
    }
    for (k, pair) in ln["first"].as_array().expect("first").iter().enumerate() {
        // test code
        let (x, y) = (pair[0].as_str().expect("x"), pair[1].as_str().expect("y")); // test code
        assert_eq!(
            (format!("{:016x}", firsts[k].0), format!("{:016x}", firsts[k].1)),
            (x.to_string(), y.to_string()),
            "input {k}"
        );
    }
    assert_eq!(
        hash_strings(&ours),
        ln["hash"].as_str().expect("hash"),
        "js_ln differs from V8 somewhere in the 200,000 inputs"
    ); // test code
    println!(
        "ln parity: {count} inputs, 0 mismatches against V8; the C library's ln (f64::ln) differs from V8 on {libm_diff} of them (max {max_ulp} ulp)"
    );
}

#[test]
fn number_to_string_matches_javascript_on_100000_doubles() {
    let fx = read_json("tests/fixtures/parity/numbers-ts.json");
    let s = &fx["toString"];
    let mut q = Rng::new(s["seed"].as_u64().expect("seed") as u32); // test code
    let count = s["count"].as_u64().expect("count") as usize; // test code
    let mut out = Vec::with_capacity(count);
    for k in 0..count {
        let x = match k % 4 {
            0 => next_double(&mut q),
            1 => q.next_float(),
            2 => {
                q.next_float()
                    * format!("1e{}", q.next_int(25).expect("bound") as i32 - 12)
                        .parse::<f64>()
                        .expect("valid literal")
            } // exact constants (V8's `10 ** n` is 1 ulp off for n = -4, -5)
            _ => f64::from(q.next_u32()) / 2f64.powi(q.next_int(8).expect("bound") as i32),
        };
        out.push(js_number_to_string(x));
    }
    for (k, expected) in s["first"].as_array().expect("first").iter().enumerate() {
        // test code
        assert_eq!(out[k], expected.as_str().expect("string"), "double #{k}"); // test code
    }
    assert_eq!(hash_strings(&out), s["hash"].as_str().expect("hash")); // test code
    println!("number printing parity: {count} doubles, 0 mismatches");
}

#[test]
fn to_fixed_matches_javascript_including_exact_ties() {
    let fx = read_json("tests/fixtures/parity/numbers-ts.json");
    let s = &fx["toFixed"];
    let mut f = Rng::new(s["seed"].as_u64().expect("seed") as u32); // test code
    let count = s["count"].as_u64().expect("count") as usize; // test code
    let (mut six, mut one) = (Vec::with_capacity(count), Vec::with_capacity(count));
    for k in 0..count {
        let x = match k % 3 {
            0 => f64::from(f.next_u32() % 20_000) / 128.0,
            1 => f.next_float() * 10.0,
            _ => f64::from(f.next_u32() % 2000) / 8.0,
        };
        six.push(js_to_fixed(x, 6));
        one.push(js_to_fixed(x, 1));
    }
    for (k, expected) in s["first6"].as_array().expect("first6").iter().enumerate() {
        // test code
        assert_eq!(six[k], expected.as_str().expect("string"), "toFixed(6) #{k}"); // test code
    }
    assert_eq!(hash_strings(&six), s["hash6"].as_str().expect("hash6")); // test code
    assert_eq!(hash_strings(&one), s["hash1"].as_str().expect("hash1")); // test code
    println!("toFixed parity: {count} values x 2 precisions, 0 mismatches");
    let _: &Value = &fx;
}
