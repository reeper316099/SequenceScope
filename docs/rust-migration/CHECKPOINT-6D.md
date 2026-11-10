# Checkpoint 6, phase 6d: CI, release and documentation

## Did
* **`.github/workflows/ci.yml`** now runs on Ubuntu, Windows and macOS: version agreement (package.json = tauri.conf.json = src-tauri/Cargo.toml),
  ESLint and typecheck, `cargo fmt --check`, `cargo clippy -D warnings` (also with the test-bridge feature), `cargo test --workspace`,
  `npm test` (UI unit tests against the Rust core), `npm run test:bridge` (headless Chrome against the Rust core), and a build of the app followed by its
  26-check self-test in a real window (`xvfb-run` on Linux). Linux installs the WebKitGTK packages Tauri needs. It also runs on pushes to `rust-port`.
* **`.github/workflows/release.yml`**: a `v*` tag builds with `tauri build` on the three systems (unsigned), creates the GitHub Release if needed, uploads
  `.dmg`, `.msi`, `-setup.exe`, `.AppImage`, `.deb`, then a final job adds `SHA256SUMS.txt`. The tag must equal all three version numbers.
* Documents rewritten for the new reality: README (download names, validation story, how to run, security notes, performance), CHANGELOG
  (an "Unreleased" entry; no version bump), CONTRIBUTING, INTERVIEW (security answer updated, new point on the port), ALGORITHMS (section 19: where the code
  lives now), DATA-SOURCES (bundled libraries), RELEASING, MANUAL-CHECKLIST (menu), PERMISSIONS, tools/README, the PR template.

## Proved
* Both workflow files parse as YAML (checked with Ruby's YAML loader). That is all that was checked.
* The commands in the workflows are the ones run locally in 6b/6c-3 on macOS (all green).
* Versions agree at 0.1.0 in the three places.

## NOT run / unknown (please read)
* **Neither workflow has run.** Not on GitHub, not under `act`. The Linux and Windows jobs have never executed any of this code.
* Specific risks: (1) the smoke step on Windows and Linux (window, exit code, `xvfb-run`); (2) the Chrome that the browser tests use (`channel: 'chrome'`)
  must exist on the runners (GitHub's images ship it, but I did not confirm); (3) the Tauri bundlers download tools (WiX for `.msi`, linuxdeploy for AppImage)
  and can fail on the first run; (4) macOS builds only the runner's CPU (Apple Silicon), not a universal binary; (5) the `.msi`/`.exe` names in the checksum job
  are the Tauri defaults; (6) action versions are pinned by tag (`@v4`, `@v2`, `@stable`) as before, not by commit hash.
* Documentation numbers: the totals and timings come from the runs in 6b/6c; the README's older validation figures (Biopython, textbook, recovery of random trees)
  are the TypeScript-era results, and I say so there; their Rust equivalents pass but I did not re-count every sub-figure.
* Not checked: the sizes of the installers (I never built a bundle), so the README makes no claim about download size.

## Left for you
* The version bump. I suggest 0.2.0 (a runtime swap with identical behaviour), changed in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml together,
  then `CHANGELOG.md` "Unreleased" becomes the 0.2.0 heading.
* `tools/gen-matrices.mjs` is dead (its output file no longer exists). I marked it obsolete rather than delete it.
* The "What I learned" section of the README, as before.
* The first tag is the first real test of the release workflow.
