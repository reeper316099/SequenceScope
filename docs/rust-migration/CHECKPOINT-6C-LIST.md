# Checkpoint 6, phase 6c: the removal list (for your approval; nothing is deleted yet)

Starting point: commit `578f3ad`, signed tag `ts-reference-v0.1.0` (verified: good signature). Everything below is
recoverable from that tag. I will do the work in **three steps with a full check after each**, so a problem is found where it
was introduced:

* **6c-1 Move what stays.** Create `src/shared/results.ts` (types only) and a tiny `src/bio/` replacement, so the UI stops importing
  the algorithms. Nothing deleted. All checks still green.
* **6c-2 Remove the TypeScript engine.** Algorithms, workers, the backend switch. UI is Rust-only.
* **6c-3 Remove Electron and the TypeScript-only tests.**

## A. Stays, moved or trimmed (so the UI keeps compiling)

| What | Where it goes |
|---|---|
| `BioError` class (`src/bio/errors.ts`, 13 lines) | stays at the same path |
| Tree accessors used for drawing: `isLeaf`, `preorder`, `leafNames`, `totalLength`, `hasNegativeBranches` (from `src/bio/tree.ts`, 329 lines) | new `src/bio/treeAccess.ts`, ~40 lines, no algorithms |
| Result and step **types** only: `UpgmaResult/UpgmaStep`, `NjResult/NjStep/NjJoinStep`, `MsaResult`, `Conservation`, `BootstrapResult`, `RfResult`, `ParsedFasta`, `FastaIssue`, `Detection`, `SubstitutionMatrix`, `AlignmentStats`, worker request types (`src/workers/protocol.ts`) | new `src/shared/results.ts` |
| `src/ui/*` (37 files), `src/io/*` (export, project), `src/shared/*` (minus the Electron IPC names), `src/backend/api.ts` (shrinks from 357 lines to thin Rust calls), `rust.ts`, `ops.ts`, `frame.ts`, `types.ts`, `RustWorker` | stay |
| `src/tauri/bridge.ts`, `smoke.ts`, `bench.ts`, `inputs.ts`, `util.ts` | stay (`inputs.ts` gets a 10-line local random generator instead of `bio/rng`) |
| Fixtures: all of `tests/fixtures/` (parity JSON, Biopython/SciPy references, FASTA/Newick cases), `tools/*.py` reference generators, `tools/bench`, `examples/`, `data/`, `crates/`, `src-tauri/`, `tests/bridge/`, `tests/tauri-ui/` | stay |
| Unit tests that test the UI/IO/frame code: `ui-pure`, `ui-trees-pure`, `io-and-cells`, `rust-worker`, and the frame-decoder half of `backend.test.ts` (4 of 8 tests) | stay (updated imports only) |

## B. Deleted in 6c-2: the TypeScript engine

* `src/bio/*.ts` except the two files above: `pairwise, scoring, matrices, matrices.data, alphabet, fasta, newick, tree, upgma, nj,
  distance, bootstrap, shuffle, rng, msa, conservation, treecompare, alignstats, typed` (19 files, ~2,500 lines).
* `src/workers/*` (7 files: pairwise, shuffle, distances, bootstrap, msa, ping workers + protocol). The page then runs no Web Worker, so
  `worker-src 'self'` is dropped from the CSP (production and dev) and the smoke check "module Web Worker runs" is replaced by "no workers allowed".
* TS side of `src/backend/`: `TsWorker`, `selectedBackend`, the `localStorage` switch, `__SEQUENCESCOPE_BACKEND__` (page) and
  `SEQUENCESCOPE_BACKEND` (Rust `smoke.rs`), `rustAvailable()` guards, the TS branches in `api.ts`.
* `src/tauri/parity.ts, parityMsa.ts, parityOps.ts, parityTrees.ts` (4 files, ~1,060 lines) and the `parity` mode in `smoke.ts`/`smoke.rs`:
  the window no longer has a TypeScript engine to compare with. The comparison is now frozen in the fixtures (A below).
* `tools/ts-parity/*.test.ts` (4 generators), `vitest.parity.config.ts`, script `parity:generate`. **Regenerating the fixtures later:**
  `git worktree add ../ts-ref ts-reference-v0.1.0 && cd ../ts-ref && npm ci && npm run parity:generate`. I'll write this into `tests/fixtures/parity/README.md`.
* Rust `ts_parity*.rs` tests **stay**: they replay the frozen fixtures (that is the proof Rust equals the TypeScript reference).

## C. Deleted in 6c-3: Electron and TypeScript-only tests

* Electron: `electron/` (4 files), `electron.vite.config.ts`, `electron-builder.yml`, `playwright.config.ts`, `build/` (icons; Tauri uses
  `src-tauri/icons`), `tests/e2e/` (9 specs, replaced by `tests/bridge/`), `tests/unit/appPath.test.ts`, `tsconfig.worker.json`.
  `package.json`: dependencies `electron`, `electron-builder`, `electron-vite`; field `main`; scripts `dev, build, dist, pack, test:e2e`;
  `screenshots` and `test` are repointed. Lockfile regenerated.
* TypeScript-only algorithm tests, **15 files, ~2,000 lines** (plus 4 helper files): `tests/unit/` `alignstats, bootstrap, conservation, crosscheck-textbook,
  distance, edge-cases, fasta-alphabet, matrices, msa, newick, pairwise-bruteforce, rng, shuffle, trees-core`, the 4 switch tests of
  `backend.test.ts`, plus `tests/property/pairwise.property.test.ts` and `tests/helpers/*` (4 files).

## D. Test coverage check before deleting those tests (done by name, not yet line by line)

I compared each TypeScript test file with the Rust tests. These have a matching Rust test (hand-written, ported, or fixture-driven):
bootstrap, conservation, distance (incl. Biopython identity), fasta/alphabet, matrices, newick (incl. random round trips), rng
(incl. chi-square), shuffle, trees (random UPGMA/NJ recovery, reroot/midpoint, RF symmetry/triangle, replay), pairwise edge cases,
brute-force optimality, MSA (merge only inserts gap columns, vs exhaustive, two sequences = pairwise), and the 40+ textbook cases.

**Gaps I found; I will fix them in 6c-2 before deleting, unless you say otherwise:**
1. `alignstats` has fixture parity (160 random alignments) but **no Rust unit tests for the hand-written edge cases** (empty alignment gives null
   percentages, adjacent opposite gaps count as two openings, similarity under a matrix, `|` `:` `.` match symbols). I will port those 8 tests.
2. The MSA-vs-MAFFT agreement test has no direct Rust twin (Rust equals TypeScript exactly on the fixtures, and TypeScript agreed with MAFFT). I will
   port it so the Rust side checks MAFFT itself.
3. Every deletion gets one more per-test check as I go; if another gap shows up I will add the Rust test first and list it in the report.

## E. Needs your OK

1. **Approve this list** (or strike items).
2. One suggestion I'd make: keep `RustWorker` / `JobWorker` as they are for now (the views use that shape); simplifying it into plain
   `async` calls is a refactor with no user benefit, so I'd leave it out of 6c ("no new features").
3. The in-window TypeScript-vs-Rust comparison disappears with the engine. I think that is right (the tag + 12 parity fixtures are the permanent
   record, 0 mismatches), but it is the one proof we can no longer re-run live in a window.
