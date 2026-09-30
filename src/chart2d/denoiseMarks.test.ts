import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, SvmRecord } from '../types';
import { rawDataset, processRecord } from '../data/denoise';
import { gridView } from '../data/grid';
import { gapNotes, interpolatedShare, pointCells, pointNotes } from './denoiseMarks';
import { buildCurve, curveSpanAt } from './spline';

const dir = path.resolve(__dirname, '../../public/datasets');
// The first Xiaomi 18 Pro Max session (superseded by a re-test) lives on in test-fixtures/ as
// real-world defects: xiaomi18promax_v1_off/on.json (with the exclusions stored at the time).
const rec = (f: string): SvmRecord => rawDataset({ ...(JSON.parse(fs.readFileSync(f.includes('_v1_') ? path.resolve(__dirname, '../../test-fixtures', f) : path.join(dir, f), 'utf8')) as Dataset), id: f, device: f, mode: '', source: 'bundled' as const });

describe('slice points back to their cells (docs/adr/0012 addendum)', () => {
  const m80 = processRecord(rec('huawei_mate80rs.json'), { denoise: true }).record;
  const v = gridView(m80);
  const key27 = v.percents.indexOf(27);

  it('gray slice: the two bracketing rows of the column, with the interpolation weights', () => {
    const cells = pointCells(m80, 'gray', 90, false, key27);
    expect(cells.map((x) => m80.matrix.rows[x.r]).sort((a, b) => a - b)).toEqual([83, 96]);
    expect(cells.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1, 12);
    expect(cells.every((x) => m80.matrix.cols[x.c] === 27)).toBe(true);
    // a measured row: one cell
    expect(pointCells(m80, 'gray', 96, false, key27)).toHaveLength(1);
  });
  it('brightness slice: the row of the key, the two bracketing columns', () => {
    const lv = gridView(m80, { clipLowGray: true });
    const key = lv.grays.indexOf(96);
    const cells = pointCells(m80, 'brightness', 30, true, key);
    expect(cells.every((x) => m80.matrix.rows[x.r] === 96)).toBe(true);
    expect(cells.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1, 12);
  });
  it('notes and the interpolated share of a point', () => {
    const n = pointNotes(m80, 'gray', 96, false, key27);
    expect(n).toHaveLength(1);
    expect(n[0].note.action).toBe('interpolated');
    expect(interpolatedShare(n)).toBe(1);
    // halfway to the next measured row: half of the point comes from the interpolated cell
    const g = (96 + 109) / 2;
    expect(interpolatedShare(pointNotes(m80, 'gray', g, false, key27))).toBeCloseTo(0.5, 9);
    // a raw record has no notes
    expect(pointNotes(rec('huawei_mate80rs.json'), 'gray', 96, false, key27)).toEqual([]);
  });
  it('gap notes: the no-data cells inside a gap (Xiaomi 18 Pro Max 关 first session G109, 4 % / 6 %)', () => {
    const x18 = processRecord(rec('xiaomi18promax_v1_off.json'), { denoise: true }).record;
    const xv = gridView(x18);
    const k4 = xv.percents.indexOf(4);
    const k6 = xv.percents.indexOf(6);
    const lo = Math.min(k4, k6) - 1;
    const hi = Math.max(k4, k6) + 1;
    const notes = gapNotes(x18, 'gray', 109, false, lo, hi);
    expect(notes.map((n) => n.brightnessPercent).sort((a, b) => a - b)).toEqual([4, 6]);
    expect(notes.every((n) => n.action === 'noData' && n.gray === 109)).toBe(true);
  });
});

describe('curveSpanAt', () => {
  const node = (x: number, key: number, a = 1) => ({ x, y: x * 2, a, key });
  it('the drawn segment under x, a gap between drawn nodes (keys missing), or nothing', () => {
    const c = buildCurve([node(0, 0), node(1, 1), node(3, 3), node(4, 4)])!;
    expect(curveSpanAt(c, 0.5)).toEqual({ nodes: [0, 1], gap: false });
    expect(curveSpanAt(c, 2)).toEqual({ nodes: [1, 2], gap: true });
    expect(c.keys[1]).toBe(1);
    expect(c.keys[2]).toBe(3);
    expect(curveSpanAt(c, 5)).toBeNull();
    // a single reading
    const one = buildCurve([node(2, 0)])!;
    expect(curveSpanAt(one, 2)).toEqual({ nodes: [0], gap: false });
  });
});
