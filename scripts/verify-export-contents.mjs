#!/usr/bin/env node
/**
 * End-to-end check of the export CONTENTS of the real views (docs/adr/0010, addendum "export
 * contents"): drives the header "导出" button → content list → export in headless Chromium against
 * the dev server, for the 3D terrain (single, side by side with 4 panels, difference map) and the
 * 2D chart, and checks every exported file:
 *
 * - the dialog lists the view's contents (ids, kinds, default = the frame on screen, remembered
 *   choice per view) and the file name preview equals the downloaded name;
 * - PNG size, non-blank pixels, the expected view: a top-view export made while the screen shows
 *   the 3D perspective has straight (unslanted) heatmap edges and equals the "current view" export
 *   taken after switching the screen to top view — and is close to the on-screen top view itself;
 *   side-by-side / difference contents equal the "current view" export of that layout;
 * - the on-screen view is exactly restored (screenshots before / after are identical) and the app
 *   store (hence the persisted settings) never changes during an export;
 * - videos (unless --quick): 3D intro and both 2D sweeps decode with the expected size / duration
 *   and non-black frames (frames are saved as PNGs next to the files for a visual check).
 *
 *   npx vite --port 5315 &
 *   LC_ALL=C.UTF-8 PW_MODULE=/path/to/playwright/index.mjs node scripts/verify-export-contents.mjs http://127.0.0.1:5315/ [outDir] [--quick]
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const QUICK = process.argv.includes('--quick');
const base = (args[0] || 'http://127.0.0.1:5315/').replace(/\/?$/, '/');
const outDir = args[1] || 'snap-out/export-contents';
fs.mkdirSync(outDir, { recursive: true });
const { chromium } = await import(process.env.PW_MODULE || 'playwright');

// Chromium on Linux turns a non-ASCII download name into "download" unless the locale is UTF-8.
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
const info = (msg) => console.log(`      ${msg}`);

/** Image helpers evaluated in the page (PNG decode via <img> + canvas). */
function installHelpers() {
  const load = (b64) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('PNG decode failed'));
      im.src = `data:image/png;base64,${b64}`;
    });
  const pixels = async (b64, w, h) => {
    const im = await load(b64);
    const c = document.createElement('canvas');
    c.width = w ?? im.naturalWidth;
    c.height = h ?? im.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, 0, 0, c.width, c.height);
    return { w: c.width, h: c.height, nw: im.naturalWidth, nh: im.naturalHeight, d: ctx.getImageData(0, 0, c.width, c.height).data };
  };
  const saturated = (d, i) => {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    return mx > 80 && (mx - mn) / mx > 0.3;
  };
  window.__vx = {
    /** Size, share of non-background pixels, share of saturated (data-colored) pixels. */
    async stats(b64) {
      const p = await pixels(b64);
      const bg = [p.d[0], p.d[1], p.d[2]];
      let fg = 0;
      let sat = 0;
      let n = 0;
      for (let i = 0; i < p.d.length; i += 4 * 5) {
        n++;
        if (Math.abs(p.d[i] - bg[0]) + Math.abs(p.d[i + 1] - bg[1]) + Math.abs(p.d[i + 2] - bg[2]) > 30) fg++;
        if (saturated(p.d, i)) sat++;
      }
      return { width: p.nw, height: p.nh, fg: fg / n, sat: sat / n };
    },
    /** Mean absolute difference (0–255) of two images scaled to w px wide (a's aspect), and the share of pixels off by > 48. */
    async diff(a, b, w = 480) {
      const pa0 = await pixels(a);
      const h = Math.max(1, Math.round((w * pa0.nh) / pa0.nw));
      const pa = await pixels(a, w, h);
      const pb = await pixels(b, w, h);
      let sum = 0;
      let big = 0;
      for (let i = 0; i < pa.d.length; i += 4) {
        const e = Math.abs(pa.d[i] - pb.d[i]) + Math.abs(pa.d[i + 1] - pb.d[i + 1]) + Math.abs(pa.d[i + 2] - pb.d[i + 2]);
        sum += e / 3;
        if (e / 3 > 48) big++;
      }
      return { mean: sum / (pa.d.length / 4), big: big / (pa.d.length / 4) };
    },
    /**
     * Left edge of the colored plot per row (first saturated pixel from the left) between the
     * fractions y0..y1 of the height: a top view (orthographic heatmap) has a vertical edge.
     */
    async leftEdge(b64, y0 = 0.3, y1 = 0.7) {
      const p = await pixels(b64);
      const xs = [];
      for (let y = Math.round(p.h * y0); y < Math.round(p.h * y1); y += 2) {
        for (let x = 0; x < p.w * 0.6; x++) {
          const i = (y * p.w + x) * 4;
          // two saturated pixels in a row (skip isolated anti-aliased text pixels)
          if (saturated(p.d, i) && saturated(p.d, i + 4)) {
            xs.push(x);
            break;
          }
        }
      }
      xs.sort((u, v) => u - v);
      const q = (f) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(f * (xs.length - 1))))];
      return { rows: xs.length, spread: xs.length ? q(0.95) - q(0.05) : -1, median: xs.length ? q(0.5) : -1 };
    },
  };
}

async function open(viewport = { width: 1600, height: 900 }) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(http:\/\/127\.0\.0\.1|http:\/\/localhost|data:|blob:|file:)/.test(u)) problems.push(`EXTERNAL: ${u}`);
  });
  await page.addInitScript(installHelpers);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__svm?.store.getState().ready && window.__svm3d?.model, null, { timeout: 30000 });
  // Toasts ("已导出图片 …") would differ between the before / after screenshots.
  await page.addStyleTag({ content: '[data-testid=toaster]{visibility:hidden !important}' });
  // Count app-store updates: an export must not cause any.
  await page.evaluate(() => {
    window.__storeChanges = 0;
    window.__svm.store.subscribe(() => window.__storeChanges++);
  });
  await page.waitForTimeout(1200);
  return { page, problems };
}

const b64 = (file) => fs.readFileSync(file).toString('base64');
const pngSize = (buf) => (buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

/** App settings that must never change because of an export (they are what gets persisted). */
const settingsOf = (page) =>
  page.evaluate(() => {
    const s = window.__svm.store.getState();
    const keys = ['tab', 'layout', 'view', 'representation', 'activeId', 'compareId', 'compareExtraIds', 'overlays', 'colormap', 'colorMax', 'heightCap', 'heightScale', 'sliceMode', 'sliceGray', 'sliceNits', 'axisMode', 'hiddenIds', 'clipLowGray', 'maxNits', 'lang'];
    return JSON.stringify(Object.fromEntries(keys.map((k) => [k, s[k]])));
  });

/** Screenshot of the view's canvas (pointer parked outside it). */
async function screen(page, name) {
  await page.mouse.move(4, 896);
  await page.waitForTimeout(350);
  const sel = (await page.evaluate(() => window.__svm.store.getState().tab)) === 'chart2d' ? 'canvas[role=img]' : '[data-testid=scene3d] canvas';
  const buf = await page.locator(sel).first().screenshot();
  fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
  return buf.toString('base64');
}

async function openDialog(page) {
  await page.click('[data-testid=export-button]');
  await page.waitForSelector('[data-testid=export-start]');
  await page.waitForTimeout(150);
}

/** Content list of the open dialog: [{ id, kind, checked, label }]. */
const listed = (page) =>
  page.$$eval('[data-testid=export-contents] [role=radio]', (els) =>
    els.map((e) => ({
      id: e.getAttribute('data-testid').replace('export-content-', ''),
      kind: e.getAttribute('data-kind'),
      checked: e.getAttribute('aria-checked') === 'true',
      onScreen: e.hasAttribute('data-current'),
      label: e.querySelector('.text-sm')?.textContent ?? '',
    })),
  );

/**
 * Export `id` through the dialog; returns { file, name }. Checks the dialog's file name preview,
 * that the screen is restored and that the store did not change.
 */
async function exportContent(page, id, { quality = '1080', aspect = '16:9', fps = null, tag = id, checkScreen = true } = {}) {
  const before = checkScreen ? await screen(page, `screen-${tag}-before`) : null;
  const settings = await settingsOf(page);
  await openDialog(page);
  await page.click(`[data-testid=export-content-${id}]`);
  await page.click(`[data-testid=export-quality-${quality}]`);
  if (quality !== 'window') await page.click(`[data-testid="export-aspect-${aspect}"]`);
  if (fps) {
    await page.click(`text=${fps} fps`);
    await page.waitForFunction(() => !document.querySelector('[data-testid=export-encoder]')?.textContent?.includes('检测'), null, { timeout: 30000 });
  }
  const preview = (await page.textContent('[data-testid=export-filename]')).trim();
  const changes0 = await page.evaluate(() => window.__storeChanges);
  const t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('[data-testid=export-start]')]);
  const name = dl.suggestedFilename();
  // Several contents can share a name (e.g. the frame on screen and the 3D view): keep each file.
  const file = path.join(outDir, `${tag}__${name}`);
  await dl.saveAs(file);
  await page.waitForSelector('[data-testid=export-progress]', { state: 'detached', timeout: 60000 });
  const changes = (await page.evaluate(() => window.__storeChanges)) - changes0;
  ok(name === preview, `${tag}: file name ${name} (dialog preview ${name === preview ? 'matches' : preview})`);
  ok(changes === 0 && (await settingsOf(page)) === settings, `${tag}: no app-store change during the export (${changes} updates)`);
  if (before) {
    const after = await screen(page, `screen-${tag}-after`);
    const d = await page.evaluate(([a, b]) => window.__vx.diff(a, b, 800), [before, after]);
    ok(d.mean < 0.5 && d.big < 0.001, `${tag}: on-screen view restored exactly (mean diff ${d.mean.toFixed(3)}, ${(d.big * 100).toFixed(2)} % px off) [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
  }
  return { file, name };
}

/** Size + non-blank checks of an exported PNG. */
async function checkPng(page, file, want, tag, { minSat = 0.05, minFg = 0.08 } = {}) {
  const buf = fs.readFileSync(file);
  const size = pngSize(buf);
  ok(size && size.width === want.width && size.height === want.height, `${tag}: PNG ${size?.width}x${size?.height} (want ${want.width}x${want.height})`);
  const st = await page.evaluate((b) => window.__vx.stats(b), buf.toString('base64'));
  ok(st.fg > minFg && st.sat > minSat, `${tag}: not blank (${(st.fg * 100).toFixed(1)} % drawn, ${(st.sat * 100).toFixed(1)} % data colors)`);
  return st;
}

const similar = (page, a, b, w = 480) => page.evaluate(([x, y, ww]) => window.__vx.diff(x, y, ww), [b64(a), b64(b), w]);

async function decodeVideo(page, file, type, samples, prefix) {
  const data = fs.readFileSync(file).toString('base64');
  const res = await page.evaluate(
    async ({ data, type, samples }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('video decode error ' + (v.error && v.error.code)));
      });
      const frames = [];
      for (const t of samples) {
        v.currentTime = Math.min(v.duration - 0.01, t);
        await new Promise((r) => (v.onseeked = r));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth / 2);
        c.height = Math.round(v.videoHeight / 2);
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        frames.push({ t, mean: sum / (d.length / 4) / 3, png: c.toDataURL('image/png').split(',')[1] });
      }
      return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, frames };
    },
    { data, type, samples },
  );
  for (const f of res.frames) fs.writeFileSync(path.join(outDir, `${prefix}-frame-${f.t}s.png`), Buffer.from(f.png, 'base64'));
  return res;
}

const setStore = (page, fn) => page.evaluate(fn);
/** Wait for static transitions (camera moves, cross-fades) to settle. */
const settle = (page, ms = 1600) => page.waitForTimeout(ms);

// =================================================================================== 3D
{
  const { page, problems } = await open();
  const viewSize = await page.evaluate(() => window.__svm3d.screenSize());
  info(`3D canvas drawing buffer ${viewSize.width}x${viewSize.height}`);

  // --- single layout, perspective on screen ------------------------------------------------
  await setStore(page, () => {
    const s = window.__svm.store.getState();
    s.setComparePanels(s.records.slice(0, 4).map((r) => r.id)); // A, B + C, D configured
    s.patch({ layout: 'single', view: 'perspective', representation: 'surface' });
  });
  await settle(page);
  await openDialog(page);
  let items = await listed(page);
  ok(
    items.map((c) => `${c.id}:${c.kind}`).join(',') === 'current:image,top:image,perspective:image,sideBySide:image,diff:image,intro:video',
    `3D single: contents ${items.map((c) => c.id).join(', ')}`,
  );
  ok(items.find((c) => c.checked)?.id === 'current', '3D single: "当前画面" selected by default');
  ok(items.filter((c) => c.onScreen).map((c) => c.id).join(',') === 'current,perspective', `3D single: on screen = ${items.filter((c) => c.onScreen).map((c) => c.id).join(', ')}`);
  ok(items.find((c) => c.id === 'sideBySide')?.label === '并排对比 4 条（俯视）', `3D single: side-by-side label "${items.find((c) => c.id === 'sideBySide')?.label}"`);
  await page.click('[data-testid=export-content-diff]');
  await page.screenshot({ path: path.join(outDir, 'dialog-3d-single.png') });
  await page.keyboard.press('Escape');

  const W = { quality: 'window' };
  const cur = await exportContent(page, 'current', { ...W, tag: '3d-single-current' });
  await checkPng(page, cur.file, viewSize, '3d-single-current');
  const top = await exportContent(page, 'top', { ...W, tag: '3d-single-top' });
  await checkPng(page, top.file, viewSize, '3d-single-top');
  ok(/_俯视_\d+x\d+\.png$/.test(top.name), `3d-single-top: name says top view (${top.name})`);
  const persp = await exportContent(page, 'perspective', { ...W, tag: '3d-single-perspective' });
  await checkPng(page, persp.file, viewSize, '3d-single-perspective');
  const sbs = await exportContent(page, 'sideBySide', { tag: '3d-single-sideBySide4' });
  await checkPng(page, sbs.file, { width: 1920, height: 1080 }, '3d-single-sideBySide4');
  ok(/_vs_.*_\+2_曲面_俯视_1920x1080\.png$/.test(sbs.name), `3d-single-sideBySide4: name lists A vs B +2, top view (${sbs.name})`);
  const diff = await exportContent(page, 'diff', { tag: '3d-single-diff' });
  await checkPng(page, diff.file, { width: 1920, height: 1080 }, '3d-single-diff');
  ok(/^diff_.*_vs_.*_俯视_1920x1080\.png$/.test(diff.name), `3d-single-diff: name (${diff.name})`);

  // The "current view" export of perspective (default pose) = the 3D content.
  let d = await similar(page, cur.file, persp.file);
  ok(d.mean < 0.5, `3d-single: perspective content equals the current frame in the default pose (mean diff ${d.mean.toFixed(3)})`);
  // No perspective slant in the top-view export; a slanted edge in the perspective one.
  const eTop = await page.evaluate((b) => window.__vx.leftEdge(b), b64(top.file));
  const ePersp = await page.evaluate((b) => window.__vx.leftEdge(b), b64(persp.file));
  ok(eTop.rows > 50 && eTop.spread <= 3, `3d-single-top: heatmap left edge is vertical (spread ${eTop.spread} px over ${eTop.rows} rows)`);
  ok(ePersp.spread > 20, `3d-single-perspective: slanted terrain edge (spread ${ePersp.spread} px) — the check tells the views apart`);
  // Top view on screen: its "current view" export equals the top content exported from perspective.
  const perspScreen = await screen(page, 'screen-3d-single-perspective');
  await setStore(page, () => window.__svm.store.getState().set('view', 'top'));
  await settle(page);
  const topScreen = await screen(page, 'screen-3d-single-top');
  const curTop = await exportContent(page, 'current', { ...W, tag: '3d-single-current-top' });
  d = await similar(page, top.file, curTop.file, 960);
  ok(d.mean < 0.5 && d.big < 0.001, `3d-single-top: equals the current-view export with the screen in top view (mean diff ${d.mean.toFixed(3)})`);
  // …and it looks like the on-screen top view (which keeps room for the viewport controls).
  const vsTop = await page.evaluate(([a, b]) => window.__vx.diff(a, b, 320), [b64(top.file), topScreen]);
  const vsPersp = await page.evaluate(([a, b]) => window.__vx.diff(a, b, 320), [b64(top.file), perspScreen]);
  ok(vsTop.mean < vsPersp.mean * 0.5, `3d-single-top: close to the on-screen top view (mean diff ${vsTop.mean.toFixed(1)}) vs the perspective screen (${vsPersp.mean.toFixed(1)})`);
  await openDialog(page);
  items = await listed(page);
  ok(items.filter((c) => c.onScreen).map((c) => c.id).join(',') === 'current,top', `3D top on screen: on screen = ${items.filter((c) => c.onScreen).map((c) => c.id).join(', ')}`);
  await page.keyboard.press('Escape');

  // --- side by side, 4 panels on screen --------------------------------------------------------
  await setStore(page, () => window.__svm.store.getState().patch({ layout: 'sideBySide', view: 'perspective' }));
  await settle(page, 2200);
  await openDialog(page);
  items = await listed(page);
  ok(items.map((c) => c.id).join(',') === 'current,top,perspective,diff,intro', `3D side by side: contents ${items.map((c) => c.id).join(', ')}`);
  await page.screenshot({ path: path.join(outDir, 'dialog-3d-sideBySide.png') });
  await page.keyboard.press('Escape');
  const sbsTop = await exportContent(page, 'top', { tag: '3d-sbs4-top' });
  await checkPng(page, sbsTop.file, { width: 1920, height: 1080 }, '3d-sbs4-top');
  d = await similar(page, sbsTop.file, sbs.file, 960);
  ok(d.mean < 0.5, `3d-sbs4-top: equals the side-by-side content exported from the single layout (mean diff ${d.mean.toFixed(3)})`);
  const sbsPortrait = await exportContent(page, 'top', { aspect: '9:16', tag: '3d-sbs4-top-portrait' });
  await checkPng(page, sbsPortrait.file, { width: 1080, height: 1920 }, '3d-sbs4-top-portrait');
  const sbsPersp = await exportContent(page, 'perspective', { tag: '3d-sbs4-perspective' });
  await checkPng(page, sbsPersp.file, { width: 1920, height: 1080 }, '3d-sbs4-perspective');
  const sbsCur = await exportContent(page, 'current', { tag: '3d-sbs4-current' });
  d = await similar(page, sbsPersp.file, sbsCur.file, 960);
  ok(d.mean < 0.5, `3d-sbs4: 3D content equals the current frame (default pose on screen) (mean diff ${d.mean.toFixed(3)})`);
  // Zoomed + orbited on screen: "current" keeps the user's framing, "top" / "3D" use the default pose.
  await page.evaluate(() => {
    const e = window.__svm3d;
    e.controls.view.theta += 0.5;
    e.controls.view.zoom = 0.6;
    e.controls.reset(e.controls.view);
    e.invalidate();
  });
  await settle(page, 800);
  const zoomCur = await exportContent(page, 'current', { tag: '3d-sbs4-zoomed-current' });
  const zoomPersp = await exportContent(page, 'perspective', { tag: '3d-sbs4-zoomed-perspective' });
  d = await similar(page, zoomPersp.file, sbsPersp.file, 960);
  const dz = await similar(page, zoomCur.file, sbsPersp.file, 960);
  ok(d.mean < 0.5 && dz.mean > 3, `3d-sbs4 zoomed: 3D content ignores the user's zoom / orbit (diff ${d.mean.toFixed(3)}), current frame keeps it (diff ${dz.mean.toFixed(1)})`);
  await page.evaluate(() => window.__svm3d.fitView());
  await settle(page);
  const sbsDiff = await exportContent(page, 'diff', { tag: '3d-sbs4-diff' });
  d = await similar(page, sbsDiff.file, diff.file, 960);
  ok(d.mean < 0.5, `3d-sbs4-diff: equals the difference content exported from the single layout (mean diff ${d.mean.toFixed(3)})`);

  // --- difference map on screen ---------------------------------------------------------------
  await setStore(page, () => window.__svm.store.getState().patch({ layout: 'diff', view: 'top' }));
  await settle(page, 2200);
  await openDialog(page);
  items = await listed(page);
  ok(items.map((c) => c.id).join(',') === 'current,top,perspective,sideBySide,intro', `3D difference: contents ${items.map((c) => c.id).join(', ')}`);
  // The last choice ("diff") is not offered here: the dialog falls back to the frame on screen.
  ok(items.find((c) => c.checked)?.id === 'current', `3D difference: remembered "diff" unavailable → "当前画面" preselected (${items.find((c) => c.checked)?.id})`);
  await page.keyboard.press('Escape');
  const diffCur = await exportContent(page, 'current', { tag: '3d-diff-current' });
  d = await similar(page, diffCur.file, diff.file, 960);
  ok(d.mean < 0.5, `3d-diff: current frame (top view on screen) equals the difference content (mean diff ${d.mean.toFixed(3)})`);
  const diffSbs = await exportContent(page, 'sideBySide', { tag: '3d-diff-sideBySide4' });
  d = await similar(page, diffSbs.file, sbs.file, 960);
  ok(d.mean < 0.5, `3d-diff-sideBySide4: equals the side-by-side content (mean diff ${d.mean.toFixed(3)})`);

  // --- intro open and paused: static contents render the static view, the screen keeps the intro --
  await setStore(page, () => window.__svm.store.getState().patch({ layout: 'single', view: 'perspective' }));
  await settle(page);
  await page.evaluate(() => window.__svm.store.getState().requestPlay('scene3d'));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const tl = window.__svm.timeline();
    tl.pause();
    tl.seek(5);
  });
  await page.waitForTimeout(600);
  await openDialog(page);
  const introDetail = await page.textContent('[data-testid=export-content-current] .text-2xs');
  ok(/5\.0/.test(introDetail), `3D intro paused: current frame described as the intro frame ("${introDetail}")`);
  await page.keyboard.press('Escape');
  const introTop = await exportContent(page, 'top', { ...W, tag: '3d-intro-paused-top' });
  d = await similar(page, introTop.file, top.file, 960);
  ok(d.mean < 0.5, `3d-intro-paused-top: static top view, not the intro frame (mean diff to the top content ${d.mean.toFixed(3)})`);
  const introFrame = await exportContent(page, 'current', { ...W, tag: '3d-intro-paused-current' });
  ok(/_开场动画_5\.0s_/.test(introFrame.name), `3d-intro-paused-current: intro frame name (${introFrame.name})`);
  const tlAfter = await page.evaluate(() => ({ t: window.__svm.timeline()?.time, playing: window.__svm.timeline()?.playing }));
  ok(tlAfter.t === 5 && !tlAfter.playing, `3D intro paused: timeline untouched after the exports (t = ${tlAfter.t}, playing ${tlAfter.playing})`);
  await page.evaluate(() => window.__svm.store.getState().requestStop('scene3d'));
  await settle(page);

  // --- values overlay on: the top-view export prints the value table like the top view on screen --
  await setStore(page, () => window.__svm.store.getState().patch({ layout: 'single', view: 'perspective' }));
  await settle(page);
  const plain = await exportContent(page, 'top', { quality: '1440', tag: '3d-top-values-off' });
  await setStore(page, () => {
    const s = window.__svm.store.getState();
    s.set('overlays', { ...s.overlays, values: true });
  });
  await settle(page, 800);
  const vals = await exportContent(page, 'top', { quality: '1440', tag: '3d-top-values-on' });
  d = await similar(page, vals.file, plain.file, 1280);
  ok(d.mean > 0.3, `3d-top-values: value table drawn in the top-view export (mean diff to values off ${d.mean.toFixed(2)})`);
  await setStore(page, () => window.__svm.store.getState().set('view', 'top'));
  await settle(page);
  const valsCur = await exportContent(page, 'current', { quality: '1440', tag: '3d-top-values-current' });
  d = await similar(page, vals.file, valsCur.file, 1280);
  ok(d.mean < 0.5, `3d-top-values: equals the current-view export with the screen in top view (mean diff ${d.mean.toFixed(3)})`);
  await setStore(page, () => {
    const s = window.__svm.store.getState();
    s.patch({ overlays: { ...s.overlays, values: false }, view: 'perspective' });
  });
  await settle(page);

  // --- intro video from the side-by-side layout (record A alone) ---------------------------------
  if (!QUICK) {
    await setStore(page, () => window.__svm.store.getState().patch({ layout: 'sideBySide', view: 'perspective' }));
    await settle(page, 2200);
    const vid = await exportContent(page, 'intro', { fps: 30, tag: '3d-intro-video' });
    ok(/_开场动画_1920x1080_30fps\.(mp4|webm)$/.test(vid.name) && !/_vs_/.test(vid.name), `3d-intro-video: named after record A (${vid.name})`);
    const v = await decodeVideo(page, vid.file, vid.name.endsWith('.webm') ? 'video/webm' : 'video/mp4', [1, 4, 7, 10, 13.1], '3d-intro');
    const introDur = await page.evaluate(() => window.__svm3dExport().animation('intro').duration);
    const want = (Math.round(introDur * 30) + 1) / 30;
    ok(v.width === 1920 && v.height === 1080 && Math.abs(v.duration - want) < 0.1, `3d-intro-video: ${v.width}x${v.height}, ${v.duration.toFixed(3)} s (expect ${want.toFixed(3)})`);
    ok(v.frames.every((f) => f.mean > 8), `3d-intro-video: frames not black (${v.frames.map((f) => `${f.t}s ${f.mean.toFixed(1)}`).join(', ')})`);
    ok((await page.evaluate(() => window.__svm.store.getState().layout)) === 'sideBySide', '3d-intro-video: the screen keeps its side-by-side layout');
  }
  ok(problems.length === 0, `3D: no page problems ${problems.join(' | ')}`);
  await page.close();
}

// =================================================================================== 2D
{
  const { page, problems } = await open();
  await setStore(page, () => window.__svm.store.getState().patch({ tab: 'chart2d', sliceMode: 'gray', sliceGray: 127, sliceNits: 100, axisMode: 'standard' }));
  await settle(page, 1200);
  await openDialog(page);
  const items = await listed(page);
  ok(
    items.map((c) => `${c.id}:${c.kind}`).join(',') === 'current:image,graySlice:image,levelSlice:image,graySweep:video,levelSweep:video',
    `2D: contents ${items.map((c) => c.id).join(', ')}`,
  );
  ok(items.find((c) => c.checked)?.id === 'current', '2D: "当前画面" selected by default');
  ok(items[1].label === '灰阶截面 G127' && items[2].label === '亮度截面 100 nits', `2D: slice labels "${items[1].label}", "${items[2].label}"`);
  await page.click('[data-testid=export-content-graySweep]');
  await page.screenshot({ path: path.join(outDir, 'dialog-2d.png') });
  await page.keyboard.press('Escape');

  const cur = await exportContent(page, 'current', { tag: '2d-current' });
  await checkPng(page, cur.file, { width: 1920, height: 1080 }, '2d-current', { minSat: 0.002, minFg: 0.01 });
  const gray = await exportContent(page, 'graySlice', { tag: '2d-graySlice' });
  await checkPng(page, gray.file, { width: 1920, height: 1080 }, '2d-graySlice', { minSat: 0.002, minFg: 0.01 });
  ok(gray.name === 'SVM_2D_G127_1920x1080.png', `2d-graySlice: name ${gray.name}`);
  let d = await similar(page, cur.file, gray.file, 960);
  ok(d.mean < 0.2, `2d: gray slice on screen = the gray-slice content (mean diff ${d.mean.toFixed(3)})`);
  const level = await exportContent(page, 'levelSlice', { tag: '2d-levelSlice' });
  await checkPng(page, level.file, { width: 1920, height: 1080 }, '2d-levelSlice', { minSat: 0.002, minFg: 0.01 });
  ok(level.name === 'SVM_2D_100nits_1920x1080.png', `2d-levelSlice: name ${level.name}`);
  d = await similar(page, level.file, gray.file, 960);
  ok(d.mean > 2, `2d-levelSlice: a different chart than the gray slice (mean diff ${d.mean.toFixed(1)})`);
  // The brightness slice on screen: its current frame equals the content rendered by override.
  await setStore(page, () => window.__svm.store.getState().set('sliceMode', 'brightness'));
  await settle(page, 800);
  await openDialog(page);
  ok((await listed(page)).find((c) => c.checked)?.id === 'levelSlice', '2D: remembered choice "levelSlice" preselected');
  await page.keyboard.press('Escape');
  const levelCur = await exportContent(page, 'current', { tag: '2d-level-current' });
  d = await similar(page, levelCur.file, level.file, 960);
  ok(d.mean < 0.2, `2d: brightness slice on screen = the brightness-slice content rendered by override (mean diff ${d.mean.toFixed(3)})`);
  const levelPortrait = await exportContent(page, 'graySlice', { aspect: '9:16', tag: '2d-graySlice-portrait' });
  await checkPng(page, levelPortrait.file, { width: 1080, height: 1920 }, '2d-graySlice-portrait', { minSat: 0.002, minFg: 0.01 });
  await setStore(page, () => window.__svm.store.getState().set('sliceMode', 'gray'));
  await settle(page, 800);

  if (!QUICK) {
    for (const [id, want] of [
      ['graySweep', 'SVM_2D_sweep_G255-G50_1920x1080_30fps'],
      ['levelSweep', 'SVM_2D_sweep_500-2nits_1920x1080_30fps'],
    ]) {
      const vid = await exportContent(page, id, { fps: 30, tag: `2d-${id}` });
      ok(vid.name.startsWith(want), `2d-${id}: name ${vid.name}`);
      const v = await decodeVideo(page, vid.file, vid.name.endsWith('.webm') ? 'video/webm' : 'video/mp4', [0.5, 5, 9.9], `2d-${id}`);
      ok(v.width === 1920 && v.height === 1080 && Math.abs(v.duration - 301 / 30) < 0.1, `2d-${id}: ${v.width}x${v.height}, ${v.duration.toFixed(3)} s (expect 10.033)`);
      ok(v.frames.every((f) => f.mean > 8), `2d-${id}: frames not black (${v.frames.map((f) => `${f.t}s ${f.mean.toFixed(1)}`).join(', ')})`);
    }
  }
  ok((await page.evaluate(() => window.__svm.store.getState().sliceMode)) === 'gray', '2D: slice mode on screen unchanged');
  ok(problems.length === 0, `2D: no page problems ${problems.join(' | ')}`);
  await page.close();
}

// =================================================================================== header button
{
  const { page, problems } = await open();
  const title3d = await page.getAttribute('[data-testid=export-button] >> xpath=..', 'title');
  ok(/俯视|并排/.test(title3d ?? ''), `header: 3D tooltip lists the choices ("${title3d}")`);
  await page.evaluate(() => window.__svm.store.getState().set('tab', 'chart2d'));
  await page.waitForTimeout(400);
  const title2d = await page.getAttribute('[data-testid=export-button] >> xpath=..', 'title');
  ok(/截面|扫描/.test(title2d ?? ''), `header: 2D tooltip lists the choices ("${title2d}")`);
  ok(problems.length === 0, `header: no page problems ${problems.join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall export-content checks passed');
process.exit(failures ? 1 : 0);
