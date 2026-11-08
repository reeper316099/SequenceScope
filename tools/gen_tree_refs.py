"""Generate Biopython UPGMA / neighbor-joining reference trees for cross-checking src/bio/{upgma,nj}.ts.

Output: tests/fixtures/reference/trees.json. We compare UNROOTED SPLITS (Robinson-Foulds = 0) and total
tree length, not Newick strings, because Biopython's tie-breaking and rooting differ from ours.
Run:  python3 -I tools/gen_tree_refs.py
"""
import json
import random
import sys
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / ".pylibs"))

import Bio  # noqa: E402
from Bio.Phylo.TreeConstruction import DistanceMatrix, DistanceTreeConstructor  # noqa: E402

SEED = 20260002


def tree_dist(tree_nodes: dict[str, dict[str, float]], names: list[str]) -> list[list[float]]:
    """Exact leaf-to-leaf path-length matrix from an adjacency dict (used to build additive/ultrametric inputs)."""
    def dfs(src: str) -> dict[str, float]:
        d, stack = {src: 0.0}, [src]
        while stack:
            u = stack.pop()
            for v, w in tree_nodes[u].items():
                if v not in d:
                    d[v] = d[u] + w
                    stack.append(v)
        return d
    return [[dfs(a)[b] for b in names] for a in names]


def add_edge(g: dict, a: str, b: str, w: float) -> None:
    """Add an undirected weighted edge."""
    g.setdefault(a, {})[b] = w
    g.setdefault(b, {})[a] = w


def nontrivial_splits(tree, names: list[str]) -> list[list[str]]:
    """Unrooted nontrivial splits, each stored as the side NOT containing names[0], sorted."""
    full, out = set(names), set()
    for cl in tree.get_nonterminals():
        s = {t.name for t in cl.get_terminals()}
        if 2 <= len(s) <= len(names) - 2:
            out.add(frozenset(full - s) if names[0] in s else frozenset(s))
    return sorted(sorted(s) for s in out)


def total_length(tree) -> float:
    """Sum of all branch lengths (None counts as 0)."""
    return sum((c.branch_length or 0.0) for c in tree.find_clades())


def main() -> None:
    """Build >= 6 matrices (hand additive, hand ultrametric, textbook-size, random), run both methods."""
    rng = random.Random(SEED)
    mats = []
    # 1) additive 5-taxon tree: (A:2,B:3) - x - (C:4,(D:1,E:2):2)
    g: dict = {}
    for a, b, w in [("A", "x", 2), ("B", "x", 3), ("x", "y", 3), ("C", "y", 4), ("y", "z", 2), ("D", "z", 1), ("E", "z", 2)]:
        add_edge(g, a, b, w)
    n1 = list("ABCDE"); mats.append(("additive_5", n1, tree_dist(g, n1), "exact additive tree (hand-built)"))
    # 2) ultrametric 5-taxon: heights known
    u = [[0, 4, 8, 8, 8], [4, 0, 8, 8, 8], [8, 8, 0, 6, 6], [8, 8, 6, 0, 2], [8, 8, 6, 2, 0]]
    mats.append(("ultrametric_5", list("ABCDE"), u, "exact ultrametric (clock-like) matrix"))
    # 3) random additive trees (6 and 8 taxa) via sequential attachment
    for tag, n in (("additive_rand_6", 6), ("additive_rand_8", 8)):
        g = {}
        add_edge(g, "t0", "i0", round(rng.uniform(1, 5), 2))
        add_edge(g, "t1", "i0", round(rng.uniform(1, 5), 2))
        add_edge(g, "t2", "i0", round(rng.uniform(1, 5), 2))
        k = 3
        edges_list = [("t0", "i0"), ("t1", "i0"), ("t2", "i0")]
        for k in range(3, n):
            a, b = edges_list.pop(rng.randrange(len(edges_list)))
            w = g[a].pop(b); g[b].pop(a)
            m = f"m{k}"; w1 = round(w * 0.5, 4)
            add_edge(g, a, m, w1); add_edge(g, m, b, w - w1); add_edge(g, f"t{k}", m, round(rng.uniform(1, 5), 2))
            edges_list += [(a, m), (m, b), (m, f"t{k}")]
        nm = [f"t{i}" for i in range(n)]
        mats.append((tag, nm, tree_dist(g, nm), "exact additive random tree (seeded)"))
    # 4) non-tree-like noisy matrices (real methods meet these): 7 and 10 taxa
    for tag, n in (("noisy_7", 7), ("noisy_10", 10)):
        nm = [f"s{i}" for i in range(n)]
        d = [[0.0] * n for _ in range(n)]
        for i, j in combinations(range(n), 2):
            d[i][j] = d[j][i] = round(rng.uniform(0.1, 1.5), 3)
        mats.append((tag, nm, d, "random symmetric matrix, not tree-like"))
    cases = []
    for tag, names, d, note in mats:
        lower = [[float(d[i][j]) for j in range(i + 1)] for i in range(len(names))]
        dm = DistanceMatrix(names, lower)
        con = DistanceTreeConstructor()
        up, nj = con.upgma(dm), con.nj(dm)
        cases.append({
            "id": tag, "note": note, "names": names, "matrix": [[float(x) for x in row] for row in d],
            "upgma": {"newick": up.format("newick").strip(), "splits": nontrivial_splits(up, names), "total_length": total_length(up)},
            "nj": {"newick": nj.format("newick").strip(), "splits": nontrivial_splits(nj, names), "total_length": total_length(nj)},
        })
    meta = {"generator": "tools/gen_tree_refs.py", "biopython": Bio.__version__, "seed": SEED,
            "note": "Biopython rooting/tie-breaking differ; compare unrooted splits (RF) and total length. "
                    "Biopython total_length counts root edges as given; verify per case."}
    dest = ROOT / "tests" / "fixtures" / "reference"
    (dest / "trees.json").write_text(json.dumps({"meta": meta, "cases": cases}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} matrices")
    for c in cases:
        print(c["id"], "UPGMA len", round(c["upgma"]["total_length"], 4), "NJ len", round(c["nj"]["total_length"], 4), "| splits", len(c["upgma"]["splits"]), len(c["nj"]["splits"]))


if __name__ == "__main__":
    main()
