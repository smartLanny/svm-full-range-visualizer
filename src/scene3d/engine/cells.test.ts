import { describe, expect, it } from 'vitest';
import { approxCellAspect, presetFit, regionAt, splitCells, splitModeFor, viewOffsetFor } from './cells';

const ins = { left: 70, right: 110, top: 116, bottom: 96 };
const opt = { pad: 24, capBand: 26, lumBand: 62 };

describe('side-by-side cells', () => {
  it('splits landscape frames side by side and portrait frames (aspect < 1) into a stack', () => {
    expect([splitModeFor(false, 0.5), splitModeFor(true, 1.78), splitModeFor(true, 1), splitModeFor(true, 0.99), splitModeFor(true, 0.5625)]).toEqual([
      'single',
      'side',
      'side',
      'stack',
      'stack',
    ]);
    expect([approxCellAspect('single', 1.6), approxCellAspect('side', 1.6), approxCellAspect('stack', 0.5625)]).toEqual([1.6, 0.8, 1.125]);
  });

  it('side: two congruent cells tiling the frame; B ends at the colorbar column', () => {
    const vp = { width: 1920, height: 1080 };
    const lay = splitCells(vp, ins, 'side', opt);
    const [a, b] = lay.cells;
    expect(a.w).toBeCloseTo(b.w, 9);
    expect(a.h).toBe(b.h);
    expect(b.x).toBeCloseTo(a.x + a.w, 9);
    // B's plot area (cell minus fit insets) ends where a single plot would end.
    expect(b.x + b.w - lay.fit.right).toBeCloseTo(vp.width - ins.right, 9);
    // Plot areas never overlap: A's right edge + gutter (pad + B's left inset) = B's left edge.
    expect(b.x + lay.fit.left - (a.x + a.w - lay.fit.right)).toBeCloseTo(opt.pad + ins.left, 9);
    // Regions cover the frame without overlap.
    expect(lay.regions[0].x + lay.regions[0].w).toBeCloseTo(lay.regions[1].x, 9);
    expect(lay.regions[1].x + lay.regions[1].w).toBeCloseTo(vp.width, 9);
  });

  it('stack: A above B with a caption band above and an axis band below each plot', () => {
    const vp = { width: 1080, height: 1920 };
    const lay = splitCells(vp, ins, 'stack', opt);
    const [a, b] = lay.cells;
    expect(a.h).toBeCloseTo(b.h, 9);
    expect(a.y).toBeCloseTo(b.y + b.h, 9);
    // A's plot top = the single plot top; B's plot bottom = the single plot bottom.
    expect(a.y + a.h - lay.fit.top).toBeCloseTo(vp.height - ins.top, 9);
    expect(b.y + lay.fit.bottom).toBeCloseTo(ins.bottom, 9);
    expect(lay.fit).toEqual({ left: ins.left, right: ins.right, top: opt.capBand, bottom: opt.lumBand });
    // Each plot gets ~half the frame's plot height (the bands are what the second panel costs).
    const plotH = a.h - lay.fit.top - lay.fit.bottom;
    expect(plotH * 2).toBeCloseTo(vp.height - ins.top - ins.bottom - opt.capBand - opt.lumBand, 9);
    expect(regionAt(lay.regions, 500, a.y + 10)).toBe(0);
    expect(regionAt(lay.regions, 500, a.y - 10)).toBe(1);
  });

  it('single: the frame itself; preset insets pass through', () => {
    const vp = { width: 800, height: 600 };
    const lay = splitCells(vp, ins, 'single', opt);
    expect(lay.cells).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
    const persp = { ...ins, top: ins.top + 6, bottom: ins.bottom + 4 };
    expect(presetFit(lay, ins, persp)).toEqual(persp);
  });

  it('preset extras go into the fit insets of stacked cells, not into the cells', () => {
    const lay = splitCells({ width: 1080, height: 1920 }, ins, 'stack', opt);
    const persp = { ...ins, top: ins.top + 6, bottom: ins.bottom + 4, left: ins.left + 6 };
    expect(presetFit(lay, ins, persp)).toEqual({ left: ins.left + 6, right: ins.right, top: opt.capBand + 6, bottom: opt.lumBand + 4 });
  });

  it('view offset places a cell-sized image at the cell (top-down offset)', () => {
    const vp = { width: 1000, height: 800 };
    expect(viewOffsetFor({ x: 500, y: 0, w: 500, h: 800 }, vp)).toEqual({ fullWidth: 500, fullHeight: 800, x: -500, y: -0, width: 1000, height: 800 });
    expect(viewOffsetFor({ x: 0, y: 0, w: 1000, h: 350 }, vp)).toEqual({ fullWidth: 1000, fullHeight: 350, x: -0, y: -450, width: 1000, height: 800 });
  });
});
