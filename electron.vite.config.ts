import { defineConfig } from 'electron-vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// Dev only: serve /examples/* from the repo so dev and production (app://local/examples/*) use the same URLs.
function serveExamples(): Plugin {
  const dir = resolve(import.meta.dirname, 'examples');
  return {
    name: 'serve-examples',
    configureServer(server) {
      server.middlewares.use('/examples', (req, res, next) => {
        const file = resolve(dir, '.' + decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
        if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'electron/main.ts') } } } },
  // The sandboxed preload must be ONE CommonJS file.
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src'),
    plugins: [serveExamples()],
    worker: { format: 'es' },
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/index.html') } },
  },
});
