//! Robinson-Foulds distance between two trees on the same leaves, viewed as UNROOTED (ALGORITHMS.md section 9).
//! Port of `src/bio/treecompare.ts`.

use crate::error::{BioError, BioErrorCode};
use crate::tree::{Tree, nontrivial_splits};

/// The distance and which splits are shared / unique.
#[derive(Debug, Clone, PartialEq)]
pub struct RfResult {
    /// |S1 Δ S2|: number of non-trivial splits present in exactly one tree.
    pub distance: usize,
    /// Largest possible RF for these trees: |S1| + |S2|.
    pub max: usize,
    pub shared: Vec<Vec<String>>,
    pub only_in_a: Vec<Vec<String>>,
    pub only_in_b: Vec<Vec<String>>,
    pub leaf_count: usize,
}

/// Compares two trees; returns an error if their leaf sets differ.
pub fn robinson_foulds(a: &Tree, b: &Tree) -> Result<RfResult, BioError> {
    let sa = nontrivial_splits(a)?;
    let sb = nontrivial_splits(b)?;
    if sa.leaves != sb.leaves {
        let only_a: Vec<&String> = sa.leaves.iter().filter(|l| !sb.leaves.contains(l)).collect();
        let only_b: Vec<&String> = sb.leaves.iter().filter(|l| !sa.leaves.contains(l)).collect();
        let show = |v: &[&String]| {
            let text = v.iter().take(5).map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            if text.is_empty() { "—".to_string() } else { text }
        };
        return Err(BioError::new(
            BioErrorCode::InvalidTree,
            format!(
                "The trees do not have the same leaves. Only in the first: {}; only in the second: {}.",
                show(&only_a),
                show(&only_b)
            ),
        ));
    }
    let (mut shared, mut only_in_a, mut only_in_b) = (Vec::new(), Vec::new(), Vec::new());
    for (k, v) in sa.splits.iter() {
        if sb.splits.contains_key(k) {
            shared.push(v.clone())
        } else {
            only_in_a.push(v.clone())
        }
    }
    for (k, v) in sb.splits.iter() {
        if !sa.splits.contains_key(k) {
            only_in_b.push(v.clone());
        }
    }
    Ok(RfResult {
        distance: only_in_a.len() + only_in_b.len(),
        max: sa.splits.len() + sb.splits.len(),
        shared,
        only_in_a,
        only_in_b,
        leaf_count: sa.leaves.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::newick::parse_newick;

    fn nw(s: &str) -> Tree {
        parse_newick(s).expect("valid newick").tree // test code
    }

    // Ported from tests/unit/trees-core.test.ts ("Robinson-Foulds").
    #[test]
    fn zero_for_identical_trees_and_for_different_rooting_or_child_order() {
        let t = nw("((A,B),(C,D),(E,F));");
        assert_eq!(robinson_foulds(&t, &t).expect("same leaves").distance, 0);
        assert_eq!(
            robinson_foulds(&t, &crate::tree::reroot_at_leaf(&t, "E").expect("leaf"))
                .expect("same leaves")
                .distance,
            0
        );
        assert_eq!(
            robinson_foulds(&t, &nw("((F,E),(D,C),(B,A));"))
                .expect("same leaves")
                .distance,
            0
        );
    }

    #[test]
    fn correct_on_hand_built_pairs_and_symmetric() {
        let a = nw("((A,B),(C,D),(E,F));");
        let b = nw("((A,B),(C,E),(D,F));");
        let r = robinson_foulds(&a, &b).expect("same leaves");
        assert_eq!(
            (r.distance, r.shared.len(), r.only_in_a.len(), r.only_in_b.len()),
            (4, 1, 2, 2)
        );
        assert_eq!(robinson_foulds(&b, &a).expect("same leaves").distance, 4);
        let star = nw("(A,B,C,D,E,F);");
        let rs = robinson_foulds(&a, &star).expect("same leaves");
        assert_eq!((rs.distance, rs.max), (3, 3));
    }

    #[test]
    fn different_leaf_sets_are_a_typed_error_naming_the_leaves() {
        let e = robinson_foulds(&nw("(A,B,C,D);"), &nw("(A,B,C,E);")).expect_err("different leaves");
        assert!(e.message.contains("Only in the first: D"));
        assert!(e.message.contains("only in the second: E"));
        assert_eq!(e.code, BioErrorCode::InvalidTree);
    }
}
