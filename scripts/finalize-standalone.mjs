#!/usr/bin/env node
/**
 * Second step of `npm run build:standalone` (docs/adr/0008):
 *   dist-standalone/index.html  →  release/SVM-Visualizer.html
 *
 *   node scripts/finalize-standalone.mjs [--out <file>]   (default: release/SVM-Visualizer.html)
 *
 * Fails (exit 1) if the file is not truly self-contained: any <script src>, stylesheet / icon
 * <link href> or CSS url() that points to http(s) or to a separate local file, or if the bundled
 * datasets are missing. Stamps the file with the build-input fingerprint (scripts/build-inputs.mjs)
 * that src/export/releaseFreshness.test.ts checks, plus the app version. Prints the final size.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BUILD_INPUTS_META, buildInputHash } from './build-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'dist-standalone', 'index.html');
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'release', 'SVM-Visualizer.html');
const outDir = path.dirname(out);

function fail(msg) {
  console.error(`\n✖ finalize-standalone: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(src)) fail(`${path.relative(root, src)} not found — run "vite build --mode standalone" first`);
let html = fs.readFileSync(src, 'utf8');

const problems = [];
const isInline = (u) => /^(data:|blob:|#|about:)/i.test(u.trim());

// <script src=...>
for (const m of html.matchAll(/<script\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/gi)) {
  if (!isInline(m[1])) problems.push(`<script src="${m[1]}">`);
}
// <link href=...> (stylesheet, icon, preload, manifest, …)
for (const m of html.matchAll(/<link\b[^>]*?\shref\s*=\s*["']?([^"'\s>]+)/gi)) {
  if (!isInline(m[1])) problems.push(`<link href="${m[1]}">`);
}
// CSS url(...) pointing to the network (inside inline <style> or style attributes).
for (const m of html.matchAll(/url\(\s*["']?(https?:[^"')\s]+)/gi)) problems.push(`url(${m[1]})`);
// CSS @import of remote stylesheets.
for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']?(https?:[^"')\s;]+)/gi)) problems.push(`@import ${m[1]}`);

if (problems.length) {
  fail(`external / non-inlined references found:\n  ${[...new Set(problems)].slice(0, 20).join('\n  ')}`);
}

// Bundled datasets must be embedded (src/data/bundledEmbedded.ts).
const manifestPath = path.join(root, 'public', 'datasets', 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const missing = manifest.filter((e) => !html.includes(e.file));
  if (missing.length) fail(`bundled datasets missing from the standalone build: ${missing.map((e) => e.file).join(', ')}`);
  console.log(`✓ ${manifest.length} bundled datasets embedded`);
}

// Staleness guard: fingerprint of the sources this file was built from.
const charset = /<meta\s+charset=["']?utf-8["']?\s*\/?>/i;
if (!charset.test(html)) fail('<meta charset="UTF-8"> not found in the built index.html');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const hash = buildInputHash(root);
html = html.replace(
  charset,
  (m) => `${m}\n    <meta name="${BUILD_INPUTS_META}" content="${hash}" />\n    <meta name="svm-version" content="${version}" />`,
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, html);
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`✓ no external references`);
console.log(`✓ build inputs ${hash.slice(0, 19)}…  (v${version})`);
console.log(`✓ ${path.relative(root, out)}  ${mb} MB  — double-click to open, works offline`);
