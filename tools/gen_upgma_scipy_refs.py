"""Independent UPGMA reference from SciPy (average linkage = true size-weighted UPGMA).

WHY: Biopython's DistanceTreeConstructor.upgma() averages the two old distances WITHOUT cluster-size weights
(`(dm[min_i,k] + dm[min_j,k]) / 2` in its source), which is WPGMA, not UPGMA. We therefore also cross-check our UPGMA
against scipy.cluster.hierarchy.linkage(method='average'), which weights by cluster size.

Uses the SYSTEM SciPy (no extra install; version recorded in the output). Reads matrices from trees.json.
Run:  python3 -I tools/gen_upgma_scipy_refs.py      (do NOT put tools/.pylibs on the path: it holds numpy 2.x)
"""
import json
from pathlib import Path

import numpy as np
import scipy
from scipy.cluster.hierarchy import linkage
from scipy.spatial.distance import squareform

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "tests" / "fixtures" / "reference"


def main() -> None:
    """For each stored matrix, record the rooted clades, root height, and total length of the SciPy average-linkage tree."""
    cases = json.loads((REF / "trees.json").read_text())["cases"]
    out = []
    for c in cases:
        names, d = c["names"], np.array(c["matrix"], dtype=float)
        n = len(names)
        z = linkage(squareform(d, checks=False), method="average")
        members = {i: [names[i]] for i in range(n)}
        height = {i: 0.0 for i in range(n)}
        total = 0.0
        clades = []
        for k, (a, b, dist, _size) in enumerate(z):
            a, b, nid = int(a), int(b), n + k
            h = dist / 2.0
            total += (h - height[a]) + (h - height[b])
            members[nid] = members[a] + members[b]
            height[nid] = h
            clades.append(sorted(members[nid]))
        out.append({"id": c["id"], "clades": sorted(clades), "root_height": height[n + len(z) - 1], "total_length": total})
    meta = {"generator": "tools/gen_upgma_scipy_refs.py", "scipy": scipy.__version__, "numpy": np.__version__,
            "method": "scipy.cluster.hierarchy.linkage(method='average') = size-weighted UPGMA; height = distance/2"}
    (REF / "upgma_scipy.json").write_text(json.dumps({"meta": meta, "cases": out}, indent=1) + "\n")
    print(f"wrote {len(out)} cases with scipy {scipy.__version__}")


if __name__ == "__main__":
    main()
