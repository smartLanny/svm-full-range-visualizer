#!/usr/bin/env node
/**
 * Visual smoke test helper: open the app in headless Chromium and take screenshots.
 *
 *   node scripts/dev/snap.mjs <url> <outDir> [steps.json]
 *
 * steps.json (optional) is an array of steps executed in order:
 *   { "wait": 1500 }                                  wait ms
 *   { "click": "text=俯视" } / { "click": "[data-testid=x]" }   Playwright selector
 *   { "eval": "window.__svmDebug?.seek(3)" }          run JS in the page
 *   { "key": "Space" }                                press a key
 *   { "shot": "name" }                                screenshot -> <outDir>/name.png
 *   { "viewport": [1920, 1080] }                      resize
 * Without steps it takes one screenshot "page.png" after 3 s.
 *
 * Console errors / page errors / failed requests are printed at the end.
 * Environment: set PW_MODULE to the playwright module path if it is not resolvable
 * (e.g. /opt/node22/lib/node_modules/playwright/index.mjs).
 */
import fs from 'fs';
import path from 'path';

const [url, outDir = 'snap-out', stepsFile] = process.argv.slice(2);
if (!url) {
  console.error('usage: snap.mjs <url> <outDir> [steps.json]');
  process.exit(2);
}
const pwPath = process.env.PW_MODULE || 'playwright';
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ wait: 3000 }, { shot: 'page' }];

const browser = await chromium.launch({
  args: ['--no-proxy-server', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith('http://127.0.0.1') && !u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('file:'))
    problems.push(`EXTERNAL REQUEST: ${u}`);
});
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
for (const s of steps) {
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.viewport) await page.setViewportSize({ width: s.viewport[0], height: s.viewport[1] });
  if (s.click) await page.locator(s.click).first().click({ timeout: 10000 });
  if (s.key) await page.keyboard.press(s.key);
  if (s.eval) console.log('eval ->', JSON.stringify(await page.evaluate(s.eval)));
  if (s.shot) await page.screenshot({ path: path.join(outDir, `${s.shot}.png`) });
}
console.log(problems.length ? problems.join('\n') : 'no console problems');
await browser.close();
