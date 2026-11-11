//! UPGMA (ALGORITHMS.md section 7): repeatedly merge the closest two clusters; new height = d/2; the distance from the
//! merged cluster to another cluster k is the size-weighted average of the old distances (Eq. 7.1). Output is ultrametric.
//! Ties: the first minimal pair in scan order (clusters in creation order: leaves in input order, merged clusters appended).
//! Port of `src/bio/upgma.ts`.

use crate::distance::{DistanceMatrix, assert_tree_ready, to_rows};
use crate::error::{BioError, BioErrorCode};
use crate::tree::{Tree, TreeNode};
use std::collections::HashMap;

/// One recorded merge.
#[derive(Debug, Clone, PartialEq)]
pub struct UpgmaStep {
    pub step: usize,
    /// Cluster ids in scan order before this merge (leaves are 0..n-1, merged clusters n, n+1, ...).
    pub active: Vec<usize>,
    /// Distances among the active clusters (same order).
    pub matrix: Vec<Vec<f64>>,
    /// Chosen pair as indices into `active`, and as cluster ids.
    pub i: usize,
    pub j: usize,
    pub a: usize,
    pub b: usize,
    pub distance: f64,
    pub new_id: usize,
    /// New node height = distance / 2, and the old heights of the two clusters.
    pub height: f64,
    pub height_a: f64,
    pub height_b: f64,
    /// Branch lengths from the new node to its two children (= height - child height).
    pub branch_a: f64,
    pub branch_b: f64,
    pub size_a: usize,
    pub size_b: usize,
    /// Distance from the new cluster to each remaining cluster (ids in `others`).
    pub others: Vec<usize>,
    pub new_row: Vec<f64>,
}

/// The tree, every merge, and the leaf names.
#[derive(Debug, Clone, PartialEq)]
pub struct UpgmaResult {
    pub tree: Tree,
    pub steps: Vec<UpgmaStep>,
    pub names: Vec<String>,
}

/// Builds the UPGMA tree and records every merge. Needs at least 3 sequences and a tree-ready matrix.
pub fn upgma(m: &DistanceMatrix) -> Result<UpgmaResult, BioError> {
    assert_tree_ready(m)?;
    let d0 = to_rows(m)?;
    let n = m.n;
    let total = 2 * n - 1;
    let mut dist = vec![vec![0.0f64; total]; total];
    for i in 0..n {
        for j in 0..n {
            dist[i][j] = d0[i][j];
        }
    }
    let mut nodes: Vec<Option<TreeNode>> = (0..total)
        .map(|k| m.names.get(k).map(|name| TreeNode::leaf(name)))
        .collect();
    let mut height = vec![0.0f64; total];
    let mut size = vec![1.0f64; total];
    let mut active: Vec<usize> = (0..n).collect();
    let mut steps: Vec<UpgmaStep> = Vec::new();
    let mut next = n;
    while active.len() > 1 {
        let (mut bi, mut bj, mut best) = (0usize, 1usize, f64::INFINITY);
        for p in 0..active.len() {
            for q in (p + 1)..active.len() {
                let d = dist[active[p]][active[q]];
                if d < best {
                    best = d;
                    bi = p;
                    bj = q;
                }
            }
        }
        let (a, b) = (active[bi], active[bj]);
        let new_id = next;
        next += 1;
        let h = best / 2.0;
        let branch_a = h - height[a];
        let branch_b = h - height[b];
        let mut node_a = nodes[a].take().unwrap_or_default();
        let mut node_b = nodes[b].take().unwrap_or_default();
        node_a.length = Some(branch_a);
        node_b.length = Some(branch_b);
        nodes[new_id] = Some(TreeNode::with_children(vec![node_a, node_b]));
        height[new_id] = h;
        size[new_id] = size[a] + size[b];
        let others: Vec<usize> = active
            .iter()
            .enumerate()
            .filter(|(k, _)| *k != bi && *k != bj)
            .map(|(_, &x)| x)
            .collect();
        let mut new_row = Vec::with_capacity(others.len());
        for &k in &others {
            let v = (size[a] * dist[a][k] + size[b] * dist[b][k]) / size[new_id]; // Eq. 7.1
            dist[new_id][k] = v;
            dist[k][new_id] = v;
            new_row.push(v);
        }
        steps.push(UpgmaStep {
            step: steps.len() + 1,
            active: active.clone(),
            matrix: active
                .iter()
                .map(|&x| active.iter().map(|&y| dist[x][y]).collect())
                .collect(),
            i: bi,
            j: bj,
            a,
            b,
            distance: best,
            new_id,
            height: h,
            height_a: height[a],
            height_b: height[b],
            branch_a,
            branch_b,
            size_a: size[a] as usize,
            size_b: size[b] as usize,
            others: others.clone(),
            new_row,
        });
        let mut next_active = others;
        next_active.push(new_id);
        active = next_active;
    }
    let root = nodes[next - 1].take().unwrap_or_default();
    Ok(UpgmaResult {
        tree: Tree { root },
        steps,
        names: m.names.clone(),
    })
}

/// Rebuilds the tree from the recorded steps alone (used to prove the trace is complete).
pub fn replay_upgma(steps: &[UpgmaStep], names: &[String]) -> Result<Tree, BioError> {
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
        let mut a = nodes.remove(&s.a).unwrap_or_default();
        let mut b = nodes.remove(&s.b).unwrap_or_default();
        a.length = Some(s.branch_a);
        b.length = Some(s.branch_b);
        last = TreeNode::with_children(vec![a, b]);
        nodes.insert(s.new_id, last.clone());
    }
    Ok(Tree { root: last })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::distance::{DistanceModel, matrix_from_rows};
    use crate::tree::{preorder, total_length};

    fn matrix(names: &[&str], rows: &[&[f64]]) -> DistanceMatrix {
        matrix_from_rows(
            &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &rows.iter().map(|r| r.to_vec()).collect::<Vec<_>>(),
            DistanceModel::P,
        )
    }

    #[test]
    fn wikipedia_worked_example_merge_distances_and_heights() {
        let m = matrix(
            &["a", "b", "c", "d", "e"],
            &[
                &[0.0, 17.0, 21.0, 31.0, 23.0],
                &[17.0, 0.0, 30.0, 34.0, 21.0],
                &[21.0, 30.0, 0.0, 28.0, 39.0],
                &[31.0, 34.0, 28.0, 0.0, 43.0],
                &[23.0, 21.0, 39.0, 43.0, 0.0],
            ],
        );
        let r = upgma(&m).expect("tree-ready");
        assert_eq!(
            r.steps.iter().map(|s| s.distance).collect::<Vec<_>>(),
            vec![17.0, 22.0, 28.0, 33.0]
        );
        assert_eq!(
            r.steps.iter().map(|s| s.height).collect::<Vec<_>>(),
            vec![8.5, 11.0, 14.0, 16.5]
        );
        assert_eq!((r.steps[0].branch_a, r.steps[0].branch_b), (8.5, 8.5));
        assert_eq!(
            r.steps[1].new_row,
            vec![30.0, 36.0],
            "d(((a,b),e), c) and d(((a,b),e), d) as in the article"
        );
        assert!((total_length(&r.tree) - (8.5 + 8.5 + 2.5 + 11.0 + 5.5 + 14.0 + 14.0 + 2.5)).abs() < 1e-12);
        assert_eq!(r.tree.root.children.len(), 2);
    }

    #[test]
    fn replaying_the_steps_rebuilds_the_tree_and_there_are_n_minus_one_steps() {
        let m = matrix(
            &["a", "b", "c", "d"],
            &[
                &[0.0, 2.0, 4.0, 6.0],
                &[2.0, 0.0, 4.0, 6.0],
                &[4.0, 4.0, 0.0, 6.0],
                &[6.0, 6.0, 6.0, 0.0],
            ],
        );
        let r = upgma(&m).expect("tree-ready");
        assert_eq!(r.steps.len(), 3);
        assert_eq!(replay_upgma(&r.steps, &r.names).expect("has steps"), r.tree);
        assert!(replay_upgma(&[], &r.names).is_err());
    }

    #[test]
    fn identical_sequences_give_a_deterministic_tree_of_zero_length_branches() {
        let zeros: Vec<Vec<f64>> = vec![vec![0.0; 4]; 4];
        let names: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let m = matrix_from_rows(&names, &zeros, DistanceModel::P);
        let (u1, u2) = (upgma(&m).expect("ready"), upgma(&m).expect("ready"));
        assert_eq!(u1, u2);
        assert_eq!(total_length(&u1.tree), 0.0);
        assert!(preorder(&u1.tree).iter().all(|n| n.length.is_none_or(f64::is_finite)));
    }

    #[test]
    fn fewer_than_three_sequences_is_a_typed_error() {
        for n in 0..3usize {
            let names: Vec<String> = (0..n).map(|k| format!("s{k}")).collect();
            let m = matrix_from_rows(&names, &vec![vec![1.0; n]; n], DistanceModel::P);
            assert_eq!(upgma(&m).expect_err("too few").code, BioErrorCode::TooFewSequences);
        }
    }
}
