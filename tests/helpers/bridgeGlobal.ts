// Vitest global setup: starts the dev-only Rust test bridge on a free port for the whole run and stops it afterwards.
// Build it first with `npm run bridge:build` (the `test` script does).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let child: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const profile = process.env['BRIDGE_PROFILE'] === 'debug' ? 'debug' : 'release';
  const exe = path.join('target', profile, process.platform === 'win32' ? 'test-bridge.exe' : 'test-bridge');
  if (!existsSync(exe)) throw new Error(`${exe} is missing: run "npm run bridge:build" first.`);
  const proc = spawn(exe, ['--serve', 'tests/helpers', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child = proc;
  process.env['BRIDGE_URL'] = await new Promise<string>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(`the test bridge exited early (code ${String(code)})`)));
    proc.stdout.on('data', (chunk: Buffer) => { const m = /LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString()); if (m?.[1] !== undefined) resolve(m[1]); });
  });
}

export function teardown(): void {
  child?.removeAllListeners('exit');
  child?.kill();
}
