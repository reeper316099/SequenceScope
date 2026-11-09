"""Biopython identity-based distance matrices for the MAFFT-aligned example sets (cross-check for src/bio/distance.ts).

DistanceCalculator('identity') = 1 - (identical columns / alignment length) over ALL columns, i.e. gaps count as
differences and ambiguity codes are compared as letters. That equals our p-distance with the policy
'gaps-as-differences' ONLY when the alignment has no ambiguity codes and no gap-vs-gap columns; the fixture records
whether that holds for each set (it is checked in the test).
Run:  python3 -I tools/gen_distance_refs.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / ".pylibs"))

import Bio  # noqa: E402
from Bio import Align  # noqa: E402
from Bio.Phylo.TreeConstruction import DistanceCalculator  # noqa: E402



def main() -> None:
    """Compute the identity distance matrix for each aligned set."""
    out = []
    for name in ("globin_alpha_vertebrates", "mito_cytb_mammals"):
        aln = Align.read(ROOT / "examples" / name / "aligned.fasta", "fasta")
        ids = [r.id for r in aln.sequences]
        dm = DistanceCalculator("identity").get_distance(aln)
        n = len(ids)
        mat = [[float(dm[i, j]) for j in range(n)] for i in range(n)]
        out.append({"set": name, "names": ids, "matrix": mat, "columns": aln.length})
    meta = {"generator": "tools/gen_distance_refs.py", "biopython": Bio.__version__, "model": "DistanceCalculator('identity')"}
    (ROOT / "tests" / "fixtures" / "reference" / "distances.json").write_text(json.dumps({"meta": meta, "sets": out}, indent=1) + "\n")
    print("wrote", [(s["set"], len(s["names"]), s["columns"]) for s in out])


if __name__ == "__main__":
    main()
