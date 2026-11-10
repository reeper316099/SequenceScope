//! SequenceScope core: the algorithms, with no UI code. This crate is the Rust port of `src/bio/*.ts`; the TypeScript
//! code stays the reference implementation until the cutover, and the tests here compare against it and against the
//! stored Biopython fixtures.
//!
//! Contents so far: errors, alphabets, FASTA, substitution matrices, scoring, pairwise alignment (Needleman-Wunsch /
//! Smith-Waterman, linear and affine gaps, cancellable), an independent alignment re-scorer for tests, the seeded PRNG,
//! and the shuffle significance test.

pub mod alphabet;
pub mod error;
pub mod fasta;
pub mod matrices;
pub mod pairwise;
pub mod rng;
pub mod scoring;
pub mod shuffle;
pub mod types;
pub mod verify;
