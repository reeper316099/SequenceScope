# Checkpoint 6 plan (cutover): for your approval. Nothing below has been changed yet.

## Where we are
Rust has every algorithm (pairwise, shuffle, distances, UPGMA/NJ, trees, Newick, Robinson-Foulds, bootstrap, MSA, conservation).
Five jobs run through Tauri behind the TS/Rust switch (align, shuffle test, distance matrix, bootstrap, multiple alignment).
The rest are ported and parity-tested but **not wired**, because the UI calls them synchronously.

## What the UI still calls directly (measured)
About **65 call sites in 17 files** in `src/ui/` use `src/bio/` directly:

| Area | Files (calls) | What they do |
|---|---|---|
| Trees | `treesView` (10), `learnTrees` (8), `compareView` (2), `treeStepper` (1) | build UPGMA/NJ, parse/write Newick, re-root, midpoint root, rotate, Robinson-Foulds |
| Learn | `learnMsa` (6), `learnView` (3) | step-by-step demos: DP fill, traceback, tiny MSA, exhaustive optimum |
| Alignment | `alignView` (3), `alignmentView` (2), `detailsPanel` (1) | alignment statistics, match line, cell details, DP rebuild from the binary frame |
| MSA | `msaView` (3), `msaCanvas` (1) | conservation per column while drawing, CSV, FASTA/Newick export |
| Input | `model` (2), `sequenceSet` (2), `examples` (1), `distancesView` (4) | FASTA parse/write on typing, alphabet detection, PHYLIP/CSV export |
| Reference data | `scoringPanel` (2), `aboutView` (1) | list substitution matrices and their values |

Pure drawing code (`treeView.ts` layout, canvases, formatting) is UI, not algorithms, and stays in TypeScript.

## The three decisions I need from you
1. **How far to cut.** (A, recommended) Rust owns every computation; TypeScript keeps only drawing, formatting and small
   tree-data helpers (`isLeaf`, `preorder`, `leafNames`). All 65 call sites become async Rust calls. (B) Remove Electron and the
   five TS job workers only; keep `src/bio` for the quick UI-side helpers. B is much smaller and safer, but two implementations of
   the same algorithms stay in the repo, which is what the migration set out to end.
2. **How to test the UI after Electron is gone.** Playwright cannot drive WKWebView (macOS) or WebKitGTK (Linux), and a plain
   Chromium page has no Rust. Recommended: a **dev-only Rust test bridge**, a small binary that serves the same commands over
   localhost (reusing the plain `run_*` functions already unit-tested), so the existing Playwright specs run in Chromium against
   the real Rust core, headless, on all three CI systems. The real IPC layer stays covered by the in-window smoke and parity runs.
   Alternative: only the in-window harness plus Playwright-over-CDP on Windows. Weaker, and the 9 specs would mostly be lost.
3. **What happens to the TS oracle.** The parity generators (`tools/ts-parity/*`) need `src/bio`. Recommended: you create a
   **signed tag** (for example `ts-reference-v0.1.0`) on the last commit that still has the TypeScript, keep the JSON fixtures
   (about 11.7 MB, frozen golden outputs the Rust tests replay), and delete the generators with a note saying how to regenerate
   from the tag. Alternative: keep a frozen copy of `src/bio` under `tests/oracle/` so the generators still run.

## Phases (each ends with all gates green; deletions come last)
* **6a. Wire the rest (non-destructive).** New async commands for trees/Newick/RF/re-root, conservation, FASTA, matrices, stats,
  learn-view demos (batched so one click is one call). UI call sites switched. TS still present; the switch still works, so the
  parity run can compare every new command against TS first. Rust tests and in-window parity extended. Playwright e2e still green on Electron.
* **6b. Replace the safety net.** Rust test bridge + the 9 e2e specs ported to run against it. The Electron-only checks
  (bridge surface, `require`, traversal, webPreferences) are covered by the Tauri smoke and Rust validation tests; I will list
  each one and where it now lives. Must be green before 6c.
* **6c. Remove (needs your final OK on the list below).** Electron, TS workers, the switch, TS algorithms, TS-only tests.
  The page then needs no Web Workers at all, so the CSP `worker-src` can be dropped.
* **6d. CI, release and docs.** CI: Rust fmt/clippy/test and `test:tauri-ui` on Linux, Windows and macOS (Linux needs the
  WebKitGTK packages); release: `tauri build` per OS, still **unsigned**, same SHA256SUMS step with the new file types
  (`.dmg`, `.msi`/`.exe`, `.AppImage`, `.deb`). Docs: README, CHANGELOG, INTERVIEW.md, ALGORITHMS.md (code pointers move from
  `src/bio/*.ts` to `crates/sequencescope-core/src/*.rs`), CONTRIBUTING. I cannot run the Linux/Windows jobs from this Mac; you
  would see those results when CI runs.

## Proposed deletion list (for option A; not touched until 6c, and you approve it then)
**Electron:** `electron/` (4 files, 316 lines), `electron.vite.config.ts`, `electron-builder.yml`, `playwright.config.ts` (after 6b),
`build/` icons (Tauri has its own in `src-tauri/icons`), `tests/e2e/*` (after 6b), `tests/unit/appPath.test.ts`; in `package.json`:
`electron`, `electron-builder`, `electron-vite`, the `main` field and the scripts `dev`, `build`, `dist`, `pack`, `test:e2e`.
**TS algorithms:** `src/bio/*.ts` except what 6a leaves as UI data helpers (about 2,666 lines now), `src/workers/*` (7 files),
the TS side of `src/backend/` (`TsWorker`, `selectedBackend`, the localStorage switch), `__SEQUENCESCOPE_BACKEND__` and
`SEQUENCESCOPE_BACKEND` in the shell, `src/tauri/parity*.ts` (the in-window TS-vs-Rust comparisons have nothing left to compare).
**TS-only tests:** the algorithm unit and property tests in `tests/unit` and `tests/property` (21 files, about 2,460 lines).
Before deleting each I will check a Rust test covers the same case (138 unit tests in the core crate carry "ported from"
notes) and list any gap first. UI-only tests (`ui-pure`, `ui-trees-pure`, `io-and-cells`, `rust-worker`) stay.
**Kept:** all fixtures in `tests/fixtures/` (parity and Biopython/SciPy references), `tools/*.py` reference generators,
`tests/tauri-ui`, `examples/`, `crates/`, `src-tauri/`.

## Risks
* The Learn view and MSA canvas are the largest UI rewrites; they are synchronous today and re-render often.
* Linux and Windows builds and CI cannot be exercised from this Mac.
* The release changes the shipped runtime (Electron/Chromium to the system web view): rendering can differ slightly per OS.
* Version number: this is a runtime swap with identical behaviour; I suggest `0.2.0` but will not bump anything without your word.
