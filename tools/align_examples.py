"""Pre-align two example sets with MAFFT (derived data) so Milestone B bootstrap has real aligned input.

MAFFT (BSD-3-Clause) is an external tool used ONLY here; the app never calls it. The aligned file and the exact
command/version are recorded in the set's metadata.json under "aligned".
Run:  python3 -I tools/align_examples.py     (needs `mafft` on PATH, e.g. `brew install mafft`)
"""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETS = ["globin_alpha_vertebrates", "mito_cytb_mammals"]
ARGS = ["--auto", "--quiet"]


def main() -> None:
    """Run MAFFT on each set and record provenance next to the source metadata."""
    ver = subprocess.run(["mafft", "--version"], capture_output=True, text=True).stderr.strip()
    for name in SETS:
        d = ROOT / "examples" / name
        out = subprocess.run(["mafft", *ARGS, str(d / "sequences.fasta")], capture_output=True, text=True, check=True).stdout
        (d / "aligned.fasta").write_text(out, encoding="utf-8")
        meta = json.loads((d / "metadata.json").read_text())
        meta["aligned"] = {"file": "aligned.fasta", "tool": "MAFFT", "version": ver, "command": "mafft " + " ".join(ARGS) + " sequences.fasta",
                           "tool_license": "BSD-3-Clause", "sha256": hashlib.sha256(out.encode()).hexdigest(),
                           "note": "Derived data: alignment produced by MAFFT from the records above; not a database record."}
        (d / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
        rows = [l for l in out.split(">")[1:]]
        lens = {len("".join(r.split("\n")[1:])) for r in rows}
        print(name, "rows", len(rows), "aligned length(s)", lens)


if __name__ == "__main__":
    main()
