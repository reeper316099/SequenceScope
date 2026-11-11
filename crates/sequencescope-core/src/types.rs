//! Plain data types shared by the algorithms (port of the bio types in `src/shared/types.ts`).

/// Alphabets the app understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Alphabet {
    Dna,
    Rna,
    Protein,
}

impl Alphabet {
    /// Lower-case name used in messages and JSON ("dna", "rna", "protein").
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dna => "dna",
            Self::Rna => "rna",
            Self::Protein => "protein",
        }
    }

    /// Parses the lower-case name; anything else is None.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "dna" => Some(Self::Dna),
            "rna" => Some(Self::Rna),
            "protein" => Some(Self::Protein),
            _ => None,
        }
    }
}

/// Alignment mode: whole-sequence (global) or best-matching region (local).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlignMode {
    Global,
    Local,
}

impl AlignMode {
    /// Lower-case name ("global" / "local").
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Local => "local",
        }
    }

    /// Parses the lower-case name; anything else is None.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "global" => Some(Self::Global),
            "local" => Some(Self::Local),
            _ => None,
        }
    }
}

/// Gap penalties are POSITIVE numbers. Linear: k gaps cost k*gap. Affine: k gaps cost open + (k-1)*extend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapModel {
    Linear { gap: i32 },
    Affine { open: i32, extend: i32 },
}

/// How residue pairs are scored: simple match/mismatch, or a named substitution matrix (protein only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubstitutionSpec {
    Simple { match_score: i32, mismatch_score: i32 },
    Matrix { name: String },
}

/// A complete scoring choice (what the UI sends and project files store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoringSpec {
    pub substitution: SubstitutionSpec,
    pub gaps: GapModel,
}

/// One pairwise alignment. Coordinates are 0-based, half-open, on the ORIGINAL (ungapped) sequences.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairwiseAlignment {
    pub mode: AlignMode,
    pub score: i32,
    pub row_a: String,
    pub row_b: String,
    pub start_a: usize,
    pub end_a: usize,
    pub start_b: usize,
    pub end_b: usize,
}
