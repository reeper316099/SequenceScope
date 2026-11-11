// Starts the dev-only Rust test bridge (src-tauri/src/bin/test_bridge.rs) for the browser tests. Used by playwright.bridge.config.ts.
// BRIDGE_PROFILE=debug uses the debug build; the default is release (the alignment tests are slow in debug builds).
import { spawn } from 'node:child_process';
import path from 'node:path';

const profile = process.env['BRIDGE_PROFILE'] === 'debug' ? 'debug' : 'release';
const exe = path.join('target', profile, process.platform === 'win32' ? 'test-bridge.exe' : 'test-bridge');
const child = spawn(exe, ['--serve', 'out/tauri-renderer', '--port', process.env['BRIDGE_PORT'] ?? '4175'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
