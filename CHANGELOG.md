# Changelog

## Unreleased — Rust core and Tauri shell (no change in behaviour)

The app now runs on **Tauri** with a **Rust** core instead of Electron with TypeScript. Results are the same: the Rust code is checked
against the old TypeScript outputs with exact comparisons (scores, tables, trees, floating-point numbers bit for bit; values computed with
a logarithm within 2 units in the last place). The version number is unchanged until a release is decided.

- All calculations (alignment, shuffle test, distances, UPGMA/NJ, Newick, tree edits and comparison, bootstrap, progressive alignment,
  conservation, FASTA, exhaustive search) run in Rust. The page keeps only drawing and formatting.
- A stricter security model (15 permissioned commands, no Web Workers, no Node in the page),
  and faster results (for example a 50 × 3000 bootstrap went from 2.35 s to 0.18 s; the exhaustive search in the Learn view from 2 s to 0.5 s).
- The application menu (File, Edit, View, Help, with the same shortcuts) is rebuilt natively. Not carried over: the Electron "Reload",
  "Zoom" and "Fullscreen" menu items.
- The About page shows "Runtime / web view" instead of "Electron / Chromium".
- Installers are built by `tauri build`: `.msi` and `-setup.exe` (Windows), `.dmg` (macOS, the build machine's CPU), `.AppImage` and `.deb`
  (Linux). Still unsigned. Windows and Linux installers have not been run by the author.
- Removed: Electron, the TypeScript algorithms and their tests (kept at the signed tag `ts-reference-v0.1.0`; their outputs live on as
  test fixtures), the portable Windows build, the universal macOS build.
- Details of each step: `docs/rust-migration/`.

## v0.1.0 — first release

SequenceScope is a desktop teaching lab for comparing biological sequences and building evolutionary trees. Everything is
written from scratch in this repository and verified against brute force, mathematical properties, textbook examples, and
Biopython/SciPy. It runs fully offline.

### What's new
- **Pairwise alignment lab.** Global (Needleman–Wunsch) and local (Smith–Waterman) alignment with linear or affine gaps and editable scoring (match/mismatch or BLOSUM45/62/80). Watch the score matrix fill cell by cell and the traceback find the alignment; click any cell to see how its value was computed. Statistics (identity with its denominator, similarity, gaps), co-optimal alignments, and a seeded shuffle test with a histogram, z-score, and empirical p-value.
- **Distances and trees.** p-distance, Jukes–Cantor, and Poisson corrections with an explicit gap policy; saturated pairs are flagged, never NaN. UPGMA and neighbor-joining with a step-through that shows every merge, matrix, and formula with the real numbers. A tree viewer (rectangular phylogram/cladogram and radial) with collapse, rotate, re-root, midpoint root, highlight, search, zoom, keyboard navigation, and a text outline. Newick import/export, SVG/PNG export, Robinson–Foulds tree comparison, and column-bootstrap support for aligned input.
- **Multiple alignment.** Progressive alignment with a guide tree, a fast alignment viewer with conservation bars and a consensus row, column selection, exports (FASTA, CLUSTAL-style text, conservation CSV, PNG), and one-click trees with bootstrap from the app's own alignment.
- **Learn view.** Plain-English explanations with the current numbers plugged in: the recurrences in MathML, an editable worked example, an interactive correction/saturation plot, a live example where UPGMA's clock assumption misleads, and how progressive alignment works and where it fails.
- **Honest by design.** Every raw score, identity, bootstrap value, and tree comes with a note on what it does and does not mean. All randomness is seeded and the seed is shown and saved.
- **Projects and exports.** Save/open project files (validated, version-checked), undo/redo, dark mode, native file dialogs.
- **Secure shell.** Sandboxed renderer, strict content-security-policy, no network access, allowlisted external links, size- and type-checked file opening.

### Known limits
- Installers are **unsigned** (SmartScreen and Gatekeeper will warn; see docs/RELEASING.md).
- Educational tool: not a replacement for BLAST, MAFFT, Clustal Omega, MUSCLE, or maximum-likelihood/Bayesian phylogenetics software.
- Pairwise alignments up to 5,000 × 5,000 residues; trees and alignments up to 100 and 50 sequences respectively.
