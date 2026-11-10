//! Tree utilities: traversal, splits (bipartitions), edge lengths, re-rooting, midpoint rooting, ordering, support.
//! Port of `src/bio/tree.ts`. A tree is a recursive `TreeNode`. A root with 3 children is the usual unrooted form; a root
//! with 2 children is a rooted form. Node numbers ("index") are PRE-ORDER positions, exactly like the UI uses.
//! Two details are reproduced on purpose: JavaScript's `Map` keeps insertion order (`OrderedMap`), and `.sort()` /
//! `<` on strings compare UTF-16 code units (`js_cmp`).

use crate::error::{BioError, BioErrorCode};
use crate::jsnum::js_cmp;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// A tree node. Leaves have a `name` and no children. `length` is the branch above the node; `support` is a bootstrap percentage.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TreeNode {
    pub name: Option<String>,
    /// Internal-node label that is not a number.
    pub label: Option<String>,
    pub length: Option<f64>,
    pub support: Option<f64>,
    pub children: Vec<TreeNode>,
}

/// A tree is just its root node.
#[derive(Debug, Clone, PartialEq)]
pub struct Tree {
    pub root: TreeNode,
}

impl TreeNode {
    /// A leaf with a name and no length.
    pub fn leaf(name: &str) -> Self {
        Self {
            name: Some(name.to_string()),
            ..Self::default()
        }
    }

    /// An internal node with the given children.
    pub fn with_children(children: Vec<TreeNode>) -> Self {
        Self {
            children,
            ..Self::default()
        }
    }

    /// True for a leaf node.
    pub fn is_leaf(&self) -> bool {
        self.children.is_empty()
    }
}

/// A map that remembers the order keys were first inserted (like a JavaScript `Map`).
#[derive(Debug, Clone, PartialEq)]
pub struct OrderedMap<V> {
    keys: Vec<String>,
    vals: Vec<V>,
    index: HashMap<String, usize>,
}

impl<V> Default for OrderedMap<V> {
    /// An empty map.
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            vals: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    /// Sets a key; an existing key keeps its original position.
    pub fn set(&mut self, key: String, value: V) {
        if let Some(&i) = self.index.get(&key) {
            self.vals[i] = value;
        } else {
            self.index.insert(key.clone(), self.keys.len());
            self.keys.push(key);
            self.vals.push(value);
        }
    }

    /// The value for a key.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|&i| &self.vals[i])
    }

    /// True if the key is present.
    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// True if there are no entries.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.keys.iter().zip(self.vals.iter())
    }

    /// Keys in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.keys.iter()
    }
}

/// Leaf names in left-to-right order.
pub fn leaf_names(t: &Tree) -> Vec<String> {
    fn walk(n: &TreeNode, out: &mut Vec<String>) {
        if n.is_leaf() {
            out.push(n.name.clone().unwrap_or_default());
        } else {
            n.children.iter().for_each(|c| walk(c, out));
        }
    }
    let mut out = Vec::new();
    walk(&t.root, &mut out);
    out
}

/// Nodes in pre-order (parent before children, children left to right). Index = node id used by the UI.
pub fn preorder(t: &Tree) -> Vec<&TreeNode> {
    fn walk<'a>(n: &'a TreeNode, out: &mut Vec<&'a TreeNode>) {
        out.push(n);
        n.children.iter().for_each(|c| walk(c, out));
    }
    let mut out = Vec::new();
    walk(&t.root, &mut out);
    out
}

/// Pre-order parent index of every node (None for the root).
fn preorder_parents(t: &Tree) -> Vec<Option<usize>> {
    fn walk(n: &TreeNode, parent: Option<usize>, out: &mut Vec<Option<usize>>) {
        let me = out.len();
        out.push(parent);
        n.children.iter().for_each(|c| walk(c, Some(me), out));
    }
    let mut out = Vec::new();
    walk(&t.root, None, &mut out);
    out
}

/// Sum of all branch lengths (missing lengths count as 0), added in pre-order like the TypeScript `reduce`.
pub fn total_length(t: &Tree) -> f64 {
    preorder(t).iter().fold(0.0, |s, n| s + n.length.unwrap_or(0.0))
}

/// True if any branch length is negative (neighbor-joining can produce these; they are never clamped).
pub fn has_negative_branches(t: &Tree) -> bool {
    preorder(t).iter().any(|n| n.length.unwrap_or(0.0) < 0.0)
}

/// Validates a tree for comparison/building: unique, non-empty leaf names.
pub fn assert_valid_leaves(t: &Tree) -> Result<Vec<String>, BioError> {
    let names = leaf_names(t);
    if names.iter().any(String::is_empty) {
        return Err(BioError::new(BioErrorCode::InvalidTree, "Every leaf needs a name."));
    }
    if names.iter().collect::<HashSet<_>>().len() != names.len() {
        return Err(BioError::new(
            BioErrorCode::DuplicateNames,
            "Leaf names must be unique.",
        ));
    }
    Ok(names)
}

const SEP: char = '\u{1}';

/// Sorts strings the way JavaScript's default `.sort()` does.
fn js_sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| js_cmp(a, b));
    v
}

/// Canonical key of a split side: sorted and joined.
fn side_key(side: &[String]) -> String {
    js_sorted(side.to_vec()).join(&SEP.to_string())
}

/// The leaf set below every node, in pre-order, with the node's pre-order index implied by the position.
fn clade_sets(t: &Tree) -> Vec<Vec<String>> {
    fn walk(n: &TreeNode, out: &mut Vec<Vec<String>>) -> Vec<String> {
        let idx = out.len();
        out.push(Vec::new());
        let leaves = if n.is_leaf() {
            vec![n.name.clone().unwrap_or_default()]
        } else {
            n.children.iter().flat_map(|c| walk(c, out)).collect()
        };
        out[idx] = leaves.clone();
        leaves
    }
    let mut out = Vec::new();
    walk(&t.root, &mut out);
    out
}

/// The canonical (reference-free) side of a split for a clade: the side NOT containing the reference leaf.
fn canonical_side(clade: &[String], all: &[String], reference: &str) -> Vec<String> {
    if !clade.iter().any(|x| x == reference) {
        return clade.to_vec();
    }
    let in_clade: HashSet<&String> = clade.iter().collect();
    all.iter().filter(|x| !in_clade.contains(x)).cloned().collect()
}

/// The reference leaf: the smallest leaf name in JavaScript order.
fn reference_leaf(all: &[String]) -> String {
    js_sorted(all.to_vec()).into_iter().next().unwrap_or_default()
}

/// All non-trivial splits of a tree plus its sorted leaf list.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitMap {
    /// key -> leaf names on the canonical side (the side not containing the smallest leaf name), sorted.
    pub splits: OrderedMap<Vec<String>>,
    pub leaves: Vec<String>,
}

/// All NON-TRIVIAL splits (both sides have at least 2 leaves) of the tree viewed as UNROOTED.
pub fn nontrivial_splits(t: &Tree) -> Result<SplitMap, BioError> {
    let all = assert_valid_leaves(t)?;
    let reference = reference_leaf(&all);
    let mut splits = OrderedMap::default();
    for (idx, leaves) in clade_sets(t).iter().enumerate() {
        if idx == 0 {
            continue; // the root
        }
        if leaves.len() < 2 || leaves.len() as i64 > all.len() as i64 - 2 {
            continue;
        }
        let side = js_sorted(canonical_side(leaves, &all, &reference));
        splits.set(side_key(&side), side);
    }
    Ok(SplitMap {
        splits,
        leaves: js_sorted(all),
    })
}

/// Key for the split induced by a clade (for any clade size 1..n-1), relative to a leaf list.
pub fn clade_key(clade: &[String], all: &[String]) -> String {
    side_key(&canonical_side(clade, all, &reference_leaf(all)))
}

/// Length of every edge, keyed by split (trivial splits included). A rooted-form tree's two root edges are one unrooted
/// edge, so their lengths are summed. Edges without a length are skipped.
pub fn edge_length_map(t: &Tree) -> Result<OrderedMap<f64>, BioError> {
    let all = assert_valid_leaves(t)?;
    let reference = reference_leaf(&all);
    let nodes = preorder(t);
    let mut out: OrderedMap<f64> = OrderedMap::default();
    for (idx, leaves) in clade_sets(t).iter().enumerate() {
        let node = nodes[idx];
        let Some(length) = node.length else { continue };
        if idx == 0 {
            continue;
        }
        let key = side_key(&canonical_side(leaves, &all, &reference));
        let prev = out.get(&key).copied().unwrap_or(0.0);
        out.set(key, prev + length);
    }
    Ok(out)
}

/// Orders children so output is deterministic: smaller clades first, ties by smallest leaf name.
pub fn ladderize(t: &Tree) -> Tree {
    struct Sorted {
        node: TreeNode,
        size: usize,
        first: String,
    }
    fn sorted(n: &TreeNode) -> Sorted {
        if n.is_leaf() {
            return Sorted {
                node: TreeNode {
                    children: Vec::new(),
                    ..n.clone()
                },
                size: 1,
                first: n.name.clone().unwrap_or_default(),
            };
        }
        let mut kids: Vec<Sorted> = n.children.iter().map(sorted).collect();
        kids.sort_by(|a, b| a.size.cmp(&b.size).then_with(|| js_cmp(&a.first, &b.first)));
        let size = kids.iter().map(|k| k.size).sum();
        let first = js_sorted(kids.iter().map(|k| k.first.clone()).collect())
            .into_iter()
            .next()
            .unwrap_or_default();
        Sorted {
            node: TreeNode {
                children: kids.into_iter().map(|k| k.node).collect(),
                ..n.clone()
            },
            size,
            first,
        }
    }
    Tree {
        root: sorted(&t.root).node,
    }
}

/// Leaf order of the ladderized tree: deterministic regardless of how the tree was built.
pub fn ordered_leaves(t: &Tree) -> Vec<String> {
    leaf_names(&ladderize(t))
}

/// Visits every node in pre-order with its index (mutable access).
fn for_each_mut(n: &mut TreeNode, counter: &mut usize, f: &mut dyn FnMut(usize, &mut TreeNode)) {
    let me = *counter;
    *counter += 1;
    f(me, n);
    for c in &mut n.children {
        for_each_mut(c, counter, f);
    }
}

/// Reverses the children of one node (the UI's "rotate branches"). `index` is the pre-order index.
pub fn rotate_node(t: &Tree, index: usize) -> Tree {
    let mut c = t.clone();
    for_each_mut(&mut c.root, &mut 0, &mut |i, n| {
        if i == index {
            n.children.reverse();
        }
    });
    c
}

// ---------------------------------------------------------------- re-rooting via an undirected graph

#[derive(Debug, Clone)]
struct GEdge {
    to: usize,
    length: Option<f64>,
    support: Option<f64>,
}

#[derive(Debug, Clone, Default)]
struct GNode {
    name: Option<String>,
    label: Option<String>,
    nbrs: Vec<GEdge>,
}

/// Converts to an undirected graph; a rooted-form root (2 children) is dissolved into one edge (lengths summed).
/// Graph ids follow the pre-order numbering, and each node's neighbour list is built in the same order as the TypeScript
/// (a node's own child edges first, then the edge to its parent).
fn to_graph(t: &Tree) -> Vec<GNode> {
    fn add(n: &TreeNode, g: &mut Vec<GNode>) -> usize {
        let id = g.len();
        g.push(GNode {
            name: n.name.clone(),
            label: n.label.clone(),
            nbrs: Vec::new(),
        });
        for c in &n.children {
            let cid = add(c, g);
            g[id].nbrs.push(GEdge {
                to: cid,
                length: c.length,
                support: c.support,
            });
            g[cid].nbrs.push(GEdge {
                to: id,
                length: c.length,
                support: c.support,
            });
        }
        id
    }
    let mut g = Vec::new();
    add(&t.root, &mut g);
    if g[0].nbrs.len() == 2 && g[0].name.is_none() {
        // Dissolve the degree-2 root: connect its two neighbours directly.
        let (e1, e2) = (g[0].nbrs[0].clone(), g[0].nbrs[1].clone());
        let length = if e1.length.is_none() && e2.length.is_none() {
            None
        } else {
            Some(e1.length.unwrap_or(0.0) + e2.length.unwrap_or(0.0))
        };
        let support = e1.support.or(e2.support);
        g[e1.to].nbrs.retain(|x| x.to != 0);
        g[e1.to].nbrs.push(GEdge {
            to: e2.to,
            length,
            support,
        });
        g[e2.to].nbrs.retain(|x| x.to != 0);
        g[e2.to].nbrs.push(GEdge {
            to: e1.to,
            length,
            support,
        });
        g[0].nbrs.clear();
        g[0].label = Some("__dissolved__".to_string());
    }
    g
}

/// Builds a rooted tree from the graph by placing a NEW root on edge (a,b) at `fraction` of the way from a to b.
fn from_graph_on_edge(g: &[GNode], a: usize, b: usize, fraction: f64) -> Result<Tree, BioError> {
    let Some(edge) = g[a].nbrs.iter().find(|x| x.to == b) else {
        return Err(BioError::new(BioErrorCode::InvalidTree, "That branch does not exist."));
    };
    fn build(g: &[GNode], id: usize, from: usize, length: Option<f64>, support: Option<f64>) -> TreeNode {
        let gn = &g[id];
        let children: Vec<TreeNode> = gn
            .nbrs
            .iter()
            .filter(|x| x.to != from)
            .map(|x| build(g, x.to, id, x.length, x.support))
            .collect();
        let mut node = TreeNode {
            children,
            ..TreeNode::default()
        };
        node.name = gn.name.clone();
        if gn.label.as_deref().is_some_and(|l| l != "__dissolved__") {
            node.label = gn.label.clone();
        }
        node.length = length;
        if support.is_some() && !node.children.is_empty() {
            node.support = support;
        }
        node
    }
    let la = edge.length.map(|l| l * fraction);
    let lb = edge.length.map(|l| l * (1.0 - fraction));
    Ok(Tree {
        root: TreeNode::with_children(vec![build(g, a, b, la, edge.support), build(g, b, a, lb, edge.support)]),
    })
}

/// Re-roots on the branch above the node with pre-order index `index`, putting the root at `fraction` (0..1) of the way
/// from the parent to the node (default in the UI: the middle). Unrooted splits and total tree length are preserved.
pub fn reroot_above(t: &Tree, index: usize, fraction: f64) -> Result<Tree, BioError> {
    let nodes = preorder(t);
    let parents = preorder_parents(t);
    let g = to_graph(t);
    if let (2, Some(Some(0))) = (t.root.children.len(), parents.get(index)) {
        // The node hangs directly off a degree-2 root: its edge was merged with the sibling edge, so use the merged edge.
        let sibling = if index == 1 {
            1 + subtree_size(&t.root.children[0])
        } else {
            1
        };
        return from_graph_on_edge(&g, index, sibling, fraction);
    }
    if index == 0 || index >= nodes.len() {
        return Err(BioError::new(
            BioErrorCode::InvalidTree,
            "Choose a branch below the root to re-root on.",
        ));
    }
    let Some(parent) = parents[index] else {
        return Err(BioError::new(BioErrorCode::InvalidTree, "The node has no parent."));
    };
    from_graph_on_edge(&g, parent, index, fraction)
}

/// Number of nodes in a subtree (the node itself included).
fn subtree_size(n: &TreeNode) -> usize {
    1 + n.children.iter().map(subtree_size).sum::<usize>()
}

/// Re-roots on the branch leading to the named leaf (outgroup rooting): the root goes in the middle of that branch.
pub fn reroot_at_leaf(t: &Tree, leaf_name: &str) -> Result<Tree, BioError> {
    let idx = preorder(t)
        .iter()
        .position(|n| n.is_leaf() && n.name.as_deref() == Some(leaf_name));
    match idx {
        Some(i) => reroot_above(t, i, 0.5),
        None => Err(BioError::new(
            BioErrorCode::InvalidTree,
            format!("No leaf named \"{leaf_name}\"."),
        )),
    }
}

/// Leaf names and the path distance between every pair of leaves (undirected, using branch lengths; missing = 0).
#[derive(Debug, Clone, PartialEq)]
pub struct LeafDistances {
    pub names: Vec<String>,
    pub dist: Vec<Vec<f64>>,
}

/// Path distance between every pair of leaves.
pub fn leaf_distances(t: &Tree) -> LeafDistances {
    let g = to_graph(t);
    let leaves: Vec<usize> = g
        .iter()
        .enumerate()
        .filter(|(_, n)| n.name.is_some() && n.nbrs.len() == 1)
        .map(|(id, _)| id)
        .collect();
    let names = leaves
        .iter()
        .map(|&id| g[id].name.clone().unwrap_or_default())
        .collect();
    let dist = leaves
        .iter()
        .map(|&src| {
            let mut d: Vec<Option<f64>> = vec![None; g.len()];
            d[src] = Some(0.0);
            let mut stack = vec![src];
            while let Some(u) = stack.pop() {
                for e in &g[u].nbrs {
                    if d[e.to].is_none() {
                        d[e.to] = Some(d[u].unwrap_or(0.0) + e.length.unwrap_or(0.0));
                        stack.push(e.to);
                    }
                }
            }
            leaves.iter().map(|&l| d[l].unwrap_or(0.0)).collect()
        })
        .collect();
    LeafDistances { names, dist }
}

/// Midpoint rooting: the root goes at the middle of the longest leaf-to-leaf path. Ties between equally long paths are
/// broken by the lexicographically smallest (name A, name B) pair. Assumes non-negative branch lengths.
pub fn midpoint_root(t: &Tree) -> Result<Tree, BioError> {
    assert_valid_leaves(t)?;
    let LeafDistances { names, dist } = leaf_distances(t);
    if names.len() < 2 {
        return Err(BioError::new(
            BioErrorCode::InvalidTree,
            "Midpoint rooting needs at least two leaves.",
        ));
    }
    let ordered = |a: &str, b: &str| -> (String, String) {
        if js_cmp(a, b) == Ordering::Less {
            (a.to_string(), b.to_string())
        } else {
            (b.to_string(), a.to_string())
        }
    };
    let mut best = f64::NEG_INFINITY;
    let mut pair = (0usize, 1usize);
    for i in 0..names.len() {
        for j in (i + 1)..names.len() {
            let d = dist[i][j];
            let key = ordered(&names[i], &names[j]);
            let cur = ordered(&names[pair.0], &names[pair.1]);
            let lexicographically_smaller = js_cmp(&key.0, &cur.0) == Ordering::Less
                || (key.0 == cur.0 && js_cmp(&key.1, &cur.1) == Ordering::Less);
            if d > best + 1e-12 || ((d - best).abs() <= 1e-12 && lexicographically_smaller) {
                best = d;
                pair = (i, j);
            }
        }
    }
    let g = to_graph(t);
    let id_of = |name: &str| {
        g.iter()
            .position(|n| n.name.as_deref() == Some(name))
            .unwrap_or(usize::MAX)
    };
    let (src, dst) = (id_of(&names[pair.0]), id_of(&names[pair.1]));
    // DFS from src recording parents, then walk the path to dst.
    let mut parent: Vec<Option<usize>> = vec![None; g.len()];
    let mut seen = vec![false; g.len()];
    seen[src] = true;
    let mut stack = vec![src];
    while let Some(u) = stack.pop() {
        for e in &g[u].nbrs {
            if !seen[e.to] {
                seen[e.to] = true;
                parent[e.to] = Some(u);
                stack.push(e.to);
            }
        }
    }
    let mut path = vec![dst];
    let mut v = dst;
    while let Some(p) = parent[v] {
        path.push(p);
        v = p;
    }
    path.reverse(); // src ... dst
    let half = best / 2.0;
    let mut cum = 0.0;
    for k in 0..path.len().saturating_sub(1) {
        let (u, v) = (path[k], path[k + 1]);
        let len = g[u]
            .nbrs
            .iter()
            .find(|x| x.to == v)
            .and_then(|x| x.length)
            .unwrap_or(0.0);
        if cum + len >= half - 1e-12 {
            let fraction = if len == 0.0 {
                0.5
            } else {
                ((half - cum) / len).clamp(0.0, 1.0)
            };
            return from_graph_on_edge(&g, u, v, fraction);
        }
        cum += len;
    }
    let (u, v) = (path[path.len() - 2], path[path.len() - 1]);
    from_graph_on_edge(&g, u, v, 1.0)
}

/// Sets node.support from a map of split key -> percent (internal, non-root nodes only). Returns a new tree.
pub fn annotate_support(t: &Tree, percent_by_key: &HashMap<String, f64>) -> Tree {
    let mut c = t.clone();
    let all = leaf_names(&c);
    let clades = clade_sets(&c);
    for_each_mut(&mut c.root, &mut 0, &mut |idx, node| {
        if idx == 0 || node.is_leaf() {
            return;
        }
        node.support = percent_by_key.get(&clade_key(&clades[idx], &all)).copied();
    });
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::newick::{WriteOptions, parse_newick, write_newick};
    use crate::treecompare::robinson_foulds;

    fn nw(s: &str) -> Tree {
        parse_newick(s).expect("valid newick").tree // test code
    }
    fn splits_text(t: &Tree) -> Vec<String> {
        let mut v: Vec<String> = nontrivial_splits(t)
            .expect("valid")
            .splits
            .iter()
            .map(|(_, s)| s.join(","))
            .collect();
        v.sort();
        v
    }

    // Ported from tests/unit/trees-core.test.ts ("tree utilities").
    #[test]
    fn splits_are_non_trivial_unrooted_and_stored_without_the_smallest_leaf() {
        assert_eq!(
            splits_text(&nw("((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);")),
            vec!["C,D,E", "C,D,E,F", "D,E"]
        );
    }

    #[test]
    fn rerooting_anywhere_preserves_splits_edges_and_total_length() {
        let t = nw("((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);");
        let base = edge_length_map(&t).expect("valid");
        for idx in 1..preorder(&t).len() {
            let r = reroot_above(&t, idx, 0.3).expect("reroot");
            assert_eq!(robinson_foulds(&t, &r).expect("same leaves").distance, 0);
            assert!((total_length(&r) - total_length(&t)).abs() < 1e-12);
            let e = edge_length_map(&r).expect("valid");
            for (k, v) in base.iter() {
                assert!((e.get(k).copied().expect("edge present") - v).abs() < 1e-12);
            }
            assert_eq!(r.root.children.len(), 2);
        }
        assert!(reroot_above(&t, 0, 0.5).is_err());
        assert!(reroot_above(&t, 999, 0.5).is_err());
    }

    #[test]
    fn outgroup_rooting_puts_the_root_in_the_middle_of_the_outgroup_branch() {
        let t = nw("((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);");
        let r = reroot_at_leaf(&t, "F").expect("leaf exists");
        assert_eq!(
            r.root
                .children
                .iter()
                .find(|c| c.name.as_deref() == Some("F"))
                .and_then(|c| c.length),
            Some(4.5)
        );
        assert_eq!(
            reroot_at_leaf(&t, "Z").expect_err("no such leaf").message,
            "No leaf named \"Z\"."
        );
    }

    #[test]
    fn midpoint_rooting_hand_built_example() {
        let tr = nw("(A:1,(B:1,C:1):5,D:0.5);");
        let m = midpoint_root(&tr).expect("midpoint");
        let depth = |name: &str| {
            fn walk(n: &TreeNode, acc: f64, name: &str, out: &mut f64) {
                if n.is_leaf() && n.name.as_deref() == Some(name) {
                    *out = acc;
                }
                n.children
                    .iter()
                    .for_each(|c| walk(c, acc + c.length.unwrap_or(0.0), name, out));
            }
            let mut out = -1.0;
            walk(&m.root, 0.0, name, &mut out);
            out
        };
        assert!((depth("A") - depth("B")).abs() < 1e-12);
        assert!((depth("A") + depth("B") - 7.0).abs() < 1e-12);
        assert!((depth("A") - 3.5).abs() < 1e-12);
        assert_eq!(robinson_foulds(&tr, &m).expect("same leaves").distance, 0);
    }

    #[test]
    fn midpoint_rooting_is_deterministic_on_ties_and_independent_of_child_order() {
        let sym = nw("((A:1,B:1):1,(C:1,D:1):1);");
        let one = write_newick(&midpoint_root(&sym).expect("midpoint"), WriteOptions::default());
        assert_eq!(
            write_newick(&midpoint_root(&sym).expect("midpoint"), WriteOptions::default()),
            one
        );
        let other = nw("((C:1,D:1):1,(A:1,B:1):1);");
        assert_eq!(
            robinson_foulds(
                &midpoint_root(&sym).expect("midpoint"),
                &midpoint_root(&other).expect("midpoint")
            )
            .expect("same leaves")
            .distance,
            0
        );
    }

    #[test]
    fn leaf_ordering_is_deterministic_and_independent_of_input_child_order() {
        assert_eq!(
            ordered_leaves(&nw("((B,A),(D,(C,E)),F);")),
            ordered_leaves(&nw("(F,((E,C),D),(A,B));"))
        );
        let l = ladderize(&nw("((B,A),C,D);"));
        let kinds: Vec<String> = l
            .root
            .children
            .iter()
            .map(|c| c.name.clone().unwrap_or_else(|| "clade".to_string()))
            .collect();
        assert_eq!(kinds, vec!["C", "D", "clade"]);
    }

    #[test]
    fn rotate_node_reverses_children_and_leaves_splits_alone() {
        let t = nw("((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);");
        let r = rotate_node(&t, 0);
        let kinds: Vec<String> = r
            .root
            .children
            .iter()
            .map(|c| c.name.clone().unwrap_or_else(|| "(clade)".to_string()))
            .collect();
        assert_eq!(kinds, vec!["F", "(clade)", "(clade)"]);
        assert_eq!(robinson_foulds(&t, &r).expect("same leaves").distance, 0);
    }

    #[test]
    fn annotate_support_attaches_percentages_by_split_whichever_way_the_tree_is_rooted() {
        let t = nw("((A:1,B:2):3,(C:4,(D:5,E:6):7):8,F:9);");
        let splits = nontrivial_splits(&t).expect("valid");
        let percent: HashMap<String, f64> = splits
            .splits
            .keys()
            .enumerate()
            .map(|(i, k)| (k.clone(), 10.0 * (i as f64 + 1.0)))
            .collect();
        let a = annotate_support(&t, &percent);
        let mut vals: Vec<f64> = preorder(&a)
            .iter()
            .filter(|n| !n.is_leaf())
            .filter_map(|n| n.support)
            .collect();
        vals.sort_by(f64::total_cmp);
        assert_eq!(vals, vec![10.0, 20.0, 30.0]);
        let all: Vec<String> = "ABCDEF".chars().map(String::from).collect();
        let strs = |s: &str| s.chars().map(String::from).collect::<Vec<_>>();
        assert_eq!(clade_key(&strs("AB"), &all), clade_key(&strs("CDEF"), &all));
    }

    #[test]
    fn ordered_map_keeps_first_insertion_order_when_a_key_is_set_again() {
        let mut m: OrderedMap<i32> = OrderedMap::default();
        m.set("b".into(), 1);
        m.set("a".into(), 2);
        m.set("b".into(), 3);
        assert_eq!(
            m.iter().map(|(k, v)| (k.clone(), *v)).collect::<Vec<_>>(),
            vec![("b".to_string(), 3), ("a".to_string(), 2)]
        );
        assert_eq!((m.len(), m.contains_key("a"), m.get("zz")), (2, true, None));
    }

    #[test]
    fn invalid_leaves_are_typed_errors() {
        let unnamed = Tree {
            root: TreeNode::with_children(vec![TreeNode::default(), TreeNode::leaf("a")]),
        };
        assert_eq!(
            assert_valid_leaves(&unnamed).expect_err("unnamed leaf").code,
            BioErrorCode::InvalidTree
        );
        let dup = Tree {
            root: TreeNode::with_children(vec![TreeNode::leaf("a"), TreeNode::leaf("a")]),
        };
        assert_eq!(
            assert_valid_leaves(&dup).expect_err("duplicate").code,
            BioErrorCode::DuplicateNames
        );
    }
}
