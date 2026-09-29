/**
 * Sub-viewports ("cells") of the 3D frame. Side-by-side renders each panel in its own cell with
 * its own camera (same orientation and scale, docs/adr/0002): the panels can never overlap on
 * screen, whatever their heights or the orbit. Landscape frames put the cells next to each other,
 * portrait frames (aspect < 1) stack them (A above B). Pure layout math, unit tested.
 */
import type { Insets, Viewport } from './camera';

/** A cell of the frame: drawing-buffer px, origin bottom-left. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SplitMode = 'single' | 'side' | 'stack';

/** How a layout splits a frame of this aspect (width / height). */
export function splitModeFor(sideBySide: boolean, aspect: number): SplitMode {
  if (!sideBySide) return 'single';
  return aspect < 1 ? 'stack' : 'side';
}

/** Approximate cell aspect (before any HUD insets), e.g. to choose the plate depth. */
export function approxCellAspect(mode: SplitMode, aspect: number): number {
  return mode === 'side' ? aspect / 2 : mode === 'stack' ? aspect * 2 : aspect;
}

export interface SplitOptions {
  /**
   * Side: room right of panel A's plot, before B's cell (B's own left gutter follows), px.
   */
  pad: number;
  /** Stack: band above each plot for its caption, px (part of the frame's top inset). */
  capBand: number;
  /** Stack: band below each plot for its luminance axis labels, px (part of the bottom inset). */
  lumBand: number;
}

export interface CellLayout {
  mode: SplitMode;
  /** One cell per view (A first). */
  cells: Cell[];
  /** Insets of the plot's safe rect inside every cell (the same for all cells). */
  fit: Insets;
  /**
   * Scissor region of each view: its cell extended to the frame edges on its outer sides, so a
   * panel never draws into the other panel's cell.
   */
  regions: Cell[];
}

/**
 * Split a frame (W × H px) with the given frame insets (the plot's safe rect for a single panel)
 * into congruent cells. Every cell has the same size and the same fit insets, so one camera pose
 * (fitted in cell 0) frames every panel identically.
 */
export function splitCells(vp: Viewport, ins: Insets, mode: SplitMode, opt: SplitOptions): CellLayout {
  const W = vp.width;
  const H = vp.height;
  if (mode === 'side') {
    // [left gutter | A | pad][left gutter | B | frame right inset]; both cells get the pad as right inset.
    const C = Math.max(2, (W - ins.right + opt.pad) / 2);
    const fit: Insets = { left: ins.left, right: opt.pad, top: ins.top, bottom: ins.bottom };
    const cells = [
      { x: 0, y: 0, w: C, h: H },
      { x: C, y: 0, w: C, h: H },
    ];
    return { mode, cells, fit, regions: [{ x: 0, y: 0, w: C, h: H }, { x: C, y: 0, w: W - C, h: H }] };
  }
  if (mode === 'stack') {
    // Title band above, colorbar / UI band below; each cell = caption band + plot + axis band.
    const capBand = Math.min(opt.capBand, ins.top);
    const lumBand = Math.min(opt.lumBand, ins.bottom);
    const yTop = H - (ins.top - capBand);
    const yBottom = ins.bottom - lumBand;
    const C = Math.max(2, (yTop - yBottom) / 2);
    const fit: Insets = { left: ins.left, right: ins.right, top: capBand, bottom: lumBand };
    const a = { x: 0, y: yTop - C, w: W, h: C };
    const b = { x: 0, y: yBottom, w: W, h: C };
    return { mode, cells: [a, b], fit, regions: [{ x: 0, y: a.y, w: W, h: H - a.y }, { x: 0, y: 0, w: W, h: a.y }] };
  }
  const cell = { x: 0, y: 0, w: W, h: H };
  return { mode, cells: [cell], fit: { ...ins }, regions: [cell] };
}

/**
 * Per-preset fit insets inside the cells: the cells themselves are laid out once (from a reference
 * preset, so they do not jump between presets); the few px a preset adds (perspective headroom,
 * elevation-view gutters) go into the fit insets.
 */
export function presetFit(layout: CellLayout, ref: Insets, preset: Insets): Insets {
  if (layout.mode === 'single') return { ...preset };
  const f = layout.fit;
  if (layout.mode === 'side') return { left: preset.left, right: f.right, top: preset.top, bottom: preset.bottom };
  return { left: preset.left, right: preset.right, top: f.top + (preset.top - ref.top), bottom: f.bottom + (preset.bottom - ref.bottom) };
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
