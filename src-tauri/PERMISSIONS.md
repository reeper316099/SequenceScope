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

## Other protections

- Navigation: the web view may only navigate to the bundled app (`tauri://localhost`, `http(s)://tauri.localhost`,
  `about:blank`; the Vite dev server in debug builds only). Anything else is blocked (`allowlist::is_app_url`).
- `app_manifest` in `build.rs` lists the commands explicitly, so a command that is not listed cannot be called.
- Smoke-test mode hides the window and the Dock icon so tests never steal focus.
