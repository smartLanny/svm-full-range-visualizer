import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../../types';
import { logNits } from '../../data/grid';
import { buildModel, cellAt, diffContourLevels, diffRange, SX, SY, type SceneModel } from './model';
import { buildSurfaceGrid } from './surfaceGrid';
import { cutUnderLabels, placeLabels, traceContours } from './contours';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/datasets', f), 'utf8')) as SvmRecord;
const iphone = load('iPhone17ProMax.json');
const mate = load('huawei_mate70air.json');
const mateLow = load('huawei_mate70air_low_frequency.json');

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

  it('diff uses a symmetric range and reports missing B', () => {
    const res = buildModel({ layout: 'diff', a: mate, b: mateLow, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.colorMax).toBe(diffRange(res.model.panels[0].maxAbs));
    expect(diffRange(0.2)).toBe(0.5);
    expect(diffRange(1.2)).toBe(1.5);
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
