//! Progressive multiple sequence alignment (simplified Feng-Doolittle / ClustalW style; ALGORITHMS.md section 11):
//!   1. align every pair globally and take the p-distance of that pairwise alignment;
//!   2. build a guide tree (UPGMA, or neighbor-joining rooted at its midpoint) from those distances;
//!   3. walk the guide tree from the leaves up, aligning two PROFILES (already-aligned groups) at each node with Gotoh
//!      dynamic programming over alignment columns.
//!
//! Column score between profile column x (group A) and y (group B) = (sum of s(a,b) over residue pairs) / (|A||B|); pairs with
//! a gap contribute 0. Gap penalties are charged once per profile column, unscaled. "Once a gap, always a gap": merging only
//! INSERTS all-gap columns; existing columns never change. This is a HEURISTIC, not guaranteed to maximise the sum-of-pairs
//! score. Port of `src/bio/msa.ts`; every floating-point operation happens in the same order, so scores are bit-identical.

use crate::alphabet::js_len;
use crate::distance::{DIST_OK, DistanceMatrix, DistanceModel, GapPolicy, assert_tree_ready, pairwise_distance_matrix};
use crate::error::{BioError, BioErrorCode};
use crate::fasta::Sequence;
use crate::jsnum::group_thousands;
use crate::nj::neighbor_joining;
use crate::pairwise::MAX_DP_CELLS;
use crate::scoring::{CompiledScoring, encode_residues};
use crate::tree::{Tree, TreeNode, leaf_names, midpoint_root};
use crate::types::Alphabet;
use crate::upgma::upgma;
use crate::verify::score_aligned_rows;
use std::collections::{HashMap, HashSet};

pub const MAX_MSA_SEQS: usize = 50;
pub const MAX_MSA_LENGTH: usize = 3000;

/// Which guide tree to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuideMethod {
    Upgma,
    Nj,
}

impl GuideMethod {
    /// "upgma" or "nj", the strings the UI uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upgma => "upgma",
            Self::Nj => "nj",
        }
    }

    /// Parses "upgma" / "nj"; anything else is None.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "upgma" => Some(Self::Upgma),
            "nj" => Some(Self::Nj),
            _ => None,
        }
    }
}

/// One merge of two profiles.
#[derive(Debug, Clone, PartialEq)]
pub struct MsaStep {
    /// Row ids of the merged profile (left group first, then right group).
    pub ids: Vec<String>,
    pub left_ids: Vec<String>,
    pub right_ids: Vec<String>,
    pub rows: Vec<String>,
    /// Optimal profile-profile alignment score of this merge.
    pub score: f64,
}

/// The finished alignment, the guide tree, and every merge.
#[derive(Debug, Clone, PartialEq)]
pub struct MsaResult {
    pub ids: Vec<String>,
    pub rows: Vec<String>,
    pub alphabet: Alphabet,
    pub guide_tree: Tree,
    pub guide: GuideMethod,
    pub steps: Vec<MsaStep>,
    /// Sum over all sequence pairs of the pairwise score of their projected alignment (gap-gap columns removed).
    pub sum_of_pairs: i64,
}

/// Sum-of-pairs score of an alignment: each pair of rows is scored with the independent column-by-column scorer.
pub fn sum_of_pairs_score(rows: &[String], scoring: &CompiledScoring) -> Result<i64, BioError> {
    let chars: Vec<Vec<char>> = rows.iter().map(|r| r.chars().collect()).collect();
    let mut total = 0i64;
    for i in 0..chars.len() {
        for j in (i + 1)..chars.len() {
            let (mut ra, mut rb) = (String::new(), String::new());
            for (&x, &y) in chars[i].iter().zip(&chars[j]) {
                if x == '-' && y == '-' {
                    continue; // a column of two gaps carries no information about this pair
                }
                ra.push(x);
                rb.push(y);
            }
            total += i64::from(score_aligned_rows(&ra, &rb, scoring).map_err(unequal_rows)?);
        }
    }
    Ok(total)
}

/// Turns the re-scorer's message into a typed error.
fn unequal_rows(message: String) -> BioError {
    BioError::new(BioErrorCode::InvalidArgument, message)
}

/// Marks an all-gap residue class in a column.
const GAP: usize = usize::MAX;

/// One alignment column as the residue classes present with their counts (sparse; first appearance first).
struct Column {
    cls: Vec<usize>,
    cnt: Vec<usize>,
}

/// Per column: the residue classes present with their counts, used for fast column-vs-column scores.
fn column_classes(rows: &[Vec<char>], len: usize, scoring: &CompiledScoring) -> Result<Vec<Column>, BioError> {
    let mut codes: Vec<Vec<usize>> = Vec::with_capacity(rows.len());
    for r in rows {
        if r.len() != len {
            return Err(BioError::new(
                BioErrorCode::NotAligned,
                "The rows of a profile must all have the same number of columns.",
            ));
        }
        let mut row = Vec::with_capacity(len);
        for &ch in r {
            row.push(if ch == '-' {
                GAP
            } else if (ch as u32) < 128 && scoring.class_of[ch as usize] >= 0 {
                scoring.class_of[ch as usize] as usize
            } else {
                // An invalid letter: encode_residues builds the same typed error the TypeScript code raises.
                usize::from(encode_residues(&ch.to_string(), scoring)?.first().copied().unwrap_or(0))
            });
        }
        codes.push(row);
    }
    let mut cols = Vec::with_capacity(len);
    for c in 0..len {
        let mut col = Column {
            cls: Vec::new(),
            cnt: Vec::new(),
        };
        for r in &codes {
            let k = r[c];
            if k == GAP {
                continue;
            }
            match col.cls.iter().position(|&x| x == k) {
                Some(p) => col.cnt[p] += 1,
                None => {
                    col.cls.push(k);
                    col.cnt.push(1);
                }
            }
        }
        cols.push(col);
    }
    Ok(cols)
}

/// The merged rows (A rows first) and the optimal merge score.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub rows: Vec<String>,
    pub score: f64,
}

const NEG: f64 = -1e18;

/// Aligns two profiles (Gotoh over columns) and returns the merged rows (A rows first) and the optimal merge score.
pub fn merge_profiles(a: &[String], b: &[String], scoring: &CompiledScoring) -> Result<Merged, BioError> {
    merge_profiles_cancellable(a, b, scoring, &mut || false)?.ok_or_else(|| {
        BioError::new(
            BioErrorCode::InvalidArgument,
            "Internal error: a merge that cannot be cancelled was cancelled.",
        )
    })
}

/// Like `merge_profiles`, but `should_cancel` is polled every few DP rows; returns `Ok(None)` if it said yes.
pub fn merge_profiles_cancellable(
    a: &[String],
    b: &[String],
    scoring: &CompiledScoring,
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<Option<Merged>, BioError> {
    let la = a.first().map_or(0, |r| js_len(r));
    let lb = b.first().map_or(0, |r| js_len(r));
    if (la + 1) * (lb + 1) > MAX_DP_CELLS {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "Merging two profiles of {la} and {lb} columns needs {} matrix cells; the limit is {}.",
                group_thousands(((la + 1) * (lb + 1)) as u64),
                group_thousands(MAX_DP_CELLS as u64)
            ),
        ));
    }
    let a_chars: Vec<Vec<char>> = a.iter().map(|r| r.chars().collect()).collect();
    let b_chars: Vec<Vec<char>> = b.iter().map(|r| r.chars().collect()).collect();
    let ca = column_classes(&a_chars, la, scoring)?;
    let cb = column_classes(&b_chars, lb, scoring)?;
    let (k_classes, table) = (scoring.classes, &scoring.table);
    let norm = (a.len() * b.len()) as f64;
    // Mean substitution score between column i of A and column j of B (pairs with a gap contribute 0).
    let sub = |i: usize, j: usize| -> f64 {
        let (x, y) = (&ca[i], &cb[j]);
        let mut s = 0.0f64;
        for p in 0..x.cls.len() {
            for q in 0..y.cls.len() {
                s += (x.cnt[p] as f64) * (y.cnt[q] as f64) * f64::from(table[x.cls[p] * k_classes + y.cls[q]]);
            }
        }
        s / norm
    };
    let w = lb + 1;
    let (open, ext) = (f64::from(scoring.gap_open), f64::from(scoring.gap_extend));
    let size = (la + 1) * w;
    let (mut m, mut x_t, mut y_t) = (vec![NEG; size], vec![NEG; size], vec![NEG; size]);
    // bits 0-2: predecessors of M (M,X,Y); 4-6: of X; 7-9: of Y
    let mut p = vec![0u16; size];
    m[0] = 0.0;
    for i in 1..=la {
        x_t[i * w] = -open - (i - 1) as f64 * ext;
        p[i * w] = (if i == 1 { 1 } else { 2 }) << 4;
    }
    for j in 1..=lb {
        y_t[j] = -open - (j - 1) as f64 * ext;
        p[j] = (if j == 1 { 1 } else { 4 }) << 7;
    }
    for i in 1..=la {
        if i % 32 == 0 && should_cancel() {
            return Ok(None);
        }
        for j in 1..=lb {
            let idx = i * w + j;
            let (d, u, l) = (idx - w - 1, idx - w, idx - 1);
            let (pm, px, py) = (m[d], x_t[d], y_t[d]);
            let pb = pm.max(px).max(py);
            m[idx] = pb + sub(i - 1, j - 1);
            let mm = u16::from(pm == pb) | (u16::from(px == pb) << 1) | (u16::from(py == pb) << 2);
            let (xm, xx, xy) = (m[u] - open, x_t[u] - ext, y_t[u] - open);
            let xv = xm.max(xx).max(xy);
            x_t[idx] = xv;
            let xmask = u16::from(xm == xv) | (u16::from(xx == xv) << 1) | (u16::from(xy == xv) << 2);
            let (ym, yx, yy) = (m[l] - open, x_t[l] - open, y_t[l] - ext);
            let yv = ym.max(yx).max(yy);
            y_t[idx] = yv;
            let ymask = u16::from(ym == yv) | (u16::from(yx == yv) << 1) | (u16::from(yy == yv) << 2);
            p[idx] = mm | (xmask << 4) | (ymask << 7);
        }
    }
    let last = la * w + lb;
    let vals = [m[last], x_t[last], y_t[last]];
    let score = vals[0].max(vals[1]).max(vals[2]);
    let mut state = vals.iter().position(|&v| v == score).unwrap_or(0); // preference M, X, Y on ties
    // traceback: ops in reverse order
    let mut ops: Vec<u8> = Vec::with_capacity(la + lb);
    let (mut i, mut j) = (la, lb);
    while i > 0 || j > 0 {
        let cell = p[i * w + j];
        let bits = match state {
            0 => cell & 7,
            1 => (cell >> 4) & 7,
            _ => (cell >> 7) & 7,
        };
        ops.push(state as u8);
        let prev = if bits & 1 != 0 {
            0
        } else if bits & 2 != 0 {
            1
        } else {
            2
        };
        let step_ok = match state {
            0 => i > 0 && j > 0,
            1 => i > 0,
            _ => j > 0,
        };
        if !step_ok {
            return Err(BioError::new(
                BioErrorCode::InvalidArgument,
                "Internal error: the profile alignment traceback left the matrix.",
            ));
        }
        match state {
            0 => {
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
        state = prev;
    }
    ops.reverse();
    let mut out_a: Vec<String> = a.iter().map(|_| String::with_capacity(ops.len())).collect();
    let mut out_b: Vec<String> = b.iter().map(|_| String::with_capacity(ops.len())).collect();
    let (mut ia, mut ib) = (0usize, 0usize);
    for op in ops {
        let take_a = op == 0 || op == 1;
        let take_b = op == 0 || op == 2;
        for (k, row) in a_chars.iter().enumerate() {
            out_a[k].push(if take_a { row[ia] } else { '-' });
        }
        for (k, row) in b_chars.iter().enumerate() {
            out_b[k].push(if take_b { row[ib] } else { '-' });
        }
        ia += usize::from(take_a);
        ib += usize::from(take_b);
    }
    out_a.extend(out_b);
    Ok(Some(Merged { rows: out_a, score }))
}

/// Guide-tree distances: p of each pair's global alignment; pairs with no comparable sites get the maximum, 1.
fn guide_matrix(m: &DistanceMatrix) -> DistanceMatrix {
    let mut values = m.values.clone();
    for (k, s) in m.status.iter().enumerate() {
        if *s != DIST_OK {
            values[k] = 1.0;
        }
    }
    DistanceMatrix {
        values,
        status: vec![DIST_OK; m.status.len()],
        ..m.clone()
    }
}

/// A group of already-aligned sequences.
struct Profile {
    ids: Vec<String>,
    rows: Vec<String>,
}

/// State shared by the recursive walk over the guide tree.
struct Walker<'a> {
    scoring: &'a CompiledScoring,
    by_id: HashMap<&'a str, &'a Sequence>,
    steps: Vec<MsaStep>,
    merges: usize,
    done: usize,
    cancelled: bool,
    on_progress: &'a mut dyn FnMut(f64),
    should_cancel: &'a mut dyn FnMut() -> bool,
}

impl Walker<'_> {
    /// Aligns the profiles below `node`, bottom-up; None when cancelled.
    fn walk(&mut self, node: &TreeNode) -> Result<Option<Profile>, BioError> {
        if self.cancelled {
            return Ok(None);
        }
        if node.is_leaf() {
            let name = node.name.as_deref().unwrap_or("");
            let s = self.by_id.get(name).ok_or_else(|| {
                BioError::new(
                    BioErrorCode::InvalidTree,
                    format!("The guide tree names an unknown sequence \"{name}\"."),
                )
            })?;
            return Ok(Some(Profile {
                ids: vec![s.id.clone()],
                rows: vec![s.residues.clone()],
            }));
        }
        let mut kids = Vec::with_capacity(node.children.len());
        for child in &node.children {
            kids.push(self.walk(child)?);
        }
        let mut kids = kids.into_iter();
        let Some(Some(mut acc)) = kids.next() else {
            return Ok(None);
        };
        let rest: Vec<Option<Profile>> = kids.collect();
        if rest.iter().any(Option::is_none) {
            return Ok(None);
        }
        for next in rest.into_iter().flatten() {
            if (self.should_cancel)() {
                self.cancelled = true;
                return Ok(None);
            }
            let left = acc.ids.clone();
            let Some(merged) =
                merge_profiles_cancellable(&acc.rows, &next.rows, self.scoring, &mut *self.should_cancel)?
            else {
                self.cancelled = true;
                return Ok(None);
            };
            let mut ids = left.clone();
            ids.extend(next.ids.iter().cloned());
            self.steps.push(MsaStep {
                ids: ids.clone(),
                left_ids: left,
                right_ids: next.ids,
                rows: merged.rows.clone(),
                score: merged.score,
            });
            acc = Profile { ids, rows: merged.rows };
            self.done += 1;
            (self.on_progress)(0.6 + 0.4 * (self.done as f64 / self.merges as f64));
        }
        Ok(Some(acc))
    }
}

/// Progressive alignment of 1..50 sequences (each up to 3000 residues). Returns `Ok(None)` if cancelled. Sequence ids must be
/// unique (they name the guide-tree leaves). `should_cancel` is polled before each pair alignment and each profile merge.
pub fn progressive_align(
    seqs: &[Sequence],
    scoring: &CompiledScoring,
    guide: GuideMethod,
    on_progress: &mut dyn FnMut(f64),
    should_cancel: &mut dyn FnMut() -> bool,
) -> Result<Option<MsaResult>, BioError> {
    let alphabet = scoring.alphabet;
    if seqs.is_empty() {
        return Err(BioError::new(
            BioErrorCode::TooFewSequences,
            "Provide at least one sequence.",
        ));
    }
    if seqs.len() > MAX_MSA_SEQS {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            format!(
                "At most {MAX_MSA_SEQS} sequences can be aligned at once (got {}).",
                seqs.len()
            ),
        ));
    }
    if seqs.iter().map(|s| s.id.as_str()).collect::<HashSet<_>>().len() != seqs.len() {
        return Err(BioError::new(
            BioErrorCode::DuplicateNames,
            "Sequence names must be unique so the guide tree can name them.",
        ));
    }
    for s in seqs {
        let len = js_len(&s.residues);
        if len == 0 {
            return Err(BioError::new(
                BioErrorCode::InvalidArgument,
                format!("Sequence \"{}\" is empty.", s.id),
            ));
        }
        if len > MAX_MSA_LENGTH {
            return Err(BioError::new(
                BioErrorCode::TooLarge,
                format!(
                    "Sequence \"{}\" has {len} residues; the limit is {MAX_MSA_LENGTH}.",
                    s.id
                ),
            ));
        }
        encode_residues(&s.residues, scoring)?; // typed error with the position of an invalid letter
    }
    let ids: Vec<String> = seqs.iter().map(|s| s.id.clone()).collect();
    if seqs.len() == 1 {
        return Ok(Some(MsaResult {
            rows: vec![seqs[0].residues.clone()],
            guide_tree: Tree {
                root: TreeNode::leaf(&ids[0]),
            },
            ids,
            alphabet,
            guide,
            steps: Vec::new(),
            sum_of_pairs: 0,
        }));
    }

    let tree = if seqs.len() == 2 {
        Tree {
            root: TreeNode::with_children(ids.iter().map(|id| TreeNode::leaf(id)).collect()),
        }
    } else {
        let dm = pairwise_distance_matrix(
            seqs,
            scoring,
            DistanceModel::P,
            GapPolicy::PairwiseDeletion,
            &mut |f| on_progress(0.6 * f),
            should_cancel,
        )?;
        let Some(dm) = dm else {
            return Ok(None);
        };
        let gm = guide_matrix(&dm);
        assert_tree_ready(&gm)?;
        match guide {
            GuideMethod::Upgma => upgma(&gm)?.tree,
            GuideMethod::Nj => midpoint_root(&neighbor_joining(&gm)?.tree)?,
        }
    };

    let mut walker = Walker {
        scoring,
        by_id: seqs.iter().map(|s| (s.id.as_str(), s)).collect(),
        steps: Vec::new(),
        merges: leaf_names(&tree).len() - 1,
        done: 0,
        cancelled: false,
        on_progress,
        should_cancel,
    };
    let Some(fin) = walker.walk(&tree.root)? else {
        return Ok(None);
    };
    let order: HashMap<&str, usize> = fin.ids.iter().enumerate().map(|(k, id)| (id.as_str(), k)).collect();
    let mut rows = Vec::with_capacity(ids.len());
    for id in &ids {
        let k = order.get(id.as_str()).ok_or_else(|| {
            BioError::new(
                BioErrorCode::InvalidTree,
                format!("The guide tree is missing the sequence \"{id}\"."),
            )
        })?;
        rows.push(fin.rows[*k].clone());
    }
    let sum_of_pairs = sum_of_pairs_score(&rows, scoring)?;
    Ok(Some(MsaResult {
        steps: walker.steps,
        ids,
        rows,
        alphabet,
        guide_tree: tree,
        guide,
        sum_of_pairs,
    }))
}

/// Exhaustive sum-of-pairs optimum for a tiny set (for teaching and tests): enumerates EVERY alignment. Limited to at most
/// 4 sequences of at most 6 residues each so it cannot run away. Returns the best score and its rows (the first best wins).
pub fn brute_force_optimum_sp(seqs: &[String], scoring: &CompiledScoring) -> Result<(i64, Vec<String>), BioError> {
    if seqs.len() > 4 || seqs.iter().any(|s| js_len(s) > 6) {
        return Err(BioError::new(
            BioErrorCode::TooLarge,
            "The exhaustive search is limited to 4 sequences of at most 6 residues.",
        ));
    }
    let chars: Vec<Vec<char>> = seqs.iter().map(|s| s.chars().collect()).collect();
    let mut best: Option<i64> = None;
    let mut best_rows: Vec<String> = seqs.to_vec();
    let mut pos = vec![0usize; seqs.len()];
    let mut rows = vec![String::new(); seqs.len()];
    enumerate(&chars, scoring, &mut pos, &mut rows, &mut best, &mut best_rows)?;
    Ok((best.unwrap_or(i64::MIN), best_rows))
}

/// Tries every non-empty subset of sequences as the next column; scores each complete alignment.
fn enumerate(
    seqs: &[Vec<char>],
    scoring: &CompiledScoring,
    pos: &mut [usize],
    rows: &mut [String],
    best: &mut Option<i64>,
    best_rows: &mut Vec<String>,
) -> Result<(), BioError> {
    let n = seqs.len();
    if pos.iter().zip(seqs).all(|(p, s)| *p == s.len()) {
        let score = sum_of_pairs_score(rows, scoring)?;
        if best.is_none_or(|b| score > b) {
            *best = Some(score);
            *best_rows = rows.to_owned();
        }
        return Ok(());
    }
    for mask in 1usize..(1 << n) {
        if !(0..n).all(|k| mask & (1 << k) == 0 || pos[k] < seqs[k].len()) {
            continue;
        }
        let mut next_rows = rows.to_owned();
        let mut next_pos = pos.to_owned();
        for k in 0..n {
            if mask & (1 << k) != 0 {
                next_rows[k].push(seqs[k][pos[k]]);
                next_pos[k] += 1;
            } else {
                next_rows[k].push('-');
            }
        }
        enumerate(seqs, scoring, &mut next_pos, &mut next_rows, best, best_rows)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoring::compile_scoring;
    use crate::types::{GapModel, ScoringSpec, SubstitutionSpec};

    fn dna() -> CompiledScoring {
        compile_scoring(
            &ScoringSpec {
                substitution: SubstitutionSpec::Simple {
                    match_score: 2,
                    mismatch_score: -1,
                },
                gaps: GapModel::Affine { open: 3, extend: 1 },
            },
            Alphabet::Dna,
        )
        .expect("valid scoring") // test code
    }

    fn seq(id: &str, residues: &str) -> Sequence {
        Sequence {
            id: id.to_string(),
            description: String::new(),
            alphabet: Alphabet::Dna,
            residues: residues.to_string(),
        }
    }

    fn run(seqs: &[Sequence], guide: GuideMethod) -> MsaResult {
        progressive_align(seqs, &dna(), guide, &mut |_| {}, &mut || false)
            .expect("valid input")
            .expect("not cancelled") // test code
    }

    #[test]
    fn identical_sequences_align_without_gaps() {
        let r = run(
            &[seq("a", "ACGTACGT"), seq("b", "ACGTACGT"), seq("c", "ACGTACGT")],
            GuideMethod::Upgma,
        );
        assert!(r.rows.iter().all(|row| row == "ACGTACGT"));
        assert_eq!(r.sum_of_pairs, 3 * 8 * 2);
        assert_eq!(r.steps.len(), 2);
    }

    #[test]
    fn rows_without_gaps_equal_the_input_sequences_and_have_equal_length() {
        let input = [
            seq("a", "ACGTTGCA"),
            seq("b", "ACGTGCA"),
            seq("c", "ACTTGCAA"),
            seq("d", "CGTTGC"),
        ];
        for guide in [GuideMethod::Upgma, GuideMethod::Nj] {
            let r = run(&input, guide);
            assert!(r.rows.iter().all(|x| x.chars().count() == r.rows[0].chars().count()));
            for (row, s) in r.rows.iter().zip(&input) {
                assert_eq!(row.replace('-', ""), s.residues);
            }
            assert_eq!(r.ids, vec!["a", "b", "c", "d"]);
        }
    }

    #[test]
    fn one_and_two_sequences_have_trivial_guide_trees() {
        let one = run(&[seq("only", "ACGT")], GuideMethod::Nj);
        assert_eq!(
            (one.rows, one.steps.len(), one.sum_of_pairs),
            (vec!["ACGT".to_string()], 0, 0)
        );
        assert!(one.guide_tree.root.is_leaf());
        let two = run(&[seq("x", "ACGT"), seq("y", "AGT")], GuideMethod::Upgma);
        assert_eq!(two.steps.len(), 1);
        assert_eq!(two.guide_tree.root.children.len(), 2);
        assert_eq!(two.guide_tree.root.length, None);
    }

    #[test]
    fn input_errors_are_typed_with_the_typescript_messages() {
        let sc = dna();
        let go = |seqs: &[Sequence]| progressive_align(seqs, &sc, GuideMethod::Upgma, &mut |_| {}, &mut || false);
        assert_eq!(go(&[]).expect_err("none").code, BioErrorCode::TooFewSequences);
        let dup = go(&[seq("a", "ACGT"), seq("a", "ACGT")]).expect_err("dup");
        assert_eq!(
            (dup.code, dup.message.as_str()),
            (
                BioErrorCode::DuplicateNames,
                "Sequence names must be unique so the guide tree can name them."
            )
        );
        let empty = go(&[seq("a", ""), seq("b", "AC")]).expect_err("empty");
        assert_eq!(empty.message, "Sequence \"a\" is empty.");
        let bad = go(&[seq("a", "ACXT"), seq("b", "ACGT")]).expect_err("bad letter");
        assert_eq!(bad.code, BioErrorCode::InvalidResidue);
        let many: Vec<Sequence> = (0..51).map(|k| seq(&format!("s{k}"), "ACGT")).collect();
        assert_eq!(
            go(&many).expect_err("too many").message,
            "At most 50 sequences can be aligned at once (got 51)."
        );
    }

    #[test]
    fn cancel_before_the_first_merge_returns_none() {
        let sc = dna();
        let input = [seq("a", "ACGT"), seq("b", "ACGA"), seq("c", "ACGG")];
        let r = progressive_align(&input, &sc, GuideMethod::Upgma, &mut |_| {}, &mut || true).expect("valid");
        assert!(r.is_none());
    }

    #[test]
    fn a_long_merge_stops_when_cancelled_partway() {
        let sc = dna();
        let (a, b) = ("ACGT".repeat(50), "ACGA".repeat(50));
        let mut polls = 0;
        let r = merge_profiles_cancellable(std::slice::from_ref(&a), std::slice::from_ref(&b), &sc, &mut || {
            polls += 1;
            polls >= 2
        })
        .expect("valid");
        assert!(r.is_none(), "cancelled after the second poll (every 32 rows)");
        assert!(polls >= 2);
        let done = merge_profiles_cancellable(&[a], &[b], &sc, &mut || false).expect("valid");
        assert!(done.is_some());
    }

    #[test]
    fn progress_rises_to_one() {
        let sc = dna();
        let input = [
            seq("a", "ACGTAC"),
            seq("b", "ACGAAC"),
            seq("c", "ACGGAC"),
            seq("d", "TCGGAC"),
        ];
        let mut seen: Vec<f64> = Vec::new();
        progressive_align(&input, &sc, GuideMethod::Nj, &mut |f| seen.push(f), &mut || false)
            .expect("valid")
            .expect("done");
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(seen.last().copied(), Some(1.0));
    }

    #[test]
    fn merging_two_profiles_scores_the_hand_computed_value() {
        // A = {ACGT}, B = {AGT}: best is A-C... check the score against the independent pairwise scorer.
        let sc = dna();
        let m = merge_profiles(&["ACGT".to_string()], &["AGT".to_string()], &sc).expect("merge");
        assert_eq!(m.rows, vec!["ACGT".to_string(), "A-GT".to_string()]);
        assert_eq!(
            m.score,
            f64::from(score_aligned_rows("ACGT", "A-GT", &sc).expect("rows"))
        );
    }

    #[test]
    fn oversized_profile_merge_reports_the_limit_with_thousands_separators() {
        let sc = dna();
        let (wide, narrow) = ("A".repeat(5001), "A".repeat(5000));
        let e = merge_profiles(&[wide], &[narrow], &sc).expect_err("too large");
        assert_eq!(e.code, BioErrorCode::TooLarge);
        assert_eq!(
            e.message,
            "Merging two profiles of 5001 and 5000 columns needs 25,015,002 matrix cells; the limit is 25,010,001."
        );
    }

    #[test]
    fn brute_force_finds_the_optimum_and_progressive_never_beats_it() {
        let sc = dna();
        let seqs: Vec<String> = ["ACGT", "AGT", "ACT"].iter().map(|s| s.to_string()).collect();
        let (best, rows) = brute_force_optimum_sp(&seqs, &sc).expect("small");
        assert_eq!(best, sum_of_pairs_score(&rows, &sc).expect("score"));
        let input: Vec<Sequence> = seqs.iter().enumerate().map(|(k, s)| seq(&format!("s{k}"), s)).collect();
        assert!(run(&input, GuideMethod::Upgma).sum_of_pairs <= best);
        assert_eq!(
            brute_force_optimum_sp(&vec!["A".to_string(); 5], &sc)
                .expect_err("limit")
                .code,
            BioErrorCode::TooLarge
        );
    }
}
