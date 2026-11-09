// Rasterises build/icon.svg to PNGs at several sizes using Electron itself (no extra dependency).
// Usage: npx electron tools/icon-render/main.cjs <outDir> <size> [<size> ...]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.whenReady().then(async () => {
  const [outDir, ...sizes] = process.argv.slice(2);
  const raw = fs.readFileSync(path.join(__dirname, '../../build/icon.svg'), 'utf8').replace(' width="1024" height="1024"', '');
  fs.mkdirSync(outDir, { recursive: true });
  // One window, re-sized and re-loaded for every size (extra windows make the sandboxed helper processes fail on some systems).
  const win = new BrowserWindow({ width: 64, height: 64, show: false, transparent: true, frame: false, backgroundColor: '#00000000', useContentSize: true });
  for (const s of sizes.map(Number)) {
    win.setContentSize(s, s);
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${raw.replace('<svg ', `<svg style="display:block" width="${s}" height="${s}" `)}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: s, height: s });
    const exact = img.getSize().width === s ? img : img.resize({ width: s, height: s, quality: 'best' }); // capturePage returns device pixels (2x on Retina)
    fs.writeFileSync(path.join(outDir, `icon_${s}.png`), exact.toPNG());
  }
  app.quit();
});
