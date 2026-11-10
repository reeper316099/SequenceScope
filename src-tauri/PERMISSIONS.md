# Tauri permissions and security settings (Checkpoint 1)

Tauri's rule: the web page can only call what a *capability file* allows. Ours is
[`capabilities/main-window.json`](capabilities/main-window.json). It applies to the one window called `main`.

## What the page is allowed to call

| Permission | Command | Why it is needed | What Rust enforces |
|---|---|---|---|
| `allow-open-file` | `open_file` | Open a FASTA / Newick / project file | Only the three known kinds; native dialog; extension must match the kind; 10 MB cap (also re-checked while reading); UTF-8 text only |
| `allow-save-file` | `save_file` | Save a project, export FASTA/CSV/PNG/SVG | Name has no path characters (≤ 200); 1–6 plain extensions; content ≤ 50 MB; writes **only** to the path the user picked in the native dialog |
| `allow-open-external` | `open_external` | "Open in browser" links | `https` only, no credentials, host must be exactly `github.com`, `www.ncbi.nlm.nih.gov` or `www.uniprot.org`; length ≤ 2048 |
| `allow-get-app-info` | `get_app_info` | About page (version, platform) | Read-only facts |
| `allow-copy-text` | `copy_text` | Copy a Newick string | Text only, ≤ 5 MB |
| `allow-align-pair` | `align_pair` | Run an alignment in Rust | Request shape and numbers validated (whole numbers in range, known alphabet/mode/matrix, enumeration cap ≥ 1); sequences limited by the 5001² cell cap; runs on a worker thread; cancellable |
| `allow-shuffle-test` | `shuffle_test` | Run the seeded shuffle significance test in Rust | 1–5000 shuffles, seed 0–4294967295, same checks as above; cancellable |
| `allow-distance-matrix` | `distance_matrix` | Compute a distance matrix in Rust (aligned rows, or every pair aligned) | Request shape checked; model must fit the alphabet; at most 100 sequences and 1.5 billion pairwise cell updates; cancellable |
| `allow-bootstrap-job` | `bootstrap_job` | Run the column bootstrap in Rust (on several threads) | 3–100 sequences, ≤ 50,000 columns, 1–1000 replicates, seed 0–4294967295, ≤ 5 billion column comparisons; cancellable |
| `allow-msa-job` | `msa_job` | Run the progressive multiple alignment in Rust | 1–50 sequences of ≤ 3000 residues each, unique names, known alphabet/guide method/matrix, ≤ 1.5 billion pairwise cell updates, each profile merge ≤ 25 million cells; cancellable (polled between pairs, between merges, and every 32 rows inside a merge) |
| `allow-bio-op` | `bio_op` | The small calculations the page used to do itself: reference data (limits, matrices, models), FASTA parse/write, alphabet detection, alignment pre-check, DP-cell explanation, UPGMA/NJ tree building, Newick parse/write, tree edits, tree comparison, leaf distances, distance-correction curves, distance exports, conservation (+CSV), sum of pairs, exhaustive optimum | ONE tagged request: the `op` must be one of those names and every field must have the right type, or the request is refused (`invalid-argument`). Text <= 50 MB; trees arrive as flat lists (<= 20,000 nodes, <= 3,000 deep); distance matrices <= 100 taxa with shapes checked; alignments <= 1,000 rows; no files, no network, no state kept between calls |
| `allow-cancel-job` | `cancel_job` | Stop a running alignment/shuffle (the page's Cancel button) | Only sets a flag for the job id; harmless for unknown or finished ids |
| `allow-smoke-active-jobs` | `smoke_active_jobs` | Smoke test proves a cancelled job really stopped | Refuses unless the process was started with `SEQUENCESCOPE_SMOKE=1` |
| `allow-smoke-report` | `smoke_report` | Hidden-window smoke test reports its result | Refuses unless the process was started with `SEQUENCESCOPE_SMOKE=1`, so it does nothing in a normal run |

## What is deliberately NOT granted

- No `core:*` permissions (no window control, no events, no app/path/menu access from the page).
- No dialog, clipboard, opener, fs, shell, http, or process plugin permissions. The dialog, clipboard and opener
  plugins are used **from Rust only**, inside the commands above, so the page cannot call them directly.
  The smoke test proves this: calls to `plugin:dialog|open`, `plugin:clipboard-manager|read_text` and
  `plugin:opener|open_url` from the page are refused.
- No shell plugin, no remote URLs in the capability, no `withGlobalTauri`.

## Content Security Policy (`tauri.conf.json` → `app.security.csp`)

```
default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

Same as the Electron CSP (no inline scripts or styles, no network sources) plus `ipc:` / `http://ipc.localhost`,
which Tauri uses to deliver command calls. `devCsp` is only used by `tauri dev` and additionally allows inline styles
and the local Vite websocket for hot reload.

## Compute commands (Checkpoint 3)

The three compute commands take only plain data (sequences, scoring numbers) and touch no files, clipboard, network or
shell. They are limited in size (5001² DP cells, 5000 shuffles), run on a background thread, and every job can be
cancelled. Progress arrives on a Tauri `Channel`; an alignment result comes back as one raw binary buffer.

## Choosing the backend (not a permission, but a setting)

`SEQUENCESCOPE_BACKEND=rust` or `ts` (environment variable read by the app and passed to the page), or
`localStorage.setItem('sequencescope.backend', 'rust')` in the web inspector. The default is `ts` until the cutover.
Under Electron the switch does nothing: the TypeScript workers are the only backend there.

## Other protections

- Navigation: the web view may only navigate to the bundled app (`tauri://localhost`, `http(s)://tauri.localhost`,
  `about:blank`; the Vite dev server in debug builds only). Anything else is blocked (`allowlist::is_app_url`).
- `app_manifest` in `build.rs` lists the commands explicitly, so a command that is not listed cannot be called.
- Smoke-test mode hides the window and the Dock icon so tests never steal focus.
