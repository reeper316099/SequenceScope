//! JavaScript-exact number behaviour that the TypeScript reference relies on, reproduced so Rust output is identical:
//!
//!  * `js_ln`: `Math.log` as V8 computes it on Apple Silicon: FreeBSD's fdlibm `__ieee754_log`, compiled with fused
//!    multiply-add (every `a*b + c` is ONE rounding). Measured on 200,000 inputs: this is bit-identical to Node/V8 on arm64;
//!    plain fdlibm without fusing differs by 1 ulp on about 1.9% of inputs (that is also how V8 on x86-64, which does not
//!    fuse, differs from V8 on Apple Silicon); the C library's `log` (what `f64::ln` calls) differs on about 6.9%, and
//!    JavaScriptCore (Safari / WKWebView) uses the C library. `f64::mul_add` is correctly rounded on every platform (hardware
//!    FMA or an exact software fallback), so this function gives the same bits on Windows, macOS, and Linux.
//!  * `js_number_to_string`: `String(number)` (the ECMAScript Number-to-string rules), used for Newick and CSV output.
//!  * `js_to_fixed`: `Number.prototype.toFixed` (exact decimal rounding, ties round UP; Rust's `{:.N}` rounds ties to even).
//!  * `js_cmp`: JavaScript's default string ordering (by UTF-16 code unit), used by `.sort()` and `<` on strings.
//!  * `group_thousands`: `toLocaleString('en-US')` for integers.

use std::cmp::Ordering;

/// `Math.log(x)` exactly as V8 computes it on Apple Silicon (fdlibm `__ieee754_log` with fused multiply-adds).
// The constants below are copied digit for digit from fdlibm so they can be audited against the original source.
#[allow(clippy::excessive_precision)]
pub fn js_ln(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-01;
    const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
    const TWO54: f64 = 1.801_439_850_948_198_4e16;
    const LG1: f64 = 6.666_666_666_666_735_130e-01;
    const LG2: f64 = 3.999_999_999_940_941_908e-01;
    const LG3: f64 = 2.857_142_874_366_239_149e-01;
    const LG4: f64 = 2.222_219_843_214_978_396e-01;
    const LG5: f64 = 1.818_357_216_161_805_012e-01;
    const LG6: f64 = 1.531_383_769_920_937_332e-01;
    const LG7: f64 = 1.479_819_860_511_658_591e-01;

    let bits = x.to_bits();
    let mut hx = (bits >> 32) as i32;
    let lx = bits as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // x < 2^-1022 (or negative, zero)
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; // log(+-0) = -inf
        }
        if hx < 0 {
            return f64::NAN; // log(negative) = NaN
        }
        k -= 54;
        x *= TWO54; // subnormal: scale up
        hx = (x.to_bits() >> 32) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x; // inf or NaN
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    // SET_HIGH_WORD(x, hx | (i ^ 0x3ff00000)): normalise x into [sqrt(2)/2, sqrt(2)].
    x = f64::from_bits((u64::from((hx | (i ^ 0x3ff0_0000)) as u32) << 32) | (x.to_bits() & 0xffff_ffff));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        // |f| < 2^-20
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk.mul_add(LN2_HI, dk * LN2_LO);
        }
        let r = f * f * (-0.333_333_333_333_333_33f64).mul_add(f, 0.5);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        let y = (-dk).mul_add(LN2_LO, r) - f;
        return dk.mul_add(LN2_HI, -y);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * w.mul_add(w.mul_add(LG6, LG4), LG2);
    let t2 = z * w.mul_add(w.mul_add(w.mul_add(LG7, LG5), LG3), LG1);
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (-s).mul_add(hfsq + r, hfsq)
        } else {
            let y = (hfsq - s.mul_add(hfsq + r, dk * LN2_LO)) - f;
            dk.mul_add(LN2_HI, -y)
        }
    } else if k == 0 {
        (-s).mul_add(f - r, f)
    } else {
        let y = s.mul_add(f - r, -(dk * LN2_LO)) - f;
        dk.mul_add(LN2_HI, -y)
    }
}

/// `String(x)` for a JavaScript number (ECMAScript Number::toString, radix 10).
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string(); // also for -0
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` prints round-trip digits like "1.2345e-7", but it differs from JavaScript in two rare cases:
    //  * at a rounding boundary it can be one digit LONGER (V8 accepts a decimal exactly on the boundary when the double's
    //    mantissa is even), so keep shortening while the correctly rounded shorter string still parses back to `x`;
    //  * when two shortest strings are equally close to `x` (an exact tie, e.g. 589772012394263.25) JavaScript takes the one
    //    with the EVEN last digit while Rust takes the upper one; exact-precision formatting rounds ties to even.
    let ax = x.abs();
    let round_trips = |s: &str| s.parse::<f64>().is_ok_and(|v| v == ax);
    let shortest = format!("{ax:e}");
    let mut digits = shortest
        .split('e')
        .next()
        .map_or(1, |m| m.chars().filter(char::is_ascii_digit).count());
    while digits > 1 && round_trips(&format!("{:.*e}", digits - 2, ax)) {
        digits -= 1;
    }
    let nearest = format!("{:.*e}", digits - 1, ax);
    let sci = if round_trips(&nearest) { nearest } else { shortest };
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32; // number of significant digits
    let n = exp.parse::<i32>().unwrap_or(0) + 1; // value = 0.DIGITS * 10^n
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let esign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{esign}{}", e.abs())
        } else {
            format!("{}.{}e{esign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// `x.toFixed(digits)` for `digits` in 0..=9. Exact: the double's true decimal value is rounded, and an exact tie rounds
/// away from zero (the larger magnitude), as JavaScript does.
pub fn js_to_fixed(x: f64, digits: u32) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let bits = x.abs().to_bits();
    let exp_field = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    // |x| = m * 2^e exactly
    let (m, e) = if exp_field == 0 {
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), exp_field - 1075)
    };
    let pow10 = 10u128.pow(digits);
    let scaled: u128 = if e >= 0 {
        (u128::from(m) << e) * pow10
    } else {
        let num = u128::from(m) * pow10;
        let shift = (-e) as u32;
        if shift >= 120 {
            0 // below 2^-67: rounds to zero for any digits <= 9
        } else {
            let q = num >> shift;
            let r = num & ((1u128 << shift) - 1);
            if r * 2 >= (1u128 << shift) { q + 1 } else { q }
        }
    };
    let text = scaled.to_string();
    if digits == 0 {
        return format!("{sign}{text}");
    }
    let padded = format!("{:0>width$}", text, width = digits as usize + 1);
    let (int_part, frac_part) = padded.split_at(padded.len() - digits as usize);
    format!("{sign}{int_part}.{frac_part}")
}

/// JavaScript's default string comparison (`<`, `.sort()`): by UTF-16 code unit.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `n.toLocaleString('en-US')` for a non-negative integer: "25,020,004".
pub fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (k, ch) in digits.chars().enumerate() {
        if k > 0 && (digits.len() - k).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::excessive_precision)] // the tie cases need more digits than f64 prints; they are exactly representable
    fn number_to_string_follows_the_ecmascript_rules() {
        let cases: [(f64, &str); 16] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (0.000_000_1, "1e-7"),
            (1e-7, "1e-7"),
            (4.5e300, "4.5e+300"),
            (0.001, "0.001"),
            (250.0, "250"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
        ];
        for (x, expected) in cases {
            assert_eq!(js_number_to_string(x), expected, "{x:e}");
        }
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_to_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        // Exact ties between two equally short strings: JavaScript takes the one with the even last digit (Rust's own
        // shortest-digits printer takes the upper one). The values below are exactly representable (…25 and …75).
        assert_eq!(js_number_to_string(-589_772_012_394_263.25), "-589772012394263.2");
        assert_eq!(js_number_to_string(589_772_012_394_263.75), "589772012394263.8");
        assert_eq!(js_number_to_string(160_018_374_910.578_12), "160018374910.57812");
    }

    #[test]
    #[allow(clippy::excessive_precision)] // 0.34999999999999998 is deliberately written out: it is the double just below 0.35
    fn to_fixed_rounds_the_exact_value_and_ties_go_up() {
        assert_eq!(
            js_to_fixed(0.0078125, 6),
            "0.007813",
            "exact tie (1/128): JavaScript rounds up, Rust's {{:.6}} would give ...812"
        );
        assert_eq!(js_to_fixed(1.25, 1), "1.3");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(0.5, 0), "1");
        assert_eq!(js_to_fixed(1.005, 2), "1.00", "1.005 is really 1.00499999999999989...");
        assert_eq!(js_to_fixed(0.0, 6), "0.000000");
        assert_eq!(js_to_fixed(-0.0, 6), "0.000000");
        assert_eq!(js_to_fixed(-1.5, 0), "-2");
        assert_eq!(js_to_fixed(123.456, 6), "123.456000");
        assert_eq!(js_to_fixed(1e-10, 6), "0.000000");
        assert_eq!(js_to_fixed(1e21, 2), "1e+21");
        assert_eq!(js_to_fixed(3.0, 1), "3.0");
        assert_eq!(js_to_fixed(0.349_999_999_999_999_98, 1), "0.3");
    }

    #[test]
    fn js_ln_agrees_with_known_values_and_handles_special_inputs() {
        assert_eq!(js_ln(1.0), 0.0);
        assert!((js_ln(std::f64::consts::E) - 1.0).abs() < 1e-15);
        assert!((js_ln(10.0) - std::f64::consts::LN_10).abs() < 1e-15);
        assert_eq!(js_ln(0.0), f64::NEG_INFINITY);
        assert!(js_ln(-1.0).is_nan());
        assert_eq!(js_ln(f64::INFINITY), f64::INFINITY);
        assert!(js_ln(f64::NAN).is_nan());
        assert!((js_ln(5e-324) + 744.440_071_921_381_3).abs() < 1e-12, "subnormal input");
        // Never more than 1 ulp from the C library (both are faithful approximations of the true logarithm).
        let mut x = 0.001f64;
        while x < 1000.0 {
            let (a, b) = (js_ln(x), x.ln());
            assert!((a - b).abs() <= a.abs().max(1e-300) * 4.5e-16, "{x}: {a} vs {b}");
            x *= 1.003;
        }
        assert_eq!(
            js_ln(0.5),
            -std::f64::consts::LN_2,
            "ln(1/2) is exact (the f == 0 branch)"
        );
        assert_eq!(js_ln(2.0), std::f64::consts::LN_2);
    }

    #[test]
    fn string_order_is_utf16_code_unit_order_not_utf8() {
        assert_eq!(js_cmp("a", "b"), Ordering::Less);
        assert_eq!(js_cmp("B", "a"), Ordering::Less);
        // U+FF5E (BMP) sorts AFTER U+1F600 (surrogate pair D83D...) in UTF-16 order, but BEFORE it in UTF-8 / code point order.
        assert_eq!(js_cmp("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert!("\u{FF5E}" < "\u{1F600}");
    }

    #[test]
    fn thousands_grouping() {
        assert_eq!(
            [
                group_thousands(0),
                group_thousands(999),
                group_thousands(1000),
                group_thousands(25_020_004)
            ],
            ["0", "999", "1,000", "25,020,004"]
        );
    }
}
