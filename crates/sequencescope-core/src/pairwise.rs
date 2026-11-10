//! Pairwise alignment by dynamic programming: Needleman-Wunsch (global) and Smith-Waterman (local), each with linear
//! gaps (one matrix H) or affine gaps (Gotoh's three matrices M, X, Y). Port of `src/bio/pairwise.ts`; see
//! ALGORITHMS.md sections 1-3.
//!
//! Conventions (identical to the TypeScript reference, and the tests prove it cell by cell):
//!  * Penalties are positive numbers; internally gap scores are NEGATIVE. Affine: a gap of length k costs
//!    open + (k-1)*extend. Linear is the special case open = extend.
//!  * TIE-BREAKING in the traceback: diagonal first, then up (residue of A against a gap), then left (residue of B
//!    against a gap). In affine mode the previous state is tried in the order M, X, Y. The deterministic alignment
//!    always takes the first option; enumeration visits the options in this same order (depth first).
//!  * Local alignments start from the FIRST optimal end cell (scan order: row by row, left to right) and stop at a
//!    zero cell (linear) or at a "fresh start" (affine), so they are reported in minimal form.
//!  * End gaps are charged in global mode.
//!  * Co-optimal alignments can be enumerated up to a hard cap.

use crate::error::{BioError, BioErrorCode};
use crate::scoring::{CompiledScoring, encode_residues};
use crate::types::{AlignMode, PairwiseAlignment};

/// (m+1)*(n+1) hard cap = two 5,000-residue sequences: about 125 MB linear, 350 MB affine.
pub const MAX_DP_CELLS: usize = 5001 * 5001;
/// Default cap for co-optimal enumeration.
pub const MAX_ENUMERATED_ALIGNMENTS: usize = 1000;
/// "Minus infinity" that cannot overflow i32 when a penalty is subtracted once.
const NEG: i32 = -1_000_000_000;
/// Maximum number of tied local end cells remembered.
const ENDS_CAP: usize = 10_000;

// Linear pointer bits: which predecessors achieve the maximum.
const L_DIAG: u8 = 1;
const L_UP: u8 = 2;
const L_LEFT: u8 = 4;
// Affine pointer layout in a u16: bits 0-2 = predecessor states of M (M=1, X=2, Y=4), bit 3 = local start,
// bits 4-6 = predecessor states of X, bits 7-9 = predecessor states of Y.
const A_START: u16 = 8;
const A_X_SHIFT: u16 = 4;
const A_Y_SHIFT: u16 = 7;

/// One alignment column type: M = both residues, X = residue of A against a gap, Y = residue of B against a gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    M,
    X,
    Y,
}

/// The score and pointer tables of a filled DP (what the matrix viewer will show).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tables {
    Linear {
        h: Vec<i32>,
        p: Vec<u8>,
    },
    Affine {
        m: Vec<i32>,
        x: Vec<i32>,
        y: Vec<i32>,
        p: Vec<u16>,
    },
}

/// A filled dynamic-programming problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dp {
    pub mode: AlignMode,
    /// The original (ASCII) residues of A and B.
    pub str_a: Vec<u8>,
    pub str_b: Vec<u8>,
    /// m + 1 and n + 1.
    pub rows: usize,
    pub cols: usize,
    /// Optimal score (local: 0 if no positive-scoring region exists).
    pub score: i32,
    /// Cells where an optimal traceback may start: linear = flat cell index; affine = flat index * 3 + state.
    pub ends: Vec<usize>,
    pub tables: Tables,
}

/// Inserts thousands separators ("25,020,004") like JavaScript's `toLocaleString('en-US')`.
fn group_thousands(n: usize) -> String {
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

/// Refuses requests whose DP tables would exceed the memory cap (a typed error, not a crash).
pub fn assert_within_cap(m: usize, n: usize, affine: bool) -> Result<(), BioError> {
    let cells = (m + 1) * (n + 1);
    if cells > MAX_DP_CELLS {
        let bytes_per_cell = if affine { 14.0 } else { 5.0 };
        let mb = ((cells as f64 * bytes_per_cell) / 1_048_576.0 + 0.5).floor() as u64; // JavaScript's Math.round
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "Aligning {m} x {n} residues needs about {mb} MB ({} cells); the limit is {} cells.",
                group_thousands(cells),
                group_thousands(MAX_DP_CELLS)
            ),
        ));
    }
    Ok(())
}

/// Fills the DP tables (Eq. 1-3 in ALGORITHMS.md) and records which predecessors achieve each maximum.
pub fn fill_matrix(a: &str, b: &str, mode: AlignMode, scoring: &CompiledScoring) -> Result<Dp, BioError> {
    assert_within_cap(
        a.chars().map(char::len_utf16).sum(),
        b.chars().map(char::len_utf16).sum(),
        scoring.affine,
    )?;
    let codes_a = encode_residues(a, scoring)?;
    let codes_b = encode_residues(b, scoring)?;
    // Encoding succeeded, so every letter is ASCII and the bytes are the letters.
    let (str_a, str_b) = (a.as_bytes().to_vec(), b.as_bytes().to_vec());
    Ok(if scoring.affine {
        fill_affine(str_a, str_b, &codes_a, &codes_b, mode, scoring)
    } else {
        fill_linear(str_a, str_b, &codes_a, &codes_b, mode, scoring)
    })
}

/// Linear-gap fill: H[i][j] = max(H[i-1][j-1]+s, H[i-1][j]-g, H[i][j-1]-g) (and 0 for local).
fn fill_linear(
    str_a: Vec<u8>,
    str_b: Vec<u8>,
    codes_a: &[u8],
    codes_b: &[u8],
    mode: AlignMode,
    sc: &CompiledScoring,
) -> Dp {
    let (m, n) = (codes_a.len(), codes_b.len());
    let w = n + 1;
    let k = sc.classes;
    let g = sc.gap_open; // linear: open == extend == g
    let local = mode == AlignMode::Local;
    let mut h = vec![0i32; (m + 1) * w];
    let mut p = vec![0u8; (m + 1) * w];
    if !local {
        for i in 1..=m {
            h[i * w] = -(i as i32) * g; // H[i][0] = -i*g
            p[i * w] = L_UP;
        }
        for j in 1..=n {
            h[j] = -(j as i32) * g; // H[0][j] = -j*g
            p[j] = L_LEFT;
        }
    }
    let mut best = 0i32;
    let mut ends: Vec<usize> = Vec::new();
    for i in 1..=m {
        let row = i * w;
        let prow = row - w;
        let ai = codes_a[i - 1] as usize * k;
        for j in 1..=n {
            let d = h[prow + j - 1] + sc.table[ai + codes_b[j - 1] as usize]; // diagonal: align a_i with b_j
            let up = h[prow + j] - g; // a_i against a gap
            let left = h[row + j - 1] - g; // b_j against a gap
            let mut v = d;
            if up > v {
                v = up;
            }
            if left > v {
                v = left;
            }
            if local {
                if v <= 0 {
                    continue; // H stays 0, pointer 0: traceback stops here
                }
                if v > best {
                    best = v;
                    ends = vec![row + j];
                } else if v == best && ends.len() < ENDS_CAP {
                    ends.push(row + j);
                }
            }
            h[row + j] = v;
            p[row + j] = (if d == v { L_DIAG } else { 0 })
                | (if up == v { L_UP } else { 0 })
                | (if left == v { L_LEFT } else { 0 });
        }
    }
    let score = if local { best } else { h[m * w + n] };
    Dp {
        mode,
        str_a,
        str_b,
        rows: m + 1,
        cols: w,
        score,
        ends: if local { ends } else { vec![m * w + n] },
        tables: Tables::Linear { h, p },
    }
}

/// Clamps a value at NEG so repeated penalties can never overflow i32.
fn clamp_neg(v: i32) -> i32 {
    v.max(NEG)
}

/// Gotoh fill: M (aligned pair), X (A residue vs gap), Y (B residue vs gap); see ALGORITHMS.md section 2.
fn fill_affine(
    str_a: Vec<u8>,
    str_b: Vec<u8>,
    codes_a: &[u8],
    codes_b: &[u8],
    mode: AlignMode,
    sc: &CompiledScoring,
) -> Dp {
    let (m, n) = (codes_a.len(), codes_b.len());
    let w = n + 1;
    let k = sc.classes;
    let (open, ext) = (sc.gap_open, sc.gap_extend);
    let local = mode == AlignMode::Local;
    let size = (m + 1) * w;
    let mut mm = vec![NEG; size];
    let mut xx = vec![NEG; size];
    let mut yy = vec![NEG; size];
    let mut p = vec![0u16; size];
    if !local {
        mm[0] = 0;
        for i in 1..=m {
            // Leading gap in B: the first column pays open, later ones extend.
            xx[i * w] = clamp_neg(-open - (i as i32 - 1) * ext);
            p[i * w] = (if i == 1 { 1 } else { 2 }) << A_X_SHIFT; // from M (open) or from X (extend)
        }
        for j in 1..=n {
            yy[j] = clamp_neg(-open - (j as i32 - 1) * ext);
            p[j] = (if j == 1 { 1 } else { 4 }) << A_Y_SHIFT; // from M (open) or from Y (extend)
        }
    }
    let mut best = 0i32;
    let mut ends: Vec<usize> = Vec::new();
    for i in 1..=m {
        let row = i * w;
        let prow = row - w;
        let ai = codes_a[i - 1] as usize * k;
        for j in 1..=n {
            let idx = row + j;
            // M: best of the three states at (i-1,j-1) plus s(a_i,b_j); local may also start fresh (value 0).
            let pi = prow + j - 1;
            let (pm, px, py) = (mm[pi], xx[pi], yy[pi]);
            let pb = pm.max(px).max(py);
            let s = sc.table[ai + codes_b[j - 1] as usize];
            let (mv, mmask): (i32, u16) = if local && pb <= 0 {
                (s, A_START)
            } else {
                (
                    clamp_neg(pb + s),
                    u16::from(pm == pb) | (u16::from(px == pb) << 1) | (u16::from(py == pb) << 2),
                )
            };
            mm[idx] = mv;
            if local {
                if mv > best {
                    best = mv;
                    ends = vec![idx * 3];
                } else if mv == best && mv > 0 && ends.len() < ENDS_CAP {
                    ends.push(idx * 3);
                }
            }
            // X: gap column consuming a_i. Open from M or Y (pays open), or extend X (pays extend).
            let ui = prow + j;
            let (xm, xe, xy) = (mm[ui] - open, xx[ui] - ext, yy[ui] - open);
            let xv = xm.max(xe).max(xy);
            let xmask = u16::from(xm == xv) | (u16::from(xe == xv) << 1) | (u16::from(xy == xv) << 2);
            xx[idx] = clamp_neg(xv);
            // Y: gap column consuming b_j. Open from M or X, or extend Y.
            let li = row + j - 1;
            let (ym, yx, ye) = (mm[li] - open, xx[li] - open, yy[li] - ext);
            let yv = ym.max(yx).max(ye);
            let ymask = u16::from(ym == yv) | (u16::from(yx == yv) << 1) | (u16::from(ye == yv) << 2);
            yy[idx] = clamp_neg(yv);
            p[idx] = mmask | (xmask << A_X_SHIFT) | (ymask << A_Y_SHIFT);
        }
    }
    let (score, end_list) = if local {
        (best, if best > 0 { ends } else { Vec::new() })
    } else {
        let last = m * w + n;
        let vals = [mm[last], xx[last], yy[last]];
        let score = vals[0].max(vals[1]).max(vals[2]);
        (
            score,
            (0..3).filter(|&st| vals[st] == score).map(|st| last * 3 + st).collect(),
        )
    };
    Dp {
        mode,
        str_a,
        str_b,
        rows: m + 1,
        cols: w,
        score,
        ends: end_list,
        tables: Tables::Affine { m: mm, x: xx, y: yy, p },
    }
}

/// A predecessor option while walking back through the tables.
#[derive(Debug, Clone, Copy)]
struct Opt {
    i: usize,
    j: usize,
    state: usize,
    op: Op,
    /// After taking this step the local alignment is finished.
    end: bool,
}

/// Predecessor options of a cell/state in preference order (diagonal, up, left; or states M, X, Y).
fn neighbors(dp: &Dp, i: usize, j: usize, state: usize) -> Vec<Opt> {
    let idx = i * dp.cols + j;
    match &dp.tables {
        Tables::Linear { p, .. } => {
            let mask = p[idx];
            let mut out = Vec::new();
            if mask & L_DIAG != 0 {
                out.push(Opt {
                    i: i - 1,
                    j: j - 1,
                    state: 0,
                    op: Op::M,
                    end: false,
                });
            }
            if mask & L_UP != 0 {
                out.push(Opt {
                    i: i - 1,
                    j,
                    state: 0,
                    op: Op::X,
                    end: false,
                });
            }
            if mask & L_LEFT != 0 {
                out.push(Opt {
                    i,
                    j: j - 1,
                    state: 0,
                    op: Op::Y,
                    end: false,
                });
            }
            out
        }
        Tables::Affine { p, .. } => {
            let pv = p[idx];
            if state == 0 && pv & A_START != 0 {
                return vec![Opt {
                    i: i - 1,
                    j: j - 1,
                    state: 0,
                    op: Op::M,
                    end: true,
                }];
            }
            let bits = match state {
                0 => pv & 7,
                1 => (pv >> A_X_SHIFT) & 7,
                _ => (pv >> A_Y_SHIFT) & 7,
            };
            let di = usize::from(state != 2);
            let dj = usize::from(state != 1);
            let op = match state {
                0 => Op::M,
                1 => Op::X,
                _ => Op::Y,
            };
            (0..3usize)
                .filter(|st| bits & (1 << st) != 0)
                .map(|st| Opt {
                    i: i - di,
                    j: j - dj,
                    state: st,
                    op,
                    end: false,
                })
                .collect()
        }
    }
}

/// Converts traceback-order operations into the two gapped rows and original-sequence coordinates.
fn to_alignment(
    dp: &Dp,
    ops_backward: &[Op],
    start_i: usize,
    start_j: usize,
    end_i: usize,
    end_j: usize,
) -> PairwiseAlignment {
    let (mut i, mut j) = (start_i, start_j);
    let mut row_a = String::with_capacity(ops_backward.len());
    let mut row_b = String::with_capacity(ops_backward.len());
    for op in ops_backward.iter().rev() {
        match op {
            Op::M => {
                row_a.push(dp.str_a[i] as char);
                row_b.push(dp.str_b[j] as char);
                i += 1;
                j += 1;
            }
            Op::X => {
                row_a.push(dp.str_a[i] as char);
                row_b.push('-');
                i += 1;
            }
            Op::Y => {
                row_a.push('-');
                row_b.push(dp.str_b[j] as char);
                j += 1;
            }
        }
    }
    PairwiseAlignment {
        mode: dp.mode,
        score: dp.score,
        row_a,
        row_b,
        start_a: start_i,
        end_a: end_i,
        start_b: start_j,
        end_b: end_j,
    }
}

/// Empty alignment for local searches with no positive-scoring region.
fn empty_alignment(dp: &Dp) -> PairwiseAlignment {
    PairwiseAlignment {
        mode: dp.mode,
        score: 0,
        row_a: String::new(),
        row_b: String::new(),
        start_a: 0,
        end_a: 0,
        start_b: 0,
        end_b: 0,
    }
}

/// Splits an end-cell code into (row, column, state): linear = flat index; affine = flat index * 3 + state.
fn decode_end(dp: &Dp, e: usize) -> (usize, usize, usize) {
    let (cell, state) = if matches!(dp.tables, Tables::Affine { .. }) {
        (e / 3, e % 3)
    } else {
        (e, 0)
    };
    (cell / dp.cols, cell % dp.cols, state)
}

/// Deterministic traceback: starts at the first optimal end and always takes the first (preferred) predecessor.
pub fn traceback_first(dp: &Dp) -> PairwiseAlignment {
    let Some(&first) = dp.ends.first() else {
        return empty_alignment(dp);
    };
    let (mut i, mut j, mut state) = decode_end(dp, first);
    let (end_i, end_j) = (i, j);
    let mut ops: Vec<Op> = Vec::new();
    loop {
        let opts = neighbors(dp, i, j, state);
        let Some(o) = opts.first() else { break };
        ops.push(o.op);
        (i, j, state) = (o.i, o.j, o.state);
        if o.end {
            break;
        }
    }
    to_alignment(dp, &ops, i, j, end_i, end_j)
}

/// One level of the depth-first search over tied predecessors.
struct Frame {
    opts: Vec<Opt>,
    k: usize,
    via_op: bool,
}

/// Records one finished alignment unless the cap is already reached (then it marks the result as capped).
fn record(
    dp: &Dp,
    ops: &[Op],
    results: &mut Vec<PairwiseAlignment>,
    capped: &mut bool,
    cap: usize,
    ends: (usize, usize),
    start: (usize, usize),
) -> bool {
    if results.len() >= cap {
        *capped = true;
        return false;
    }
    results.push(to_alignment(dp, ops, start.0, start.1, ends.0, ends.1));
    true
}

/// Result of enumerating co-optimal alignments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enumerated {
    pub alignments: Vec<PairwiseAlignment>,
    /// True if more co-optimal alignments exist than the cap allowed.
    pub capped: bool,
}

/// Enumerates co-optimal alignments by depth-first search over tied predecessors, stopping at `cap`.
pub fn traceback_all(dp: &Dp, cap: usize) -> Result<Enumerated, BioError> {
    if cap < 1 {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            "Enumeration cap must be a positive integer.",
        ));
    }
    let mut results: Vec<PairwiseAlignment> = Vec::new();
    if dp.ends.is_empty() {
        return Ok(Enumerated {
            alignments: vec![empty_alignment(dp)],
            capped: false,
        });
    }
    let mut capped = false;
    for &e in &dp.ends {
        let (end_i, end_j, state0) = decode_end(dp, e);
        let ends = (end_i, end_j);
        let top_opts = neighbors(dp, end_i, end_j, state0);
        let top_is_leaf = top_opts.is_empty();
        let mut stack = vec![Frame {
            opts: top_opts,
            k: 0,
            via_op: false,
        }];
        let mut ops: Vec<Op> = Vec::new();
        if top_is_leaf && !record(dp, &ops, &mut results, &mut capped, cap, ends, ends) {
            return Ok(Enumerated {
                alignments: results,
                capped,
            });
        }
        while let Some(f) = stack.last_mut() {
            if f.k >= f.opts.len() {
                let via_op = f.via_op;
                stack.pop();
                if via_op {
                    ops.pop();
                }
                continue;
            }
            let o = f.opts[f.k];
            f.k += 1;
            ops.push(o.op);
            let child = if o.end {
                Vec::new()
            } else {
                neighbors(dp, o.i, o.j, o.state)
            };
            if child.is_empty() {
                if !record(dp, &ops, &mut results, &mut capped, cap, ends, (o.i, o.j)) {
                    return Ok(Enumerated {
                        alignments: results,
                        capped,
                    });
                }
                ops.pop();
            } else {
                stack.push(Frame {
                    opts: child,
                    k: 0,
                    via_op: true,
                });
            }
        }
    }
    Ok(Enumerated {
        alignments: results,
        capped,
    })
}

/// Aligns two residue strings and returns the deterministic (first-preference) optimal alignment.
pub fn align(a: &str, b: &str, mode: AlignMode, scoring: &CompiledScoring) -> Result<PairwiseAlignment, BioError> {
    Ok(traceback_first(&fill_matrix(a, b, mode, scoring)?))
}

/// Result of `align_all`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignAll {
    pub alignments: Vec<PairwiseAlignment>,
    pub capped: bool,
    pub score: i32,
}

/// Aligns and also enumerates up to `cap` co-optimal alignments (the first one equals `align`'s result).
pub fn align_all(
    a: &str,
    b: &str,
    mode: AlignMode,
    scoring: &CompiledScoring,
    cap: usize,
) -> Result<AlignAll, BioError> {
    let dp = fill_matrix(a, b, mode, scoring)?;
    let r = traceback_all(&dp, cap)?;
    Ok(AlignAll {
        alignments: r.alignments,
        capped: r.capped,
        score: dp.score,
    })
}

/// Score only, in two rows of memory (O(n) instead of O(mn)); used by the shuffle test where no traceback is needed.
pub fn align_score_only(a: &str, b: &str, mode: AlignMode, scoring: &CompiledScoring) -> Result<i32, BioError> {
    let codes_a = encode_residues(a, scoring)?;
    let codes_b = encode_residues(b, scoring)?;
    let (m, n) = (codes_a.len(), codes_b.len());
    let w = n + 1;
    let k = scoring.classes;
    let t = &scoring.table;
    let local = mode == AlignMode::Local;
    let mut best = 0i32;
    if !scoring.affine {
        let g = scoring.gap_open;
        let mut prev = vec![0i32; w];
        let mut cur = vec![0i32; w];
        if !local {
            for (j, cell) in prev.iter_mut().enumerate().skip(1) {
                *cell = -(j as i32) * g; // row 0: j leading gaps
            }
        }
        for i in 1..=m {
            cur[0] = if local { 0 } else { -(i as i32) * g };
            let ai = codes_a[i - 1] as usize * k;
            for j in 1..=n {
                let mut v = prev[j - 1] + t[ai + codes_b[j - 1] as usize];
                let up = prev[j] - g;
                let left = cur[j - 1] - g;
                if up > v {
                    v = up;
                }
                if left > v {
                    v = left;
                }
                if local {
                    v = v.max(0);
                    best = best.max(v);
                }
                cur[j] = v;
            }
            std::mem::swap(&mut prev, &mut cur);
        }
        return Ok(if local { best } else { prev[n] });
    }
    let (open, ext) = (scoring.gap_open, scoring.gap_extend);
    let (mut pm, mut px, mut py) = (vec![NEG; w], vec![NEG; w], vec![NEG; w]);
    let (mut cm, mut cx, mut cy) = (vec![0i32; w], vec![0i32; w], vec![0i32; w]);
    if !local {
        pm[0] = 0;
        for (j, cell) in py.iter_mut().enumerate().skip(1) {
            *cell = clamp_neg(-open - (j as i32 - 1) * ext); // row 0: a leading gap run of length j
        }
    }
    for i in 1..=m {
        cm[0] = NEG;
        cy[0] = NEG;
        cx[0] = if local {
            NEG
        } else {
            clamp_neg(-open - (i as i32 - 1) * ext)
        };
        let ai = codes_a[i - 1] as usize * k;
        for j in 1..=n {
            let pb = pm[j - 1].max(px[j - 1]).max(py[j - 1]);
            let s = t[ai + codes_b[j - 1] as usize];
            let mv = clamp_neg((if local && pb < 0 { 0 } else { pb }) + s);
            cm[j] = if local && pb <= 0 { s } else { mv };
            if local && cm[j] > best {
                best = cm[j];
            }
            cx[j] = clamp_neg((pm[j] - open).max(py[j] - open).max(px[j] - ext));
            cy[j] = clamp_neg((cm[j - 1] - open).max(cx[j - 1] - open).max(cy[j - 1] - ext));
        }
        std::mem::swap(&mut pm, &mut cm);
        std::mem::swap(&mut px, &mut cx);
        std::mem::swap(&mut py, &mut cy);
    }
    Ok(if local { best } else { pm[n].max(px[n]).max(py[n]) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoring::compile_scoring;
    use crate::types::{Alphabet, GapModel, ScoringSpec, SubstitutionSpec};

    fn dna(m: i32, mm: i32, gaps: GapModel) -> CompiledScoring {
        compile_scoring(
            &ScoringSpec {
                substitution: SubstitutionSpec::Simple {
                    match_score: m,
                    mismatch_score: mm,
                },
                gaps,
            },
            Alphabet::Dna,
        )
        .expect("valid scoring") // test code
    }
    fn lin(g: i32) -> GapModel {
        GapModel::Linear { gap: g }
    }
    fn aff(o: i32, e: i32) -> GapModel {
        GapModel::Affine { open: o, extend: e }
    }
    fn run(a: &str, b: &str, mode: AlignMode, sc: &CompiledScoring) -> PairwiseAlignment {
        align(a, b, mode, sc).expect("alignment") // test code
    }

    #[test]
    fn textbook_global_example_gcatgcg_gattaca() {
        let sc = dna(1, -1, lin(1));
        let r = run("GCATGCG", "GATTACA", AlignMode::Global, &sc);
        assert_eq!(r.score, 0);
        assert_eq!((r.start_a, r.end_a, r.start_b, r.end_b), (0, 7, 0, 7));
    }

    #[test]
    fn group_thousands_matches_the_en_us_locale() {
        assert_eq!(group_thousands(25_010_001), "25,010,001");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(group_thousands(1000), "1,000");
    }

    // Ported from tests/unit/edge-cases.test.ts.
    #[test]
    fn global_empty_vs_empty_scores_zero_and_empty_vs_nonempty_is_one_all_gap_alignment() {
        let sc = dna(2, -3, aff(5, 1));
        let e = run("", "", AlignMode::Global, &sc);
        assert_eq!((e.score, e.row_a.as_str(), e.row_b.as_str()), (0, "", ""));
        let r = run("", "ACG", AlignMode::Global, &sc);
        assert_eq!(
            (r.score, r.row_a.as_str(), r.row_b.as_str()),
            (-(5 + 1 + 1), "---", "ACG")
        );
        let l = run("AC", "", AlignMode::Global, &dna(2, -3, lin(4)));
        assert_eq!((l.score, l.row_a.as_str(), l.row_b.as_str()), (-8, "AC", "--"));
    }

    #[test]
    fn local_empty_input_gives_score_zero_and_an_empty_alignment() {
        assert_eq!(run("", "ACG", AlignMode::Local, &dna(2, -3, lin(4))).row_a, "");
        let all = align_all("", "", AlignMode::Local, &dna(2, -3, aff(3, 1)), 1000).expect("align"); // test code
        assert_eq!((all.score, all.capped), (0, false));
    }

    #[test]
    fn single_residues() {
        let sc = dna(2, -3, lin(4));
        assert_eq!(run("A", "A", AlignMode::Global, &sc).score, 2);
        assert_eq!(
            run("A", "C", AlignMode::Global, &sc).score,
            -3,
            "a mismatch (-3) beats two gaps (-8)"
        );
        assert_eq!(run("A", "C", AlignMode::Local, &sc).score, 0);
    }

    #[test]
    fn completely_different_sequences_local_is_zero_global_still_aligns_end_to_end() {
        let sc = dna(2, -3, aff(5, 2));
        let l = run("AAAAAA", "CCCCCC", AlignMode::Local, &sc);
        assert_eq!((l.score, l.row_a.as_str(), l.end_a), (0, "", 0));
        assert_eq!(run("AAAAAA", "CCCCCC", AlignMode::Global, &sc).score, -18);
    }

    #[test]
    fn affine_all_gap_alignment_has_the_closed_form() {
        assert_eq!(
            run("", "AAAAAAAAAA", AlignMode::Global, &dna(1, -1, aff(7, 2))).score,
            -(7 + 9 * 2)
        );
    }

    #[test]
    fn very_unequal_lengths_work() {
        let sc = dna(2, -3, aff(5, 1));
        let long = "ACGT".repeat(50);
        let r = run(&long, "ACGT", AlignMode::Global, &sc);
        assert_eq!(r.row_a.len(), long.len());
        assert_eq!(run(&long, "ACGT", AlignMode::Local, &sc).score, 8);
    }

    #[test]
    fn dna_ambiguity_codes_score_zero() {
        let sc = dna(2, -3, lin(4));
        assert_eq!(run("ACNGT", "ACNGT", AlignMode::Global, &sc).score, 2 * 4);
    }

    #[test]
    fn invalid_characters_raise_a_typed_error_with_the_position() {
        let e = align("ACGT", "AC#T", AlignMode::Global, &dna(1, -1, lin(1))).expect_err("bad letter"); // test code
        assert_eq!(e.code, BioErrorCode::InvalidResidue);
        assert!(e.message.contains("position 3"));
    }

    #[test]
    fn size_cap_is_exact() {
        assert!(assert_within_cap(5000, 5000, true).is_ok());
        let e = assert_within_cap(5001, 5001, false).expect_err("over the cap"); // test code
        assert_eq!(e.code, BioErrorCode::TooLarge);
        assert!(
            e.message.contains("25,020,004 cells") && e.message.contains("25,010,001 cells"),
            "{}",
            e.message
        );
        assert!(
            assert_within_cap(5000, 5001, true).is_err(),
            "5001 x 5002 cells is over the cap"
        );
    }

    #[test]
    fn enumeration_cap_must_be_positive() {
        let dp = fill_matrix("AC", "AC", AlignMode::Global, &dna(1, -1, lin(1))).expect("fill"); // test code
        assert_eq!(
            traceback_all(&dp, 0).expect_err("cap 0").code,
            BioErrorCode::InvalidArgument
        );
    }

    #[test]
    fn enumeration_reports_capped_only_when_more_exist() {
        let sc = dna(0, 0, lin(0)); // every alignment scores 0, so ALL alignments are co-optimal
        let all = align_all("AAA", "AAA", AlignMode::Global, &sc, 1_000_000).expect("align"); // test code
        let n = all.alignments.len();
        assert_eq!(
            n, 63,
            "the Delannoy number D(3,3): all ways to align two length-3 sequences"
        );
        assert!(!all.capped);
        let exact = align_all("AAA", "AAA", AlignMode::Global, &sc, n).expect("align"); // test code
        assert!(!exact.capped, "cap equal to the count is not capped");
        let fewer = align_all("AAA", "AAA", AlignMode::Global, &sc, n - 1).expect("align"); // test code
        assert!(fewer.capped && fewer.alignments.len() == n - 1);
    }

    #[test]
    fn tie_order_prefers_diagonal_then_up_then_left() {
        // A vs AA with free gaps: every placement ties. The first (preferred) alignment keeps the diagonal last
        // (traceback walks backwards, taking the diagonal first), i.e. the gap comes first in the row.
        let sc = dna(1, -1, lin(0));
        let r = run("A", "AA", AlignMode::Global, &sc);
        assert_eq!((r.row_a.as_str(), r.row_b.as_str()), ("-A", "AA"));
    }
}
