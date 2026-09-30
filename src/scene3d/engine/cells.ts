/**
 * Sub-viewports ("cells") of the 3D frame. Side-by-side renders each panel (2–6 records) in its
 * own cell with its own camera (same orientation and scale, docs/adr/0002): the panels can never
 * overlap on screen, whatever their heights or the orbit. The cells form a grid of congruent
 * cells (A top-left, row by row); a last row with fewer panels is centered. Two panels keep their
 * classic arrangement: next to each other in landscape frames, stacked (A above B) in portrait
 * ones (aspect < 1). Pure layout math, unit tested.
 */
import type { Insets, Viewport } from './camera';

/** A cell of the frame: drawing-buffer px, origin bottom-left. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid of the side-by-side cells (1 × 1 = a single view over the whole frame). */
export interface GridShape {
  cols: number;
  rows: number;
}

export const SINGLE_GRID: GridShape = { cols: 1, rows: 1 };

export interface SplitOptions {
  /** Room right of a panel's plot before the next column's cell (its own left gutter follows), px. */
  pad: number;
  /** Several rows: band above each plot for its caption, px (row 0: part of the frame's top inset). */
  capBand: number;
  /** Several rows: band below each plot for its luminance axis labels, px (last row: part of the bottom inset). */
  lumBand: number;
}

export interface CellLayout {
  cols: number;
  rows: number;
  /** One cell per view (A first, row-major from the top-left). */
  cells: Cell[];
  /** Grid row of each cell (0 = top), its index within the row, and whether it ends the row. */
  slots: { row: number; col: number; first: boolean; last: boolean }[];
  /** Insets of the plot's safe rect inside every cell (the same for all cells). */
  fit: Insets;
  /**
   * Scissor region of each view: its cell, extended to the frame edges on its outer sides, so a
   * panel never draws into another panel's cell. The regions tile the frame without overlap.
   */
  regions: Cell[];
}

/** Width / depth of the plate at depth 1 (log luminance span × gray span, typical records). */
export const NOMINAL_PLATE_ASPECT = 1.45;

/**
 * Depth (gray axis) stretch for a cell of this aspect: 1 for landscape / square cells, deeper for
 * narrow ones (≤ 1.5) so the plate fills a tall cell instead of a thin band. Quantised to quarters,
 * so resizing rebuilds the scene only at a few thresholds.
 */
export function depthScaleFor(cellAspect: number): number {
  const k = Math.min(1.5, Math.max(1, 0.85 / Math.max(0.1, cellAspect)));
  return Math.floor(k * 4 + 1e-6) / 4;
}

/** Deepest plate of a grid cell (fillDepthScale). */
export const MAX_FILL_DEPTH = 2;

/**
 * Depth stretch letting a plate (width / depth `plateAspect` at depth 1) fill a plot area of
 * w × h px: between 1 and MAX_FILL_DEPTH, quantised down to eighths (never deeper than the area).
 * Used for grids of 3–6 panels, whose axis bands take a bigger share of each cell than a single
 * frame's, and whose cells are often much taller than a plate (e.g. 2 × 2 in 9:16).
 */
export function fillDepthScale(plot: { w: number; h: number }, plateAspect = NOMINAL_PLATE_ASPECT): number {
  if (!(plot.w > 0 && plot.h > 0)) return 1;
  const k = Math.min(MAX_FILL_DEPTH, Math.max(1, (plateAspect * plot.h) / plot.w));
  return Math.floor(k * 8 + 1e-6) / 8;
}

/** Approximate cell aspect (before any HUD insets), e.g. to choose the plate depth. */
export function approxCellAspect(grid: GridShape, aspect: number): number {
  return (aspect * grid.rows) / grid.cols;
}

/**
 * Plot size (px) every cell of `grid` leaves for its plate: the cell minus its fit insets (see
 * splitCells). Negative sizes clamp to 0.
 */
export function gridPlotSize(vp: Viewport, ins: Insets, grid: GridShape, opt: SplitOptions): { w: number; h: number } {
  const w = grid.cols <= 1 ? vp.width - ins.left - ins.right : (vp.width - ins.right + opt.pad) / grid.cols - ins.left - opt.pad;
  const capBand = Math.min(opt.capBand, ins.top);
  const lumBand = Math.min(opt.lumBand, ins.bottom);
  const h = grid.rows <= 1 ? vp.height - ins.top - ins.bottom : (vp.height - ins.top - ins.bottom + capBand + lumBand) / grid.rows - capBand - lumBand;
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Candidate grids for n panels: one row, one column, and the grids whose last row misses at most
 * one panel (2 × 2 for 3, 3 × 2 / 2 × 3 for 5–6); never a grid with an empty row or column.
 */
export function gridCandidates(n: number): GridShape[] {
  const out: GridShape[] = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const lastRow = n - cols * (rows - 1);
    if (rows > 1 && cols > 1 && lastRow < cols - 1) continue;
    out.push({ cols, rows });
  }
  return out;
}

/**
 * The grid expected for n panels in a clearly landscape (16:9) or portrait (9:16) frame:
 * 2 → 1 × 2 / 2 × 1, 3 → one row / one column, 4 → 2 × 2, 5–6 → 3 columns × 2 rows / 2 × 3.
 */
export function defaultGrid(n: number, landscape: boolean): GridShape {
  if (n <= 1) return SINGLE_GRID;
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 3) return landscape ? { cols: n, rows: 1 } : { cols: 1, rows: n };
  return landscape ? { cols: 3, rows: Math.ceil(n / 3) } : { cols: 2, rows: Math.ceil(n / 2) };
}


/** Frame insets and cell bands (px) a candidate grid would have (its captions may need two lines). */
export interface GridMetrics {
  ins: Insets;
  opt: SplitOptions;
}

/**
 * Grid for n side-by-side panels in a frame (W × H px; `metrics` gives the single-panel insets and
 * the cell bands of each candidate grid): two panels as before (side by side when aspect ≥ 1,
 * else stacked); more panels take the candidate grid whose congruent cells show the biggest plates
 * (each deepened to fill its cell, see fillDepthScale). The 16:9 / 9:16 defaults (defaultGrid) get
 * a small bonus so near-ties keep the familiar arrangement and resizing does not flip grids back
 * and forth.
 */
export function gridFor(n: number, vp: Viewport, metrics: (g: GridShape) => GridMetrics, plateAspect = NOMINAL_PLATE_ASPECT): GridShape {
  if (n <= 1) return SINGLE_GRID;
  const aspect = vp.width / Math.max(1, vp.height);
  if (n === 2) return aspect < 1 ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
  const def = defaultGrid(n, aspect >= 1);
  let best = def;
  let bestScore = -1;
  for (const g of gridCandidates(n)) {
    const { ins, opt } = metrics(g);
    const plot = gridPlotSize(vp, ins, g, opt);
    const pa = plateAspect / fillDepthScale(plot, plateAspect);
    const w = Math.min(plot.w, plot.h * pa);
    const score = w * (w / pa) * (g.cols === def.cols && g.rows === def.rows ? 1.12 : 1);
    if (score > bestScore + 1e-9) {
      best = g;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Split a frame (W × H px) with the given frame insets (the plot's safe rect for a single panel)
 * into `n` congruent cells on `grid`. Every cell has the same size and the same fit insets, so one
 * camera pose (fitted in cell 0) frames every panel identically. Columns: [left gutter | plot |
 * pad] each, the last plot ending where a single plot would (frame right inset). Rows: [caption
 * band | plot | axis band] each, the first plot starting where a single plot would (below the
 * title) and the last one ending at the frame's bottom inset. One row / column keeps the frame's
 * own insets on that axis.
 */
export function splitCells(vp: Viewport, ins: Insets, n: number, grid: GridShape, opt: SplitOptions): CellLayout {
  const W = vp.width;
  const H = vp.height;
  const cols = Math.max(1, Math.min(grid.cols, n));
  const rows = Math.max(1, Math.ceil(n / cols));
  if (n <= 1 || cols * rows <= 1) {
    const cell = { x: 0, y: 0, w: W, h: H };
    return { cols: 1, rows: 1, cells: [cell], slots: [{ row: 0, col: 0, first: true, last: true }], fit: { ...ins }, regions: [{ ...cell }] };
  }
  const fit: Insets = { ...ins };
  let cw = W;
  if (cols > 1) {
    cw = Math.max(2, (W - ins.right + opt.pad) / cols);
    fit.right = opt.pad;
  }
  let ch = H;
  let yTop = H;
  if (rows > 1) {
    const capBand = Math.min(opt.capBand, ins.top);
    const lumBand = Math.min(opt.lumBand, ins.bottom);
    yTop = H - (ins.top - capBand);
    const yBottom = ins.bottom - lumBand;
    ch = Math.max(2, (yTop - yBottom) / rows);
    fit.top = capBand;
    fit.bottom = lumBand;
  }
  const cells: Cell[] = [];
  const slots: CellLayout['slots'] = [];
  const regions: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
    // A shorter last row is centered under the full rows.
    const x = (col + (cols - inRow) / 2) * cw;
    const y = yTop - (row + 1) * ch;
    const first = col === 0;
    const last = col === inRow - 1;
    cells.push({ x, y, w: cw, h: ch });
    slots.push({ row, col, first, last });
    const x0 = first ? 0 : x;
    const x1 = last ? W : x + cw;
    const y1 = row === 0 ? H : y + ch;
    const y0 = row === rows - 1 ? 0 : y;
    regions.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return { cols, rows, cells, slots, fit, regions };
}

/**
 * Per-preset fit insets inside the cells: the cells themselves are laid out once (from a reference
 * preset, so they do not jump between presets); the few px a preset adds (perspective headroom,
 * elevation-view gutters) go into the fit insets.
 */
export function presetFit(layout: CellLayout, ref: Insets, preset: Insets): Insets {
  if (layout.cells.length <= 1) return { ...preset };
  const f = layout.fit;
  const out: Insets = { ...preset };
  if (layout.cols > 1) out.right = f.right;
  if (layout.rows > 1) {
    out.top = f.top + (preset.top - ref.top);
    out.bottom = f.bottom + (preset.bottom - ref.bottom);
  }
  return out;
}

/** A view offset placing a cell-sized camera image at its cell inside the full frame. */
export function viewOffsetFor(cell: Cell, vp: Viewport): { fullWidth: number; fullHeight: number; x: number; y: number; width: number; height: number } {
  return { fullWidth: cell.w, fullHeight: cell.h, x: -cell.x, y: -(vp.height - (cell.y + cell.h)), width: vp.width, height: vp.height };
}

/** Index of the region containing (x, y) px (origin bottom-left), or 0. */
export function regionAt(regions: Cell[], x: number, y: number): number {
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return 0;
}
