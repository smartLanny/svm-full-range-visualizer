import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cellEdges, diffRecords, gridView, logTicks, sampleView, sliceAtGray, sliceAtLevel } from './grid';
import type { Dataset } from '../types';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/datasets', f), 'utf8')) as Dataset;
const iphone = load('iPhone17ProMax.json');
const mate = load('huawei_mate70air.json');

describe('gridView', () => {
  it('sorts ascending and applies clip / cap', () => {
    const v = gridView(iphone, { clipLowGray: true, maxNits: 500 });
    expect(v.grays[0]).toBeGreaterThanOrEqual(15);
    expect([...v.grays].sort((a, b) => a - b)).toEqual(v.grays);
    expect([...v.levelNits].sort((a, b) => a - b)).toEqual(v.levelNits);
    expect(Math.max(...v.levelNits)).toBeLessThanOrEqual(500);
    expect(v.points[0][0]?.gray).toBe(v.grays[0]);
  });
});

describe('cellEdges', () => {
  it('uses midpoints and extends ends', () => {
    expect(cellEdges([0, 10, 30])).toEqual([-5, 5, 20, 40]);
    expect(cellEdges([0, 10, 30], 0, 35)).toEqual([0, 5, 20, 35]);
  });
});

describe('slices', () => {
  it('gray slice at a measured row returns measured points', () => {
    const s = sliceAtGray(iphone, 255);
    const row = iphone.matrix.grid[0].filter(Boolean);
    expect(s.length).toBe(row.filter((p) => p!.nits > 0).length);
    expect(s[s.length - 1].nits).toBeCloseTo(Math.max(...row.map((p) => p!.nits)), 3);
  });
  it('gray slice is continuous between rows', () => {
    const a = sliceAtGray(iphone, 200);
    const b = sliceAtGray(iphone, 200.001);
    expect(a.length).toBe(b.length);
    a.forEach((p, i) => expect(Math.abs(p.svm - b[i].svm)).toBeLessThan(1e-2));
  });
  it('level slice at a measured column equals that column', () => {
    const v = gridView(mate);
    const c = 5;
    const s = sliceAtLevel(mate, v.levelNits[c]);
    expect(s.length).toBe(v.grays.length);
    s.forEach((p, r) => expect(p.svm).toBeCloseTo(v.points[r][c]!.svm, 6));
  });
});

describe('sample / diff', () => {
  it('samples exact grid points', () => {
    const v = gridView(mate);
    const s = sampleView(v, v.x[3], v.grays[4]);
    expect(s?.svm).toBeCloseTo(v.points[4][3]!.svm, 9);
  });
  it('self-diff is zero', () => {
    const d = diffRecords(mate, mate, { clipLowGray: true, maxNits: 500 });
    expect(d.maxAbs).toBeLessThan(1e-9);
    expect(d.count).toBeGreaterThan(100);
  });
});

describe('logTicks', () => {
  it('1-2-5 ticks', () => {
    expect(logTicks(0.01, 500)).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]);
  });
});
