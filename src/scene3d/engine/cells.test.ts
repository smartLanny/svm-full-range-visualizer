import { describe, expect, it } from 'vitest';
import {
  approxCellAspect,
  DEFAULT_GRID_BONUS,
  defaultGrid,
  plateFit,
  gridCandidates,
  gridFor,
  gridPlotSize,
  presetFit,
  regionAt,
  splitCells,
  viewOffsetFor,
  type CellLayout,
  type GridShape,
} from './cells';
import { PLATE_ASPECT } from './plate';

const ins = { left: 70, right: 110, top: 116, bottom: 96 };
const opt = { pad: 24, capBand: 26, lumBand: 62 };
const SIDE: GridShape = { cols: 2, rows: 1 };
const STACK: GridShape = { cols: 1, rows: 2 };

describe('side-by-side cells: two panels', () => {
  it('two panels: side by side in landscape frames, stacked in portrait and square ones (bigger plates)', () => {
    const g = (w: number, h: number) => gridFor(2, { width: w, height: h }, () => ({ ins, opt }));
    // Square frames: side-by-side cells are twice as tall as a plate, stacked ones fit it.
    expect([g(1920, 1080), g(1600, 900), g(1024, 768), g(1000, 1000), g(990, 1000), g(1080, 1920)]).toEqual([SIDE, SIDE, SIDE, STACK, STACK, STACK]);
    expect(gridFor(1, { width: 1920, height: 1080 }, () => ({ ins, opt }))).toEqual({ cols: 1, rows: 1 });
    expect([approxCellAspect({ cols: 1, rows: 1 }, 1.6), approxCellAspect(SIDE, 1.6), approxCellAspect(STACK, 0.5625)]).toEqual([1.6, 0.8, 1.125]);
  });

  it('side: two congruent cells tiling the frame; B ends at the colorbar column', () => {
    const vp = { width: 1920, height: 1080 };
    const lay = splitCells(vp, ins, 2, SIDE, opt);
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
    expect(lay.fit).toEqual({ ...ins, right: opt.pad });
  });

  it('stack: A above B with a caption band above and an axis band below each plot', () => {
    const vp = { width: 1080, height: 1920 };
    const lay = splitCells(vp, ins, 2, STACK, opt);
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
    const lay = splitCells(vp, ins, 1, { cols: 1, rows: 1 }, opt);
    expect(lay.cells).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
    const persp = { ...ins, top: ins.top + 6, bottom: ins.bottom + 4 };
    expect(presetFit(lay, ins, persp)).toEqual(persp);
  });

  it('preset extras go into the fit insets of stacked cells, not into the cells', () => {
    const lay = splitCells({ width: 1080, height: 1920 }, ins, 2, STACK, opt);
    const persp = { ...ins, top: ins.top + 6, bottom: ins.bottom + 4, left: ins.left + 6 };
    expect(presetFit(lay, ins, persp)).toEqual({ left: ins.left + 6, right: ins.right, top: opt.capBand + 6, bottom: opt.lumBand + 4 });
    const side = splitCells({ width: 1920, height: 1080 }, ins, 2, SIDE, opt);
    expect(presetFit(side, ins, persp)).toEqual({ ...persp, right: opt.pad });
  });

  it('view offset places a cell-sized image at the cell (top-down offset)', () => {
    const vp = { width: 1000, height: 800 };
    expect(viewOffsetFor({ x: 500, y: 0, w: 500, h: 800 }, vp)).toEqual({ fullWidth: 500, fullHeight: 800, x: -500, y: -0, width: 1000, height: 800 });
    expect(viewOffsetFor({ x: 0, y: 0, w: 1000, h: 350 }, vp)).toEqual({ fullWidth: 1000, fullHeight: 350, x: -0, y: -450, width: 1000, height: 800 });
  });
});

/** Geometry problems of a layout of n cells in a frame (empty = fine). */
function layoutProblems(lay: CellLayout, vp: { width: number; height: number }, n: number): string[] {
  const out: string[] = [];
  const eps = 1e-6;
  if (lay.cells.length !== n) out.push(`cells ${lay.cells.length} != ${n}`);
  const c0 = lay.cells[0];
  lay.cells.forEach((c, i) => {
    if (Math.abs(c.w - c0.w) > eps || Math.abs(c.h - c0.h) > eps) out.push(`cell ${i} not congruent`);
    if (c.x < -eps || c.y < -eps || c.x + c.w > vp.width + eps || c.y + c.h > vp.height + eps) out.push(`cell ${i} outside the frame`);
    const r = lay.regions[i];
    if (r.x > c.x + eps || r.y > c.y + eps || r.x + r.w < c.x + c.w - eps || r.y + r.h < c.y + c.h - eps) out.push(`region ${i} does not contain its cell`);
    for (let j = 0; j < i; j++) {
      const d = lay.cells[j];
      const ox = Math.min(c.x + c.w, d.x + d.w) - Math.max(c.x, d.x);
      const oy = Math.min(c.y + c.h, d.y + d.h) - Math.max(c.y, d.y);
      if (ox > eps && oy > eps) out.push(`cells ${j} / ${i} overlap`);
      const q = lay.regions[j];
      const rx = Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x);
      const ry = Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y);
      if (rx > eps && ry > eps) out.push(`regions ${j} / ${i} overlap`);
    }
  });
  // Regions tile the frame (their areas add up to it, and they do not overlap).
  const area = lay.regions.reduce((s, r) => s + r.w * r.h, 0);
  if (Math.abs(area - vp.width * vp.height) > 1e-3) out.push(`regions cover ${area} of ${vp.width * vp.height}`);
  // Plots stay inside the single-panel safe rect of the frame.
  for (const c of lay.cells) {
    if (c.x + lay.fit.left < ins.left - eps || c.x + c.w - lay.fit.right > vp.width - ins.right + eps) out.push('plot outside the safe rect (x)');
    if (c.y + lay.fit.bottom < ins.bottom - eps || c.y + c.h - lay.fit.top > vp.height - ins.top + eps) out.push('plot outside the safe rect (y)');
  }
  return out;
}

describe('side-by-side cells: 2–6 panels on a grid', () => {
  const frames = [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 1080, height: 1920 },
    { width: 1080, height: 1080 },
    { width: 1030, height: 800 },
    { width: 700, height: 650 },
  ];

  it('candidates never leave an empty row or column', () => {
    const shapes = (n: number) => gridCandidates(n).map((g) => `${g.cols}x${g.rows}`);
    expect([2, 3, 4, 5, 6].map(shapes)).toEqual([
      ['1x2', '2x1'],
      ['1x3', '2x2', '3x1'],
      ['1x4', '2x2', '4x1'],
      ['1x5', '2x3', '3x2', '5x1'],
      ['1x6', '2x3', '3x2', '6x1'],
    ]);
  });

  it('16:9 and 9:16 frames get the expected grids (1×2 / 1×3 / 2×2 / 3×2 and their portrait twins)', () => {
    const land = { width: 1920, height: 1080 };
    const port = { width: 1080, height: 1920 };
    // Portrait frames carry the colorbar below the plot instead of right of it.
    const portIns = { ...ins, right: 30, bottom: ins.bottom + 64 };
    const got = (vp: typeof land, i = ins) => [2, 3, 4, 5, 6].map((n) => gridFor(n, vp, () => ({ ins: i, opt }))).map((g) => `${g.cols}x${g.rows}`);
    expect(got(land)).toEqual(['2x1', '3x1', '2x2', '3x2', '3x2']);
    expect(got({ width: 1600, height: 900 })).toEqual(['2x1', '3x1', '2x2', '3x2', '3x2']);
    expect(got(port, portIns)).toEqual(['1x2', '1x3', '2x2', '2x3', '2x3']);
    // A 9:16 presentation stage in a 1600 × 900 window (CSS px).
    expect(got({ width: 506, height: 900 }, portIns)).toEqual(['1x2', '1x3', '2x2', '2x3', '2x3']);
    expect([2, 3, 4, 5, 6].map((n) => defaultGrid(n, true))).toEqual([
      { cols: 2, rows: 1 },
      { cols: 3, rows: 1 },
      { cols: 2, rows: 2 },
      { cols: 3, rows: 2 },
      { cols: 3, rows: 2 },
    ]);
  });

  it('square frames use the space: 3 panels on 2 × 2 rather than a thin row', () => {
    const sq = { width: 1080, height: 1080 };
    expect(gridFor(3, sq, () => ({ ins, opt }))).toEqual({ cols: 2, rows: 2 });
    // The chosen grid shows plates at least as big as any candidate's (bonus aside).
    const plate = (g: GridShape) => {
      const p = gridPlotSize(sq, ins, g, opt);
      const f = plateFit(p);
      return f.w * f.h;
    };
    for (const n of [3, 4, 5, 6]) {
      const best = Math.max(...gridCandidates(n).map(plate));
      expect(plate(gridFor(n, sq, () => ({ ins, opt }))) * DEFAULT_GRID_BONUS).toBeGreaterThanOrEqual(best);
    }
  });

  it('every panel count and frame: congruent, non-overlapping cells inside the frame; regions tile it', () => {
    const problems: string[] = [];
    for (const vp of frames)
      for (const n of [2, 3, 4, 5, 6])
        for (const g of gridCandidates(n)) {
          const lay = splitCells(vp, ins, n, g, opt);
          for (const p of layoutProblems(lay, vp, n)) problems.push(`${vp.width}x${vp.height} n=${n} ${g.cols}x${g.rows}: ${p}`);
          // The plot size helper agrees with the cells.
          const plot = gridPlotSize(vp, ins, g, opt);
          const c = lay.cells[0];
          const pw = Math.max(0, c.w - lay.fit.left - lay.fit.right);
          const ph = Math.max(0, c.h - lay.fit.top - lay.fit.bottom);
          if (ph > 2 && (Math.abs(pw - plot.w) > 1e-6 || Math.abs(ph - plot.h) > 1e-6)) problems.push(`${n} ${g.cols}x${g.rows}: plot size`);
        }
    expect(problems).toEqual([]);
  });

  it('a shorter last row is centered; A is top-left, panels fill row by row', () => {
    const vp = { width: 1920, height: 1080 };
    const lay = splitCells(vp, ins, 5, { cols: 3, rows: 2 }, opt);
    const [a, b, c, d, e] = lay.cells;
    expect(a.x).toBe(0);
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(c.x).toBeCloseTo(2 * a.w, 9);
    expect(d.y).toBeLessThan(a.y);
    // Row 2 holds D and E, centered under the three columns.
    expect(d.x).toBeCloseTo(a.w / 2, 9);
    expect(e.x).toBeCloseTo(d.x + d.w, 9);
    expect(lay.slots.map((s) => `${s.row}${s.col}${s.first ? 'f' : ''}${s.last ? 'l' : ''}`)).toEqual(['00f', '01', '02l', '10f', '11l']);
    // The pointer in the gap left of D picks D (its region reaches the frame edge).
    expect(regionAt(lay.regions, 5, d.y + 10)).toBe(3);
    expect(regionAt(lay.regions, vp.width - 5, d.y + 10)).toBe(4);
    // First row's plots start where a single plot would; last row's end at the bottom inset.
    expect(a.y + a.h - lay.fit.top).toBeCloseTo(vp.height - ins.top, 9);
    expect(d.y + lay.fit.bottom).toBeCloseTo(ins.bottom, 9);
  });
});

describe('stable plate proportions (docs/adr/0002, addendum)', () => {
  /** Frames: exports, the workbench's 3D canvas at 1600 × 900 / 1280 × 720 and presentation stages. */
  const frames: { name: string; vp: { width: number; height: number }; portrait: boolean }[] = [
    { name: '16:9 1920×1080', vp: { width: 1920, height: 1080 }, portrait: false },
    { name: '16:9 3840×2160', vp: { width: 3840, height: 2160 }, portrait: false },
    { name: '9:16 1080×1920', vp: { width: 1080, height: 1920 }, portrait: true },
    { name: '1:1 1080×1080', vp: { width: 1080, height: 1080 }, portrait: false },
    { name: 'workbench 1600×900', vp: { width: 1028, height: 852 }, portrait: false },
    { name: 'workbench 1280×720', vp: { width: 708, height: 672 }, portrait: false },
    { name: 'stage 9:16', vp: { width: 506, height: 900 }, portrait: true },
    { name: 'stage 16:9', vp: { width: 1600, height: 900 }, portrait: false },
  ];
  /** Nominal metrics like the engine's (landscape: colorbar right; portrait: below). */
  const metrics = (n: number, portrait: boolean) => (g: GridShape) => {
    const cap = 26 + (g.rows > 1 ? 12 : 0);
    return {
      ins: { left: 70, right: portrait ? 30 : 110, top: 84 + cap, bottom: 62 + (portrait ? (n >= 3 ? 80 : 64) : 0) + 34 },
      opt: { pad: 24, capBand: cap, lumBand: n >= 3 ? 34 : 62 },
    };
  };

  it('fitting a plate never stretches it: the plate keeps its aspect and fills one side of the plot', () => {
    for (const plot of [
      { w: 800, h: 600 },
      { w: 200, h: 290 },
      { w: 980, h: 1500 },
      { w: 1700, h: 900 },
    ]) {
      const f = plateFit(plot);
      expect(f.w / f.h).toBeCloseTo(PLATE_ASPECT, 9);
      expect(f.w).toBeLessThanOrEqual(plot.w + 1e-9);
      expect(f.h).toBeLessThanOrEqual(plot.h + 1e-9);
      expect(Math.max(f.w / plot.w, f.h / plot.h)).toBeCloseTo(1, 9);
    }
    expect(plateFit({ w: 0, h: 100 })).toEqual({ w: 0, h: 0 });
  });

  it('1–6 panels in every frame: the chosen grid shows plates of the plate aspect, as big as any candidate (familiar grid bonus aside)', () => {
    const problems: string[] = [];
    for (const f of frames)
      for (let n = 1; n <= 6; n++) {
        const m = metrics(n, f.portrait);
        const g = gridFor(n, f.vp, m);
        const plate = plateFit(gridPlotSize(f.vp, m(g).ins, g, m(g).opt));
        if (!(plate.w > 0) || Math.abs(plate.w / plate.h - PLATE_ASPECT) > 1e-9) problems.push(`${f.name} n=${n}: plate ${plate.w}×${plate.h}`);
        // Readable: at least ~1/7 of the frame's short side deep even with six panels.
        if (plate.h < Math.min(f.vp.width, f.vp.height) / 7) problems.push(`${f.name} n=${n}: plate only ${plate.h.toFixed(0)} px deep`);
        if (n >= 2) {
          const best = Math.max(...gridCandidates(n).map((c) => ((p) => p.w * p.h)(plateFit(gridPlotSize(f.vp, m(c).ins, c, m(c).opt)))));
          if (plate.w * plate.h * DEFAULT_GRID_BONUS < best - 1e-6) problems.push(`${f.name} n=${n}: ${g.cols}x${g.rows} not the best grid`);
        }
      }
    expect(problems).toEqual([]);
  });

  it('grids of the workbench, stages and exports: familiar in 16:9 / 9:16, bigger plates in square frames', () => {
    const got = (f: (typeof frames)[number]) => [2, 3, 4, 5, 6].map((n) => gridFor(n, f.vp, metrics(n, f.portrait))).map((g) => `${g.cols}x${g.rows}`);
    const by = Object.fromEntries(frames.map((f) => [f.name, got(f).join(' ')]));
    expect(by).toEqual({
      '16:9 1920×1080': '2x1 3x1 2x2 3x2 3x2',
      '16:9 3840×2160': '2x1 3x1 2x2 3x2 3x2',
      '9:16 1080×1920': '1x2 1x3 2x2 2x3 2x3',
      // Square frames: stacked pair, 2 × 2 for three, two columns for five / six.
      '1:1 1080×1080': '1x2 2x2 2x2 2x3 2x3',
      'workbench 1600×900': '2x1 2x2 2x2 3x2 3x2',
      'workbench 1280×720': '2x1 2x2 2x2 2x3 2x3',
      'stage 9:16': '1x2 1x3 2x2 2x3 2x3',
      'stage 16:9': '2x1 3x1 2x2 3x2 3x2',
    });
  });
});
