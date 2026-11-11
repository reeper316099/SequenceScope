# Checkpoint 6, phase 6b: the new safety net (nothing deleted yet)

Goal of this phase: before Electron and the TypeScript algorithms are removed (6c), have a test suite that exercises the **Rust
core through the real UI** on every operating system, and know where each Electron-only check now lives. The Electron tests and all
TypeScript code are untouched and still pass-able; 6b only adds.

## What was built

**The test bridge** (`src-tauri/src/bin/test_bridge.rs`, dev-only). A small HTTP server on `127.0.0.1` that
1. serves the built Tauri UI (`out/tauri-renderer`) with the app's **production** Content-Security-Policy (read from `tauri.conf.json`), and
2. answers `POST /invoke/<command>` by calling the **same plain Rust functions the Tauri commands call** (`run_align`, `run_shuffle`,
   `run_distances`, `run_bootstrap`, `run_msa`, `run_op`). Progress and the result are streamed back, binary results raw.

It is not part of the app: it only builds with `--features test-bridge` (`required-features` on the bin, `tiny_http` is an optional
dependency pinned to `=0.12.0`), so `tauri build` never compiles or ships it. It refuses any request whose `Host` is not loopback,
serves files only below the folder it was given (no `..`, no escapes), and has no file or dialog commands. Test hooks (`hold_jobs`,
`effective_cancels`, `active_jobs`) exist only there.

**The page side** (`tests/bridge/shim.ts`, ~60 lines). Stands in for `window.__TAURI_INTERNALS__`: calculation commands go to the
bridge, the five native commands (open/save file, open link, app info, copy) go to Node-side test doubles (`tests/bridge/helpers.ts`).
The app code under test is the **unchanged** production page (`rust.ts`, `ops.ts`, `api.ts`, all views), running with `backend=rust`.

**The ports** (`tests/bridge/*.spec.ts`, config `playwright.bridge.config.ts`, run with `npm run test:bridge`): all 9 Electron specs.

| Electron spec | Tests | Ported as | Notes |
|---|---|---|---|
| `align.spec.ts` | 12 | `align.spec.ts` (11) | The file-size-cap test moved to Rust (below). Oracle numbers that came from the TypeScript aligner are now fixed values computed at the TS reference. Cancel test is stronger (see below). |
| `trees.spec.ts` | 10 | `trees.spec.ts` (10) | Newick/RF oracle is a new 70-line independent checker (`newick.ts`), shared with neither backend. The old "helpers agree" test became a self-test of that checker. |
| `msa.spec.ts` | 7 | `msa.spec.ts` (7) | FASTA reading and random data use small local helpers instead of `src/bio`. |
| `phase7.spec.ts` | 5 | `phase7.spec.ts` (5) | "Restart" = new Chrome process, new profile. |
| `packaged.spec.ts` | 1 (skipped) | `bundle.spec.ts` (1, **runs always**) | Same flow on the Tauri build. What really needs a packaged executable is covered by the in-window smoke test. |
| `crosscheck.spec.ts` | 1 (skipped) | `crosscheck.spec.ts` (skipped unless `CROSSCHECK_DIR`) | Not run here: it needs the Python generator (`tools/crosscheck_fresh.py`). |
| `perf.spec.ts` | 1 (skipped) | `perf.spec.ts` (skipped unless `PERF=1`) | Run once; writes `docs/validation/perf-bridge.json`. Memory column dropped (the page cannot see process memory; the in-window benchmark has it). |
| `screenshots.spec.ts` | 1 (opt-in) | `screenshots.spec.ts` (opt-in) | Run once into a temp folder to prove it works; `docs/screenshots` untouched. |

## Where each Electron-only check lives now

| Electron check | Now covered by | Honest note |
|---|---|---|
| Page gets exactly the 5 bridge functions | bridge test + in-window smoke ("bridge has exactly 5 functions") | |
| No `require` / Node in the page | bridge test + smoke ("no Node globals") | There is no Node in a Tauri page at all. |
| Outside network blocked | bridge test (production CSP, `connect-src` violation seen) + smoke (CSP header + "no CSP violations") | |
| `openExternal` allowlist (evil host, http, `javascript:`) | `allowlist.rs` tests + smoke ("rejects non-allowlisted host / http") | The bridge double does not reimplement it on purpose. |
| `openFile` unknown kind rejected | `validate.rs` test + smoke ("openFile rejects an unknown kind") | |
| `openFile` 10 MB cap | `fileio.rs::size_cap_is_exact` and the open-pipeline tests | No UI test any more: it needs a real dialog. |
| Save-name path tricks | `validate.rs` tests + smoke ("saveFile rejects a path-tricking name") | |
| Path traversal on the app's own file server | **Not applicable / not ours**: Electron had a custom `app://` handler (tested); Tauri serves the bundle through its own protocol. | The bridge test of traversal only proves the *test bridge* is not an open door. |
| `webPreferences` (contextIsolation, nodeIntegration, sandbox) | **Replaced** by new Rust tests `lockdown_tests.rs`: exactly one permission per declared command and nothing else (no `core:*`, no plugin permissions), one capability file, main window only, strict CSP, no fs/shell/http/process plugin, registered commands == declared commands. Smoke also proves the page cannot call the dialog/clipboard/opener plugins or an unknown command. | Mutation-checked: adding `core:default` fails the test. |
| Dark mode persists across restart | bridge test (same Chrome profile, new process) | |
| Packaged app launches | in-window smoke (26 checks, run on the real built app) | CI will build the real bundles in 6d. |

## Things found while doing this (all fixed or flagged)

1. **The Tauri app had no application menu.** Electron's File / Edit / View / Help menu (Open FASTA/Newick/Project, Save Project,
   Export, Undo/Redo, Cmd/Ctrl+1–7 for the views, Cmd/Ctrl+D dark mode, Help links) was never ported. Every earlier test fired the page's
   `menu-action` event directly, so nothing noticed. Without it, Open/Save Project and the keyboard shortcuts are unreachable once Electron
   is deleted. **Added `src-tauri/src/menu.rs`** with the same items and shortcuts; a click sends one of a fixed list of commands to the
   page (no user data in the script), Help links go through the same https allowlist. Proved by: a unit test that the menu offers exactly
   the commands in `src/shared/types.ts` `MENU_ACTIONS`, unique shortcuts, allowlisted links; and the in-window smoke now checks that every command is in the real menu
   and that clicking "Toggle Dark Mode" / "View > Trees" changes the real page. Not done: Electron's View menu also had Reload,
   Zoom in/out/reset and Fullscreen (system roles); Tauri has no equivalent items, and I did not add them.
2. **The exhaustive-optimum search was 2x slower in Rust than in TypeScript** (4.0 s vs 2.0 s for the Learn view's 3-sequence
   example; it made the Learn page lag). Cause: one allocation-heavy string per candidate. Rewrote the enumeration in place with a
   string-free scorer; **0.46 s now**, identical results (all 38 TS fixtures, the DP-vs-exhaustive property tests, the in-window
   parity run).
3. **My first cancel test proved nothing.** With the cancel command switched off, the shuffle test still passed: the Rust job just
   finished on its own (the largest shuffle the app allows, 600 x 600 x 5000, takes ~1.7 s here). Fixed with a bridge hook that holds a
   job "running" until cancelled and a counter of cancels that hit a running job; with cancel disabled the test now fails
   (verified), and it passed 10 of 10 repeats.
4. A Learn-view test needed a longer wait, not a code fix; and one assertion matched the *previous* result (a 3-digit
   alignment length) before the new one arrived, which made the cancel test flaky until it matched only the new length.

## Proof (all run, this machine: Apple Silicon Mac, release build for the bridge)

| Check | Result |
|---|---|
| `npm run test:bridge` (36 tests) | 34 passed, 2 skipped (`crosscheck`, `perf`: need env switches) |
| Same, perf (`PERF=1`), screenshots (`SCREENSHOTS=1`) | each 1 passed |
| Mutation: JC distance constant 0.75 -> 0.76 in Rust | the Learn/trees test fails (caught) |
| Mutation: bridge cancel disabled | the shuffle/cancel test fails (caught); was NOT caught before the fix in item 3 |
| Mutation: `core:default` added to the capability file | `lockdown_tests` fails (caught) |
| `cargo test --workspace` | 279 passed (271 before + 3 menu + 5 lockdown) |
| `cargo clippy --workspace --all-targets -- -D warnings` (also with `--features test-bridge`), `cargo fmt --check` | clean |
| TypeScript: typecheck, lint, 381 unit tests | clean / 381 passed |
| In-window smoke on the real built app | 26 of 26 (was 22; +4 menu checks) |
| In-window parity (TS in the window vs Rust, 52 checks, run after the exhaustive-search rewrite) | **52 of 52 identical** |
| `npm run test:tauri-ui` (old double-based UI test) | 3 of 3 |

Performance, for context only (bridge = localhost HTTP, not the app's own IPC; Electron numbers are from `docs/validation/perf.json`, 2026-11-09):

| Scenario | Electron / TypeScript | Chromium + Rust core |
|---|---|---|
| 5000 x 5000 protein, affine | 1.07 s | 1.35 s |
| 1000 shuffles, 300 x 300 DNA | 0.86 s | 0.24 s |
| bootstrap 100 x (10 x 1144) | 0.14 s | 0.07 s |
| bootstrap 100 x (50 x 3000) | 2.35 s | 0.18 s |
| MSA 50 x 1000 protein | 17.4 s | 9.3 s |

The 5000 x 5000 alignment is the one case where Rust is not faster here; most of it is moving a ~125 MB result over HTTP. The real
app measured this over its own IPC in checkpoint 3.

## Not run / unknown

* Windows and Linux: the bridge, specs and menu were only run on macOS. The menu is native per OS (on Windows/Linux it attaches to the window); I have not seen it there.
* I have **not looked at the menu bar by eye**. The smoke test proves the items exist and a click reaches the page; whether it looks right is yours to check: `SEQUENCESCOPE_BACKEND=rust npx tauri dev`.
* Electron e2e was not re-run in this phase (no TypeScript algorithm or Electron file changed; only `src/tauri/smoke.ts`, which Electron never loads).
* `crosscheck.spec.ts` was ported but not run (needs Python).
* The bridge speaks plain HTTP on loopback; a browser extension or another local program could call it while it runs. It has no file, dialog or shell access, and it only runs during tests.

## Risks / decisions for 6c

* Deleting the Electron e2e after this means the remaining UI tests drive Chrome, not the Tauri window (WebKit on macOS/Linux, WebView2 on Windows). WebView-specific rendering bugs are only caught by the smoke test, which checks far less. This was the trade-off you accepted with decision B.
* Needs your tag first (decision C): `git tag -s ts-reference-v0.1.0 <last TypeScript commit>`.
