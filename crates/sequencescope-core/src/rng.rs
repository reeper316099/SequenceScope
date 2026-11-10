//! Seeded, platform-independent PRNG. Port of `src/bio/rng.ts`; the output for a given seed is IDENTICAL to the
//! TypeScript implementation (the tests check known answers and a parity fixture). There is no unseeded randomness
//! anywhere in the project.
//!
//! Generator: sfc32 (Chris Doty-Humphrey, PractRand), 128-bit state, 32-bit integer arithmetic only. Seeding:
//! splitmix32 expands one 32-bit seed into the four state words, then 12 outputs are discarded (warm-up).

use crate::error::{BioError, BioErrorCode};

/// A splitmix32 stream starting from `seed` (used for seeding and stream derivation).
pub struct SplitMix32 {
    a: u32,
}

impl SplitMix32 {
    /// Starts the stream at `seed`.
    pub fn new(seed: u32) -> Self {
        Self { a: seed }
    }

    /// Next 32-bit output (all arithmetic wraps modulo 2^32, like JavaScript's `Math.imul` and `|0`).
    pub fn next_u32(&mut self) -> u32 {
        self.a = self.a.wrapping_add(0x9e37_79b9);
        let mut t = self.a ^ (self.a >> 16);
        t = t.wrapping_mul(0x21f0_aaad);
        t ^= t >> 15;
        t = t.wrapping_mul(0x735a_2d97);
        t ^ (t >> 15)
    }
}

/// Checks that a JavaScript-style number is a valid seed (an integer from 0 to 4294967295) and converts it.
pub fn check_seed(seed: f64) -> Result<u32, BioError> {
    if seed.fract() != 0.0 || !(0.0..=4_294_967_295.0).contains(&seed) {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            format!("Seed must be an integer from 0 to 4294967295, got {seed}."),
        ));
    }
    Ok(seed as u32)
}

/// The sfc32 generator.
#[derive(Debug, Clone)]
pub struct Rng {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
}

impl Rng {
    /// Builds the generator from a 32-bit seed (see the file header for the algorithm).
    pub fn new(seed: u32) -> Self {
        let mut sm = SplitMix32::new(seed);
        let (a, b, c, d) = (sm.next_u32(), sm.next_u32(), sm.next_u32(), sm.next_u32());
        let mut rng = Self { a, b, c, d };
        for _ in 0..12 {
            rng.next_u32();
        }
        rng
    }

    /// Next unsigned 32-bit integer (one sfc32 step).
    pub fn next_u32(&mut self) -> u32 {
        let t = self.a.wrapping_add(self.b).wrapping_add(self.d);
        self.d = self.d.wrapping_add(1);
        self.a = self.b ^ (self.b >> 9);
        self.b = self.c.wrapping_add(self.c << 3);
        self.c = self.c.rotate_left(21);
        self.c = self.c.wrapping_add(t);
        t
    }

    /// Uniform float in [0, 1) with 32 bits of resolution.
    pub fn next_float(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }

    /// Unbiased integer in [0, bound) using rejection sampling (no modulo bias). `bound` must be in 1..=2^32.
    pub fn next_int(&mut self, bound: u64) -> Result<u32, BioError> {
        if !(1..=4_294_967_296).contains(&bound) {
            return Err(BioError::new(
                BioErrorCode::InvalidArgument,
                format!("nextInt bound must be an integer in [1, 2^32], got {bound}."),
            ));
        }
        let limit = (4_294_967_296 / bound) * bound; // largest multiple of bound that fits in 2^32
        let mut x = u64::from(self.next_u32());
        while x >= limit {
            x = u64::from(self.next_u32());
        }
        Ok((x % bound) as u32)
    }
}

/// Derives an independent seed for stream number `stream` from a master seed (e.g. bootstrap replicate r), so results do
/// not depend on how work is split across threads.
pub fn derive_seed(seed: u32, stream: u32) -> u32 {
    let mixed = SplitMix32::new(seed).next_u32() ^ stream.wrapping_add(1).wrapping_mul(0x85eb_ca6b);
    SplitMix32::new(mixed).next_u32()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known answers copied from tests/unit/rng.test.ts (made by an independent Python port of sfc32/splitmix32).
    #[test]
    fn first_five_outputs_for_known_seeds() {
        let cases: [(u32, [u32; 5]); 4] = [
            (
                0,
                [548_183_886, 1_097_162_541, 2_219_297_441, 1_664_216_021, 3_479_288_465],
            ),
            (
                1,
                [1_130_556_604, 2_591_592_147, 3_014_952_990, 960_850_752, 2_734_082_507],
            ),
            (
                12345,
                [
                    2_142_345_551,
                    3_083_893_245,
                    1_997_626_643,
                    3_123_200_824,
                    1_123_390_551,
                ],
            ),
            (
                4_294_967_295,
                [
                    2_246_433_216,
                    2_156_899_173,
                    2_040_853_526,
                    3_823_104_220,
                    1_358_629_326,
                ],
            ),
        ];
        for (seed, expected) in cases {
            let mut r = Rng::new(seed);
            let got: Vec<u32> = (0..5).map(|_| r.next_u32()).collect();
            assert_eq!(got, expected, "seed {seed}");
        }
    }

    #[test]
    fn derive_seed_known_answers() {
        let got: Vec<u32> = (0..4).map(|k| derive_seed(42, k)).collect();
        assert_eq!(got, vec![3_301_857_756, 1_832_936_576, 2_771_854_531, 3_733_768_584]);
    }

    #[test]
    fn same_seed_same_sequence_different_seed_differs() {
        let (mut a, mut b, mut c) = (Rng::new(7), Rng::new(7), Rng::new(8));
        let xs: Vec<u32> = (0..50).map(|_| a.next_u32()).collect();
        assert_eq!((0..50).map(|_| b.next_u32()).collect::<Vec<_>>(), xs);
        assert_ne!((0..50).map(|_| c.next_u32()).collect::<Vec<_>>(), xs);
    }

    #[test]
    fn next_float_is_in_unit_interval_and_roughly_uniform() {
        let mut r = Rng::new(2024);
        let n = 100_000;
        let mut bins = [0usize; 10];
        for _ in 0..n {
            let f = r.next_float();
            assert!((0.0..1.0).contains(&f));
            bins[(f * 10.0) as usize] += 1;
        }
        let expected = n as f64 / 10.0;
        let chi: f64 = bins.iter().map(|&o| (o as f64 - expected).powi(2) / expected).sum();
        assert!(chi < 27.88, "chi-square {chi} (critical 27.88 for 9 dof at 0.001)");
    }

    #[test]
    fn next_int_is_unbiased_for_a_bound_that_does_not_divide_2_pow_32() {
        let mut r = Rng::new(99);
        let n = 70_000;
        let mut bins = [0usize; 7];
        for _ in 0..n {
            bins[r.next_int(7).expect("valid bound") as usize] += 1; // test code
        }
        let expected = n as f64 / 7.0;
        let chi: f64 = bins.iter().map(|&o| (o as f64 - expected).powi(2) / expected).sum();
        assert!(chi < 22.46, "chi-square {chi} (critical 22.46 for 6 dof at 0.001)");
    }

    #[test]
    fn derived_streams_are_independent_of_each_other() {
        let firsts: std::collections::HashSet<u32> = (0..200).map(|k| Rng::new(derive_seed(5, k)).next_u32()).collect();
        assert_eq!(firsts.len(), 200);
        let alone = Rng::new(derive_seed(5, 3)).next_u32();
        for k in 0..3 {
            Rng::new(derive_seed(5, k)).next_u32();
        }
        assert_eq!(Rng::new(derive_seed(5, 3)).next_u32(), alone);
    }

    #[test]
    fn bad_seeds_and_bounds_are_typed_errors() {
        for s in [-1.0, 1.5, 4_294_967_296.0] {
            let e = check_seed(s).expect_err("invalid seed"); // test code
            assert_eq!(e.code, BioErrorCode::InvalidArgument);
            assert!(e.message.starts_with("Seed must be"));
        }
        assert_eq!(check_seed(4_294_967_295.0), Ok(u32::MAX));
        assert_eq!(check_seed(0.0), Ok(0));
        assert!(Rng::new(1).next_int(0).is_err());
        assert!(Rng::new(1).next_int(4_294_967_297).is_err());
        assert!(Rng::new(1).next_int(4_294_967_296).is_ok());
    }

    #[test]
    fn extreme_stream_numbers_wrap_like_javascript_imul() {
        // stream 2^32-1: stream+1 wraps to 0, so the multiplier term vanishes and only the master-seed mix remains.
        let mixed = SplitMix32::new(1).next_u32();
        assert_eq!(derive_seed(1, u32::MAX), SplitMix32::new(mixed).next_u32());
    }
}
