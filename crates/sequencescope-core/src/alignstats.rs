//! What the Align view shows about a finished alignment: identity / similarity / gap statistics, the match line between
//! the two rows, and the explanation of one DP cell (which candidate values produced it and which move was chosen).
//! Port of `alignmentStats`, `matchLine` (src/bio/alignstats.ts) and `cellInfo` (src/bio/pairwise.ts). `cell_info` takes the
//! raw table values around the cell (the page already holds the tables), so Rust never has to keep a DP alive.

use crate::error::{BioError, BioErrorCode};
use crate::pairwise::{A_START, A_X_SHIFT, A_Y_SHIFT, L_DIAG, L_LEFT, L_UP, NEG};
use crate::scoring::CompiledScoring;
use crate::types::{AlignMode, PairwiseAlignment};

/// Identity, similarity and gap statistics (the denominator of the percentages is the alignment length).
#[derive(Debug, Clone, PartialEq)]
pub struct AlignmentStats {
    pub length: usize,
    pub identities: usize,
    pub mismatches: usize,
    pub positives: usize,
    pub gap_columns: usize,
    pub gap_opens: usize,
    pub gaps_in_a: usize,
    pub gaps_in_b: usize,
    pub ambiguous_columns: usize,
    pub identity_pct: Option<f64>,
    pub similarity_pct: Option<f64>,
    pub aligned_columns: usize,
}

/// Computes the statistics of one alignment.
pub fn alignment_stats(aln: &PairwiseAlignment, sc: &CompiledScoring) -> Result<AlignmentStats, BioError> {
    let (mut identities, mut mismatches, mut positives, mut gap_columns, mut gap_opens) = (0, 0, 0, 0, 0);
    let (mut gaps_in_a, mut gaps_in_b, mut ambiguous_columns) = (0, 0, 0);
    let mut prev_gap: Option<char> = None; // 'A' or 'B': which row had the gap in the previous column
    let (row_a, row_b): (Vec<char>, Vec<char>) = (aln.row_a.chars().collect(), aln.row_b.chars().collect());
    for (&x, &y) in row_a.iter().zip(&row_b) {
        if x == '-' || y == '-' {
            gap_columns += 1;
            let which = if x == '-' { 'A' } else { 'B' };
            if which == 'A' {
                gaps_in_a += 1;
            } else {
                gaps_in_b += 1;
            }
            if prev_gap != Some(which) {
                gap_opens += 1;
            }
            prev_gap = Some(which);
            continue;
        }
        prev_gap = None;
        if sc.is_ambiguous(x) || sc.is_ambiguous(y) {
            ambiguous_columns += 1;
            mismatches += 1;
            continue;
        }
        if x == y {
            identities += 1;
        } else {
            mismatches += 1;
            if sc.char_score(x, y)? > 0 {
                positives += 1;
            }
        }
    }
    let length = row_a.len();
    Ok(AlignmentStats {
        length,
        identities,
        mismatches,
        positives,
        gap_columns,
        gap_opens,
        gaps_in_a,
        gaps_in_b,
        ambiguous_columns,
        identity_pct: (length != 0).then(|| (identities as f64 / length as f64) * 100.0),
        similarity_pct: (length != 0).then(|| ((identities + positives) as f64 / length as f64) * 100.0),
        aligned_columns: length - gap_columns,
    })
}

/// Match line: '|' identity, ':' positive score, '.' score 0, ' ' mismatch, gap or ambiguity code.
pub fn match_line(aln: &PairwiseAlignment, sc: &CompiledScoring) -> Result<String, BioError> {
    let mut out = String::with_capacity(aln.row_a.len());
    for (x, y) in aln.row_a.chars().zip(aln.row_b.chars()) {
        out.push(if x == '-' || y == '-' || sc.is_ambiguous(x) || sc.is_ambiguous(y) {
            ' '
        } else if x == y {
            '|'
        } else {
            match sc.char_score(x, y)? {
                s if s > 0 => ':',
                0 => '.',
                _ => ' ',
            }
        });
    }
    Ok(out)
}

/// The table values around one cell, as the page reads them from the transferred tables.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValues {
    /// Linear gaps: H at (i-1,j-1), (i-1,j), (i,j-1), (i,j), and the pointer byte at (i,j).
    Linear {
        diag: i32,
        up: i32,
        left: i32,
        here: i32,
        pointer: u8,
    },
    /// Affine gaps: M, X, Y at the same four cells (each `[M, X, Y]`), and the pointer word at (i,j).
    Affine {
        diag: [i32; 3],
        up: [i32; 3],
        left: [i32; 3],
        here: [i32; 3],
        pointer: u16,
    },
}

/// The explanation of one DP cell.
#[derive(Debug, Clone, PartialEq)]
pub enum CellInfo {
    Border {
        i: usize,
        j: usize,
        value: i32,
        note: &'static str,
    },
    Linear {
        i: usize,
        j: usize,
        s: i32,
        diag: i32,
        up: i32,
        left: i32,
        zero_floor: bool,
        value: i32,
        chosen: Vec<&'static str>,
    },
    Affine {
        i: usize,
        j: usize,
        s: i32,
        m: MInfo,
        x: XInfo,
        y: YInfo,
    },
}

/// State M of an affine cell.
#[derive(Debug, Clone, PartialEq)]
pub struct MInfo {
    pub from_m: i32,
    pub from_x: i32,
    pub from_y: i32,
    pub start_fresh: bool,
    pub value: i32,
    pub chosen: Vec<&'static str>,
}

/// State X of an affine cell.
#[derive(Debug, Clone, PartialEq)]
pub struct XInfo {
    pub open_from_m: i32,
    pub extend_x: i32,
    pub open_from_y: i32,
    pub value: i32,
    pub chosen: Vec<&'static str>,
}

/// State Y of an affine cell.
#[derive(Debug, Clone, PartialEq)]
pub struct YInfo {
    pub open_from_m: i32,
    pub open_from_x: i32,
    pub extend_y: i32,
    pub value: i32,
    pub chosen: Vec<&'static str>,
}

/// Predecessor state names from a 3-bit mask (M=1, X=2, Y=4).
fn mask_names(mask: u16) -> Vec<&'static str> {
    ["M", "X", "Y"]
        .into_iter()
        .enumerate()
        .filter(|(k, _)| mask & (1 << k) != 0)
        .map(|(_, n)| n)
        .collect()
}

/// Explains cell (i, j). `letters` are the residues a_i and b_j (None on the border); `sc` supplies the pair score and the
/// gap penalties; `values` are the table entries around the cell.
pub fn cell_info(
    mode: AlignMode,
    i: usize,
    j: usize,
    letters: Option<(char, char)>,
    sc: &CompiledScoring,
    values: &CellValues,
) -> Result<CellInfo, BioError> {
    if i == 0 || j == 0 {
        let raw = match values {
            CellValues::Linear { here, .. } => *here,
            CellValues::Affine { here, .. } => here[0].max(here[1]).max(here[2]),
        };
        let note = if mode == AlignMode::Local {
            "Local alignment: the first row and column are 0 (an alignment may start anywhere)."
        } else {
            "Global alignment: leading gaps are charged, so the border holds the cost of gaps only."
        };
        return Ok(CellInfo::Border {
            i,
            j,
            value: if raw <= NEG / 2 { 0 } else { raw },
            note,
        });
    }
    let (a, b) = letters.ok_or_else(|| {
        BioError::new(
            BioErrorCode::InvalidArgument,
            "An interior cell needs the two residues it pairs.",
        )
    })?;
    let class = |ch: char| -> Result<usize, BioError> {
        let c = if (ch as u32) < 128 {
            sc.class_of[ch as usize]
        } else {
            -1
        };
        usize::try_from(c).map_err(|_| {
            BioError::new(
                BioErrorCode::InvalidResidue,
                format!("Letter \"{ch}\" is not valid for {}.", sc.alphabet.as_str()),
            )
        })
    };
    let s = sc.table[class(a)? * sc.classes + class(b)?];
    Ok(match values {
        CellValues::Linear {
            diag,
            up,
            left,
            here,
            pointer,
        } => {
            let g = sc.gap_open;
            let (d, u, l) = (diag + s, up - g, left - g);
            let best = d.max(u).max(l);
            let mut chosen = Vec::new();
            if pointer & L_DIAG != 0 {
                chosen.push("diagonal");
            }
            if pointer & L_UP != 0 {
                chosen.push("up");
            }
            if pointer & L_LEFT != 0 {
                chosen.push("left");
            }
            CellInfo::Linear {
                i,
                j,
                s,
                diag: d,
                up: u,
                left: l,
                zero_floor: mode == AlignMode::Local && best <= 0,
                value: *here,
                chosen,
            }
        }
        CellValues::Affine {
            diag,
            up,
            left,
            here,
            pointer,
        } => {
            let (open, ext) = (sc.gap_open, sc.gap_extend);
            let start = pointer & A_START != 0;
            CellInfo::Affine {
                i,
                j,
                s,
                m: MInfo {
                    from_m: diag[0],
                    from_x: diag[1],
                    from_y: diag[2],
                    start_fresh: start,
                    value: here[0],
                    chosen: if start {
                        vec!["fresh start"]
                    } else {
                        mask_names(pointer & 7)
                    },
                },
                x: XInfo {
                    open_from_m: up[0] - open,
                    extend_x: up[1] - ext,
                    open_from_y: up[2] - open,
                    value: here[1],
                    chosen: mask_names((pointer >> A_X_SHIFT) & 7),
                },
                y: YInfo {
                    open_from_m: left[0] - open,
                    open_from_x: left[1] - open,
                    extend_y: left[2] - ext,
                    value: here[2],
                    chosen: mask_names((pointer >> A_Y_SHIFT) & 7),
                },
            }
        }
    })
}
