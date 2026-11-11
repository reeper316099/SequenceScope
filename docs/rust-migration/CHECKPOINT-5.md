# Checkpoint 5: progressive multiple alignment, conservation, V8's `Math.log2`

Same machine and method as [CHECKPOINT-3-BENCHMARKS.md](CHECKPOINT-3-BENCHMARKS.md) (MacBook Air M2, macOS 27.0.1, Rust 1.99.1,
release builds, 2026-11-09).

## What was ported (crates/sequencescope-core)

* `msa`: the progressive aligner (all pairs aligned, p-distance guide matrix, UPGMA or midpoint-rooted NJ guide tree, Gotoh
  profile-profile merging over alignment columns, every merge recorded), `merge_profiles` (now also `merge_profiles_cancellable`),
  `sum_of_pairs_score` and the exhaustive optimum `brute_force_optimum_sp`.
* `conservation`: per-column counts, identity, Shannon entropy, conservation, consensus, whole-alignment summary and the CSV export.
* `jsnum::js_log2`: V8's `Math.log2` (the entropy needs it).

Every floating-point operation in the profile DP happens in the same order as the TypeScript, so the merge scores (means of
fractions) are bit-identical, not just close.

## `Math.log2`: measured, like `Math.log` in Checkpoint 4

| Comparison | Inputs that differ from V8 | Largest difference |
|---|---|---|
| Rust `f64::log2` (the C library) | 10,676 of 1,580,219 (0.68%) | 1 ulp |
| **`js_log2` in this repo** | **0** | **0** |

The inputs were every fraction c/n for n up to 400 (all the entropy can see for up to 400 sequences), 1.5 million seeded doubles
over 2^-100..2^100 and (0, 9), and the special values. Unlike `Math.log`, **no fused multiply-add is needed**: the plain fdlibm
port (and the variant with one fused expression) both match V8 on Apple Silicon on every input, so the unfused port is used and
also matches V8 on x86-64. Float policy for this checkpoint: **everything is exact**. The MSA itself uses no logarithm, and the
conservation entropy uses `js_log2`. The 0.68% matters little in practice (swapping in the C library's `log2` changes 12 of 2,000
column results and 7 of 182 whole-alignment results in the fixtures) but it would break the "identical output" promise.

## Proof (all run)

TypeScript fixtures (`tests/fixtures/parity/msa-ts.json`, 1.9 MB, from `npm run parity:generate`), replayed in Rust with exact
comparison, **0 mismatches** everywhere:

| What | Inputs |
|---|---|
| `Math.log2`: fractions c/n (n <= 400) and seeded doubles | 380,200 |
| Progressive alignment: rows, guide tree, every merge's rows and score, sum of pairs; 9 typed errors | 160 runs, 925 merge steps (82 UPGMA, 78 NJ) |
| Profile merging (rows and scores; 2 typed errors) | 163 |
| Sum of pairs | 140 |
| Exhaustive optimum (2 to 4 sequences; 2 typed errors) | 38 |
| Column statistics (counts in JavaScript object order, entropy, consensus, thresholds; 10 typed errors) | 2,000 |
| Whole-alignment conservation, plus the CSV | 182 |

Independent checks that do not use the TypeScript (`tests/msa_properties.rs`, 200 random cases each):

* the profile DP's merge score equals an **exhaustive search over every alignment of the two column sequences** (gap-run costs counted
  from first principles), for DNA and for protein with BLOSUM62, and the returned rows achieve exactly that score;
* removing the inserted gap columns gives each input profile back ("once a gap, always a gap");
* a progressive alignment keeps every sequence, has equal-length rows, no all-gap column, n-1 merges, a guide tree with the right
  leaves, and a sum of pairs equal to the independent scorer;
* with two sequences it equals the optimal pairwise global score from `pairwise.rs`;
* it never beats the exhaustive sum-of-pairs optimum.

**The tests can fail** (mutation checks): preferring Y over M in the profile traceback gives 138 progressive and 56 merge
mismatches; leaving the NJ guide tree unrooted gives 73; using the C library's `log2` gives 12 column and 7 whole-alignment
mismatches; making a gap extension cost a gap open fails 3 of the 6 property tests (for example "DP -2 vs exhaustive -1.5").

In the real Tauri window (`SEQUENCESCOPE_SMOKE_MODE=parity`), **34 of 34 checks pass**, including this checkpoint's: 28 runs
(7 sets x UPGMA/NJ x two scorings, including the app's own example sets) with 176 merge steps exactly equal between TypeScript
(JavaScriptCore) and Rust; 6 kinds of bad input giving the same error code and message; cancelling a long alignment (50 sequences
x 1100) on both backends with no late messages (the Rust job registry empties in about 110 ms) and a normal run afterwards; and the
real MSA view showing identical tiles, alignment text and guide-tree drawing under both backends for UPGMA and NJ.

Lesson from building that last check: the page redraws the guide tree a moment after the result arrives, and an unfocused window
throttles redraws, so a fixed 300 ms wait compared a stale drawing. The check now waits until the tiles name the requested guide
tree and the drawing stops changing. (The data was already proven identical by the worker-level checks.)

## What is wired to the switch, and what is not

| Piece | Status |
|---|---|
| Progressive alignment (`msa_job`), progress, cancel (polled between pairs, between merges, and every 32 DP rows inside a merge) | **Wired** (MSA view uses the switch) |
| Conservation, sum of pairs, exhaustive optimum, `merge_profiles` | **Ported and parity-tested, not wired** |

Conservation is called synchronously while the MSA canvas draws, the CSV export and the Learn view are synchronous too, and all take
microseconds to milliseconds; wiring them would turn those paths asynchronous for no speed gain. Like the tree functions
from Checkpoint 4, they get wired at the cutover (Checkpoint 6) when the TypeScript goes away and the UI changes anyway.

## Benchmarks (median ms, lower is better; the result checksum is identical in all three columns)

| Scenario | Runs | TypeScript in WKWebView | Rust through Tauri | Rust alone |
|---|---|---|---|---|
| MSA, 12 protein x 300, BLOSUM62 affine, UPGMA guide | 3 | 147 | **51** | 46 |
| MSA, 40 DNA x 800, affine, NJ guide (780 pairs aligned, 39 merges) | 3 | 7,137 | **3,513** | 3,474 |

Peak memory (outside sampler): the 40 x 800 run uses about 259 MB in the Rust app process and 369 MB in the web view, versus 102 MB
and 538 MB with TypeScript. Raw files: `cp5-*.json`, `cp5-bench-rust-core-only.txt`.

The gain is about 2x to 3x, smaller than for the bootstrap, because the time goes into aligning every pair (780 independent
global alignments) one after another, and Rust does that sequentially here. Running the pairs on several threads is possible
without changing any result (each pair is independent), but it changes the shared distance code from Checkpoint 4, so it is
left as an optional follow-up rather than done silently.

## Surprises worth remembering

* The unfused `log2` is enough, unlike `log`. Worth knowing if someone later tries to "fix" it with `mul_add`.
* Entropy sums terms in the order a JavaScript object lists its keys (digits first, then first appearance), so the Rust code
  reproduces that order; it only matters for exotic columns, and is tested.
* `merge_profiles` in TypeScript has no cancellation (the worker is killed instead); Rust cancels cooperatively, so the merge loop
  polls every 32 rows. Parity is unaffected.
