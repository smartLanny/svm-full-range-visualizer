import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cellEdges, diffRecords, fmtNits, fmtSvm, gridView, levelRange, logTicks, sampleView, sliceAtGray, sliceAtLevel } from './grid';
import type { Dataset } from '../types';
import { restoreExcluded } from './anomalies';

// The first Xiaomi 18 Pro Max session (superseded by a re-test) lives on in test-fixtures/ as
// real-world defects: xiaomi18promax_v1_off/on.json (with the exclusions stored at the time).
const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, f.includes('_v1_') ? '../../test-fixtures' : '../../public/datasets', f), 'utf8')) as Dataset;
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

// ---------------------------------------------------------------------------
// Extended coverage (stats module).

const xiaomi = load('xiaomi17ultra_leica_dc_120hz.json');

/** Synthetic dataset in on-disk order (gray desc, level desc). svm/nits from functions of (gray, level). */
function synth(
  rows: number[],
  header: number[],
  f: (gray: number, level: number) => { nits: number; svm: number } | null,
): Dataset {
  const cols = header.map((_, i) => 100 - i);
  return {
    id: 's',
    name: 's',
    data: [],
    matrix: {
      rows,
      cols,
      headerNits: header,
      grid: rows.map((g) => header.map((lv, c) => {
        const v = f(g, lv);
        return v ? { gray: g, brightnessPercent: cols[c], ...v } : null;
      })),
    },
  };
}

describe('diffRecords across different grids', () => {
  it('Huawei (24 rows) minus Xiaomi (18 rows): null outside B, finite inside', () => {
    const a = gridView(mate);
    const b = gridView(xiaomi);
    expect(a.grays.length).toBe(24);
    expect(b.grays.length).toBe(18);
    const d = diffRecords(mate, xiaomi);
    let expected = 0;
    d.view.points.forEach((row, r) =>
      row.forEach((p, c) => {
        const inside =
          d.view.grays[r] >= b.grays[0] && d.view.grays[r] <= b.grays[b.grays.length - 1] && d.view.x[c] >= b.x[0] && d.view.x[c] <= b.x[b.x.length - 1];
        if (inside && p) {
          expected++;
          expect(Number.isFinite(d.values[r][c]!)).toBe(true);
        } else expect(d.values[r][c]).toBeNull();
      }),
    );
    expect(d.count).toBe(expected);
    expect(d.count).toBeGreaterThan(50);
    expect(d.count).toBeLessThan(24 * 18);
    // A's grid (with its clip / cap) is the output grid.
    expect(diffRecords(mate, xiaomi, { clipLowGray: true, maxNits: 500 }).view).toBe(gridView(mate, { clipLowGray: true, maxNits: 500 }));
  });

  it('bilinear resampling is exact for a function linear in (x, gray)', () => {
    const lin = (g: number, lv: number) => ({ nits: lv, svm: 0.3 * Math.log10(lv + 1) + 0.004 * g });
    const a = synth([250, 170, 90, 40], [400, 120, 30, 8, 2], lin);
    const b = synth([255, 200, 100, 20], [500, 50, 5, 1], (g, lv) => ({ nits: lv, svm: lin(g, lv).svm + 0.25 }));
    const d = diffRecords(a, b);
    expect(d.count).toBe(20);
    d.values.flat().forEach((v) => expect(v!).toBeCloseTo(-0.25, 9));
    expect(d.maxAbs).toBeCloseTo(0.25, 9);
  });
});

describe('sliceAtLevel edge cases', () => {
  it('outside the measured level range returns []', () => {
    const [lo, hi] = levelRange(mate)!;
    expect(sliceAtLevel(mate, hi * 2)).toEqual([]);
    expect(sliceAtLevel(mate, lo / 2)).toEqual([]);
    expect(sliceAtLevel(mate, hi).length).toBeGreaterThan(0);
  });
  it('honors the low-gray clip', () => {
    const s = sliceAtLevel(mate, 100, { clipLowGray: true });
    expect(Math.min(...s.map((p) => p.gray))).toBeGreaterThanOrEqual(15);
    expect(sliceAtLevel(mate, 100).length).toBeGreaterThan(s.length);
  });
});

describe('sampleView with missing corners', () => {
  const ds = synth([200, 100], [100, 10], (g, lv) => (g === 200 && lv === 100 ? null : { nits: lv, svm: g / 100 + lv / 100 }));
  const v = gridView(ds);
  it('a weighted missing corner -> null', () => {
    expect(sampleView(v, (v.x[0] + v.x[1]) / 2, 150)).toBeNull();
  });
  it('exact sample next to a missing corner still works (zero weight)', () => {
    expect(sampleView(v, v.x[0], 200)?.svm).toBeCloseTo(2.1, 9);
    expect(sampleView(v, v.x[1], 100)?.svm).toBeCloseTo(2, 9);
    // along an edge away from the missing corner
    expect(sampleView(v, (v.x[0] + v.x[1]) / 2, 100)?.svm).toBeCloseTo(1.55, 9);
  });
  it('out of range -> null', () => {
    expect(sampleView(v, v.x[1] + 0.1, 150)).toBeNull();
    expect(sampleView(v, v.x[0], 99)).toBeNull();
  });
});

describe('gridView robustness', () => {
  it('drops non-positive / non-finite level columns and caches per options', () => {
    const ds = synth([255, 128], [300, 0, NaN, 3], () => ({ nits: 1, svm: 0.1 }));
    const v = gridView(ds);
    expect(v.levelNits).toEqual([3, 300]);
    expect(gridView(ds)).toBe(v);
    expect(gridView(ds, { maxNits: 100 }).levelNits).toEqual([3]);
  });
});

describe('fmt helpers', () => {
  it('formats', () => {
    expect(fmtSvm(0.4)).toBe('0.40');
    expect(fmtSvm(NaN)).toBe('—');
    expect(fmtNits(512.3)).toBe('512');
    expect(fmtNits(35.24)).toBe('35.2');
    expect(fmtNits(2.1)).toBe('2.10');
    expect(fmtNits(0.012)).toBe('0.012');
  });
});

describe('duplicate level columns (raw xiaomi18promax_v1_on fixture: 60% and 50% share 162.51 nits)', () => {
  // The fixture is stored cleaned (docs/adr/0012); restore the raw grid to exercise the tie.
  const x18 = restoreExcluded(load('xiaomi18promax_v1_on.json'));
  it('the cleaned record drops the all-empty duplicate column from the grid view', () => {
    const clean = gridView(load('xiaomi18promax_v1_on.json'));
    expect(clean.levelNits.filter((n) => n === 162.51).length).toBe(1);
    expect(clean.percents).not.toContain(50);
  });
  const v = gridView(x18);
  const dup = 162.51;
  it('keeps both columns, ascending with a tie', () => {
    const idx = v.levelNits.map((n, i) => (n === dup ? i : -1)).filter((i) => i >= 0);
    expect(idx.length).toBe(2);
    expect(idx[1]).toBe(idx[0] + 1);
  });
  it('samples, slices and diffs stay finite at and around the tied level', () => {
    for (const n of [dup - 1, dup, dup + 1]) {
      const s = sliceAtLevel(x18, n);
      expect(s.length).toBe(v.grays.length);
      s.forEach((p) => expect(Number.isFinite(p.svm)).toBe(true));
      for (const g of [255, 200, 128, 60]) {
        const r = sampleView(v, Math.log10(n + 1), g);
        expect(r && Number.isFinite(r.svm)).toBe(true);
      }
    }
    const d = diffRecords(iphone, x18, { clipLowGray: true, maxNits: 500 });
    d.values.flat().forEach((x) => expect(x === null || Number.isFinite(x)).toBe(true));
    const d2 = diffRecords(x18, iphone, { clipLowGray: true, maxNits: 500 });
    d2.values.flat().forEach((x) => expect(x === null || Number.isFinite(x)).toBe(true));
  });
});
