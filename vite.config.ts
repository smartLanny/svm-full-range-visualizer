import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * index.html tweaks per build flavour (docs/adr/0008):
 * - standalone: the favicon becomes an inline data URI (the single HTML file references nothing).
 * - web / dev: link the web app manifest + touch icon (installable hosted build). Not in the
 *   standalone file: from file:// the manifest fetch would be blocked and log an error.
 */
function htmlFlavour(standalone: boolean): Plugin {
  return {
    name: 'svm:html-flavour',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (standalone) {
          const svg = fs.readFileSync(path.resolve(__dirname, 'public/icon.svg'));
          const uri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
          return html.replace(/href="(?:\.\/|\/)?icon\.svg"/g, `href="${uri}"`);
        }
        return html.replace(
          '</head>',
          '  <link rel="manifest" href="./manifest.webmanifest" />\n    <link rel="apple-touch-icon" href="./icon-192.png" />\n  </head>',
        );
      },
    },
  };
}

/**
 * Standalone-only size trims (docs/adr/0008). The single HTML file inlines every asset (fonts as
 * base64, +33 %), so every unused byte ships:
 * - @fontsource CSS lists a .woff fallback after each .woff2. Every browser that can run the app
 *   (ES modules, WebGL2, WebCodecs) uses woff2, so the woff sources are dropped and never inlined.
 * - Bundled datasets carry each measurement twice: the flat `data` list and `matrix.grid`.
 *   validateDataset() (src/data/records.ts) always rebuilds `data` from the grid, so only the grid
 *   (plus `excluded` and the metadata) is embedded.
 */
function standaloneTrim(): Plugin {
  const fontCss = /[\\/]@fontsource[\\/][^?]*\.css(?:\?|$)/;
  const dataset = /[\\/]public[\\/]datasets[\\/](?!manifest\.json)[^/\\?]+\.json(?:\?|$)/;
  return {
    name: 'svm:standalone-trim',
    enforce: 'pre',
    transform(code, id) {
      if (fontCss.test(id)) {
        return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\((['"])woff\1\)/g, ''), map: null };
      }
      if (dataset.test(id)) {
        const { data: _flat, ...rest } = JSON.parse(code) as Record<string, unknown>;
        return { code: JSON.stringify(rest), map: null };
      }
      return null;
    },
  };
}

// Modes: default web build (`vite build`, datasets fetched from ./datasets at runtime) and
// "standalone" (`npm run build:standalone`): one self-contained offline HTML file with every
// script, style, font, icon and bundled dataset inlined; finalized by scripts/finalize-standalone.mjs.
export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  return {
    base: './',
    // Separate dep-optimizer caches let several dev servers share one node_modules.
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    // The standalone file embeds datasets through src/data/bundledEmbedded.ts; nothing is copied.
    publicDir: standalone ? false : 'public',
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      htmlFlavour(standalone),
      ...(standalone ? [standaloneTrim(), viteSingleFile({ removeViteModuleLoader: true })] : []),
    ],
    define: {
      'import.meta.env.VITE_STANDALONE': JSON.stringify(standalone ? '1' : ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: standalone
      ? {
          outDir: 'dist-standalone',
          emptyOutDir: true,
          assetsInlineLimit: 100_000_000,
          cssCodeSplit: false,
          modulePreload: false,
          reportCompressedSize: false,
          chunkSizeWarningLimit: 100_000,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {
          chunkSizeWarningLimit: 4000,
        },
  };
});
