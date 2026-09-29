/**
 * Cell value table: one Canvas2D texture per panel. One decision per layout (chooseValueFont): a
 * uniform font for every cell that holds it, or no values at all (never a few stray numbers);
 * never overlapping, black/white for contrast.
 */
import * as THREE from 'three';
import { ColormapType } from '../../types';
import { linearToCss, relativeLuminance, sampleColormap, sampleDiverging } from '../../colormaps';
import type { PanelModel } from './model';
import type { LabelBox } from './contours';
import { SANS } from './text';

export interface ValuesTextureOptions {
  /** World units per CSS px in the top-view fit. */
  worldPerCssPx: number;
  /** Device px per CSS px. */
  pxScale: number;
  colormap: ColormapType;
  /** svm: colorMax; diff: symmetric range. */
  colorMax: number;
  /** Bars shrink cells by this fraction (text must fit the bar top). */
  inset: number;
}

export function formatCellValue(v: number, kind: 'svm' | 'diff'): string {
  const a = Math.abs(v);
  const s = a >= 10 ? a.toFixed(1) : a.toFixed(2);
  // Sign follows the ROUNDED value, so a tiny difference never prints as "+0.00" / "−0.00".
  const zero = Number(s) === 0;
  if (kind === 'diff') return zero ? s : v > 0 ? `+${s}` : `−${s}`;
  return v < 0 && !zero ? `−${s}` : s;
}

/** Smallest printed size (CSS px): below it a value is not legible. */
export const MIN_CSS = 7;
const MAX_CSS = 12.5;
/** A uniform size is chosen so that at least this share of every panel's cells fit it... */
const TARGET_SHARE = 0.8;
/** ...and the table is shown only if at least this share of every panel's cells fit MIN_CSS. */
export const MIN_SHARE = 0.6;

export interface ValuesLayer {
  texture: THREE.CanvasTexture;
  /**
   * World boxes (xz) of the printed values, padded by ~4 CSS px: contour lines are cut here while
   * the value table shows, so no line ever crosses a number (docs/adr/0002).
   */
  boxes: LabelBox[];
}

/** Padding (CSS px) around a printed value that contour lines keep clear of. */
const BOX_PAD = 4;

/** One printable cell: text, world / CSS geometry and the largest font (CSS px) it can hold. */
export interface ValueCell {
  text: string;
  /** World center. */
  wx: number;
  wz: number;
  /** Largest font size (CSS px) that fits the cell. */
  fit: number;
  dark: boolean;
  /** Cell color (display sRGB): used as a halo that masks contour lines under the digits. */
  bg: string;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Every valid cell of a panel with the font size it can hold at the given top-view scale. */
export function measureValueCells(panel: PanelModel, opt: ValuesTextureOptions): ValueCell[] {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return [];
  const cssPerWorld = 1 / Math.max(1e-6, opt.worldPerCssPx);
  const cells: ValueCell[] = [];
  ctx.font = `600 10px ${SANS}`;
  const lin: [number, number, number] = [0, 0, 0];
  panel.values.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === null) return;
      const text = formatCellValue(v, panel.kind);
      const wCss = (panel.xe[c + 1] - panel.xe[c]) * cssPerWorld * (1 - opt.inset);
      const hCss = Math.abs(panel.ze[r + 1] - panel.ze[r]) * cssPerWorld * (1 - opt.inset);
      const w10 = ctx.measureText(text).width; // at 10 px
      const fit = Math.min(hCss * 0.6, ((wCss - 3) * 0.9 * 10) / Math.max(1, w10));
      const zc = (panel.ze[r] + panel.ze[r + 1]) / 2;
      if (panel.kind === 'diff') sampleDiverging(v / Math.max(1e-6, opt.colorMax), lin);
      else sampleColormap(opt.colormap, v, opt.colorMax, lin);
      cells.push({ text, wx: (panel.xe[c] + panel.xe[c + 1]) / 2, wz: zc, fit, dark: relativeLuminance(lin) > 0.28, bg: linearToCss(lin) });
    }),
  );
  return cells;
}

/** Share (0..1) of `fits` that hold a font of `size`. */
const shareAt = (fits: readonly number[], size: number) => (fits.length ? fits.filter((f) => f >= size - 1e-9).length / fits.length : 1);

/**
 * One decision for the whole layout (docs/adr/0002): a single uniform font size for every panel,
 * or none. The size is the largest (≤ 12.5 CSS px) that at least 80 % of every panel's cells can
 * hold; when even the minimum legible size (7 px) fits fewer than 60 % of some panel's cells, no
 * value is printed anywhere (a handful of stray numbers reads as a rendering error) and the view
 * shows a hint instead. Panels without cells do not take part.
 */
export function chooseValueFont(fitsPerPanel: readonly (readonly number[])[]): { size: number | null; share: number } {
  const panels = fitsPerPanel.filter((f) => f.length > 0);
  if (panels.length === 0) return { size: null, share: 0 };
  let size = MAX_CSS;
  for (const fits of panels) {
    const sorted = [...fits].sort((a, b) => a - b);
    const k = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * (1 - TARGET_SHARE) + 1e-9)));
    size = Math.min(size, sorted[k]);
  }
  if (size >= MIN_CSS) return { size, share: Math.min(...panels.map((f) => shareAt(f, size))) };
  const share = Math.min(...panels.map((f) => shareAt(f, MIN_CSS)));
  return share >= MIN_SHARE ? { size: MIN_CSS, share } : { size: null, share };
}

/** Draw the cells that hold `size` (CSS px, uniform) into one texture for the panel. */
export function drawValuesTexture(panel: PanelModel, cells: readonly ValueCell[], size: number, opt: ValuesTextureOptions, maxTex = 4096): ValuesLayer | null {
  const { x0, x1, z0, z1 } = panel.rect;
  const cssPerWorld = 1 / Math.max(1e-6, opt.worldPerCssPx);
  // Texture density: device px with 2x headroom for zooming in, capped.
  let texPerWorld = cssPerWorld * opt.pxScale * 2;
  const Wt = (x1 - x0) * texPerWorld;
  const Ht = (z1 - z0) * texPerWorld;
  const shrink = Math.min(1, maxTex / Math.max(Wt, Ht));
  texPerWorld *= shrink;
  const W = Math.max(4, Math.round((x1 - x0) * texPerWorld));
  const H = Math.max(4, Math.round((z1 - z0) * texPerWorld));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const texPerCss = texPerWorld / cssPerWorld;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const boxes: LabelBox[] = [];
  const worldPerCss = 1 / cssPerWorld;
  const fs = size;
  ctx.font = `600 ${(fs * texPerCss).toFixed(2)}px ${SANS}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, fs * texPerCss * 0.2);
  for (const cell of cells) {
    if (cell.fit < fs - 1e-9) continue;
    const wCss = ctx.measureText(cell.text).width / texPerCss;
    // Digits (no descenders): ~0.74 em tall around the middle baseline.
    boxes.push({ x: cell.wx, y: 0, z: cell.wz + fs * 0.04 * worldPerCss, hw: (wCss / 2 + BOX_PAD) * worldPerCss, hh: (fs * 0.37 + BOX_PAD) * worldPerCss });
    const cx = (cell.wx - x0) * texPerWorld;
    const y = (cell.wz - z0) * texPerWorld + fs * texPerCss * 0.04;
    ctx.strokeStyle = cell.bg;
    ctx.strokeText(cell.text, cx, y);
    ctx.fillStyle = cell.dark ? 'rgba(11,14,20,0.88)' : 'rgba(250,251,253,0.95)';
    ctx.fillText(cell.text, cx, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return { texture: tex, boxes };
}
