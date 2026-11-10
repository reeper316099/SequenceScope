# Checkpoint 6, phase 6a: every calculation behind one async door (nothing deleted yet)

Decisions you approved: (A) Rust owns every computation, (B) a Rust-backed test bridge for UI tests (phase 6b), (C) a signed tag plus
frozen fixtures for the TypeScript oracle. This phase is non-destructive: the TypeScript code is still there and still the default,
so the Electron app and its 34 end-to-end tests are unchanged in behaviour.

## What changed

* **Before:** about 65 places in 17 UI files called the algorithms directly and synchronously.
* **Now:** none do. The UI imports `src/backend/api.ts`, whose async functions run the TypeScript implementation (Electron, plain
  browser) or Rust (Tauri with the Rust backend). What is left in `src/ui` from `src/bio`: the `BioError` class, five tiny tree-data
  accessors used for drawing (`isLeaf`, `preorder`, `leafNames`, `totalLength`, `hasNegativeBranches`), and type-only imports.
* **One new Tauri command, `bio_op`,** with ONE permission (`allow-bio-op`). The request is a tagged enum: an unknown operation or a
  wrong field type is refused (`invalid-argument`). 19 operations: reference data (limits, matrices, models), FASTA parse/write,
  alphabet detection, alignment pre-check, DP-cell explanation, UPGMA/NJ with every step, Newick parse/write, tree edits (rotate,
  re-root, outgroup, midpoint), tree comparison with red-branch indexes, leaf distances, correction curves, distance exports,
  conservation (+CSV), sum of pairs, exhaustive optimum. Limits are listed in `src-tauri/PERMISSIONS.md`.
* **The align job now also returns** the statistics and the match line of every co-optimal alignment (ported:
  `alignstats.rs`), so the UI no longer needs a compiled scoring object. DP-cell explanations are computed from the table entries the
  page already holds, so Rust keeps no state and no extra memory between calls.
* **Trees travel as flat lists** (pre-order with parent indexes) from the page to Rust, because the JSON reader refuses nesting deeper than
  128 levels and a 100-taxon ladder tree is about 200 deep. Results come back nested, like the TypeScript objects.
* **UI conversions** used a "latest answer wins" guard wherever a keystroke or click can start a second request before the first
  returns (set analysis, tree rebuild, comparison, details panel, stepper legend, Learn examples).

## A real bug found by the parity run

The Rust shell read decimals from the page without `serde_json`'s `float_roundtrip` feature, so `1.3333333333333335` arrived as
`...337` (one unit in the last place off). It only shows with decimals that are not exactly representable (real distances and branch
lengths), which is why earlier checks with round numbers passed. Fixed in `src-tauri/Cargo.toml`, with a regression test that fails
without the feature (verified by removing it).

## Deliberate differences (Rust is stricter; the UI never triggers them)

* `fastaWrite` refuses a line width that is not a whole number from 1 to 10,000,000 (the TypeScript sliced by a fraction).
* `sum_of_pairs_score` refuses rows of unequal length with a typed error (the TypeScript threw a bare `RangeError`).

## Proof (all run)

| Check | Result |
|---|---|
| TypeScript fixtures replayed in Rust (`align-ui-ts.json`): 160 alignments' statistics, 1,145 match lines, 4,081 explained DP cells (border, linear, affine), 19 pre-check cases | 0 mismatches |
| Mutation check: `:` for score 0 and the local-zero floor changed | 54 mismatches (restored, 0) |
| In-window parity (TypeScript in JavaScriptCore vs Rust, through the same facade the UI uses) | **52 of 52** |
| ...of which this phase: reference data (3 matrices, 1,728 scores), 224 FASTA parses, 224 FASTA writes, 99 alphabet detections, 10 alignments, 3,170 DP-cell explanations, 14 pre-checks, 20 tree builds, 42 Newick parses (17 broken, exact messages), 135 Newick writes, 348 tree edits, 57 tree comparisons, 18 leaf-distance tables, 2 correction curves (401 points each), 38 distance exports, 24 conservation runs, 8 CSVs, 11 sum-of-pairs/exhaustive runs | all identical |
| Basic smoke (3 new `bio_op` checks: unknown op refused, wrong fields refused, valid op answers) | 22 of 22, twice |
| Electron e2e (the TypeScript branch of all the new async code) | 34 passed, 3 skipped (as before) |
| `cargo test --workspace` | 271 passed (debug) |
| TypeScript unit tests | 381 passed; typecheck, lint, clippy `-D warnings`, `cargo fmt --check` clean |
| `npm run test:tauri-ui` | 3 of 3 |

Float rule used: everything exact, except results of a logarithm (`jc`/`poisson` curves, conservation entropy), allowed up to 2 ulps
because JavaScriptCore's own log differs from V8's by up to 1 ulp and Rust reproduces V8's (see CHECKPOINT-4.md, CHECKPOINT-5.md).

## Not done / unknown

* Phases 6b (Rust test bridge and the 9 end-to-end specs), 6c (removal, needs your approval of the list in CHECKPOINT-6-PLAN.md) and
  6d (CI, release, docs) are untouched.
* Windows and Linux were not run.
* Performance of the new operations was not benchmarked: they take microseconds to milliseconds, and each is one IPC round trip.
* The manual click-through is yours; in particular please try, with `SEQUENCESCOPE_BACKEND=rust`, typing in the Distances box, building trees,
  re-rooting, comparing, hovering matrix cells and the Learn view, since those are the paths that became asynchronous.
