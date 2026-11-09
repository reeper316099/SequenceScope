"""FRESH cross-check of the built app against Biopython (and SciPy for true UPGMA) on newly generated random cases.

Unlike the stored fixtures, the cases are generated at run time from a seed that is recorded in the output, the app is driven
through its real UI (tests/e2e/crosscheck.spec.ts), and its EXPORTED files are what gets compared.

Steps (see tools/README.md):
  python3 -I tools/crosscheck_fresh.py prepare DIR          # writes DIR/cases.json, DIR/trees/*.fasta, DIR/matrices.json
  CROSSCHECK_DIR=DIR npx playwright test tests/e2e/crosscheck.spec.ts   # app exports -> DIR/results.json, DIR/trees/*.nwk
  python3 -I tools/crosscheck_fresh.py compare DIR          # Biopython comparison (alignments + NJ)   -> DIR/report-bio.json
  python3 -I tools/crosscheck_fresh.py compare-scipy DIR    # SciPy UPGMA comparison (system numpy)   -> DIR/report-scipy.json
"""
import json
import random
import re
import sys
import time
from itertools import combinations
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
if MODE in ("prepare", "compare"):
    sys.path.insert(0, str(HERE / ".pylibs"))  # Biopython (numpy 2.x) lives here; the scipy mode must NOT see it

DNA, PROT = "ACGT", "ACDEFGHIKLMNPQRSTVWY"


def mutate(rng: random.Random, s: str, alpha: str, rate: float) -> str:
    """Related sequence: substitutions plus short indels."""
    out = []
    for ch in s:
        r = rng.random()
        if r < rate * 0.6:
            out.append(rng.choice(alpha))
        elif r < rate * 0.8:
            continue
        elif r < rate:
            out += [ch] + [rng.choice(alpha) for _ in range(rng.randint(1, 3))]
        else:
            out.append(ch)
    return "".join(out) or alpha[0]


def has_ties(mat) -> bool:
    """True if UPGMA (size-weighted average) or neighbor-joining meets a TIE for the minimum at ANY step (tool-dependent tie-breaking)."""
    n = len(mat)
    # UPGMA
    d = {(i, j): mat[i][j] for i in range(n) for j in range(i + 1, n)}
    size = {i: 1 for i in range(n)}
    active, nxt = list(range(n)), n
    def key(a, b): return (a, b) if a < b else (b, a)
    while len(active) > 1:
        vals = sorted((d[key(a, b)], a, b) for i, a in enumerate(active) for b in active[i + 1:])
        if len(vals) > 1 and abs(vals[0][0] - vals[1][0]) < 1e-12:
            return True
        _, a, b = vals[0]
        for k in active:
            if k not in (a, b):
                d[key(nxt, k)] = (size[a] * d[key(a, k)] + size[b] * d[key(b, k)]) / (size[a] + size[b])
        size[nxt] = size[a] + size[b]
        active = [k for k in active if k not in (a, b)] + [nxt]
        nxt += 1
    # NJ
    dm = {(i, j): mat[i][j] for i in range(n) for j in range(i + 1, n)}
    active, nxt = list(range(n)), n
    while len(active) > 3:
        m = len(active)
        r = {a: sum(dm[key(a, b)] for b in active if b != a) for a in active}
        qs = sorted(((m - 2) * dm[key(a, b)] - r[a] - r[b], a, b) for i, a in enumerate(active) for b in active[i + 1:])
        if abs(qs[0][0] - qs[1][0]) < 1e-12:
            # With 4 nodes left Q(a,b) = Q(c,d) always (complementary pairs give the same tree), so only other ties matter.
            if not (m == 4 and not ({qs[0][1], qs[0][2]} & {qs[1][1], qs[1][2]})) or (len(qs) > 2 and abs(qs[0][0] - qs[2][0]) < 1e-12):
                return True
        _, a, b = qs[0]
        for k in active:
            if k not in (a, b):
                dm[key(nxt, k)] = (dm[key(a, k)] + dm[key(b, k)] - dm[key(a, b)]) / 2
        active = [k for k in active if k not in (a, b)] + [nxt]
        nxt += 1
    return False


def prepare(d: Path) -> None:
    """Write fresh alignment cases and gap-free aligned sets (evolved along random trees)."""
    seed = int(time.time())
    rng = random.Random(seed)
    d.mkdir(parents=True, exist_ok=True)
    (d / "trees").mkdir(exist_ok=True)
    specs = [
        ("dna", "global", {"kind": "simple", "match": 2, "mismatch": -3}, {"kind": "linear", "gap": 4}),
        ("dna", "global", {"kind": "simple", "match": 1, "mismatch": -2}, {"kind": "affine", "open": 6, "extend": 2}),
        ("dna", "local", {"kind": "simple", "match": 3, "mismatch": -2}, {"kind": "affine", "open": 5, "extend": 1}),
        ("protein", "global", {"kind": "matrix", "name": "BLOSUM62"}, {"kind": "affine", "open": 11, "extend": 1}),
        ("protein", "local", {"kind": "matrix", "name": "BLOSUM45"}, {"kind": "linear", "gap": 7}),
        ("protein", "global", {"kind": "matrix", "name": "BLOSUM80"}, {"kind": "affine", "open": 9, "extend": 2}),
    ]
    cases = []
    for k, (alpha, mode, sub, gaps) in enumerate(specs):
        letters = DNA if alpha == "dna" else PROT
        n = rng.randint(40, 120)
        a = "".join(rng.choice(letters) for _ in range(n))
        b = mutate(rng, a, letters, 0.3) if k % 3 != 2 else "".join(rng.choice(letters) for _ in range(rng.randint(30, 100)))
        cases.append({"id": f"aln{k}", "alphabet": alpha, "mode": mode, "substitution": sub, "gaps": gaps, "a": a, "b": b})
    (d / "cases.json").write_text(json.dumps({"seed": seed, "cases": cases}, indent=1))
    mats = []
    for t, n in enumerate((6, 8, 10)):  # gap-free aligned sets evolved along a random tree; retry until no tie can occur at any step
        length = 3000
        for attempt in range(5000):  # bounded: never loop forever
            root = "".join(rng.choice(DNA) for _ in range(length))
            seqs = [root]
            names = ["t0"]
            for i in range(1, n):
                parent = rng.choice(seqs)
                rate = rng.choice([0.03, 0.06, 0.12])
                child = "".join(rng.choice(DNA) if rng.random() < rate else c for c in parent)
                seqs.append(child); names.append(f"t{i}")
            mat = [[sum(x != y for x, y in zip(a_, b_)) / length for b_ in seqs] for a_ in seqs]
            vals = [mat[i][j] for i in range(n) for j in range(i + 1, n)]
            if len(set(vals)) == len(vals) and not has_ties(mat):  # no ties at any step: tie-breaking rules cannot differ between tools
                break
        else:
            raise SystemExit(f"could not generate a tie-free set with {n} taxa in 5000 attempts")
        (d / "trees" / f"set{t}.fasta").write_text("".join(f">{nm}\n{s}\n" for nm, s in zip(names, seqs)))
        mats.append({"id": f"set{t}", "names": names, "matrix": mat})
    (d / "matrices.json").write_text(json.dumps(mats))
    print(f"prepared seed {seed}: {len(cases)} alignment cases, {len(mats)} tree sets in {d}")


# ---------------------------------------------------------------- tiny Newick helpers (names here contain no special characters)
def parse_newick(text: str):
    """Returns (nested children structure, branch lengths): node = {'name', 'len', 'kids'}."""
    s = text.strip().rstrip(";")
    pos = 0

    def node():
        nonlocal pos
        kids = []
        if s[pos] == "(":
            pos += 1
            kids.append(node())
            while s[pos] == ",":
                pos += 1
                kids.append(node())
            assert s[pos] == ")"
            pos += 1
        m = re.compile(r"[^,():;]*").match(s, pos)
        label = m.group(0)
        pos = m.end()
        length = None
        if pos < len(s) and s[pos] == ":":
            m2 = re.compile(r":(-?[0-9.eE+-]+)").match(s, pos)
            length = float(m2.group(1))
            pos = m2.end()
        return {"name": label if not kids else "", "len": length, "kids": kids}

    return node()


def leaves(n):
    return [n["name"]] if not n["kids"] else [x for k in n["kids"] for x in leaves(k)]


def nontrivial_splits(root, all_names):
    ref = sorted(all_names)[0]
    out = set()
    def walk(n, is_root):
        ls = leaves(n)
        if not is_root and 2 <= len(ls) <= len(all_names) - 2:
            side = frozenset(set(all_names) - set(ls)) if ref in ls else frozenset(ls)
            out.add(side)
        for k in n["kids"]:
            walk(k, False)
    walk(root, True)
    return out


def total_length(n):
    return sum((k["len"] or 0) for k in n["kids"]) + sum(total_length(k) for k in n["kids"])


def rooted_clades(root):
    out = set()
    def walk(n):
        if n["kids"]:
            out.add(frozenset(leaves(n)))
        for k in n["kids"]:
            walk(k)
    walk(root)
    return out


# ---------------------------------------------------------------- comparisons
def compare(d: Path) -> None:
    """Biopython: fresh PairwiseAligner scores for the app's alignments, and Biopython's NJ for the app's NJ trees."""
    import Bio
    from Bio import Align
    from Bio.Align import substitution_matrices
    from Bio.Phylo.TreeConstruction import DistanceMatrix, DistanceTreeConstructor

    cases = json.loads((d / "cases.json").read_text())
    res = json.loads((d / "results.json").read_text())
    rep = {"biopython": Bio.__version__, "seed": cases["seed"], "alignments": [], "nj": []}
    max_diff = 0.0
    for c in cases["cases"]:
        r = next(x for x in res["alignments"] if x["id"] == c["id"])
        al = Align.PairwiseAligner()
        al.mode = c["mode"]
        sub, g = c["substitution"], c["gaps"]
        if sub["kind"] == "simple":
            al.match_score, al.mismatch_score = sub["match"], sub["mismatch"]
        else:
            al.substitution_matrix = substitution_matrices.load(sub["name"])
        if g["kind"] == "linear":
            al.open_gap_score = al.extend_gap_score = -g["gap"]
        else:
            al.open_gap_score, al.extend_gap_score = -g["open"], -g["extend"]
        bio = al.score(c["a"], c["b"])
        valid = r["rowA"].replace("-", "") in c["a"] and r["rowB"].replace("-", "") in c["b"] if c["mode"] == "local" else (r["rowA"].replace("-", "") == c["a"] and r["rowB"].replace("-", "") == c["b"])
        diff = abs(bio - r["score"])
        max_diff = max(max_diff, diff)
        rep["alignments"].append({"id": c["id"], "mode": c["mode"], "alphabet": c["alphabet"], "app_score": r["score"], "biopython_score": bio, "abs_diff": diff, "alignment_valid": valid})
    rep["max_score_difference"] = max_diff
    mats = json.loads((d / "matrices.json").read_text())
    for m in mats:
        names, mat = m["names"], m["matrix"]
        dm = DistanceMatrix(names, [[mat[i][j] for j in range(i + 1)] for i in range(len(names))])
        theirs = DistanceTreeConstructor().nj(dm).format("newick")
        mine = (d / "trees" / f"{m['id']}.nj.nwk").read_text()
        a, b = parse_newick(mine), parse_newick(theirs)
        sa, sb = nontrivial_splits(a, names), nontrivial_splits(b, names)
        rf = len(sa ^ sb)
        rep["nj"].append({"id": m["id"], "taxa": len(names), "rf": rf, "app_total_length": total_length(a), "biopython_total_length": total_length(b), "abs_length_diff": abs(total_length(a) - total_length(b))})
    (d / "report-bio.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep, indent=1))


def compare_scipy(d: Path) -> None:
    """SciPy (true UPGMA = average linkage): rooted clades and total length of the app's UPGMA trees."""
    import numpy as np
    import scipy
    from scipy.cluster.hierarchy import linkage
    from scipy.spatial.distance import squareform

    rep = {"scipy": scipy.__version__, "upgma": []}
    for m in json.loads((d / "matrices.json").read_text()):
        names, mat = m["names"], np.array(m["matrix"])
        z = linkage(squareform(mat, checks=False), method="average")
        n = len(names)
        members = {i: [names[i]] for i in range(n)}
        height = {i: 0.0 for i in range(n)}
        total, clades = 0.0, set()
        for k, (a, b, dist, _) in enumerate(z):
            a, b, nid = int(a), int(b), n + k
            h = dist / 2
            total += (h - height[a]) + (h - height[b])
            members[nid] = members[a] + members[b]; height[nid] = h
            clades.add(frozenset(members[nid]))
        mine = parse_newick((d / "trees" / f"{m['id']}.upgma.nwk").read_text())
        rep["upgma"].append({"id": m["id"], "taxa": n, "same_rooted_clades": rooted_clades(mine) == clades, "abs_length_diff": abs(total_length(mine) - total)})
    (d / "report-scipy.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
    {"prepare": prepare, "compare": compare, "compare-scipy": compare_scipy}[MODE](target)
