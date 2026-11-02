import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { siteFiles, siteInfo } from './pipeline/site/files.mjs';

/**
 * The screen database page (db/), built separately from the SVM workbench (vite.config.ts).
 *
 * The workbench's offline release fingerprints vite.config.ts, tailwind.config.js and src/, so the
 * database has its own Vite config, Tailwind config (tailwind.db.config.js) and entry (db/index.html).
 * It imports a few workbench modules read-only (src/stats, src/data, src/ui) and never edits them.
 *
 * Data: the page fetches ./data/** and ./datasets/** at runtime. In dev they are served straight from
 * the repository (allow-list in pipeline/site/files.mjs); `db:build` copies exactly those files into
 * dist-db/ next to the page, plus a generated data/site-info.json (data version for the footer).
 */
const ROOT = __dirname;

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

function databaseData(): Plugin {
  return {
    name: 'screendb:data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!url.startsWith('data/') && !url.startsWith('datasets/')) return next();
        if (url === 'data/site-info.json') {
          res.setHeader('Content-Type', CONTENT_TYPES['.json']);
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(siteInfo(ROOT)));
          return;
        }
        // The allow-list is rebuilt per request so catalog changes show up without a restart.
        const from = siteFiles(ROOT).get(url);
        if (!from) {
          res.statusCode = 404;
          res.end('not part of the screen database site');
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(from)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(path.join(ROOT, from)).pipe(res);
      });
    },
    generateBundle() {
      for (const [served, from] of siteFiles(ROOT)) {
        this.emitFile({ type: 'asset', fileName: served, source: fs.readFileSync(path.join(ROOT, from)) });
      }
      this.emitFile({ type: 'asset', fileName: 'data/site-info.json', source: `${JSON.stringify(siteInfo(ROOT), null, 2)}\n` });
    },
  };
}

export default defineConfig({
  root: path.resolve(ROOT, 'db'),
  base: './',
  publicDir: false,
  // Own dep-optimizer cache: the workbench dev server can run at the same time.
  cacheDir: process.env.VITE_CACHE_DIR || path.resolve(ROOT, 'node_modules/.vite-db'),
  plugins: [react(), databaseData()],
  css: {
    postcss: {
      plugins: [tailwindcss({ config: path.resolve(ROOT, 'tailwind.db.config.js') }), autoprefixer()],
    },
  },
  resolve: {
    alias: { '@': path.resolve(ROOT, 'src') },
  },
  server: {
    port: 5341,
    strictPort: true,
    host: '0.0.0.0',
    fs: { allow: [ROOT] },
  },
  preview: { port: 5342 },
  build: {
    outDir: path.resolve(ROOT, 'dist-db'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
