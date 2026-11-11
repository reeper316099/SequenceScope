# Checkpoint 3: TypeScript vs Rust backend, measured

Everything here was measured on **one machine**: MacBook Air, Apple M2 (8 cores), 16 GB RAM, macOS 27.0.1, Rust 1.99.1,
**release builds** (`npx tauri build --no-bundle`, `cargo run --release`), 2026-11-09. The Tauri window used macOS WKWebView
(JavaScriptCore), so the "TypeScript" numbers below are TypeScript running in WebKit, not in Electron's V8.

## What was timed

A full round trip as the UI experiences it: from posting the request to having the finished result in JavaScript. That
includes (for Rust) validating the request, computing, building the binary frame, sending it through Tauri's IPC, and
decoding it; and (for TypeScript) the Web Worker computing and handing the typed arrays back. Alignment = fill the
matrix + deterministic traceback + enumerate up to 1000 co-optimal alignments, exactly what the Align view asks for.
Inputs come from the project's seeded PRNG (`src/tauri/inputs.ts`), and the Rust-only benchmark generates the same
sequences with its port of the PRNG. **Every scenario's result checksum (score, hash of the gapped rows, hash of the
first DP table, number of co-optimal alignments) is identical in all three runs**, so all three computed the same
answer, including the 5000 x 5000 tables.

## Time (median of the runs, milliseconds; lower is better)

| Scenario | Runs | TypeScript in WKWebView | Rust through Tauri (full round trip) | Rust alone (no window, no IPC) |
|---|---|---|---|---|
| Small: 200 x 200 DNA, affine, global | 7 | 19 | **6** | 3.3 |
| Medium: 1000 x 1000 protein BLOSUM62, affine, global | 5 | 58 | **21** | 11.7 |
| Largest: 5000 x 5000 DNA, linear, global | 3 | 276 | **165** (143 in a second run) | 72 |
| Largest: 5000 x 5000 protein BLOSUM62, affine, global | 3 | 538 | **442** (464 in a second run) | 186 |
| Shuffle test: 1000 shuffles of 300 x 300 DNA, local, affine | 3 | 694 | **395** | 398 |

Where the Rust time goes for the largest affine case (frame = 345 MB): fill 173 ms, traceback + enumeration 15 ms,
**transfer + decoding 230 ms**. So at the largest sizes moving the tables to the page costs more than computing them,
which is why the end-to-end speed-up shrinks from about 3x (small, medium) to about 1.2x (largest). The shuffle test
sends almost nothing back, so it shows the pure compute gain (1.8x).

For reference, `docs/validation/perf.json` (Electron, V8, measured earlier on the same machine, different random inputs,
measured through the whole UI) recorded 1.07 s for the 5000 x 5000 protein affine alignment and 0.86 s for the shuffle
scenario. Those are not directly comparable with the table above (different engine, different harness).

## Memory (peak resident memory in MB; measured from outside, see tools/bench/measure.py)

Each large scenario was run alone in its own launch. "App process" is exact (ru_maxrss); "web view" is sampled every
50 ms from the WebKit processes the app started, so it is a lower bound.

| Scenario | TypeScript: app + web view | Rust through Tauri: app + web view |
|---|---|---|
| Medium 1000 x 1000 protein affine | 102 + 433 | 156 + 410 |
| Largest 5000 x 5000 DNA linear | 103 + 749 (about 850) | 540 + 660 (about 1,200) |
| Largest 5000 x 5000 protein affine | 103 + 900 (about 1,000) | 1,163 + 1,063 (about 2,200) |

The sum is an upper bound (the two peaks need not coincide). The likely contributors on the Rust side for the largest
affine case are the DP tables (350 MB), the frame built from them (345 MB; each table is freed as it is copied in), and
Tauri's own handling of the response; the page then receives 345 MB. (This breakdown is an inference from the sizes, not
separately measured.) **The raw-binary transfer (option a) did not fail on speed or memory**
for any allowed input on this 16 GB machine, but at the largest size it uses roughly twice the memory of the TypeScript
backend. Option b (keep the tables in Rust and send only what the matrix viewer needs) would remove that, at the cost of
changing how the UI asks for cells. That decision is left to the project owner.

## Reproduce

```bash
npx tauri build --no-bundle                                     # release app
cargo run --release -p sequencescope-core --example bench       # Rust alone
python3 -I tools/bench/measure.py --binary target/release/sequencescope --backend ts
python3 -I tools/bench/measure.py --binary target/release/sequencescope --backend rust
python3 -I tools/bench/measure.py --binary target/release/sequencescope --backend rust --only largestProteinAffine
```

Raw outputs: `bench-ts-all.json`, `bench-rust-all.json`, `bench-rust-core-only.txt`, `memory-*.json` in this folder.
The benchmark opens the app window for the length of the run (unfocused, no Dock icon).
