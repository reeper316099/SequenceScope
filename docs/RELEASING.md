# Releasing SequenceScope (v0.1.0 and later)

Installers are built by GitHub Actions when you push a tag that starts with `v`.

## One-time check
- `package.json` `version` must equal the tag without the `v` (the workflow stops with an error otherwise).
- Repository **Settings → Actions → General → Workflow permissions** may stay on the default; the workflow asks for `contents: write` itself.

## Steps
1. Make sure `main` is pushed and the **CI** workflow is green.
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Open **github.com/reeper316099/SequenceScope → Actions → Release**. Three jobs build in parallel (Linux, Windows, macOS), then a fourth adds `SHA256SUMS.txt`.
4. Installers appear on **github.com/reeper316099/SequenceScope/releases** under the tag:
   - Windows: `SequenceScope-0.1.0-win-x64-setup.exe` and `…-win-x64-portable.exe`
   - macOS: `SequenceScope-0.1.0-mac-universal.dmg`
   - Linux: `SequenceScope-0.1.0-linux-x86_64.AppImage` (name as produced by electron-builder) and `…-amd64.deb`

## Unsigned builds: what users will see
No code-signing certificate is used, so each operating system warns on first launch. This is expected, not a sign of damage.
- **Windows (SmartScreen: "Windows protected your PC / unknown publisher")**: click **More info → Run anyway**.
- **macOS (Gatekeeper: "cannot be opened because the developer cannot be verified")**: drag the app to Applications, then **right-click (or Control-click) the app → Open → Open**. If macOS still refuses, run `xattr -dr com.apple.quarantine /Applications/SequenceScope.app` once in Terminal.
- **Linux**: `chmod +x SequenceScope-*.AppImage` then run it, or install the `.deb` with `sudo apt install ./SequenceScope-*.deb`.

Signing, notarization and auto-update are on the stretch list (they need paid certificates).
