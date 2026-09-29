/**
 * Cell value table: one Canvas2D texture per panel with every value that fits in its cell (font
 * sized to the cell, uniform where possible, never overlapping, black/white for contrast).
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

const MIN_CSS = 7;
const MAX_CSS = 12.5;

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

export function buildValuesTexture(panel: PanelModel, opt: ValuesTextureOptions, maxTex = 4096): ValuesLayer | null {
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

  interface Cell {
    text: string;
    cx: number;
    cy: number;
    /** World center. */
    wx: number;
    wz: number;
    fit: number;
    dark: boolean;
    /** Cell color (display sRGB): used as a halo that masks contour lines under the digits. */
    bg: string;
  }
  const cells: Cell[] = [];
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
      const cx = ((panel.xe[c] + panel.xe[c + 1]) / 2 - x0) * texPerWorld;
      const zc = (panel.ze[r] + panel.ze[r + 1]) / 2;
      const cy = (zc - z0) * texPerWorld;
      if (panel.kind === 'diff') sampleDiverging(v / Math.max(1e-6, opt.colorMax), lin);
      else sampleColormap(opt.colormap, v, opt.colorMax, lin);
      cells.push({ text, cx, cy, wx: (panel.xe[c] + panel.xe[c + 1]) / 2, wz: zc, fit, dark: relativeLuminance(lin) > 0.28, bg: linearToCss(lin) });
    }),
  );
  if (cells.length === 0) return null;
  // Nominal size: most cells share it; smaller cells shrink down to MIN_CSS, below that no label.
  const fits = cells.map((c) => c.fit).sort((a, b) => a - b);
  const nominal = Math.max(MIN_CSS, Math.min(MAX_CSS, fits[Math.floor(fits.length * 0.3)]));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const boxes: LabelBox[] = [];
  const worldPerCss = 1 / cssPerWorld;
  for (const cell of cells) {
    const fs = Math.min(nominal, cell.fit);
    if (fs < MIN_CSS) continue;
    ctx.font = `600 ${(fs * texPerCss).toFixed(2)}px ${SANS}`;
    const wCss = ctx.measureText(cell.text).width / texPerCss;
    // Digits (no descenders): ~0.74 em tall around the middle baseline.
    boxes.push({ x: cell.wx, y: 0, z: cell.wz + fs * 0.04 * worldPerCss, hw: (wCss / 2 + BOX_PAD) * worldPerCss, hh: (fs * 0.37 + BOX_PAD) * worldPerCss });
    const y = cell.cy + fs * texPerCss * 0.04;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, fs * texPerCss * 0.2);
    ctx.strokeStyle = cell.bg;
    ctx.strokeText(cell.text, cell.cx, y);
    ctx.fillStyle = cell.dark ? 'rgba(11,14,20,0.88)' : 'rgba(250,251,253,0.95)';
    ctx.fillText(cell.text, cell.cx, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return { texture: tex, boxes };
}
