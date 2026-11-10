//! One typed error for the whole crate, so the UI can show a friendly message per `code`.
//! Port of `src/bio/errors.ts`; the code strings are identical to the TypeScript `BioErrorCode` values.

use std::fmt;

/// Machine-readable error kinds (same set as the TypeScript `BioErrorCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BioErrorCode {
    TooLarge,
    InvalidResidue,
    InvalidScoring,
    InvalidArgument,
    UnknownMatrix,
    AlphabetMismatch,
    NotAligned,
    TooFewSequences,
    DuplicateNames,
    SaturatedDistances,
    InvalidTree,
    NewickSyntax,
    IncompatibleModel,
}

impl BioErrorCode {
    /// The kebab-case string the TypeScript side uses for this code.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too-large",
            Self::InvalidResidue => "invalid-residue",
            Self::InvalidScoring => "invalid-scoring",
            Self::InvalidArgument => "invalid-argument",
            Self::UnknownMatrix => "unknown-matrix",
            Self::AlphabetMismatch => "alphabet-mismatch",
            Self::NotAligned => "not-aligned",
            Self::TooFewSequences => "too-few-sequences",
            Self::DuplicateNames => "duplicate-names",
            Self::SaturatedDistances => "saturated-distances",
            Self::InvalidTree => "invalid-tree",
            Self::NewickSyntax => "newick-syntax",
            Self::IncompatibleModel => "incompatible-model",
        }
    }
}

/// A failure with a code (for programs) and a message (for people).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BioError {
    pub code: BioErrorCode,
    pub message: String,
}

impl BioError {
    /// Creates an error with a machine-readable code and a human-readable message.
    pub fn new(code: BioErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for BioError {
    /// Shows just the message (what the UI prints).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BioError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_strings_match_the_typescript_union() {
        assert_eq!(BioErrorCode::TooLarge.as_str(), "too-large");
        assert_eq!(BioErrorCode::InvalidResidue.as_str(), "invalid-residue");
        assert_eq!(BioErrorCode::AlphabetMismatch.as_str(), "alphabet-mismatch");
        assert_eq!(BioErrorCode::IncompatibleModel.as_str(), "incompatible-model");
    }

    #[test]
    fn display_is_the_message() {
        let e = BioError::new(BioErrorCode::InvalidArgument, "nope");
        assert_eq!(e.to_string(), "nope");
        assert_eq!(e.code, BioErrorCode::InvalidArgument);
    }
}
