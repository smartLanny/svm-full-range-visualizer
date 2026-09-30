import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../../types';
import { logNits } from '../../data/grid';
import { buildModel, cellAt, diffColorbarTicks, diffContourLevels, diffRange, DIFF_RANGES, setModelHeightCap, SX, SY, type PanelModel, type SceneModel } from './model';
import { boundaryEdges, buildSurfaceGrid, sampleSurface, type SurfaceGrid } from './surfaceGrid';
import { cutUnderLabels, placeLabels, traceContours } from './contours';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/datasets', f), 'utf8')) as SvmRecord;
const iphone = load('iPhone17ProMax.json');
const mate = load('huawei_mate70air.json');
const mateLow = load('huawei_mate70air_low_frequency.json');
const x18off = load('xiaomi18promax_adaptive_pro_off.json');
const x17dc = load('xiaomi17ultra_leica_dc_120hz.json');
const x17ltpo = load('xiaomi17ultra_leica_ltpo_120hz.json');

function single(rec: SvmRecord, clip = true): SceneModel {
  const res = buildModel({ layout: 'single', a: rec, b: null, clipLowGray: clip, maxNits: 500, colorMax: 4, heightCap: 6 });
  if (!res.ok) throw new Error(res.reason);
  return res.model;
}

describe('scene model', () => {
  it('places columns by log level luminance (not by index) and tiles cells exactly', () => {
    const m = single(iphone);
    const p = m.panels[0];
    for (let c = 1; c < p.xs.length; c++) {
      const d = p.xs[c] - p.xs[c - 1];
      expect(d).toBeCloseTo((logNits(p.view.levelNits[c]) - logNits(p.view.levelNits[c - 1])) * SX, 6);
    }
    // Edges are midpoints; cell centers lie inside their cells.
    for (let c = 0; c < p.xs.length; c++) {
      expect(p.xs[c]).toBeGreaterThan(p.xe[c]);
      expect(p.xs[c]).toBeLessThan(p.xe[c + 1]);
    }
    expect(p.rect.x0).toBe(p.xe[0]);
    expect(p.rect.x1).toBe(p.xe[p.xe.length - 1]);
    expect(Math.max(...p.view.levelNits)).toBeLessThanOrEqual(500);
    expect(Math.min(...p.view.grays)).toBeGreaterThanOrEqual(15);
  });

  it('gray increases toward -z (up in top view) and cells are disjoint', () => {
    const m = single(mate, false);
    const p = m.panels[0];
    for (let r = 1; r < p.zs.length; r++) expect(p.zs[r]).toBeLessThan(p.zs[r - 1]);
    // Every cell center maps back to its own cell.
    p.values.forEach((row, r) => row.forEach((_, c) => expect(cellAt(p, p.xs[c], p.zs[r])).toEqual({ r, c })));
  });

  it('side-by-side panels share one scale and do not overlap', () => {
    const res = buildModel({ layout: 'sideBySide', a: mate, b: iphone, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [a, b] = res.model.panels;
    expect(a.rect.x1).toBeLessThan(b.rect.x0);
    expect(a.id).toBe('A');
    expect(b.id).toBe('B');
  });

  it('side by side takes up to six panels (A–F) on one shared domain, in a row that never overlaps', () => {
    const recs = [mate, iphone, mateLow, x18off, x17dc, x17ltpo];
    const panelCount = (extras: SvmRecord[], layout: 'single' | 'sideBySide' | 'diff' = 'sideBySide') => {
      const res = buildModel({ layout, a: mate, b: iphone, extras, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
      return res.ok ? res.model.panels.length : res.reason;
    };
    expect([0, 1, 2, 3, 4, 5].map((k) => panelCount(recs.slice(2, 2 + k)))).toEqual([2, 3, 4, 5, 6, 6]);
    // Extras only matter side by side.
    expect([panelCount(recs.slice(2), 'single'), panelCount(recs.slice(2), 'diff')]).toEqual([1, 1]);
    const res = buildModel({ layout: 'sideBySide', a: mate, b: iphone, extras: recs.slice(2), clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    if (!res.ok) throw new Error(res.reason);
    const m = res.model;
    expect(m.panels.map((p) => p.id).join('')).toBe('ABCDEF');
    expect(m.panels.map((p) => p.record)).toEqual(recs);
    // Congruent spacing, centered on the single-panel mapping; each panel inside its slot.
    const step = m.panels[1].offsetX - m.panels[0].offsetX;
    const bad = m.panels.filter((p, i) => Math.abs(p.offsetX - (i - 2.5) * step) > 1e-9 || (i > 0 && p.rect.x0 <= m.panels[i - 1].rect.x1));
    expect(bad).toEqual([]);
    expect(m.bounds.x0).toBeCloseTo(Math.min(...m.panels.map((p) => p.rect.x0)), 9);
    expect(m.bounds.x1).toBeCloseTo(Math.max(...m.panels.map((p) => p.rect.x1)), 9);
    // Shared value scale: plotMax over every panel.
    expect(m.plotMax).toBe(Math.min(6, Math.max(...m.panels.map((p) => p.maxValue))));
  });

  it('diff uses a symmetric range and reports missing B', () => {
    const res = buildModel({ layout: 'diff', a: mate, b: mateLow, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const abs = res.model.panels[0].values.flat().filter((v): v is number => v !== null);
    expect(res.model.colorMax).toBe(diffRange(abs));
    expect(diffRange([0.2])).toBe(0.5);
    expect(diffRange([1.2])).toBe(1.5);
    expect(diffContourLevels(1)).toEqual([-0.5, 0.5]);
    expect(buildModel({ layout: 'diff', a: mate, b: null, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 })).toEqual({ ok: false, reason: 'needB' });
    expect(buildModel({ layout: 'single', a: null, b: null, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 })).toEqual({ ok: false, reason: 'noRecord' });
  });
});

describe('surface grid + contours', () => {
  it('keeps measured values at cell centers and covers the cell rectangle', () => {
    const m = single(iphone);
    const p = m.panels[0];
    const g = buildSurfaceGrid(p, 4);
    expect(g.gx[0]).toBe(p.rect.x0);
    expect(g.gx[g.nx - 1]).toBe(p.rect.x1);
    // Base vertex (i = c + 1) sits at the cell center with the measured value.
    const S = 4;
    for (let r = 0; r < p.zs.length; r += 3)
      for (let c = 0; c < p.xs.length; c += 3) {
        const I = (c + 1) * S;
        const J = (r + 1) * S;
        expect(g.gx[I]).toBeCloseTo(p.xs[c]);
        expect(g.gz[J]).toBeCloseTo(p.zs[r]);
        expect(g.v[J * g.nx + I]).toBeCloseTo(p.values[r][c] as number);
      }
  });

  it('traces contours on the surface and labels them without overlaps, cutting lines under labels', () => {
    const m = single(mate);
    const p = m.panels[0];
    const g = buildSurfaceGrid(p);
    const unitH = (v: number) => Math.min(6, v) * SY;
    const lines = traceContours(g, m.contourLevels, unitH);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) for (const pt of l.points) expect(pt.y).toBeCloseTo(unitH(l.level), 5);
    const hh = 0.1;
    const labels = placeLabels(lines, { rect: p.rect, halfHeight: hh, halfWidth: (t) => t.length * 0.06, format: (v) => v.toFixed(1) });
    expect(labels.length).toBeGreaterThan(0);
    for (let i = 0; i < labels.length; i++) {
      const a = labels[i];
      expect(a.x - a.hw).toBeGreaterThan(p.rect.x0);
      expect(a.x + a.hw).toBeLessThan(p.rect.x1);
      expect(a.z - a.hh).toBeGreaterThan(p.rect.z0);
      expect(a.z + a.hh).toBeLessThan(p.rect.z1);
      for (let j = i + 1; j < labels.length; j++) {
        const b = labels[j];
        const overlap = Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.z - b.z) < a.hh + b.hh;
        expect(overlap).toBe(false);
      }
    }
    const pieces = cutUnderLabels(lines, labels, 1.0);
    for (const pc of pieces)
      for (let i = 1; i < pc.points.length; i++) {
        const mx = (pc.points[i].x + pc.points[i - 1].x) / 2;
        const mz = (pc.points[i].z + pc.points[i - 1].z) / 2;
        for (const lb of labels) expect(Math.abs(mx - lb.x) < lb.hw * 0.98 && Math.abs(mz - lb.z) < lb.hh * 0.98).toBe(false);
      }
  });
});

import { formatCellValue } from './values';
describe('cell value format', () => {
  it('formats svm and signed differences without "-0.00"', () => {
    expect(formatCellValue(0.345, 'svm')).toBe('0.34');
    expect(formatCellValue(12.34, 'svm')).toBe('12.3');
    expect(formatCellValue(0.004, 'diff')).toBe('0.00');
    expect(formatCellValue(-0.004, 'diff')).toBe('0.00');
    expect(formatCellValue(0.25, 'diff')).toBe('+0.25');
    expect(formatCellValue(-0.5, 'diff')).toBe('−0.50');
  });
});

describe('robust ΔSVM color range (outliers never set the scale)', () => {
  it('uses the 95th percentile of |Δ| rounded up to a nice range, clamped to 0.5 … 3', () => {
    const base = Array.from({ length: 200 }, (_, i) => ((i % 17) / 16) * 0.8 - 0.4); // |Δ| ≤ 0.4
    expect(diffRange(base)).toBe(0.5);
    // One (or a few) wild outliers do not change R.
    expect(diffRange([...base, 19.87])).toBe(0.5);
    expect(diffRange([...base, 19.87, -12, 8])).toBe(0.5);
    expect(diffRange(base.map((v) => v * 3))).toBe(1.5);
    expect(diffRange(base.map((v) => v * 100))).toBe(3);
    expect(diffRange([])).toBe(0.5);
    for (const r of [0.1, 0.7, 1.2, 1.9, 2.2, 7]) expect(DIFF_RANGES).toContain(diffRange([r]));
  });

  it('keeps at most a few contour levels and colorbar ticks for every range', () => {
    for (const r of DIFF_RANGES) {
      const lv = diffContourLevels(r);
      expect(lv.length).toBeLessThanOrEqual(6);
      expect(lv.length).toBeGreaterThan(0);
      for (const v of lv) expect(Math.abs(v)).toBeLessThan(r);
      expect(lv).toEqual([...lv].sort((a, b) => a - b));
      const ticks = diffColorbarTicks(r);
      expect(ticks[0]).toBe(-r);
      expect(ticks[ticks.length - 1]).toBe(r);
      expect(ticks).toContain(0);
      expect(ticks.length).toBeLessThanOrEqual(7);
    }
  });

  it('real outlier pairs get a readable range (e.g. 17 Ultra DC − LTPO was ±20)', () => {
    const res = buildModel({ layout: 'diff', a: x17dc, b: x17ltpo, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    if (!res.ok) throw new Error(res.reason);
    expect(res.model.colorMax).toBeLessThanOrEqual(3);
    expect(res.model.panels[0].maxAbs).toBeGreaterThan(res.model.colorMax * 3);
    expect(res.model.contourLevels.length).toBeLessThanOrEqual(6);
  });

  it('drops diff rows / columns without any valid difference', () => {
    const res = buildModel({ layout: 'diff', a: x18off, b: x17dc, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    if (!res.ok) throw new Error(res.reason);
    const p = res.model.panels[0];
    for (const row of p.values) expect(row.some((v) => v !== null)).toBe(true);
    for (let c = 0; c < p.xs.length; c++) expect(p.values.some((row) => row[c] !== null)).toBe(true);
    expect(p.values.length).toBe(p.view.grays.length);
    expect(p.values[0].length).toBe(p.view.x.length);
    expect(p.otherValues!.length).toBe(p.values.length);
  });
});

/** Synthetic panel: nR × nC unit-spaced cells with the given values (null = missing). */
function synthPanel(values: (number | null)[][]): PanelModel {
  const nR = values.length;
  const nC = values[0].length;
  const xs = Array.from({ length: nC }, (_, c) => c + 0.5);
  const zs = Array.from({ length: nR }, (_, r) => -(r + 0.5)); // gray up = −z
  const xe = Array.from({ length: nC + 1 }, (_, c) => c);
  const ze = Array.from({ length: nR + 1 }, (_, r) => -r);
  const flat = values.flat().filter((v): v is number => v !== null);
  return {
    id: 'A',
    record: {} as never,
    view: {} as never,
    kind: 'svm',
    values,
    offsetX: 0,
    xs,
    zs,
    xe,
    ze,
    rect: { x0: 0, x1: nC, z0: -nR, z1: 0 },
    maxAbs: Math.max(0, ...flat.map(Math.abs)),
    minValue: Math.min(...flat),
    maxValue: Math.max(...flat),
    count: flat.length,
  };
}

/** Triangle area (xz) per cell, by the cell containing each triangle's centroid. */
function areaPerCell(p: PanelModel, g: SurfaceGrid): number[][] {
  const out = p.values.map((row) => row.map(() => 0));
  for (let t = 0; t < g.tris.length; t += 3) {
    const [a, b, c] = [g.tris[t], g.tris[t + 1], g.tris[t + 2]].map((k) => ({ x: g.gx[k % g.nx], z: g.gz[Math.floor(k / g.nx)] }));
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
    if (area < 1e-12) continue;
    const cell = cellAt(p, (a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3);
    if (cell) out[cell.r][cell.c] += area;
  }
  return out;
}

describe('surface coverage with missing cells (docs/adr/0002, 0012)', () => {
  it('fills every valid cell rectangle completely and leaves every missing cell empty', () => {
    const vals = [
      [0.3, 0.5, null, 0.7, 0.9],
      [0.4, null, null, 1.1, 1.3],
      [0.6, 0.8, 1.0, null, 1.6],
      [null, 1.2, 1.4, 1.8, 2.0],
    ];
    const p = synthPanel(vals);
    const g = buildSurfaceGrid(p);
    const area = areaPerCell(p, g);
    vals.forEach((row, r) =>
      row.forEach((v, c) => {
        const cellArea = (p.xe[c + 1] - p.xe[c]) * Math.abs(p.ze[r + 1] - p.ze[r]);
        if (v === null) expect(area[r][c]).toBe(0);
        else expect(area[r][c]).toBeCloseTo(cellArea, 9);
      }),
    );
  });

  it('draws an isolated valid cell, with its measured value at its center', () => {
    const vals = [
      [null, null, null],
      [null, 2.5, null],
      [null, null, null],
    ];
    const p = synthPanel(vals);
    const g = buildSurfaceGrid(p);
    expect(areaPerCell(p, g)[1][1]).toBeCloseTo(1, 9);
    // Only the isolated value contributes: the whole cell is flat at 2.5.
    for (const k of new Set(g.tris)) expect(g.v[k]).toBeCloseTo(2.5, 9);
    expect(sampleSurface(p, 1.5, -1.5)).toBeCloseTo(2.5, 9);
    expect(sampleSurface(p, 0.5, -0.5)).toBeNull();
  });

  it('renormalises the interpolation next to a hole (valid neighbours extend to the hole edge)', () => {
    const p = synthPanel([[1, null, 3]]);
    // Right edge of the first cell: only the valid corner counts.
    expect(sampleSurface(p, 1, -0.5)).toBeCloseTo(1, 9);
    expect(sampleSurface(p, 2.001, -0.5)).toBeCloseTo(3, 9);
    expect(sampleSurface(p, 1.5, -0.5)).toBeNull();
  });

  it('closes every hole with walls: boundary edges = outer border + hole rims', () => {
    const vals = [
      [1, 1, 1, 1],
      [1, null, null, 1],
      [1, 1, 1, 1],
    ];
    const p = synthPanel(vals);
    const g = buildSurfaceGrid(p);
    const edges = boundaryEdges(g);
    const len = edges.reduce((s, e) => s + Math.hypot(g.gx[e.a % g.nx] - g.gx[e.b % g.nx], g.gz[Math.floor(e.a / g.nx)] - g.gz[Math.floor(e.b / g.nx)]), 0);
    const outer = 2 * (4 + 3);
    const hole = 2 * (2 + 1);
    expect(len).toBeCloseTo(outer + hole, 9);
    // Walls face away from the drawn surface: (b − a) × ŷ = n.
    for (const e of edges) {
      const dx = g.gx[e.b % g.nx] - g.gx[e.a % g.nx];
      const dz = g.gz[Math.floor(e.b / g.nx)] - g.gz[Math.floor(e.a / g.nx)];
      // (dx, 0, dz) × (0, 1, 0) = (−dz, 0, dx)
      const sgn = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.sign(v));
      expect(sgn(-dz)).toBe(sgn(e.n[0]));
      expect(sgn(dx)).toBe(sgn(e.n[2]));
    }
  });

  it('matches the bars footprint on the real 18 Pro Max record (excluded cells)', () => {
    const m = single(x18off);
    const p = m.panels[0];
    expect(p.count).toBeLessThan(p.values.length * p.values[0].length);
    const area = areaPerCell(p, buildSurfaceGrid(p));
    p.values.forEach((row, r) =>
      row.forEach((v, c) => {
        const cellArea = (p.xe[c + 1] - p.xe[c]) * Math.abs(p.ze[r + 1] - p.ze[r]);
        if (v === null) expect(area[r][c]).toBe(0);
        else expect(area[r][c]).toBeCloseTo(cellArea, 6);
      }),
    );
  });
});

describe('height cap in place', () => {
  it('updates the plotted range and value ticks without touching cells or colors', () => {
    const m = single(mate);
    const panels = m.panels;
    const levels = m.contourLevels;
    const colorMax = m.colorMax;
    setModelHeightCap(m, 1);
    expect(m.heightCap).toBe(1);
    expect(m.plotMax).toBeLessThanOrEqual(1);
    expect(m.valueTicks[m.valueTicks.length - 1]).toBe(1);
    setModelHeightCap(m, 6);
    expect(m.plotMax).toBe(Math.min(6, Math.max(...panels[0].values.flat().filter((v): v is number => v !== null))));
    expect(m.panels).toBe(panels);
    expect(m.contourLevels).toBe(levels);
    expect(m.colorMax).toBe(colorMax);
  });
});
