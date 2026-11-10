// Vite config for the UI: bundled on its own (no Electron). `npm run renderer:dev` serves it on port 5174 for `tauri dev`;
// `npm run renderer:build` writes out/tauri-renderer/, which Tauri embeds in the app.
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const repo = import.meta.dirname;
const examplesDir = resolve(repo, 'examples');
const outDir = resolve(repo, 'out/tauri-renderer');

/** Serves /examples/* from the repo in dev and copies the folder into the build, so the UI's `fetch('/examples/...')` works in both. */
function bundledExamples(): Plugin {
  return {
    name: 'bundled-examples',
    configureServer(server) {
      server.middlewares.use('/examples', (req, res, next) => {
        const file = resolve(examplesDir, '.' + decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
        if (!file.startsWith(examplesDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (process.argv.includes('build')) cpSync(examplesDir, resolve(outDir, 'examples'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: resolve(repo, 'src'),
  clearScreen: false,
  plugins: [bundledExamples()],
  server: { port: 5174, strictPort: true },
  build: { outDir, emptyOutDir: true },
});
