#!/usr/bin/env node
/**
 * Render public/icon.svg into the raster icons (run after editing the SVG; outputs are committed):
 *   public/icon-192.png, public/icon-512.png   web app manifest / apple-touch-icon
 *   release/icon.ico                           Windows desktop shortcut (16…256 px, PNG-in-ICO)
 *
 *   PW_MODULE=/path/to/playwright/index.mjs node scripts/gen-icons.mjs
 *
 * Uses headless Chromium (Playwright) to rasterize, so no image tooling is required.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf8');
const { chromium } = await import(process.env.PW_MODULE || 'playwright');

const PNG_SIZES = [192, 512];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
const sizes = [...new Set([...PNG_SIZES, ...ICO_SIZES])];
const rendered = await page.evaluate(
  async ({ svg, sizes }) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    await img.decode();
    const out = {};
    for (const s of sizes) {
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // Render large and downscale for crisp small sizes.
      if (s < 64) {
        const big = document.createElement('canvas');
        big.width = s * 8;
        big.height = s * 8;
        big.getContext('2d').drawImage(img, 0, 0, s * 8, s * 8);
        let src = big;
        // Halve repeatedly (box filter) for good antialiasing.
        while (src.width / 2 >= s) {
          const half = document.createElement('canvas');
          half.width = src.width / 2;
          half.height = src.height / 2;
          const hctx = half.getContext('2d');
          hctx.imageSmoothingQuality = 'high';
          hctx.drawImage(src, 0, 0, half.width, half.height);
          src = half;
        }
        ctx.drawImage(src, 0, 0, s, s);
      } else {
        ctx.drawImage(img, 0, 0, s, s);
      }
      out[s] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  },
  { svg, sizes },
);
await browser.close();

const png = (s) => Buffer.from(rendered[s], 'base64');
for (const s of PNG_SIZES) {
  const file = path.join(root, 'public', `icon-${s}.png`);
  fs.writeFileSync(file, png(s));
  console.log(`✓ ${path.relative(root, file)}`);
}

// ICO container: ICONDIR + ICONDIRENTRY[] + PNG payloads (supported since Windows Vista).
const images = ICO_SIZES.map((s) => ({ s, data: png(s) }));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ s, data }, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, e); // width (0 = 256)
  header.writeUInt8(s >= 256 ? 0 : s, e + 1); // height
  header.writeUInt8(0, e + 2); // palette
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // color planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
const ico = path.join(root, 'release', 'icon.ico');
fs.writeFileSync(ico, Buffer.concat([header, ...images.map((x) => x.data)]));
console.log(`✓ ${path.relative(root, ico)} (${ICO_SIZES.join(', ')} px)`);
