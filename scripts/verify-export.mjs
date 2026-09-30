#!/usr/bin/env node
/**
 * End-to-end check of the export module against the DEV-only mock target.
 *
 *   npx vite --port 5315 &   # dev server
 *   PW_MODULE=/path/to/playwright/index.mjs node scripts/verify-export.mjs http://127.0.0.1:5315/ [outDir]
 *
 * Drives the real UI (header "导出" button → dialog → progress modal) in headless Chromium and
 * checks: PNG dimensions, MP4 container + decoded duration/size, WebGL-canvas capture is not
 * black, cancel, render failure recovery, and the MediaRecorder fallback. The mock target has no
 * contents() (a legacy target): the dialog offers its implicit contents "current" + "animation".
 * The real views' contents are checked by scripts/verify-export-contents.mjs.
 */
import fs from 'fs';
import path from 'path';

const base = (process.argv[2] || 'http://127.0.0.1:5315/').replace(/\/?$/, '/');
const outDir = process.argv[3] || 'snap-out/export';
fs.mkdirSync(outDir, { recursive: true });
const { chromium } = await import(process.env.PW_MODULE || 'playwright');

// Chromium on Linux turns a non-ASCII download name into "download" when the process locale is
// not UTF-8 (e.g. LANG unset / C in containers); real desktops are UTF-8. Match them.
const utf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const browser = await chromium.launch({
  args: ['--no-proxy-server', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  env: utf8 ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' },
});
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

async function open(query, viewport = { width: 1600, height: 900 }) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(http:\/\/127\.0\.0\.1|http:\/\/localhost|data:|blob:|file:)/.test(u)) problems.push(`EXTERNAL: ${u}`);
  });
  await page.goto(`${base}?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mockExportState === 'idle', null, { timeout: 20000 });
  return { page, problems };
}

async function openDialog(page) {
  await page.click('[data-testid=export-button]');
  await page.waitForSelector('[data-testid=export-start]');
}

function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function decodeVideo(page, file, type) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ b64, type }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('video decode error ' + (v.error && v.error.code)));
      });
      // WebM from MediaRecorder has no duration until seeked to the end.
      if (!isFinite(v.duration)) {
        v.currentTime = 1e6;
        await new Promise((r) => (v.ontimeupdate = r));
      }
      const duration = v.duration;
      v.currentTime = Math.min(2, duration / 2);
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 36;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 64, 36);
      const d = ctx.getImageData(0, 0, 64, 36).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return { duration, width: v.videoWidth, height: v.videoHeight, meanRgb: sum / (d.length / 4) / 3 };
    },
    { b64, type },
  );
}

// --- 1. PNG presets ---------------------------------------------------------------------
{
  const { page, problems } = await open('mockExport');
  for (const [quality, aspect, expect] of [
    ['1080', '16:9', [1920, 1080]],
    ['1080', '9:16', [1080, 1920]],
    ['2160', '1:1', [2160, 2160]],
    ['window', null, null],
  ]) {
    await openDialog(page);
    // Legacy target (no contents()): the dialog offers the frame on screen + the animation.
    ok((await page.getAttribute('[data-testid=export-content-current]', 'aria-checked')) === 'true', 'legacy target: "当前画面" offered and selected by default');
    await page.click('[data-testid=export-content-current]');
    await page.click(`[data-testid=export-quality-${quality}]`);
    if (aspect) await page.click(`[data-testid="export-aspect-${aspect}"]`);
    const name = await page.textContent('[data-testid=export-filename]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=export-start]')]);
    const file = path.join(outDir, dl.suggestedFilename());
    await dl.saveAs(file);
    const size = pngSize(fs.readFileSync(file));
    const want = expect ?? name.match(/_(\d+)x(\d+)\.png$/).slice(1).map(Number);
    ok(size && size.width === want[0] && size.height === want[1], `PNG ${quality} ${aspect ?? ''} -> ${dl.suggestedFilename()} is ${size?.width}x${size?.height}`);
    ok(dl.suggestedFilename() === name, `PNG filename matches dialog preview (${name})`);
    await page.waitForFunction(() => window.__mockExportState === 'idle');
  }
  await page.screenshot({ path: path.join(outDir, 'after-png.png') });
  ok(problems.length === 0, `no page problems (PNG) ${problems.join(' | ')}`);
  await page.close();
}

// --- 2. Video, offline WebCodecs (2D and WebGL mock) ------------------------------------
for (const mode of ['mockExport', 'mockExport=webgl']) {
  const { page, problems } = await open(mode);
  await openDialog(page);
  await page.click('[data-testid=export-content-animation]');
  await page.click('[data-testid=export-quality-1080]');
  await page.click('[data-testid="export-aspect-16:9"]');
  await page.click('text=30 fps');
  await page.waitForFunction(() => !document.querySelector('[data-testid=export-encoder]')?.textContent?.includes('检测'));
  console.log('      encoder:', await page.textContent('[data-testid=export-encoder]'));
  const dlP = page.waitForEvent('download', { timeout: 300000 });
  const t0 = Date.now();
  await page.click('[data-testid=export-start]');
  await page.waitForSelector('[data-testid=export-progress]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, `progress-${mode.replace(/\W/g, '_')}.png`) });
  const dl = await dlP;
  const file = path.join(outDir, dl.suggestedFilename());
  await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  ok(buf.length > 1000 && buf.toString('latin1', 4, 8) === 'ftyp', `${mode}: ${dl.suggestedFilename()} ${buf.length} bytes, ftyp box (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const info = await decodeVideo(page, file, 'video/mp4');
  ok(Math.abs(info.duration - 121 / 30) < 0.1 && info.width === 1920 && info.height === 1080, `${mode}: decoded ${info.width}x${info.height}, ${info.duration.toFixed(3)} s (expect 4.033)`);
  ok(info.meanRgb > 10, `${mode}: frame at 2 s is not black (mean ${info.meanRgb.toFixed(1)})`);
  await page.waitForFunction(() => window.__mockExportState === 'idle');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `done-${mode.replace(/\W/g, '_')}.png`) });
  ok(problems.length === 0, `${mode}: no page problems ${problems.join(' | ')}`);
  await page.close();
}

// --- 3. Cancel ---------------------------------------------------------------------------
{
  const { page, problems } = await open('mockExport');
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await openDialog(page);
  await page.click('[data-testid=export-content-animation]');
  await page.click('[data-testid=export-quality-2160]');
  await page.click('text=60 fps');
  await page.waitForFunction(() => !document.querySelector('[data-testid=export-encoder]')?.textContent?.includes('检测'));
  await page.click('[data-testid=export-start]');
  await page.waitForFunction(() => /渲染第 \d+/.test(document.querySelector('[data-testid=export-status]')?.textContent || ''), null, { timeout: 60000 });
  await page.click('[data-testid=export-cancel]');
  await page.waitForSelector('[data-testid=export-progress]', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => window.__mockExportState);
  const toastText = await page.textContent('[role=status]').catch(() => '');
  ok(state === 'idle' && !downloaded, `cancel: target ended (${state}), no download, toast "${toastText}"`);
  ok(await page.isEnabled('[data-testid=export-button]'), 'cancel: export button enabled again');
  ok(problems.length === 0, `cancel: no page problems ${problems.join(' | ')}`);
  await page.close();
}

// --- 4. Render failure -------------------------------------------------------------------
{
  const { page, problems } = await open('mockExport&mockFail=0.5');
  await openDialog(page);
  await page.click('[data-testid=export-content-animation]');
  await page.click('[data-testid=export-quality-1080]');
  await page.click('text=30 fps');
  await page.waitForFunction(() => !document.querySelector('[data-testid=export-encoder]')?.textContent?.includes('检测'));
  await page.click('[data-testid=export-start]');
  await page.waitForSelector('[data-testid=export-progress]', { state: 'detached', timeout: 60000 });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => window.__mockExportState);
  const toastText = await page.textContent('[role=status]').catch(() => '');
  await page.screenshot({ path: path.join(outDir, 'error-toast.png') });
  ok(state === 'idle' && /mock render failure/.test(toastText), `failure: target ended (${state}), toast "${toastText}"`);
  // Only the intentional console.error from the failed export is expected.
  ok(problems.every((p) => p.includes('mock render failure')), `failure: no unexpected problems ${problems.join(' | ')}`);
  await page.close();
}

// --- 5. MediaRecorder fallback -----------------------------------------------------------
{
  const { page, problems } = await open('mockExport&exportForce=recorder', { width: 1280, height: 720 });
  await openDialog(page);
  await page.click('[data-testid=export-content-animation]');
  await page.click('[data-testid=export-quality-1080]');
  await page.click('text=30 fps');
  await page.waitForFunction(() => !document.querySelector('[data-testid=export-encoder]')?.textContent?.includes('检测'));
  await page.screenshot({ path: path.join(outDir, 'dialog-recorder.png') });
  const dlP = page.waitForEvent('download', { timeout: 120000 });
  await page.click('[data-testid=export-start]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'progress-recorder.png') });
  const dl = await dlP;
  const file = path.join(outDir, dl.suggestedFilename());
  await dl.saveAs(file);
  const type = file.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const info = await decodeVideo(page, file, type);
  // Real-time recording drops frames when the machine cannot encode fast enough (software
  // SwiftShader here), so only the container/size is asserted; the duration is informational.
  ok(info.width === 1920 && info.height === 1080 && info.duration > 0, `recorder: ${dl.suggestedFilename()} ${info.width}x${info.height} playable`);
  console.log(`      recorder duration ${info.duration.toFixed(2)} s (ideal 4.03 s; lower = frames dropped by a slow encoder)`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'done-recorder.png') });
  ok(problems.length === 0, `recorder: no page problems ${problems.join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall export checks passed');
process.exit(failures ? 1 : 0);
