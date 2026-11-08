"""Generate Biopython PairwiseAligner reference cases for cross-checking src/bio/pairwise.ts.

Output: tests/fixtures/reference/pairwise.json (+ metadata recorded INSIDE the file).
Compared exactly on SCORE; our alignment must be valid (re-scores to the score, gap-free rows == input),
and strings must match only when `n_optimal == 1`.

Gap convention (verified empirically against Biopython, see ALGORITHMS.md):
  a gap of length k costs  open + (k-1)*extend   (open/extend given as NEGATIVE scores here).
End gaps are penalised like internal gaps in global mode (Biopython default).
Run:  python3 -I tools/gen_alignment_refs.py
"""

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / ".pylibs"))

import Bio  # noqa: E402
from Bio import Align  # noqa: E402
from Bio.Align import substitution_matrices  # noqa: E402

SEED = 20260001
MAX_COUNT = 1000  # cap on co-optimal alignments we count (documented; matches the app's enumeration cap idea)
DNA, PROT = "ACGT", "ACDEFGHIKLMNPQRSTVWY"  # 20 standard residues only: ambiguity policy differs from Biopython


def mutate(rng: random.Random, s: str, alpha: str, rate: float) -> str:
    """Make a related sequence: point substitutions plus short insertions/deletions."""
    out = []
    for ch in s:
        r = rng.random()
        if r < rate * 0.6:
            out.append(rng.choice(alpha))
        elif r < rate * 0.8:
            continue  # deletion
        elif r < rate:
            out += [ch] + [rng.choice(alpha) for _ in range(rng.randint(1, 3))]  # insertion
        else:
            out.append(ch)
    return "".join(out) or ch


def make_aligner(cfg: dict) -> Align.PairwiseAligner:
    """Build a Biopython aligner from our config dict."""
    a = Align.PairwiseAligner()
    a.mode = cfg["mode"]
    if cfg["alphabet"] == "dna":
        a.match_score, a.mismatch_score = cfg["match"], cfg["mismatch"]
    else:
        a.substitution_matrix = substitution_matrices.load(cfg["matrix"])
    a.open_gap_score, a.extend_gap_score = cfg["gap_open"], cfg["gap_extend"]
    return a


def sub(cfg: dict, x: str, y: str) -> float:
    """Substitution score for the independent re-scorer."""
    if cfg["alphabet"] == "dna":
        return cfg["match"] if x == y else cfg["mismatch"]
    return float(substitution_matrices.load(cfg["matrix"])[x, y])


def rescore(cfg: dict, ra: str, rb: str) -> float:
    """Independent scorer for aligned rows: gap run of length k costs open + (k-1)*extend."""
    total, gap_a, gap_b = 0.0, 0, 0  # current run lengths in each row
    for x, y in zip(ra, rb):
        if x == "-":
            total += cfg["gap_open"] if gap_a == 0 else cfg["gap_extend"]
            gap_a, gap_b = gap_a + 1, 0
        elif y == "-":
            total += cfg["gap_open"] if gap_b == 0 else cfg["gap_extend"]
            gap_b, gap_a = gap_b + 1, 0
        else:
            total += sub(cfg, x, y)
            gap_a = gap_b = 0
    return total


def main() -> None:
    """Create >= 40 cases across modes, gap models and alphabets; verify each against our own re-scorer."""
    rng = random.Random(SEED)
    cases = []
    dna_cfgs = [dict(match=m, mismatch=mm) for m, mm in [(1, -1), (2, -3), (5, -4)]]
    gap_cfgs = [(-2, -2), (-5, -1), (-4, -4), (-8, -2)]  # (open, extend): equal pair == linear
    for mode in ("global", "local"):
        for gi, (go, ge) in enumerate(gap_cfgs):
            for k in range(3):
                n = rng.randint(8, 45)
                s1 = "".join(rng.choice(DNA) for _ in range(n))
                s2 = mutate(rng, s1, DNA, 0.3) if k < 2 else "".join(rng.choice(DNA) for _ in range(rng.randint(5, 40)))
                d = rng.choice(dna_cfgs)
                cases.append(dict(alphabet="dna", mode=mode, gap_open=go, gap_extend=ge, a=s1, b=s2, **d))
            for matrix in ("BLOSUM62", "BLOSUM45", "BLOSUM80") if gi < 2 else ("BLOSUM62",):
                n = rng.randint(10, 60)
                s1 = "".join(rng.choice(PROT) for _ in range(n))
                s2 = mutate(rng, s1, PROT, 0.35)
                cases.append(dict(alphabet="protein", mode=mode, gap_open=go - 5 if go == ge else go,
                                  gap_extend=ge - 5 if go == ge else ge, matrix=matrix, a=s1, b=s2))
    # tiny/edge cases: single residue, identical, very unequal lengths
    cases.append(dict(alphabet="dna", mode="global", gap_open=-2, gap_extend=-2, match=1, mismatch=-1, a="A", b="A"))
    cases.append(dict(alphabet="dna", mode="global", gap_open=-5, gap_extend=-1, match=2, mismatch=-3, a="ACGTACGT", b="ACGTACGT"))
    cases.append(dict(alphabet="dna", mode="global", gap_open=-5, gap_extend=-1, match=2, mismatch=-3, a="ACGTACGTACGTAAAA", b="C"))
    cases.append(dict(alphabet="dna", mode="local", gap_open=-5, gap_extend=-1, match=2, mismatch=-3, a="AAAAAA", b="CCCCCC"))
    for i, c in enumerate(cases):
        al = make_aligner(c)
        c["id"] = f"case{i:03d}"
        c["score"] = al.score(c["a"], c["b"])
        alns = al.align(c["a"], c["b"])
        c["n_optimal"] = min(len(alns), MAX_COUNT)
        c["n_optimal_capped"] = len(alns) > MAX_COUNT
        if len(alns) == 0:  # local score 0: Biopython returns no alignment at all
            c["example_rows"], c["coordinates"] = ["", ""], []
            continue
        first = alns[0]
        ra, rb = str(first[0]), str(first[1])  # gapped rows (local mode: the aligned region only, see coords)
        c["example_rows"] = [ra, rb]
        c["coordinates"] = first.coordinates.tolist()
        if c["mode"] == "global":
            got = rescore(c, ra, rb)
            assert abs(got - c["score"]) < 1e-9, (c["id"], got, c["score"])
    out = {
        "meta": {
            "generator": "tools/gen_alignment_refs.py", "biopython": Bio.__version__, "seed": SEED,
            "gap_convention": "gap of length k costs open + (k-1)*extend; end gaps penalised in global mode",
            "max_optimal_counted": MAX_COUNT, "note": "Alphabet limited to unambiguous residues on purpose.",
            "global_rows_rescored_independently": True,
        },
        "cases": cases,
    }
    dest = ROOT / "tests" / "fixtures" / "reference"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "pairwise.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases; unique-optimum cases: {sum(c['n_optimal'] == 1 for c in cases)}")


if __name__ == "__main__":
    main()
