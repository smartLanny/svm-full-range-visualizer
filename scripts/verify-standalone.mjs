#!/usr/bin/env node
/**
 * Smoke-test the single-file offline build (docs/adr/0008) the way users open it: file://.
 *
 *   npm run build:standalone
 *   PW_MODULE=/path/to/playwright/index.mjs node scripts/verify-standalone.mjs [release/SVM-Visualizer.html] [outDir]
 *
 * Checks: page loads with no page errors, no failed or network requests, all bundled records
 * are present, WebCodecs is available (file:// is a secure context), settings persist across a
 * reload through IndexedDB, and the app still starts silently when IndexedDB is unavailable.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const file = path.resolve(process.argv[2] || 'release/SVM-Visualizer.html');
const outDir = process.argv[3] || 'snap-out/standalone';
fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(file)) {
  console.error(`not found: ${file} (run npm run build:standalone)`);
  process.exit(2);
}
const url = pathToFileURL(file).href;
const manifest = JSON.parse(fs.readFileSync(path.resolve('public/datasets/manifest.json'), 'utf8'));
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
const browser = await chromium.launch({
  args: ['--no-proxy-server', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function watch(page) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text().slice(0, 200)}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url().slice(0, 120)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(data:|blob:|file:)/.test(u)) problems.push(`NETWORK REQUEST: ${u}`);
    else if (u.startsWith('file:') && u.split('#')[0] !== url) problems.push(`LOCAL FILE REQUEST: ${u}`);
  });
  return problems;
}

const ready = (page) => page.waitForFunction(() => window.__svm?.store.getState().ready === true, null, { timeout: 30000 });
const recordCount = (page) => page.evaluate(() => window.__svm.store.getState().records.length);

// 1. Fresh load + persistence across reload (same browser profile).
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const problems = watch(page);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await ready(page);
  ok(true, `loaded from ${url} in ${Date.now() - t0} ms`);
  const n = await recordCount(page);
  ok(n === manifest.length, `${n} bundled records present (expect ${manifest.length})`);
  ok(await page.evaluate(() => isSecureContext && typeof VideoEncoder === 'function'), 'file:// is a secure context with WebCodecs');
  ok(await page.evaluate(() => (document.querySelector('link[rel=icon]')?.getAttribute('href') || '').startsWith('data:image/svg+xml')), 'favicon is an inline data URI');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'standalone.png') });

  await page.evaluate(() => {
    const s = window.__svm.store.getState();
    s.set('lang', 'en');
    s.set('sliceGray', 64);
  });
  await page.waitForTimeout(1200); // auto-save is debounced (400 ms)
  await page.reload({ waitUntil: 'load' });
  await ready(page);
  const persisted = await page.evaluate(() => {
    const s = window.__svm.store.getState();
    return { lang: s.lang, sliceGray: s.sliceGray };
  });
  ok(persisted.lang === 'en' && persisted.sliceGray === 64, `settings persisted across reload via IndexedDB (${JSON.stringify(persisted)})`);
  await page.screenshot({ path: path.join(outDir, 'standalone-en.png') });
  ok(problems.length === 0, `no errors / requests: ${problems.join(' | ') || 'none'}`);
  await context.close();
}

// 2. IndexedDB unavailable (e.g. locked-down browser): must degrade silently.
{
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(url, { waitUntil: 'load' });
  await ready(page);
  const n = await recordCount(page);
  ok(n === manifest.length, `without IndexedDB: ${n} records, app ready`);
  ok(problems.length === 0, `without IndexedDB: no errors: ${problems.join(' | ') || 'none'}`);
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nstandalone checks passed');
process.exit(failures ? 1 : 0);
