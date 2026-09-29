import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, SvmRecord } from '../types';
import { gridView, sliceAtGray, sliceAtLevel } from '../data/grid';
import { buildSpline, evalSpline, monotoneSlopes } from './spline';
import { smoothSliceAtGray, smoothSliceAtLevel, sweepExtent, sweepParam, SWEEP_DURATION } from './slices';
import { buildAxes, logAxisTicks } from './scales';
import { buildScene, type ChartInputs } from './scene';
import { recordStyles } from '../data/colors';
import { buildTable, tableToTsv } from './table';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/datasets', f), 'utf8')) as Dataset;
const asRec = (ds: Dataset, id: string, device: string, mode: string): SvmRecord => ({ ...ds, id, device, mode, source: 'bundled' });
const iphone = asRec(load('iPhone17ProMax.json'), 'a', 'iPhone', 'std');
const mate = asRec(load('huawei_mate70air.json'), 'b', 'Mate', 'std');
const mate60 = asRec(load('huawei_mate70air_60hz.json'), 'c', 'Mate', '60Hz');

describe('monotone spline', () => {
  it('interpolates the points and never overshoots', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 5 },
      { x: 4, y: 4.9 },
    ];
    const s = buildSpline(pts)!;
    for (const p of pts) expect(evalSpline(s, p.x)).toBeCloseTo(p.y, 9);
    for (let x = 0; x <= 4; x += 0.01) {
      const i = Math.min(3, Math.floor(x));
      const v = evalSpline(s, x)!;
      expect(v).toBeGreaterThanOrEqual(Math.min(pts[i].y, pts[i + 1].y) - 1e-9);
      expect(v).toBeLessThanOrEqual(Math.max(pts[i].y, pts[i + 1].y) + 1e-9);
    }
    expect(evalSpline(s, -0.1)).toBeNull();
  });
  it('merges duplicate x and splits runs at NaN', () => {
    const s = buildSpline([
      { x: 1, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 2 },
    ])!;
    expect(s.xs.length).toBe(2);
    expect(s.ys[0]).toBeCloseTo(2);
    const m = monotoneSlopes([0, 1, 2, 3], [0, NaN, 1, 2]);
    expect(Number.isNaN(m[1])).toBe(true);
    expect(m[0]).toBe(0);
  });
});

describe('smooth slices', () => {
  it('match the grid slices exactly at measured rows / columns', () => {
    for (const g of gridView(mate).grays) {
      const a = sliceAtGray(mate, g);
      const b = smoothSliceAtGray(mate, g);
      expect(b.length).toBe(a.length);
      b.forEach((p, i) => {
        expect(p.svm).toBeCloseTo(a[i].svm, 9);
        expect(p.nits).toBeCloseTo(a[i].nits, 6);
      });
    }
    for (const n of gridView(iphone).levelNits) {
      const a = sliceAtLevel(iphone, n, { clipLowGray: true });
      const b = smoothSliceAtLevel(iphone, n, { clipLowGray: true });
      expect(b.length).toBe(a.length);
      b.forEach((p, i) => expect(p.svm).toBeCloseTo(a[i].svm, 6));
    }
  });
  it('stays between the neighbouring measurements', () => {
    const lin = sliceAtGray(mate, 124);
    const hi = sliceAtGray(mate, 139);
    const mid = smoothSliceAtGray(mate, 131);
    // compare by column: sort order may differ slightly, so compare svm ranges
    const lo = Math.min(...lin.map((p) => p.svm), ...hi.map((p) => p.svm));
    const up = Math.max(...lin.map((p) => p.svm), ...hi.map((p) => p.svm));
    for (const p of mid) {
      expect(p.svm).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(p.svm).toBeLessThanOrEqual(up + 1e-9);
    }
  });
  it('is continuous in the sweep parameter (no endpoint pops)', () => {
    for (let t = 0; t < SWEEP_DURATION; t += 0.1) {
      const a = smoothSliceAtGray(mate, sweepParam('gray', t));
      const b = smoothSliceAtGray(mate, sweepParam('gray', t + 1 / 60));
      expect(b.length).toBe(a.length);
      const ea = a[a.length - 1];
      const eb = b[b.length - 1];
      expect(Math.abs(Math.log10(ea.nits) - Math.log10(eb.nits))).toBeLessThan(0.02);
      expect(Math.abs(ea.svm - eb.svm)).toBeLessThan(0.05);
    }
  });
  it('sweep params go from start to end', () => {
    expect(sweepParam('gray', 0)).toBeCloseTo(255);
    expect(sweepParam('gray', SWEEP_DURATION)).toBeCloseTo(50);
    expect(sweepParam('brightness', 0)).toBeCloseTo(500);
    expect(sweepParam('brightness', SWEEP_DURATION)).toBeCloseTo(2);
  });
  it('sweep extent bounds every frame', () => {
    const e = sweepExtent([iphone, mate], 'gray', false)!;
    for (let t = 0; t <= SWEEP_DURATION; t += 0.25) {
      for (const r of [iphone, mate]) {
        for (const p of smoothSliceAtGray(r, sweepParam('gray', t))) {
          expect(p.x).toBeGreaterThanOrEqual(e.xMin * (1 - 1e-9));
          expect(p.x).toBeLessThanOrEqual(e.xMax * (1 + 1e-9));
          expect(p.svm).toBeGreaterThanOrEqual(e.yMin - 1e-9);
          expect(p.svm).toBeLessThanOrEqual(e.yMax + 1e-9);
        }
      }
    }
  });
});

describe('axes', () => {
  it('standard gray axis is 0.01-500 with the v1 ticks', () => {
    const a = buildAxes('gray', 'standard', null);
    expect(Math.pow(10, a.x.u0)).toBeCloseTo(0.01);
    expect(Math.pow(10, a.x.u1)).toBeCloseTo(500);
    expect(a.x.ticks.filter((t) => t.label).map((t) => t.label)).toEqual(['0.01', '0.1', '1', '10', '100', '500']);
    expect([a.y.u0, a.y.u1]).toEqual([0, 6]);
  });
  it('free mode pads y by 10% and never goes below 0 for non-negative data', () => {
    const a = buildAxes('gray', 'free', { xMin: 0.1, xMax: 100, yMin: 0.1, yMax: 4.1 });
    expect(a.y.u0).toBe(0);
    expect(a.y.u1).toBeCloseTo(4.5);
  });
  it('log ticks label a short range densely', () => {
    expect(logAxisTicks(2, 20, false).filter((t) => t.label).length).toBeGreaterThanOrEqual(3);
  });
});

describe('scene + table', () => {
  const records = [iphone, mate, mate60];
  const inputs: ChartInputs = {
    records,
    hiddenIds: ['c'],
    styles: recordStyles(records),
    lang: 'zh',
    sliceMode: 'gray',
    sliceGray: 127,
    sliceNits: 100,
    axisMode: 'standard',
    clipLowGray: true,
    presenting: false,
    presentBlack: false,
  };
  it('lists hidden records only in the interactive legend', () => {
    const on = buildScene(inputs, { t: null, interactive: true });
    expect(on.series.map((s) => s.id)).toEqual(['a', 'b']);
    expect(on.legend.flatMap((g) => g.rows.map((r) => r.id))).toEqual(['a', 'b', 'c']);
    const off = buildScene(inputs, { t: null, interactive: false });
    expect(off.legend.flatMap((g) => g.rows.map((r) => r.id))).toEqual(['a', 'b']);
    expect(on.title.join('')).toBe('SVM 测试（灰阶 G127）');
  });
  it('adaptive axes are fixed over a sweep', () => {
    const i2 = { ...inputs, axisMode: 'free' as const };
    const a = buildScene(i2, { t: 1, interactive: false }).axes;
    const b = buildScene(i2, { t: 7.3, interactive: false }).axes;
    expect([a.x.u0, a.x.u1, a.y.u0, a.y.u1]).toEqual([b.x.u0, b.x.u1, b.y.u0, b.y.u1]);
  });
  it('builds a table and TSV', () => {
    const tb = buildTable(buildScene(inputs, { t: null, interactive: false }));
    expect(tb.rows.length).toBe(2);
    expect(tb.xs.length).toBeGreaterThan(3);
    const tsv = tableToTsv(tb, { record: 'Record', unit: 'nits' });
    expect(tsv.split('\n').length).toBe(3);
  });
});
