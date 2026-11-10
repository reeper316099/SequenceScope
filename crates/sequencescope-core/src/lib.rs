//! SequenceScope core: the algorithms, with no UI code. This crate is the Rust port of `src/bio/*.ts`; the TypeScript
//! code stays the reference implementation until the cutover, and the tests here compare against it and against the
//! stored Biopython fixtures.
//!
//! Checkpoint 2 contents: errors, alphabets, FASTA, substitution matrices, scoring, and pairwise alignment
//! (Needleman-Wunsch / Smith-Waterman, linear and affine gaps), plus an independent alignment re-scorer for tests.

pub mod alphabet;
pub mod error;
pub mod fasta;
pub mod matrices;
pub mod pairwise;
pub mod scoring;
pub mod types;
pub mod verify;
