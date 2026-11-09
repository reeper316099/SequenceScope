// Builds build/icon.png (1024), build/icon.ico (PNG-compressed ICO), and build/icon.icns (macOS iconutil) from build/icon.svg.
// Rasterising uses Electron (already a dependency); the .ico container is written here; .icns needs macOS `iconutil`
// (on other systems electron-builder can derive both from icon.png, so the committed files are enough).
// Run: node tools/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'sscope-icons-'));
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
execFileSync('npx', ['electron', 'tools/icon-render/main.cjs', tmp, ...sizes.map(String)], { stdio: 'inherit' });
const png = (s) => readFileSync(path.join(tmp, `icon_${s}.png`));
copyFileSync(path.join(tmp, 'icon_1024.png'), 'build/icon.png');

// ICO: header + directory + PNG payloads (PNG-compressed entries are valid since Windows Vista).
const icoSizes = [16, 32, 48, 64, 128, 256];
const images = icoSizes.map((s) => ({ s, data: png(s) }));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dir = Buffer.concat(images.map(({ s, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
}));
writeFileSync('build/icon.ico', Buffer.concat([header, dir, ...images.map((i) => i.data)]));

// ICNS via iconutil (macOS only)
if (process.platform === 'darwin') {
  const set = path.join(tmp, 'icon.iconset');
  mkdirSync(set);
  const map = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64, 'icon_128x128.png': 128, 'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512, 'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024 };
  for (const [name, s] of Object.entries(map)) writeFileSync(path.join(set, name), png(s));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns']);
} else {
  console.log('Not macOS: skipping icon.icns (electron-builder derives it from icon.png).');
}
rmSync(tmp, { recursive: true, force: true });
console.log('wrote build/icon.png, build/icon.ico' + (process.platform === 'darwin' ? ', build/icon.icns' : ''));
