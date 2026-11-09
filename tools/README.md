# tools/ — reference generators (NOT shipped in the app)

Python scripts that make test fixtures and fetch example data. The app itself never runs Python.

| Script | Output |
| --- | --- |
| `fetch_examples.py` | `examples/<set>/sequences.fasta` + `metadata.json` (source, accession, date, license, SHA-256) |
| `align_examples.py` | `examples/<set>/aligned.fasta` via MAFFT 7.526 (BSD-3, `brew install mafft`; derived data) |
| `gen_distance_refs.py` | `tests/fixtures/reference/distances.json` (Biopython identity distances for the MAFFT-aligned sets) |
| `gen_upgma_scipy_refs.py` | `tests/fixtures/reference/upgma_scipy.json` (SciPy average-linkage = true UPGMA; uses the SYSTEM SciPy, not `.pylibs`) |
| `gen-matrices.mjs` | `src/bio/matrices.data.ts` from `data/matrices/*` (node, no Python) |
| `crosscheck_fresh.py` | FRESH cross-check: random cases driven through the real app UI; compares exports with Biopython/SciPy (see its docstring) |
| `gen_alignment_refs.py` | `tests/fixtures/reference/pairwise.json` (Biopython PairwiseAligner scores/alignments) |
| `gen_tree_refs.py` | `tests/fixtures/reference/trees.json` (Biopython UPGMA / NJ trees) |

## Setup (no virtualenv)
```bash
python3 -m pip install --target tools/.pylibs --only-binary=:all: -r tools/requirements.txt
python3 -I tools/gen_alignment_refs.py
```
`tools/.pylibs/` is git-ignored. Biopython is pinned to 1.86 because 1.87/1.88 had no prebuilt wheel for
macOS arm64 / Python 3.11 when this was set up (verified 2026-11-08).

## Local-only dev artifacts (delete when no longer needed)
- `tools/.pylibs/` — pip `--target` install of Biopython + numpy. Delete with `rm -rf tools/.pylibs` once fixtures are final.
- Scratch Electron/tooling spike lived in the session scratchpad (outside this repo); nothing to clean in the repo.
