# Releasing SequenceScope

Installers are built by GitHub Actions (Tauri) when you push a tag that starts with `v`.

## One-time check
- The version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` must be the same and equal the tag without the `v` (CI and the release workflow stop with an error otherwise). Change all three together.
- Repository **Settings → Actions → General → Workflow permissions** may stay on the default; the workflow asks for `contents: write` itself.

## Steps
1. Make sure `main` is pushed and the **CI** workflow is green.
2. Tag and push (use the real version):
   ```bash
   git tag -s v0.2.0 -m "SequenceScope 0.2.0"
   git push origin v0.2.0
   ```
3. Open **github.com/reeper316099/SequenceScope → Actions → Release**. Three jobs build in parallel (Linux, Windows, macOS), then a fourth adds `SHA256SUMS.txt`.
4. Installers appear on **github.com/reeper316099/SequenceScope/releases** under the tag:
   - Windows: `SequenceScope_<version>_x64-setup.exe` and `SequenceScope_<version>_x64_en-US.msi`
   - macOS: `SequenceScope_<version>_universal.dmg` (one app containing Apple Silicon and Intel code; built with `--target universal-apple-darwin`)
   - Linux: `SequenceScope_<version>_amd64.AppImage` and `SequenceScope_<version>_amd64.deb`
   - `SHA256SUMS.txt` for all of them.

The workflow has not been run yet on this code; the first tag is also its first test. If a job fails, fix it and move the tag (or use a new patch version).

## Unsigned builds: what users will see
No code-signing certificate is used, so each operating system warns on first launch. This is expected, not a sign of damage.
- **Windows (SmartScreen: "Windows protected your PC / unknown publisher")**: click **More info → Run anyway**.
- **macOS (Gatekeeper: "cannot be opened because the developer cannot be verified")**: drag the app to Applications, then **right-click (or Control-click) the app → Open → Open**. If macOS still refuses, run `xattr -dr com.apple.quarantine /Applications/SequenceScope.app` once in Terminal.
- **Linux**: `chmod +x SequenceScope_*.AppImage` then run it, or install the `.deb` with `sudo apt install ./SequenceScope_*.deb`.

Signing, notarization and auto-update are on the stretch list (they need paid certificates).
