//! External and mathematical checks for distances, trees, and Newick: the Biopython 1.86 / SciPy reference cases, the
//! Wikipedia worked examples, the Newick fixtures, and exact recovery of random trees from their own distance matrices.
//! Port of the corresponding parts of tests/unit/trees-core.test.ts, newick.test.ts, and distance.test.ts (same inputs, same
//! comparisons, same tolerances).
#![allow(clippy::needless_range_loop)] // the matrix loops mirror the TypeScript index arithmetic on purpose

mod common;

use common::{matrix_of, read_json, repo_root};
use sequencescope_core::alphabet::js_len;
use sequencescope_core::distance::{
    DIST_OK, DistanceMatrix, DistanceModel, GapPolicy, cell_value, distance_matrix_from_aligned,
};
use sequencescope_core::error::BioErrorCode;
use sequencescope_core::fasta::{AlphabetChoice, ParseOptions, parse_fasta};
use sequencescope_core::newick::{WriteOptions, parse_newick, write_newick};
use sequencescope_core::nj::{NjStep, neighbor_joining, replay_nj};
use sequencescope_core::rng::Rng;
use sequencescope_core::tree::*;
use sequencescope_core::treecompare::robinson_foulds;
use sequencescope_core::types::Alphabet;
use sequencescope_core::upgma::{replay_upgma, upgma};
use serde_json::Value;
use std::collections::BTreeSet;

fn nw(s: &str) -> Tree {
    parse_newick(s).expect("valid newick").tree // test code
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect() // test code
}

fn matrix_from_fixture(c: &Value) -> DistanceMatrix {
    matrix_of(
        c["names"].as_array().expect("names"),
        c["matrix"].as_array().expect("matrix"),
    ) // test code
}

/// Uniform float in [lo, hi), like the TypeScript test helper.
fn uniform(rng: &mut Rng, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * rng.next_float()
}

/// Random rooted binary ULTRAMETRIC tree (port of tests/helpers/trees.ts).
fn random_ultrametric(seed: u32, n: usize) -> Tree {
    let mut rng = Rng::new(seed);
    let mut clusters: Vec<(TreeNode, f64)> = (0..n).map(|k| (TreeNode::leaf(&format!("t{k}")), 0.0)).collect();
    while clusters.len() > 1 {
        let (mut a, ha) = clusters.remove(rng.next_int(clusters.len() as u64).expect("bound") as usize); // test code
        let (mut b, hb) = clusters.remove(rng.next_int(clusters.len() as u64).expect("bound") as usize); // test code
        let h = ha.max(hb) + uniform(&mut rng, 0.1, 2.0);
        a.length = Some(h - ha);
        b.length = Some(h - hb);
        clusters.push((TreeNode::with_children(vec![a, b]), h));
    }
    Tree {
        root: clusters.remove(0).0,
    }
}

/// Random unrooted binary ADDITIVE tree (root has 3 children) built by attaching leaves to random edges.
fn random_additive(seed: u32, n: usize) -> Tree {
    let mut rng = Rng::new(seed);
    let leaf = |rng: &mut Rng, k: usize| TreeNode {
        name: Some(format!("t{k}")),
        length: Some(uniform(rng, 0.2, 4.0)),
        ..TreeNode::default()
    };
    let first = [leaf(&mut rng, 0), leaf(&mut rng, 1), leaf(&mut rng, 2)];
    let mut root = TreeNode::with_children(first.to_vec());
    for k in 3..n {
        // paths (child indices from the root) of every edge, in pre-order
        fn walk(node: &TreeNode, path: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
            for (idx, c) in node.children.iter().enumerate() {
                path.push(idx);
                out.push(path.clone());
                walk(c, path, out);
                path.pop();
            }
        }
        let mut edges = Vec::new();
        walk(&root, &mut Vec::new(), &mut edges);
        let path = edges[rng.next_int(edges.len() as u64).expect("bound") as usize].clone(); // test code
        let mut parent = &mut root;
        for &i in &path[..path.len() - 1] {
            parent = &mut parent.children[i];
        }
        let idx = path[path.len() - 1];
        let split = uniform(&mut rng, 0.1, 0.9);
        let new_leaf = leaf(&mut rng, k);
        let mut child = std::mem::take(&mut parent.children[idx]);
        let whole = child.length.unwrap_or(1.0);
        child.length = Some(whole * (1.0 - split));
        parent.children[idx] = TreeNode {
            length: Some(whole * split),
            children: vec![child, new_leaf],
            ..TreeNode::default()
        };
    }
    Tree { root }
}

/// Exact leaf-to-leaf distance matrix of a tree, as a tree-ready DistanceMatrix.
fn matrix_of_tree(t: &Tree) -> DistanceMatrix {
    let ld = leaf_distances(t);
    let n = ld.names.len();
    let mut m = sequencescope_core::distance::matrix_from_rows(&ld.names, &ld.dist, DistanceModel::P);
    m.compared = vec![100; n * n];
    m
}

/// The set of rooted clades (leaf sets of internal nodes) as sorted comma-joined strings.
fn clade_set(t: &Tree) -> BTreeSet<String> {
    fn walk(n: &TreeNode, out: &mut BTreeSet<String>) -> Vec<String> {
        let mut leaves: Vec<String> = if n.is_leaf() {
            vec![n.name.clone().unwrap_or_default()]
        } else {
            n.children.iter().flat_map(|c| walk(c, out)).collect()
        };
        if !n.is_leaf() {
            leaves.sort();
            out.insert(leaves.join(","));
        }
        leaves
    }
    let mut out = BTreeSet::new();
    walk(&t.root, &mut out);
    out
}

/// Asserts two trees have the same unrooted edges (keys) and lengths within `tol`.
fn expect_edges_equal(a: &Tree, b: &Tree, tol: f64) {
    let (ea, eb) = (edge_length_map(a).expect("valid"), edge_length_map(b).expect("valid")); // test code
    let (mut ka, mut kb): (Vec<&String>, Vec<&String>) = (ea.keys().collect(), eb.keys().collect());
    ka.sort();
    kb.sort();
    assert_eq!(ka, kb);
    for (k, v) in ea.iter() {
        assert!(
            (v - eb.get(k).copied().expect("same edge")).abs() < tol,
            "edge {k:?}: {v} vs {:?}",
            eb.get(k)
        ); // test code
    }
}

/// Distance from the root to the first leaf, following first children (UPGMA trees are ultrametric).
fn depth_first_leaf(t: &Tree) -> f64 {
    let (mut x, mut nd) = (0.0, &t.root);
    while let Some(c) = nd.children.first() {
        nd = c;
        x += nd.length.unwrap_or(0.0);
    }
    x
}

// ------------------------------------------------------------------------------------------------ worked examples

#[test]
fn wikipedia_worked_examples_upgma_and_nj() {
    let ex = read_json("tests/fixtures/worked-examples/trees.json");
    let u = &ex["upgma"];
    let r = upgma(&matrix_from_fixture(u)).expect("tree-ready"); // test code
    let merges = u["merges"].as_array().expect("merges"); // test code
    assert_eq!(
        r.steps.iter().map(|s| s.distance).collect::<Vec<_>>(),
        merges
            .iter()
            .map(|m| m["distance"].as_f64().expect("distance"))
            .collect::<Vec<_>>()
    ); // test code
    assert_eq!(
        r.steps.iter().map(|s| s.height).collect::<Vec<_>>(),
        merges
            .iter()
            .map(|m| m["height"].as_f64().expect("height"))
            .collect::<Vec<_>>()
    ); // test code
    assert_eq!((r.steps[0].branch_a, r.steps[0].branch_b), (8.5, 8.5));
    assert_eq!(r.steps[1].new_row, vec![30.0, 36.0]);
    assert_eq!(r.steps[1].matrix.iter().flatten().filter(|&&v| v == 22.0).count(), 2);
    fn depths(nd: &TreeNode, d: f64, out: &mut BTreeSet<i64>) {
        if nd.is_leaf() {
            out.insert((d * 1e9).round() as i64);
        }
        nd.children
            .iter()
            .for_each(|c| depths(c, d + c.length.unwrap_or(0.0), out));
    }
    let mut set = BTreeSet::new();
    depths(&r.tree.root, 0.0, &mut set);
    assert_eq!(
        set.into_iter().collect::<Vec<_>>(),
        vec![16_500_000_000],
        "every leaf is 16.5 from the root, as in the article"
    );
    let mut want: BTreeSet<String> = strs(&u["clades"]).into_iter().collect();
    want.insert("a,b,c,d,e".to_string());
    assert_eq!(clade_set(&r.tree), want);
    assert!((total_length(&r.tree) - (8.5 + 8.5 + 2.5 + 11.0 + 5.5 + 14.0 + 14.0 + 2.5)).abs() < 1e-12);

    let nj = &ex["nj"];
    let names = strs(&nj["names"]);
    let r = neighbor_joining(&matrix_from_fixture(nj)).expect("tree-ready"); // test code
    let NjStep::Join(s1) = &r.steps[0] else {
        panic!("expected a join")
    }; // test code
    for (pair, v) in nj["firstQ"].as_object().expect("firstQ") {
        // test code
        let (x, y) = pair.split_once(',').expect("pair"); // test code
        let (ix, iy) = (
            names.iter().position(|n| n == x).expect("name"),
            names.iter().position(|n| n == y).expect("name"),
        ); // test code
        assert_eq!(s1.q[ix][iy], v.as_f64().expect("q"), "Q({pair})"); // test code
    }
    assert_eq!(
        (s1.q_min, s1.a, s1.b, s1.branch_a, s1.branch_b),
        (-50.0, 0, 1, 2.0, 3.0)
    );
    assert_eq!(s1.new_row, vec![7.0, 7.0, 6.0]);
    let NjStep::Join(s2) = &r.steps[1] else {
        panic!("expected a join")
    }; // test code
    assert_eq!(s2.q_min, nj["secondMinQ"].as_f64().expect("secondMinQ")); // test code
    assert_eq!((s2.branch_a, s2.branch_b), (4.0, 3.0));
    let NjStep::Final(f) = &r.steps[2] else {
        panic!("expected the final step")
    }; // test code
    let mut b = f.branches;
    b.sort_by(f64::total_cmp);
    assert_eq!(b, [1.0, 2.0, 2.0]);
    assert_eq!(nontrivial_splits(&r.tree).expect("valid").splits.len(), 2);
}

// ------------------------------------------------------------------------------------------------ exact recovery

#[test]
fn upgma_recovers_random_ultrametric_trees_exactly() {
    for seed in 1..=200u32 {
        let n = 3 + (seed as usize % 12);
        let truth = random_ultrametric(seed, n);
        let got = upgma(&matrix_of_tree(&truth)).expect("tree-ready").tree; // test code
        assert_eq!(clade_set(&got), clade_set(&truth), "seed {seed}");
        expect_edges_equal(&got, &truth, 1e-9);
        fn depths(nd: &TreeNode, d: f64, out: &mut BTreeSet<i64>) {
            if nd.is_leaf() {
                out.insert((d * 1e8).round() as i64);
            }
            nd.children
                .iter()
                .for_each(|c| depths(c, d + c.length.unwrap_or(0.0), out));
        }
        let mut set = BTreeSet::new();
        depths(&got.root, 0.0, &mut set);
        assert_eq!(
            set.len(),
            1,
            "ultrametric: every leaf is the same distance from the root (seed {seed})"
        );
    }
}

#[test]
fn neighbor_joining_recovers_random_additive_trees_exactly() {
    for seed in 1..=200u32 {
        let n = 3 + (seed as usize % 12);
        let truth = random_additive(seed, n);
        let got = neighbor_joining(&matrix_of_tree(&truth)).expect("tree-ready").tree; // test code
        assert_eq!(
            robinson_foulds(&got, &truth).expect("same leaves").distance,
            0,
            "seed {seed}"
        ); // test code
        expect_edges_equal(&got, &truth, 1e-9);
        assert!(!has_negative_branches(&got));
    }
    let truth = random_additive(777, 40);
    let got = neighbor_joining(&matrix_of_tree(&truth)).expect("tree-ready").tree; // test code
    assert_eq!(robinson_foulds(&got, &truth).expect("same leaves").distance, 0); // test code
    expect_edges_equal(&got, &truth, 1e-9);
}

#[test]
fn rerooting_and_midpoint_rooting_hold_on_random_trees() {
    for seed in 1..=50u32 {
        let tr = random_additive(seed, 10);
        let idx = 1 + (seed as usize % (preorder(&tr).len() - 1));
        let r = reroot_above(&tr, idx, 0.5).expect("reroot"); // test code
        assert_eq!(robinson_foulds(&tr, &r).expect("same leaves").distance, 0);
        let r2 = reroot_above(&r, 1 + (seed as usize % (preorder(&r).len() - 1)), 0.25).expect("reroot"); // test code
        assert_eq!(robinson_foulds(&tr, &r2).expect("same leaves").distance, 0);
        assert!((total_length(&r2) - total_length(&tr)).abs() < 1e-9);
    }
    for seed in 1..=100u32 {
        let tr = random_additive(seed, 3 + (seed as usize % 10));
        let m = midpoint_root(&tr).expect("midpoint"); // test code
        let longest = leaf_distances(&tr)
            .dist
            .iter()
            .flatten()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        fn max_depth(nd: &TreeNode, acc: f64) -> f64 {
            if nd.is_leaf() {
                acc
            } else {
                nd.children
                    .iter()
                    .map(|c| max_depth(c, acc + c.length.unwrap_or(0.0)))
                    .fold(f64::NEG_INFINITY, f64::max)
            }
        }
        assert!((max_depth(&m.root, 0.0) - longest / 2.0).abs() < 1e-9, "seed {seed}");
        assert_eq!(robinson_foulds(&tr, &m).expect("same leaves").distance, 0);
    }
}

#[test]
fn robinson_foulds_is_symmetric_and_obeys_the_triangle_inequality_on_random_trees() {
    for seed in 1..=60u32 {
        let (x, y, z) = (
            random_additive(seed, 9),
            random_additive(seed + 1000, 9),
            random_additive(seed + 2000, 9),
        );
        let d = |a: &Tree, b: &Tree| robinson_foulds(a, b).expect("same leaves").distance; // test code
        assert_eq!(d(&x, &y), d(&y, &x));
        assert!(d(&x, &z) <= d(&x, &y) + d(&y, &z));
    }
}

#[test]
fn permuting_taxon_order_does_not_change_the_unrooted_topology_on_tie_free_matrices() {
    for seed in 1..=100u32 {
        let mut rng = Rng::new(seed);
        let n = 4 + (seed as usize % 6);
        let names: Vec<String> = (0..n).map(|k| format!("s{k}")).collect();
        let mut rows = vec![vec![0.0; n]; n];
        for i in 0..n {
            for j in (i + 1)..n {
                let v = uniform(&mut rng, 0.1, 2.0);
                rows[i][j] = v;
                rows[j][i] = v;
            }
        }
        let mut perm: Vec<usize> = (0..n).collect();
        for i in (1..perm.len()).rev() {
            let j = rng.next_int(i as u64 + 1).expect("bound") as usize; // test code
            perm.swap(i, j);
        }
        let perm_rows: Vec<Vec<f64>> = perm
            .iter()
            .map(|&a| perm.iter().map(|&b| rows[a][b]).collect())
            .collect();
        let m1 = sequencescope_core::distance::matrix_from_rows(&names, &rows, DistanceModel::P);
        let m2 = sequencescope_core::distance::matrix_from_rows(
            &perm.iter().map(|&p| names[p].clone()).collect::<Vec<_>>(),
            &perm_rows,
            DistanceModel::P,
        );
        for build in [
            |m: &DistanceMatrix| upgma(m).expect("ready").tree,
            |m: &DistanceMatrix| neighbor_joining(m).expect("ready").tree,
        ] {
            // test code
            let (t1, t2) = (build(&m1), build(&m2));
            assert_eq!(
                robinson_foulds(&t1, &t2).expect("same leaves").distance,
                0,
                "seed {seed}"
            ); // test code
            assert!((total_length(&t1) - total_length(&t2)).abs() < 1e-9);
        }
    }
}

#[test]
fn replaying_recorded_steps_rebuilds_the_tree_exactly() {
    for seed in 1..=50u32 {
        let mut rng = Rng::new(seed);
        let n = 3 + (seed as usize % 9);
        let names: Vec<String> = (0..n).map(|k| format!("s{k}")).collect();
        let mut rows = vec![vec![0.0; n]; n];
        for i in 0..n {
            for j in (i + 1)..n {
                let v = uniform(&mut rng, 0.1, 2.0);
                rows[i][j] = v;
                rows[j][i] = v;
            }
        }
        let m = sequencescope_core::distance::matrix_from_rows(&names, &rows, DistanceModel::P);
        let (u, j) = (upgma(&m).expect("ready"), neighbor_joining(&m).expect("ready")); // test code
        assert_eq!(replay_upgma(&u.steps, &u.names).expect("steps"), u.tree); // test code
        assert_eq!(replay_nj(&j.steps, &j.names).expect("steps"), j.tree); // test code
        assert_eq!((u.steps.len(), j.steps.len()), (n - 1, n - 2));
    }
}

// ------------------------------------------------------------------------------------------------ Biopython / SciPy

/// Removes Biopython's internal-node names ("Inner12") from a Newick string.
fn strip_inner(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("Inner") {
        out.push_str(&rest[..i]);
        rest = rest[i + 5..].trim_start_matches(|c: char| c.is_ascii_digit());
    }
    out + rest
}

/// Weighted-pair-group averaging (WPGMA) as implemented by Biopython's upgma(): unweighted mean of the two old distances.
fn wpgma(names: &[String], rows: &[Vec<f64>]) -> Tree {
    let mut nodes: Vec<TreeNode> = names.iter().map(|n| TreeNode::leaf(n)).collect();
    let mut height = vec![0.0; names.len()];
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };
    let mut d: std::collections::HashMap<(usize, usize), f64> = std::collections::HashMap::new();
    for i in 0..names.len() {
        for j in (i + 1)..names.len() {
            d.insert((i, j), rows[i][j]);
        }
    }
    let mut active: Vec<usize> = (0..names.len()).collect();
    while active.len() > 1 {
        let (mut best, mut bi, mut bj) = (f64::INFINITY, 0, 1);
        for p in 0..active.len() {
            for q in (p + 1)..active.len() {
                let v = d[&key(active[p], active[q])];
                if v < best {
                    best = v;
                    bi = p;
                    bj = q;
                }
            }
        }
        let (a, b) = (active[bi], active[bj]);
        let id = nodes.len();
        nodes[a].length = Some(best / 2.0 - height[a]);
        nodes[b].length = Some(best / 2.0 - height[b]);
        let (na, nb) = (nodes[a].clone(), nodes[b].clone());
        nodes.push(TreeNode::with_children(vec![na, nb]));
        height.push(best / 2.0);
        let rest: Vec<usize> = active
            .iter()
            .enumerate()
            .filter(|(k, _)| *k != bi && *k != bj)
            .map(|(_, &x)| x)
            .collect();
        for &k in &rest {
            d.insert(key(id, k), (d[&key(a, k)] + d[&key(b, k)]) / 2.0);
        }
        active = rest;
        active.push(id);
    }
    Tree {
        root: nodes.pop().expect("a root"),
    } // test code
}

#[test]
fn biopython_and_scipy_reference_trees() {
    let bio = read_json("tests/fixtures/reference/trees.json");
    let sci = read_json("tests/fixtures/reference/upgma_scipy.json");
    let cases = bio["cases"].as_array().expect("cases"); // test code
    assert!(cases.len() >= 6 && sci["cases"].as_array().expect("sci cases").len() == cases.len()); // test code
    let mut checks = 0;
    for c in cases {
        let id = c["id"].as_str().expect("id"); // test code
        let m = matrix_from_fixture(c);
        // NJ equals Biopython's NJ
        let ours = neighbor_joining(&m).expect("tree-ready").tree; // test code
        let theirs = nw(&strip_inner(c["nj"]["newick"].as_str().expect("newick"))); // test code
        assert_eq!(
            robinson_foulds(&ours, &theirs).expect("same leaves").distance,
            0,
            "{id}: NJ topology"
        ); // test code
        assert!(
            (total_length(&ours) - c["nj"]["total_length"].as_f64().expect("total_length")).abs() < 1e-9,
            "{id}: NJ total length"
        ); // test code
        expect_edges_equal(&ours, &theirs, 6e-6); // Biopython's Newick text has only 5 decimals
        // UPGMA equals SciPy average linkage
        let s = sci["cases"]
            .as_array()
            .expect("sci cases")
            .iter()
            .find(|x| x["id"] == c["id"])
            .expect("matching case"); // test code
        let ours_u = upgma(&m).expect("tree-ready").tree; // test code
        let want: BTreeSet<String> = s["clades"]
            .as_array()
            .expect("clades")
            .iter()
            .map(|x| {
                let mut v = strs(x);
                v.sort();
                v.join(",")
            })
            .collect(); // test code
        assert_eq!(clade_set(&ours_u), want, "{id}: UPGMA clades vs SciPy");
        assert!(
            (total_length(&ours_u) - s["total_length"].as_f64().expect("total_length")).abs() < 1e-9,
            "{id}: UPGMA total length"
        ); // test code
        assert!(
            (depth_first_leaf(&ours_u) - s["root_height"].as_f64().expect("root_height")).abs() < 1e-9,
            "{id}: UPGMA root height"
        ); // test code
        // Biopython's "UPGMA" is WPGMA
        let rows: Vec<Vec<f64>> = c["matrix"]
            .as_array()
            .expect("matrix")
            .iter()
            .map(|r| {
                r.as_array()
                    .expect("row")
                    .iter()
                    .map(|x| x.as_f64().expect("number"))
                    .collect()
            })
            .collect(); // test code
        let reference = wpgma(&strs(&c["names"]), &rows);
        let their_upgma = nw(&strip_inner(c["upgma"]["newick"].as_str().expect("newick"))); // test code
        assert_eq!(
            robinson_foulds(&reference, &their_upgma).expect("same leaves").distance,
            0,
            "{id}: WPGMA topology"
        ); // test code
        assert!(
            (total_length(&reference) - c["upgma"]["total_length"].as_f64().expect("total_length")).abs() < 1e-9,
            "{id}: WPGMA total length"
        ); // test code
        checks += 1;
    }
    println!(
        "Biopython {} / SciPy {}: {checks} matrices, NJ vs Biopython, UPGMA vs SciPy, WPGMA vs Biopython's \"UPGMA\", 0 mismatches",
        bio["meta"]["biopython"], sci["meta"]["scipy"]
    );
    // On the ultrametric matrix all three UPGMA variants agree
    let c = cases
        .iter()
        .find(|x| x["id"] == "ultrametric_5")
        .expect("ultrametric_5"); // test code
    let ours = upgma(&matrix_from_fixture(c)).expect("tree-ready").tree; // test code
    assert!((total_length(&ours) - c["upgma"]["total_length"].as_f64().expect("total_length")).abs() < 1e-9); // test code
    // NJ keeps negative branches exactly as Biopython reports them
    let c = cases.iter().find(|x| x["id"] == "noisy_7").expect("noisy_7"); // test code
    let t = neighbor_joining(&matrix_from_fixture(c)).expect("tree-ready").tree; // test code
    assert!(has_negative_branches(&t));
    let min = preorder(&t)
        .iter()
        .map(|n| n.length.unwrap_or(0.0))
        .fold(f64::INFINITY, f64::min);
    assert!(
        (min + 0.08419).abs() < 5e-5,
        "the same negative branch Biopython reports: {min}"
    );
    assert!((total_length(&t) - c["nj"]["total_length"].as_f64().expect("total_length")).abs() < 1e-9); // test code
}

#[test]
fn biopython_identity_distances_on_the_mafft_aligned_example_sets() {
    let reference = read_json("tests/fixtures/reference/distances.json");
    let mut pairs_checked = 0;
    for s in reference["sets"].as_array().expect("sets") {
        // test code
        let set = s["set"].as_str().expect("set"); // test code
        let text =
            std::fs::read_to_string(repo_root().join(format!("examples/{set}/aligned.fasta"))).expect("example file"); // test code
        let alphabet = if set.starts_with("globin") {
            Alphabet::Protein
        } else {
            Alphabet::Dna
        };
        let parsed = parse_fasta(
            &text,
            ParseOptions {
                alphabet: AlphabetChoice::Fixed(alphabet),
                allow_gaps: true,
            },
        );
        assert!(parsed.issues.is_empty(), "{set}: {:?}", parsed.issues);
        let rows: Vec<String> = parsed.records.iter().map(|r| r.residues.clone()).collect();
        let names = strs(&s["names"]);
        assert_eq!(parsed.records.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), names);
        let m = distance_matrix_from_aligned(
            &names,
            &rows,
            alphabet,
            DistanceModel::P,
            GapPolicy::GapsAsDifferences,
            None,
        )
        .expect("valid"); // test code
        let columns = s["columns"].as_f64().expect("columns"); // test code
        let mut max_raw = 0.0f64;
        for i in 0..m.n {
            for j in (i + 1)..m.n {
                let (a, b) = (&rows[i], &rows[j]);
                let shared = a.chars().zip(b.chars()).filter(|(x, y)| *x == '-' && *y == '-').count() as f64;
                let bio = s["matrix"][i][j].as_f64().expect("distance"); // test code
                let ours = cell_value(&m, i, j).expect("usable"); // test code
                assert!(
                    (ours * (columns - shared) - bio * columns).abs() < 1e-9,
                    "{set} {i},{j}: same number of differing columns"
                );
                max_raw = max_raw.max((ours - bio).abs());
                pairs_checked += 1;
            }
        }
        assert!(
            max_raw < 0.01,
            "{set}: raw difference is small but nonzero when shared-gap columns exist: {max_raw}"
        );
        assert_eq!(js_len(&rows[0]) as f64, columns);
        assert_eq!(m.status.iter().filter(|&&st| st != DIST_OK).count(), 0);
    }
    println!("Biopython identity distances: {pairs_checked} pairs across the example sets, 0 mismatches");
}

// ------------------------------------------------------------------------------------------------ Newick fixtures

#[test]
fn newick_good_and_bad_fixtures() {
    let fx = read_json("tests/fixtures/newick/cases.json");
    for g in fx["good"].as_array().expect("good") {
        // test code
        let id = g["id"].as_str().expect("id"); // test code
        let r = parse_newick(g["text"].as_str().expect("text")).unwrap_or_else(|e| panic!("{id}: {}", e.message)); // test code
        assert_eq!(leaf_names(&r.tree), strs(&g["leaves"]), "{id}");
        assert_eq!(r.extra_trees as u64, g["extraTrees"].as_u64().unwrap_or(0), "{id}");
        let again = parse_newick(&write_newick(&r.tree, WriteOptions::default())).expect("re-read"); // test code
        assert_eq!(again.tree, r.tree, "{id}: write -> read gives an identical tree");
        assert_eq!(
            write_newick(&again.tree, WriteOptions::default()),
            write_newick(&r.tree, WriteOptions::default()),
            "{id}"
        );
    }
    for b in fx["bad"].as_array().expect("bad") {
        // test code
        let id = b["id"].as_str().expect("id"); // test code
        let e = parse_newick(b["text"].as_str().expect("text")).expect_err(id); // test code
        assert!(
            e.message.contains(b["contains"].as_str().expect("contains")),
            "{id}: {}",
            e.message
        ); // test code
        assert_eq!(
            sequencescope_core::error::BioError::from(e.clone()).code,
            BioErrorCode::NewickSyntax
        );
        if let Some(line) = b["line"].as_u64() {
            assert_eq!(e.line as u64, line, "{id}: line");
        }
        if let Some(col) = b["column"].as_u64() {
            assert_eq!(e.column as u64, col, "{id}: column");
        }
    }
}

#[test]
fn newick_write_read_is_the_identity_on_random_trees() {
    for seed in 1..=100u32 {
        let n = 3 + (seed as usize * 7 % 23);
        for t in [random_ultrametric(seed, n), random_additive(seed, n)] {
            let text = write_newick(&t, WriteOptions::default());
            assert_eq!(parse_newick(&text).expect("valid").tree, t, "seed {seed}");
            assert_eq!(
                write_newick(&parse_newick(&text).expect("valid").tree, WriteOptions::default()),
                text
            );
        }
    }
}

#[test]
fn unusual_leaf_names_survive_quoting() {
    let alphabet: Vec<char> = "ab (),:;[]' _1.".chars().collect();
    let mut rng = Rng::new(5);
    for _ in 0..200 {
        let count = 3 + rng.next_int(4).expect("bound") as usize; // test code
        let mut names: Vec<String> = Vec::new();
        while names.len() < count {
            let len = 1 + rng.next_int(8).expect("bound") as usize; // test code
            let name: String = (0..len)
                .map(|_| alphabet[rng.next_int(alphabet.len() as u64).expect("bound") as usize])
                .collect(); // test code
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let t = Tree {
            root: TreeNode::with_children(
                names
                    .iter()
                    .map(|n| TreeNode {
                        name: Some(n.clone()),
                        length: Some(1.0),
                        ..TreeNode::default()
                    })
                    .collect(),
            ),
        };
        assert_eq!(
            leaf_names(
                &parse_newick(&write_newick(&t, WriteOptions::default()))
                    .expect("valid")
                    .tree
            ),
            names
        );
    }
}
