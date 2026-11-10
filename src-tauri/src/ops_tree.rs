//! Tree and distance operations behind `bio_op`: build UPGMA and neighbor-joining trees (with every recorded step), read and
//! write Newick, edit trees (rotate, re-root, midpoint root), compare two trees, leaf distances, the distance-correction
//! curve, and the distance-matrix exports. Trees arrive from the page as a FLAT list (pre-order, each node naming its parent)
//! because JSON nesting deeper than 128 levels is refused by the JSON reader, and a 100-taxon ladder tree is about 200 deep.
//! Trees leave Rust nested, exactly like the TypeScript objects.

use crate::dto::{TreeDto, parse_model, parse_policy};
use crate::jobs::JobError;
use sequencescope_core::distance::{
    DistanceMatrix, DistanceModel, correct_distance, matrix_from_rows, to_distance_csv, to_phylip,
};
use sequencescope_core::newick::{WriteOptions, parse_newick, write_newick};
use sequencescope_core::nj::{NjStep, neighbor_joining};
use sequencescope_core::tree::{
    Tree, TreeNode, assert_valid_leaves, leaf_distances, midpoint_root, reroot_above, reroot_at_leaf, rotate_node,
};
use sequencescope_core::treecompare::{robinson_foulds, unique_branches};
use sequencescope_core::upgma::upgma;
use serde::Deserialize;
use serde_json::{Value, json};

/// The most nodes a tree from the page may have, and the deepest nesting (the Newick reader allows the same depth).
const MAX_TREE_NODES: usize = 20_000;
const MAX_TREE_DEPTH: usize = 3000;

/// One node of a flat tree: `parent` is the index of the parent node (-1 for the root); a parent always comes first.
#[derive(Debug, Deserialize)]
pub struct FlatNodeDto {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub length: Option<f64>,
    #[serde(default)]
    pub support: Option<f64>,
    pub parent: i64,
}

/// A tree as the page sends it.
#[derive(Debug, Deserialize)]
pub struct TreeIn {
    pub nodes: Vec<FlatNodeDto>,
}

impl TreeIn {
    /// Rebuilds the nested tree. Refuses anything that is not a proper tree (bad parents, too many or too deep nodes).
    pub fn to_core(&self) -> Result<Tree, JobError> {
        let bad = |why: &str| JobError::new("invalid-tree", format!("The tree is not valid: {why}."));
        let n = self.nodes.len();
        if n == 0 || n > MAX_TREE_NODES {
            return Err(bad(&format!("it must have 1 to {MAX_TREE_NODES} nodes")));
        }
        let mut kids: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut depth = vec![0usize; n];
        for (k, node) in self.nodes.iter().enumerate() {
            if k == 0 {
                if node.parent != -1 {
                    return Err(bad("the first node must be the root"));
                }
                continue;
            }
            let p = usize::try_from(node.parent)
                .ok()
                .filter(|p| *p < k)
                .ok_or_else(|| bad("a node names a parent that does not come before it"))?;
            kids[p].push(k);
            depth[k] = depth[p] + 1;
            if depth[k] > MAX_TREE_DEPTH {
                return Err(bad(&format!("it is nested deeper than {MAX_TREE_DEPTH} levels")));
            }
        }
        let mut built: Vec<Option<TreeNode>> = (0..n).map(|_| None).collect();
        for k in (0..n).rev() {
            let mut children = Vec::with_capacity(kids[k].len());
            for &c in &kids[k] {
                children.push(built[c].take().ok_or_else(|| bad("internal ordering error"))?);
            }
            let src = &self.nodes[k];
            built[k] = Some(TreeNode {
                name: src.name.clone(),
                label: src.label.clone(),
                length: src.length,
                support: src.support,
                children,
            });
        }
        let root = built[0].take().ok_or_else(|| bad("there is no root"))?;
        Ok(Tree { root })
    }
}

/// A distance matrix as the page holds it (typed arrays sent as plain number lists).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixIn {
    pub names: Vec<String>,
    pub n: usize,
    pub values: Vec<f64>,
    pub status: Vec<u8>,
    pub compared: Vec<u32>,
    pub model: String,
    pub gap_policy: String,
}

impl MatrixIn {
    /// Converts to the core matrix, checking the shapes.
    pub fn to_core(&self) -> Result<DistanceMatrix, JobError> {
        let cells = self.n.checked_mul(self.n).filter(|c| *c <= 10_000);
        let cells = cells
            .ok_or_else(|| JobError::new("invalid-argument", "A distance matrix may have at most 100 sequences."))?;
        if self.names.len() != self.n
            || self.values.len() != cells
            || self.status.len() != cells
            || self.compared.len() != cells
        {
            return Err(JobError::new(
                "invalid-argument",
                "The distance matrix arrays do not match its size.",
            ));
        }
        if self.status.iter().any(|s| *s > 2) {
            return Err(JobError::new(
                "invalid-argument",
                "A distance status must be 0, 1 or 2.",
            ));
        }
        Ok(DistanceMatrix {
            names: self.names.clone(),
            n: self.n,
            values: self.values.clone(),
            status: self.status.clone(),
            compared: self.compared.clone(),
            model: parse_model(&self.model)?,
            gap_policy: parse_policy(&self.gap_policy)?,
        })
    }
}

/// One edit of a tree.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditIn {
    Rotate { index: f64 },
    RerootAbove { index: f64, fraction: f64 },
    RerootAtLeaf { leaf: String },
    Midpoint,
}

/// A whole, non-negative node index.
fn node_index(v: f64) -> Result<usize, JobError> {
    if v.fract() != 0.0 || !(0.0..=1e9).contains(&v) {
        return Err(JobError::new(
            "invalid-argument",
            "A node index must be a whole number.",
        ));
    }
    Ok(v as usize)
}

/// A tree as nested JSON, like the TypeScript object.
fn tree_value(t: &Tree) -> Result<Value, JobError> {
    serde_json::to_value(TreeDto::from(t))
        .map_err(|e| JobError::new("internal", format!("Could not encode the tree: {e}")))
}

/// UPGMA and neighbor-joining results (tree, every step, names) as JSON, keyed like the TypeScript results.
fn builds(m: &DistanceMatrix) -> Result<Value, JobError> {
    let u = upgma(m)?;
    let u_steps: Vec<Value> = u
        .steps
        .iter()
        .map(|s| {
            json!({ "step": s.step, "active": s.active, "matrix": s.matrix, "i": s.i, "j": s.j, "a": s.a, "b": s.b, "distance": s.distance,
                "newId": s.new_id, "height": s.height, "heightA": s.height_a, "heightB": s.height_b, "branchA": s.branch_a,
                "branchB": s.branch_b, "sizeA": s.size_a, "sizeB": s.size_b, "others": s.others, "newRow": s.new_row })
        })
        .collect();
    let j = neighbor_joining(m)?;
    let j_steps: Vec<Value> = j
        .steps
        .iter()
        .map(|s| match s {
            NjStep::Join(x) => json!({ "kind": "join", "step": x.step, "active": x.active, "matrix": x.matrix, "sums": x.sums, "q": x.q,
                "i": x.i, "j": x.j, "a": x.a, "b": x.b, "distance": x.distance, "qMin": x.q_min, "newId": x.new_id,
                "branchA": x.branch_a, "branchB": x.branch_b, "others": x.others, "newRow": x.new_row }),
            NjStep::Final(x) => json!({ "kind": "final", "step": x.step, "active": x.active, "matrix": x.matrix, "ids": x.ids,
                "branches": x.branches, "newId": x.new_id }),
        })
        .collect();
    Ok(json!({
        "upgma": { "tree": tree_value(&u.tree)?, "steps": u_steps, "names": u.names },
        "nj": { "tree": tree_value(&j.tree)?, "steps": j_steps, "names": j.names },
    }))
}

/// Builds both trees from a distance matrix.
pub fn tree_build(m: &MatrixIn) -> Result<Value, JobError> {
    builds(&m.to_core()?)
}

/// Builds both trees from plain rows of numbers (the teaching examples).
pub fn tree_build_rows(names: &[String], rows: &[Vec<f64>]) -> Result<Value, JobError> {
    if names.len() > 100 || rows.len() > 100 || rows.iter().any(|r| r.len() > 100) {
        return Err(JobError::new(
            "invalid-argument",
            "At most 100 sequences are supported.",
        ));
    }
    builds(&matrix_from_rows(names, rows, DistanceModel::P))
}

/// Parses Newick; with `validate` the leaves must also be named and unique.
pub fn newick_parse(text: &str, validate: bool) -> Result<Value, JobError> {
    let parsed = parse_newick(text).map_err(|e| JobError::new("newick-syntax", e.message))?;
    if validate {
        assert_valid_leaves(&parsed.tree)?;
    }
    Ok(json!({ "tree": tree_value(&parsed.tree)?, "extraTrees": parsed.extra_trees }))
}

/// Writes several trees as Newick with the same options.
pub fn newick_write(trees: &[TreeIn], include_lengths: bool, include_support: bool) -> Result<Value, JobError> {
    let opts = WriteOptions {
        include_support,
        include_lengths,
    };
    let mut out = Vec::with_capacity(trees.len());
    for t in trees {
        out.push(write_newick(&t.to_core()?, opts));
    }
    Ok(json!(out))
}

/// Applies one edit to a tree and returns the new tree.
pub fn tree_edit(tree: &TreeIn, edit: &EditIn) -> Result<Value, JobError> {
    let t = tree.to_core()?;
    let next = match edit {
        EditIn::Rotate { index } => rotate_node(&t, node_index(*index)?),
        EditIn::RerootAbove { index, fraction } => reroot_above(&t, node_index(*index)?, *fraction)?,
        EditIn::RerootAtLeaf { leaf } => reroot_at_leaf(&t, leaf)?,
        EditIn::Midpoint => midpoint_root(&t)?,
    };
    tree_value(&next)
}

/// Robinson-Foulds distance plus the branches of each tree that the other lacks (for the red marks).
pub fn tree_compare(a: &TreeIn, b: &TreeIn) -> Result<Value, JobError> {
    let (ta, tb) = (a.to_core()?, b.to_core()?);
    let rf = robinson_foulds(&ta, &tb)?;
    Ok(json!({
        "rf": { "distance": rf.distance, "max": rf.max, "shared": rf.shared, "onlyInA": rf.only_in_a, "onlyInB": rf.only_in_b, "leafCount": rf.leaf_count },
        "uniqueA": unique_branches(&ta, &tb)?,
        "uniqueB": unique_branches(&tb, &ta)?,
    }))
}

/// Leaf names and the path distance between every pair of leaves.
pub fn leaf_dist(tree: &TreeIn) -> Result<Value, JobError> {
    let d = leaf_distances(&tree.to_core()?);
    Ok(json!({ "names": d.names, "dist": d.dist }))
}

/// The corrected distance for each observed proportion p (null where the correction is undefined).
pub fn correct_curve(model: &str, ps: &[f64]) -> Result<Value, JobError> {
    if ps.len() > 100_000 {
        return Err(JobError::new(
            "too-large",
            "At most 100,000 points can be corrected at once.",
        ));
    }
    let model = parse_model(model)?;
    Ok(json!(
        ps.iter().map(|p| correct_distance(*p, model)).collect::<Vec<_>>()
    ))
}

/// A distance matrix exported as CSV or PHYLIP text.
pub fn distance_export(m: &MatrixIn, format: &str) -> Result<Value, JobError> {
    let core = m.to_core()?;
    match format {
        "csv" => Ok(json!(to_distance_csv(&core))),
        "phylip" => Ok(json!(to_phylip(&core)?)),
        other => Err(JobError::new(
            "invalid-argument",
            format!("Unknown export format \"{other}\"."),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(spec: &[(i64, Option<&str>, Option<f64>)]) -> TreeIn {
        TreeIn {
            nodes: spec
                .iter()
                .map(|(parent, name, length)| FlatNodeDto {
                    name: name.map(str::to_string),
                    label: None,
                    length: *length,
                    support: None,
                    parent: *parent,
                })
                .collect(),
        }
    }

    #[test]
    fn a_flat_tree_rebuilds_with_children_in_order() {
        let t = flat(&[
            (-1, None, None),
            (0, None, Some(0.5)),
            (1, Some("A"), Some(1.0)),
            (1, Some("B"), Some(2.0)),
            (0, Some("C"), Some(3.0)),
        ])
        .to_core()
        .expect("valid");
        assert_eq!(t.root.children.len(), 2);
        assert_eq!(t.root.children[0].children[1].name.as_deref(), Some("B"));
        assert_eq!(t.root.children[1].length, Some(3.0));
    }

    #[test]
    fn improper_trees_are_refused() {
        assert!(flat(&[]).to_core().is_err());
        assert!(
            flat(&[(0, None, None)]).to_core().is_err(),
            "the root must have parent -1"
        );
        assert!(
            flat(&[(-1, None, None), (1, Some("A"), None)]).to_core().is_err(),
            "a parent must come first"
        );
        assert!(flat(&[(-1, None, None), (5, Some("A"), None)]).to_core().is_err());
        let mut deep = vec![(-1i64, None, None)];
        for k in 0..=MAX_TREE_DEPTH as i64 {
            deep.push((k, None, None));
        }
        assert!(flat(&deep).to_core().is_err(), "too deep");
    }

    #[test]
    fn a_ladder_of_100_taxa_survives_the_round_trip_through_nested_json() {
        let mut spec = vec![(-1i64, None, None)];
        let (mut parent, mut next) = (0i64, 1i64);
        for _ in 0..99 {
            spec.push((parent, Some("leaf"), Some(1.0)));
            spec.push((parent, None, Some(1.0)));
            parent = next + 1;
            next += 2;
        }
        let t = flat(&spec).to_core().expect("valid");
        let v = tree_value(&t).expect("json");
        assert_eq!(v["root"]["children"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn newick_errors_keep_the_position_text_and_a_syntax_code() {
        let e = newick_parse("((A,B);", false).expect_err("syntax");
        assert_eq!(e.code, "newick-syntax");
        assert!(e.message.contains("line 1"));
        let ok = newick_parse("(A:1,B:2,C:3);", true).expect("valid");
        assert_eq!(ok["extraTrees"], 0);
        assert_eq!(
            newick_parse("(A,A,C);", true).expect_err("duplicate leaves").code,
            "duplicate-names"
        );
    }

    #[test]
    fn build_edit_compare_and_write_agree_with_each_other() {
        let names: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let rows = vec![
            vec![0.0, 2.0, 4.0, 6.0],
            vec![2.0, 0.0, 4.0, 6.0],
            vec![4.0, 4.0, 0.0, 6.0],
            vec![6.0, 6.0, 6.0, 0.0],
        ];
        let b = tree_build_rows(&names, &rows).expect("builds");
        assert_eq!(b["upgma"]["steps"].as_array().map(Vec::len), Some(3));
        assert_eq!(
            b["nj"]["steps"]
                .as_array()
                .and_then(|s| s.last())
                .map(|s| s["kind"].clone()),
            Some(json!("final"))
        );
        // a tree and the same tree re-rooted at a leaf have distance 0
        let nw = newick_parse("((A:1,B:1):1,(C:1,D:1):1);", true).expect("valid");
        let flat_of = |v: &Value| -> TreeIn {
            let mut nodes = Vec::new();
            fn walk(n: &Value, parent: i64, out: &mut Vec<FlatNodeDto>) {
                let me = out.len() as i64;
                out.push(FlatNodeDto {
                    name: n["name"].as_str().map(str::to_string),
                    label: n["label"].as_str().map(str::to_string),
                    length: n["length"].as_f64(),
                    support: n["support"].as_f64(),
                    parent,
                });
                for c in n["children"].as_array().map_or(&[][..], |a| a.as_slice()) {
                    walk(c, me, out);
                }
            }
            walk(&v["root"], -1, &mut nodes);
            TreeIn { nodes }
        };
        let t = flat_of(&nw["tree"]);
        let moved = tree_edit(&t, &EditIn::RerootAtLeaf { leaf: "C".to_string() }).expect("reroots");
        let cmp = tree_compare(&t, &flat_of(&moved)).expect("compares");
        assert_eq!(cmp["rf"]["distance"], 0);
        assert_eq!(cmp["uniqueA"], json!([]));
        let text = newick_write(&[t], true, true).expect("writes");
        assert_eq!(text[0], "((A:1,B:1):1,(C:1,D:1):1);");
    }

    #[test]
    fn decimals_sent_by_the_page_are_read_exactly() {
        // Without serde_json's float_roundtrip feature these parse one unit in the last place off.
        for text in [
            "1.3333333333333335",
            "5.416666666666667",
            "0.1",
            "2.7083333333333335",
            "1e-7",
            "123456.78901234567",
        ] {
            let v: Value = serde_json::from_str(text).expect("valid number");
            assert_eq!(
                v.as_f64().map(f64::to_bits),
                text.parse::<f64>().ok().map(f64::to_bits),
                "{text}"
            );
        }
    }

    #[test]
    fn distance_matrices_are_checked_before_use() {
        let m = MatrixIn {
            names: vec!["a".into(), "b".into()],
            n: 2,
            values: vec![0.0; 3],
            status: vec![0; 4],
            compared: vec![1; 4],
            model: "p".into(),
            gap_policy: "pairwise-deletion".into(),
        };
        assert_eq!(m.to_core().expect_err("shape").code, "invalid-argument");
        let ok = MatrixIn {
            values: vec![0.0, 0.25, 0.25, 0.0],
            ..m
        };
        assert!(
            distance_export(&ok, "csv")
                .expect("csv")
                .as_str()
                .is_some_and(|s| s.starts_with(",a,b\n") || s.contains("a,"))
        );
        assert!(distance_export(&ok, "xml").is_err());
        assert_eq!(
            correct_curve("jc", &[0.0, 0.2, 0.8]).expect("curve")[2],
            Value::Null,
            "saturated"
        );
    }
}
