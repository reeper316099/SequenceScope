//! Neighbor-joining, Saitou & Nei (ALGORITHMS.md section 8). With n active nodes and r_i = sum_k d(i,k):
//!   Q(i,j) = (n-2) d(i,j) - r_i - r_j                         (Eq. 8.1)  join the pair with the smallest Q
//!   branch(i->u) = d(i,j)/2 + (r_i - r_j) / (2(n-2))          (Eq. 8.2)  branch(j->u) = d(i,j) - branch(i->u)
//!   d(u,k) = (d(i,k) + d(j,k) - d(i,j)) / 2                   (Eq. 8.3)
//! When 3 nodes remain they are joined in a star with x_i = (d(i,j) + d(i,k) - d(j,k)) / 2 (Eq. 8.4).
//! Ties: the first minimal Q in scan order. Negative branch lengths can occur and are NEVER clamped.
//! Port of `src/bio/nj.ts`.

use crate::distance::{DistanceMatrix, assert_tree_ready, to_rows};
use crate::error::{BioError, BioErrorCode};
use crate::tree::{Tree, TreeNode};
use std::collections::HashMap;

/// One join of two nodes.
#[derive(Debug, Clone, PartialEq)]
pub struct NjJoinStep {
    pub step: usize,
    pub active: Vec<usize>,
    pub matrix: Vec<Vec<f64>>,
    /// r_i for each active node.
    pub sums: Vec<f64>,
    /// Q matrix (diagonal entries are 0 and not candidates).
    pub q: Vec<Vec<f64>>,
    pub i: usize,
    pub j: usize,
    pub a: usize,
    pub b: usize,
    pub distance: f64,
    pub q_min: f64,
    pub new_id: usize,
    pub branch_a: f64,
    pub branch_b: f64,
    pub others: Vec<usize>,
    pub new_row: Vec<f64>,
}

/// The last step: three nodes joined in a star.
#[derive(Debug, Clone, PartialEq)]
pub struct NjFinalStep {
    pub step: usize,
    pub active: Vec<usize>,
    pub matrix: Vec<Vec<f64>>,
    pub ids: [usize; 3],
    pub branches: [f64; 3],
    pub new_id: usize,
}

/// A recorded step.
#[derive(Debug, Clone, PartialEq)]
pub enum NjStep {
    Join(NjJoinStep),
    Final(NjFinalStep),
}

/// The tree, every step, and the leaf names.
#[derive(Debug, Clone, PartialEq)]
pub struct NjResult {
    pub tree: Tree,
    pub steps: Vec<NjStep>,
    pub names: Vec<String>,
}

/// Builds the NJ tree (unrooted: the root has 3 children) and records every step.
pub fn neighbor_joining(m: &DistanceMatrix) -> Result<NjResult, BioError> {
    assert_tree_ready(m)?;
    let d0 = to_rows(m)?;
    let n0 = m.n;
    let total = 2 * n0 - 1;
    let mut dist = vec![vec![0.0f64; total]; total];
    for i in 0..n0 {
        for j in 0..n0 {
            dist[i][j] = d0[i][j];
        }
    }
    let mut nodes: Vec<Option<TreeNode>> = (0..total)
        .map(|k| m.names.get(k).map(|name| TreeNode::leaf(name)))
        .collect();
    let mut active: Vec<usize> = (0..n0).collect();
    let mut steps: Vec<NjStep> = Vec::new();
    let mut next = n0;
    while active.len() > 3 {
        let n = active.len();
        let sums: Vec<f64> = active
            .iter()
            .map(|&x| active.iter().fold(0.0, |s, &y| s + dist[x][y]))
            .collect();
        let q: Vec<Vec<f64>> = active
            .iter()
            .enumerate()
            .map(|(p, &x)| {
                active
                    .iter()
                    .enumerate()
                    .map(|(r, &y)| {
                        if p == r {
                            0.0
                        } else {
                            (n as f64 - 2.0) * dist[x][y] - sums[p] - sums[r]
                        }
                    })
                    .collect()
            })
            .collect(); // Eq. 8.1
        let (mut bi, mut bj, mut best) = (0usize, 1usize, f64::INFINITY);
        for (p, qrow) in q.iter().enumerate() {
            for (r, &v) in qrow.iter().enumerate().skip(p + 1) {
                if v < best {
                    best = v;
                    bi = p;
                    bj = r;
                }
            }
        }
        let (a, b) = (active[bi], active[bj]);
        let dab = dist[a][b];
        let branch_a = dab / 2.0 + (sums[bi] - sums[bj]) / (2.0 * (n as f64 - 2.0)); // Eq. 8.2
        let branch_b = dab - branch_a;
        let mut node_a = nodes[a].take().unwrap_or_default();
        let mut node_b = nodes[b].take().unwrap_or_default();
        node_a.length = Some(branch_a);
        node_b.length = Some(branch_b);
        let new_id = next;
        next += 1;
        nodes[new_id] = Some(TreeNode::with_children(vec![node_a, node_b]));
        let others: Vec<usize> = active
            .iter()
            .enumerate()
            .filter(|(k, _)| *k != bi && *k != bj)
            .map(|(_, &x)| x)
            .collect();
        let mut new_row = Vec::with_capacity(others.len());
        for &k in &others {
            let v = (dist[a][k] + dist[b][k] - dab) / 2.0; // Eq. 8.3
            dist[new_id][k] = v;
            dist[k][new_id] = v;
            new_row.push(v);
        }
        steps.push(NjStep::Join(NjJoinStep {
            step: steps.len() + 1,
            active: active.clone(),
            matrix: active
                .iter()
                .map(|&x| active.iter().map(|&y| dist[x][y]).collect())
                .collect(),
            sums,
            q,
            i: bi,
            j: bj,
            a,
            b,
            distance: dab,
            q_min: best,
            new_id,
            branch_a,
            branch_b,
            others: others.clone(),
            new_row,
        }));
        let mut next_active = others;
        next_active.push(new_id);
        active = next_active;
    }
    let (x, y, z) = (active[0], active[1], active[2]);
    let bx = (dist[x][y] + dist[x][z] - dist[y][z]) / 2.0; // Eq. 8.4
    let by = (dist[x][y] + dist[y][z] - dist[x][z]) / 2.0;
    let bz = (dist[x][z] + dist[y][z] - dist[x][y]) / 2.0;
    let mut nx = nodes[x].take().unwrap_or_default();
    let mut ny = nodes[y].take().unwrap_or_default();
    let mut nz = nodes[z].take().unwrap_or_default();
    nx.length = Some(bx);
    ny.length = Some(by);
    nz.length = Some(bz);
    let new_id = next; // the root of the unrooted tree
    let root = TreeNode::with_children(vec![nx, ny, nz]);
    steps.push(NjStep::Final(NjFinalStep {
        step: steps.len() + 1,
        active: active.clone(),
        matrix: active
            .iter()
            .map(|&p| active.iter().map(|&r| dist[p][r]).collect())
            .collect(),
        ids: [x, y, z],
        branches: [bx, by, bz],
        new_id,
    }));
    Ok(NjResult {
        tree: Tree { root },
        steps,
        names: m.names.clone(),
    })
}

/// Rebuilds the tree from the recorded steps alone.
pub fn replay_nj(steps: &[NjStep], names: &[String]) -> Result<Tree, BioError> {
    if steps.is_empty() {
        return Err(BioError::new(BioErrorCode::InvalidArgument, "No steps to replay."));
    }
    let mut nodes: HashMap<usize, TreeNode> = names
        .iter()
        .enumerate()
        .map(|(k, name)| (k, TreeNode::leaf(name)))
        .collect();
    let mut last = TreeNode::default();
    for s in steps {
        match s {
            NjStep::Join(j) => {
                let mut a = nodes.remove(&j.a).unwrap_or_default();
                let mut b = nodes.remove(&j.b).unwrap_or_default();
                a.length = Some(j.branch_a);
                b.length = Some(j.branch_b);
                last = TreeNode::with_children(vec![a, b]);
                nodes.insert(j.new_id, last.clone());
            }
            NjStep::Final(f) => {
                let kids: Vec<TreeNode> = f
                    .ids
                    .iter()
                    .enumerate()
                    .map(|(k, id)| {
                        let mut nd = nodes.remove(id).unwrap_or_default();
                        nd.length = Some(f.branches[k]);
                        nd
                    })
                    .collect();
                last = TreeNode::with_children(kids);
                nodes.insert(f.new_id, last.clone());
            }
        }
    }
    Ok(Tree { root: last })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::distance::{DistanceModel, matrix_from_rows};
    use crate::tree::{nontrivial_splits, total_length};

    fn matrix(names: &[&str], rows: &[&[f64]]) -> DistanceMatrix {
        matrix_from_rows(
            &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &rows.iter().map(|r| r.to_vec()).collect::<Vec<_>>(),
            DistanceModel::P,
        )
    }

    #[test]
    fn wikipedia_worked_example_q_values_branches_and_final_step() {
        let m = matrix(
            &["a", "b", "c", "d", "e"],
            &[
                &[0.0, 5.0, 9.0, 9.0, 8.0],
                &[5.0, 0.0, 10.0, 10.0, 9.0],
                &[9.0, 10.0, 0.0, 8.0, 7.0],
                &[9.0, 10.0, 8.0, 0.0, 3.0],
                &[8.0, 9.0, 7.0, 3.0, 0.0],
            ],
        );
        let r = neighbor_joining(&m).expect("tree-ready");
        let NjStep::Join(s1) = &r.steps[0] else {
            panic!("expected a join")
        }; // test code
        assert_eq!((s1.q_min, s1.a, s1.b), (-50.0, 0, 1));
        assert_eq!((s1.branch_a, s1.branch_b), (2.0, 3.0));
        assert_eq!(s1.new_row, vec![7.0, 7.0, 6.0]);
        let NjStep::Join(s2) = &r.steps[1] else {
            panic!("expected a join")
        }; // test code
        assert_eq!((s2.branch_a, s2.branch_b), (4.0, 3.0));
        let NjStep::Final(f) = &r.steps[2] else {
            panic!("expected the final step")
        }; // test code
        let mut b = f.branches;
        b.sort_by(f64::total_cmp);
        assert_eq!(b, [1.0, 2.0, 2.0]);
        assert_eq!(nontrivial_splits(&r.tree).expect("valid").splits.len(), 2);
        assert!((total_length(&r.tree) - (2.0 + 3.0 + 3.0 + 4.0 + 2.0 + 2.0 + 1.0)).abs() < 1e-12);
    }

    #[test]
    fn three_taxa_give_the_exact_star() {
        let m = matrix(
            &["a", "b", "c"],
            &[&[0.0, 4.0, 6.0], &[4.0, 0.0, 8.0], &[6.0, 8.0, 0.0]],
        );
        let r = neighbor_joining(&m).expect("tree-ready");
        assert_eq!(
            r.tree.root.children.iter().map(|c| c.length).collect::<Vec<_>>(),
            vec![Some(1.0), Some(3.0), Some(5.0)]
        );
        assert_eq!(nontrivial_splits(&r.tree).expect("valid").splits.len(), 0);
        assert_eq!(r.steps.len(), 1);
    }

    #[test]
    fn replay_rebuilds_the_tree_and_has_n_minus_two_steps() {
        let m = matrix(
            &["a", "b", "c", "d", "e", "f"],
            &[
                &[0.0, 3.0, 5.0, 7.0, 8.0, 9.0],
                &[3.0, 0.0, 4.5, 6.5, 8.0, 8.0],
                &[5.0, 4.5, 0.0, 3.0, 6.0, 7.5],
                &[7.0, 6.5, 3.0, 0.0, 4.0, 6.0],
                &[8.0, 8.0, 6.0, 4.0, 0.0, 2.5],
                &[9.0, 8.0, 7.5, 6.0, 2.5, 0.0],
            ],
        );
        let r = neighbor_joining(&m).expect("tree-ready");
        assert_eq!(r.steps.len(), 4);
        assert_eq!(replay_nj(&r.steps, &r.names).expect("has steps"), r.tree);
    }

    #[test]
    fn negative_branches_are_kept_never_clamped() {
        // d(a,b) = d(a,c) = 1 but d(b,c) = 5 breaks the triangle inequality: x_a = (1 + 1 - 5) / 2 = -1.5.
        let m = matrix(
            &["a", "b", "c"],
            &[&[0.0, 1.0, 1.0], &[1.0, 0.0, 5.0], &[1.0, 5.0, 0.0]],
        );
        let r = neighbor_joining(&m).expect("tree-ready");
        assert_eq!(r.tree.root.children[0].length, Some(-1.5));
        assert!(crate::tree::has_negative_branches(&r.tree));
    }

    #[test]
    fn fewer_than_three_sequences_is_a_typed_error() {
        let m = matrix(&["a", "b"], &[&[0.0, 1.0], &[1.0, 0.0]]);
        assert_eq!(
            neighbor_joining(&m).expect_err("too few").code,
            BioErrorCode::TooFewSequences
        );
    }
}
