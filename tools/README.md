# tools/ — reference generators (NOT shipped in the app)

Python scripts that make test fixtures and fetch example data. The app itself never runs Python.

| Script | Output |
| --- | --- |
| `fetch_examples.py` | `examples/<set>/sequences.fasta` + `metadata.json` (source, accession, date, license, SHA-256) |
| `align_examples.py` | `examples/<set>/aligned.fasta` via MAFFT 7.526 (BSD-3, `brew install mafft`; derived data) |
| `gen_distance_refs.py` | `tests/fixtures/reference/distances.json` (Biopython identity distances for the MAFFT-aligned sets) |
| `gen_upgma_scipy_refs.py` | `tests/fixtures/reference/upgma_scipy.json` (SciPy average-linkage = true UPGMA; uses the SYSTEM SciPy, not `.pylibs`) |
| `gen-matrices.mjs` | **Obsolete** since Checkpoint 6: it wrote `src/bio/matrices.data.ts`, which no longer exists (the Rust core embeds `data/matrices/*` directly). Safe to delete. |
| `crosscheck_fresh.py` | FRESH cross-check: random cases driven through the real app UI; compares exports with Biopython/SciPy (see its docstring) |
| `gen_alignment_refs.py` | `tests/fixtures/reference/pairwise.json` (Biopython PairwiseAligner scores/alignments) |
| `bench/measure.py` | Runs the in-window benchmark (`SEQUENCESCOPE_SMOKE_MODE=bench`) for one backend and measures peak memory from outside (stdlib only); see `docs/rust-migration/CHECKPOINT-3-BENCHMARKS.md` |
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


The TypeScript parity generators (`ts-parity/*.test.ts`) and the icon renderer (`make-icons.mjs`, which needed Electron) were removed in Checkpoint 6; they live at the tag `ts-reference-v0.1.0`. See `tests/fixtures/parity/README.md` to regenerate the parity fixtures. Icons: edit `src-tauri/icons/icon.svg`, export a 1024 px PNG, and run `npx tauri icon <png>`.
