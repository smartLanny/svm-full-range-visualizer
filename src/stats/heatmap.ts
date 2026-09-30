/**
 * Mini heatmap of a stats card (Canvas2D), shared by the on-screen thumbnail (Thumbnail.tsx) and
 * the stats export (exportRender.ts), so both draw exactly the same cells, hatch, contours, slice
 * marker, gray labels and ticks.
 */
import { Color } from 'three';
import type { ColormapType, SvmRecord } from '../types';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges, gridView, logNits, type GridView } from '../data/grid';
import { getJsColor } from '../colormaps';
import { plateHeight } from '../scene3d/engine/plate';

/** Shared extent of all thumbnails, so cards compare at the same scale. */
export interface ThumbExtent {
  /** log1p-nits range. */
  x0: number;
  x1: number;
  /** Gray range (bottom, top). */
  g0: number;
  g1: number;
  /** Lowest / highest measured gray in scope (axis labels). */
  grayMin: number;
  grayMax: number;
}

export function thumbExtent(records: SvmRecord[], opts: { clipLowGray: boolean; maxNits: number | null }): ThumbExtent | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let g0 = Infinity;
  let g1 = -Infinity;
  let grayMin = Infinity;
  let grayMax = -Infinity;
  for (const r of records) {
    const v = gridView(r, opts);
    if (!v.x.length || !v.grays.length) continue;
    const xe = cellEdges(v.x, 0);
    const ge = cellEdges(v.grays, 0, 255);
    x0 = Math.min(x0, xe[0]);
    x1 = Math.max(x1, xe[xe.length - 1]);
    g0 = Math.min(g0, ge[0]);
    g1 = Math.max(g1, ge[ge.length - 1]);
    grayMin = Math.min(grayMin, v.grays[0]);
    grayMax = Math.max(grayMax, v.grays[v.grays.length - 1]);
  }
  if (!Number.isFinite(x1) || !Number.isFinite(g0) || !(x1 > x0) || !(g1 > g0)) return null;
  return { x0, x1, g0, g1, grayMin, grayMax };
}

const TICK_CANDIDATES = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
/** Heatmap height (CSS px) until the thumbnail's width is known (a typical 310 px card). */
export const THUMB_DEFAULT_HEIGHT = plateHeight(242);

/**
 * Height (CSS / design px) of a heatmap `width` px wide: the plate aspect of the 3D heatmaps
 * (plate.ts, docs/adr/0002 addendum "stable heatmap proportions"), so every heatmap in the app has
 * the same shape — never the wide, flat strip a fixed height made of wide cards.
 */
export function thumbHeight(width: number): number {
  return width > 0 ? plateHeight(width) : THUMB_DEFAULT_HEIGHT;
}

/** Level-luminance ticks under a heatmap `width` px wide (at least 30 px apart). */
export function thumbTicks(width: number, extent: ThumbExtent): { v: number; px: number }[] {
  if (width <= 0) return [];
  const out: { v: number; px: number }[] = [];
  let last = -Infinity;
  for (const v of TICK_CANDIDATES) {
    const x = logNits(v);
    if (x < extent.x0 - 1e-9 || x > extent.x1 + 1e-9) continue;
    const px = ((x - extent.x0) / (extent.x1 - extent.x0)) * width;
    if (px - last < 30) continue;
    out.push({ v, px });
    last = px;
  }
  return out;
}

/**
 * Gray labels left of a heatmap `height` px tall: top and bottom measured gray, plus the current
 * slice (accent) which hides a neighbour closer than 14 px. `top` is the label's CSS top within
 * the heatmap.
 */
export function thumbGrayLabels(extent: ThumbExtent, sliceGray: number | null, height: number): { g: number; top: number; accent?: boolean }[] {
  const yOf = (g: number) => ((extent.g1 - g) / (extent.g1 - extent.g0)) * height;
  const out: { g: number; y: number; accent?: boolean }[] = [];
  const sliceY = sliceGray !== null && sliceGray >= extent.g0 && sliceGray <= extent.g1 ? yOf(sliceGray) : null;
  for (const g of [extent.grayMax, extent.grayMin]) {
    const y = yOf(g);
    if (sliceY === null || Math.abs(y - sliceY) > 14) out.push({ g, y });
  }
  if (sliceY !== null && sliceGray !== null) out.push({ g: Math.round(sliceGray), y: sliceY, accent: true });
  return out.map(({ g, y, accent }) => ({ g, top: Math.min(height - 12, Math.max(-1, y - 7)), accent }));
}

export interface DrawOpts {
  W: number;
  H: number;
  dpr: number;
  colormap: ColormapType;
  colorMax: number;
  sliceGray: number | null;
  extent: ThumbExtent;
}

/** Flat background outside the record's measured cells (not measured at all). */
const OUTSIDE = '#0b0e14';
/** Neutral "no valid data" hatch: mid-grey diagonal lines, unlike any colormap end. */
export const HATCH_BASE = '#1b2029';
export const HATCH_LINE = 'rgba(255,255,255,0.24)';

let hatch: { key: number; pattern: CanvasPattern | null } | null = null;

/** The "no valid data" hatch as a pattern (tile scaled by dpr), cached. */
export function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  if (hatch && hatch.key === dpr) return hatch.pattern;
  const s = Math.max(4, Math.round(5 * dpr));
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = HATCH_BASE;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = HATCH_LINE;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  // 45° lines, continuous across tiles.
  g.moveTo(0, s);
  g.lineTo(s, 0);
  g.moveTo(-s / 2, s / 2);
  g.lineTo(s / 2, -s / 2);
  g.moveTo(s / 2, s * 1.5);
  g.lineTo(s * 1.5, s / 2);
  g.stroke();
  hatch = { key: dpr, pattern: ctx.createPattern(c, 'repeat') };
  return hatch.pattern;
}

/** CSS twin of the canvas hatch, for the legend chip. */
export const HATCH_CSS = `repeating-linear-gradient(135deg, ${HATCH_LINE} 0 1px, ${HATCH_BASE} 1px 4px)`;

/** True when the view has at least one cell without a valid value. */
export function hasNoDataCells(view: GridView): boolean {
  return view.points.some((row) => row.some((p) => !p || !Number.isFinite(p.svm)));
}

/**
 * Draw the heatmap of `view` into a W×H px context: gray up, level luminance (log) right, cells
 * exactly as in the 3D top view; missing / excluded cells hatched (never drawn as 0), area outside
 * the record's measured range flat background; stepped 0.4 / 1.0 contours along cell borders and
 * the current gray slice as a dashed accent line.
 */
export function drawHeatmap(ctx: CanvasRenderingContext2D, view: GridView, o: DrawOpts) {
  const { W, H, dpr, extent } = o;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(0, 0, W, H);

  const X = (x: number) => Math.round(((x - extent.x0) / (extent.x1 - extent.x0)) * W);
  const Y = (g: number) => Math.round(H - ((g - extent.g0) / (extent.g1 - extent.g0)) * H);
  const xe = cellEdges(view.x, 0).map(X);
  const ge = cellEdges(view.grays, 0, 255).map(Y);
  const scale = 4 / Math.max(0.05, o.colorMax || 4);
  const col = new Color();

  const noData = hatchPattern(ctx, dpr) ?? HATCH_BASE;
  for (let r = 0; r < view.grays.length; r++) {
    for (let c = 0; c < view.x.length; c++) {
      const p = view.points[r][c];
      if (!p || !Number.isFinite(p.svm)) {
        // Missing / excluded cell inside the measured grid: neutral hatch (never drawn as a value).
        ctx.fillStyle = noData;
        ctx.fillRect(xe[c], ge[r + 1], xe[c + 1] - xe[c], ge[r] - ge[r + 1]);
        continue;
      }
      getJsColor(p.svm * scale, o.colormap, col);
      ctx.fillStyle = `#${col.getHexString()}`;
      // Cell r spans gray edges [r, r+1] -> y from ge[r+1] (top) to ge[r] (bottom).
      ctx.fillRect(xe[c], ge[r + 1], xe[c + 1] - xe[c], ge[r] - ge[r + 1]);
    }
  }

  // Stepped contours along cell borders where the threshold is crossed.
  const segs = (th: number) => {
    const out: [number, number, number, number][] = [];
    const above = (r: number, c: number) => {
      const p = view.points[r]?.[c];
      return p && Number.isFinite(p.svm) ? p.svm >= th : null;
    };
    for (let r = 0; r < view.grays.length; r++) {
      for (let c = 0; c < view.x.length; c++) {
        const a = above(r, c);
        if (a === null) continue;
        const right = c + 1 < view.x.length ? above(r, c + 1) : null;
        if (right !== null && right !== a) out.push([xe[c + 1], ge[r + 1], xe[c + 1], ge[r]]);
        const up = r + 1 < view.grays.length ? above(r + 1, c) : null;
        if (up !== null && up !== a) out.push([xe[c], ge[r + 1], xe[c + 1], ge[r + 1]]);
      }
    }
    return out;
  };
  const stroke = (lines: [number, number, number, number][], core: string, halo: string, width: number) => {
    if (!lines.length) return;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of lines) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.strokeStyle = halo;
    ctx.lineWidth = (width + 1.5) * dpr;
    ctx.stroke();
    ctx.strokeStyle = core;
    ctx.lineWidth = width * dpr;
    ctx.stroke();
  };
  // 0.4: white line; 1.0: dark line — readable on light and dark colormap ends alike.
  stroke(segs(SVM_SAFE), '#ffffff', 'rgba(0,0,0,0.45)', 1.25);
  stroke(segs(SVM_CRITICAL), '#0b0e14', 'rgba(255,255,255,0.7)', 1.5);

  // Current gray slice marker (the row behind "SVM @ nits").
  if (o.sliceGray !== null && o.sliceGray >= extent.g0 && o.sliceGray <= extent.g1) {
    const y = Y(o.sliceGray) + 0.5;
    ctx.setLineDash([5 * dpr, 3 * dpr]);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.strokeStyle = '#6aa1ff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
