# Checkpoint 4: distances, trees, Newick, Robinson-Foulds, bootstrap

Same machine and method as [CHECKPOINT-3-BENCHMARKS.md](CHECKPOINT-3-BENCHMARKS.md) (MacBook Air M2, macOS 27.0.1, Rust 1.99.1,
release builds, 2026-11-09).

## What was ported (crates/sequencescope-core)

`distance`, `upgma`, `nj`, `tree` (splits, edge lengths, ladderize, rotate, re-root, midpoint root, leaf distances, support),
`newick` (parse with exact error positions, write), `treecompare` (Robinson-Foulds), `bootstrap` (including a multi-threaded
run that gives the identical result), and `jsnum` (the JavaScript number behaviour the output depends on, below).

## The floating-point policy (the tolerance number)

Measured, not assumed. On 200,000 seeded inputs of the form 1 - 4p/3 and 1 - p (what Jukes-Cantor and Poisson take the logarithm of):

| Comparison | Inputs that differ | Largest difference |
|---|---|---|
| Rust `f64::ln` (the C library) vs V8 `Math.log` | 13,778 (6.9%) | 1 ulp |
| Plain fdlibm port (no fused multiply-add) vs V8 on Apple Silicon | about 1.9% | 1 ulp |
| **`js_ln` in this repo vs V8 on Apple Silicon** | **0 (bit-identical)** | **0** |

Why: V8's `Math.log` is FreeBSD's fdlibm, and V8 on Apple Silicon compiles it with fused multiply-add. I found the fusing
pattern by testing every combination against V8's output, then confirmed the result on all 200,000 inputs and on 22,000
edge inputs (powers of two, values near 1). `f64::mul_add` is correctly rounded on every platform, so `js_ln` returns the
same bits on Windows, macOS and Linux. Two consequences worth knowing:

- **The TypeScript reference is not platform-deterministic.** V8 on x86-64 does not fuse, so Node on an Intel machine can differ from Node
  on Apple Silicon by 1 ulp in a log; JavaScriptCore (Safari, Tauri's macOS web view) uses the C library and differs from V8
  by the same amount. The Rust code gives the same answer everywhere.
- Only distances with a correction (Jukes-Cantor, Poisson) are affected. The p-distance, every tree algorithm, and everything
  else is plain arithmetic and is identical across engines.

**Agreed tolerances**

| Where | Rule |
|---|---|
| Rust vs the TypeScript fixtures (generated with Node on Apple Silicon) | **0 ulp: exact**, every number |
| In-window, Rust vs the TypeScript backend running in JavaScriptCore, p-distance | exact |
| In-window, logarithm-model distance values | at most **2 ulps** (observed: 1 ulp, in 14 of 538 cells) |
| In-window, tree branch lengths from logarithm-model distances | at most **1e-12 relative** (observed: 6 of 8 bootstrap trees bit-identical, the other 2 within tolerance) |
| Always exact | statuses, compared-site counts, split counts, supports, topology, names, error codes and messages |

Newick output is exact: the writer reproduces JavaScript's `String(number)` (checked on 100,000 doubles), including two cases
Rust's own printer gets wrong (a digit too long at a rounding boundary; exact ties between two equally short strings, where
JavaScript takes the even digit). `toFixed` (used by the PHYLIP export) is exact on 40,000 values, including the exact ties
that Rust rounds the other way.

## Proof (all run)

Core crate, replaying TypeScript output on seeded inputs, **0 mismatches** everywhere:

| What | Inputs |
|---|---|
| V8 `Math.log` | 200,000 |
| `String(number)` | 100,000 doubles |
| `toFixed(6)` and `toFixed(1)` | 40,000 values each |
| Distance matrices, PHYLIP and CSV exports, typed errors | 260 (96 typed errors, 95 with a logarithm) |
| Distances from pairwise alignments | 26 |
| UPGMA and NJ, every recorded step (matrices, Q, sums, branches, new rows) | 226 runs, 1,114 steps |
| Tree utilities (splits, edge lengths, ladderize, rotate, 14 re-roots per tree x 2 fractions, outgroup, midpoint, leaf distances, support) | 4,721 checks |
| Robinson-Foulds | 205 pairs (48 typed errors) |
| Newick writing | 345 |
| Newick parsing, including error position, line, column and message | 731 (255 valid, 476 invalid) |
| Bootstrap, single-threaded and on 4 threads | 144 runs |

External references: Biopython 1.86 and SciPy 1.11.1 (6 matrices: NJ, UPGMA, and the WPGMA that Biopython calls UPGMA),
the Wikipedia worked examples, 123 distance pairs against Biopython identity distances, and exact recovery of 200 random
ultrametric trees (UPGMA) and 200 random additive trees (NJ). Mutation checks: using the C library's `ln` produces 40 distance
and 6 bootstrap mismatches; flipping the UPGMA tie rule produces 42 tree and 34 bootstrap mismatches.

In the real Tauri window (`SEQUENCESCOPE_SMOKE_MODE=parity`), 26 of 26 checks pass, including this checkpoint's: aligned distances
for every example set, distances from pairwise alignments with progress, 8 bootstrap runs with identical splits and supports,
cancelling a long distance job and a long bootstrap on both backends (the Rust job registry empties in 34 and 74 ms), and the
real Distances and Trees views showing identical tables and support values under both backends.

## What is wired to the switch, and what is not

| Piece | Status |
|---|---|
| Distance matrices (both modes), progress, cancel | **Wired** (`distance_matrix` command; the Distances view uses the switch) |
| Bootstrap, progress, cancel | **Wired** (`bootstrap_job` command; the Trees view uses the switch) |
| UPGMA, NJ, Newick, Robinson-Foulds, re-root, midpoint | **Ported and parity-tested, not wired** |

The second group is called synchronously from many places in the UI (every tree rebuild, every step of the step-through
text, every re-root click, the Learn view). Through IPC they would become asynchronous, which means rewriting those UI paths,
and they take microseconds on at most 100 taxa, so there is no speed to gain. I did not add commands and permissions that
nothing uses. They get wired when the TypeScript is removed (Checkpoint 6), where the UI has to change anyway.

## Benchmarks (median ms, lower is better; every scenario's result checksum is identical in all three columns)

| Scenario | Runs | TypeScript in WKWebView | Rust through Tauri | Rust alone |
|---|---|---|---|---|
| Distance matrix, 30 DNA sequences x 400, every pair aligned (435 alignments) | 3 | 834 | **468** | 466 |
| Bootstrap, 100 replicates, 10 x 1144 DNA, NJ | 3 | 35 | **5** | 8.8 (1 thread), 3.4 (8 threads) |
| Bootstrap, 100 replicates, 50 x 3000 DNA, NJ | 3 | 1,588 | **127** | 487 (1 thread), 114 (8 threads) |

The bootstrap gain has two parts: Rust on one thread is 3.3x faster than TypeScript, and running replicates on 8 threads is
another 4.3x (replicate r has its own random stream, so the result does not depend on the split; this is tested). Memory for these
scenarios is similar in both backends (about 100 MB app + 370-430 MB web view); raw files are `cp4-*.json`.

## Surprises worth remembering

- V8's `10 ** -5` is `0.000009999999999999999` (1 ulp off the exact constant). The test generator now uses exact `1e-5` literals.
- Rust's float printer can be one digit longer than JavaScript's, and breaks ties differently (see above).
- A debug build overflowed the stack on a 4,000-deep Newick string (the parser recurses once per level). Deep input is now parsed on
  a 64 MB-stack thread.
