import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, DataPoint } from '../types';
import { gridView, sliceAtGray } from './grid';
import { cellAreas, computeRecordStats, interpolateAtNits, safeFromNits, SVM_AT_NITS, type StatsOptions } from './stats';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/datasets', f), 'utf8')) as Dataset;
const BUNDLED = fs.readdirSync(path.resolve(__dirname, '../../public/datasets')).filter((f) => f.endsWith('.json') && f !== 'manifest.json');

const ALL: StatsOptions = { clipLowGray: false, maxNits: null, sliceGray: 127 };
const DEFAULT: StatsOptions = { clipLowGray: true, maxNits: 500, sliceGray: 127 };

/**
 * Synthetic dataset in the on-disk ordering (gray descending, brightness descending).
 * rows: gray levels; header: level luminance per column; cell(r, c) -> [nits, svm] | null.
 */
function synth(rows: number[], header: number[], cell: (gray: number, level: number, r: number, c: number) => [number, number] | null): Dataset {
  const cols = header.map((_, i) => 100 - i * 10);
  const grid: (DataPoint | null)[][] = rows.map((g, r) =>
    header.map((lv, c) => {
      const v = cell(g, lv, r, c);
      return v ? { gray: g, brightnessPercent: cols[c], nits: v[0], svm: v[1] } : null;
    }),
  );
  return { id: 'x', name: 'x', data: [], matrix: { rows, cols, headerNits: header, grid } };
}

describe('cellAreas', () => {
  it('weights cells by log-nits width x gray height', () => {
    // x = log10(n + 1) = 1, 2, 4 -> edges 0.5, 1.5, 3, 5 -> widths 1, 1.5, 2
    const ds = synth([255, 155], [9999, 99, 9], () => [1, 0.1]);
    const v = gridView(ds);
    const a = cellAreas(v);
    // gray edges [105, 205, 255] (clamped): heights 100, 50
    expect(a[0].map((x) => x / 100)).toEqual([1, 1.5, 2].map((w) => expect.closeTo(w, 9)));
    expect(a[1].map((x) => x / 50)).toEqual([1, 1.5, 2].map((w) => expect.closeTo(w, 9)));
  });
});

describe('computeRecordStats — synthetic grids', () => {
  it('equal areas: shares and mean are plain fractions; missing cells excluded', () => {
    // grays 100/200 -> heights 100 each; x = 1, 2 -> widths 1 each
    const ds = synth([200, 100], [99, 9], (g, lv) => {
      if (g === 200 && lv === 99) return null; // missing
      if (g === 100 && lv === 9) return [1, 0.1];
      if (g === 100 && lv === 99) return [10, 0.5];
      return [5, 1.5];
    });
    const s = computeRecordStats(ds, ALL);
    expect(s.cellCount).toBe(3);
    expect(s.safeShare).toBeCloseTo(1 / 3, 9);
    expect(s.midShare).toBeCloseTo(1 / 3, 9);
    expect(s.criticalShare).toBeCloseTo(1 / 3, 9);
    expect(s.meanSvm).toBeCloseTo(0.7, 9);
    expect(s.peak).toEqual({ svm: 1.5, gray: 200, levelNits: 9, nits: 5 });
    expect(s.coverage).toEqual({ grayMin: 100, grayMax: 200, levelMin: 9, levelMax: 99 });
  });

  it('unequal areas: wide high-luminance cells weigh more', () => {
    const ds = synth([255], [9999, 99, 9], (_g, lv) => (lv === 9 ? [9, 0.1] : lv === 99 ? [99, 0.5] : [9999, 2]));
    const s = computeRecordStats(ds, ALL);
    expect(s.safeShare).toBeCloseTo(1 / 4.5, 9);
    expect(s.midShare).toBeCloseTo(1.5 / 4.5, 9);
    expect(s.criticalShare).toBeCloseTo(2 / 4.5, 9);
    expect(s.meanSvm).toBeCloseTo((0.1 * 1 + 0.5 * 1.5 + 2 * 2) / 4.5, 9);
  });

  it('thresholds: exactly 0.4 is mid, exactly 1.0 is critical', () => {
    const ds = synth([255], [99, 9], (_g, lv) => (lv === 9 ? [9, 0.4] : [99, 1.0]));
    const s = computeRecordStats(ds, ALL);
    expect(s.safeShare).toBe(0);
    expect(s.midShare).toBeCloseTo(0.5, 9);
    expect(s.criticalShare).toBeCloseTo(0.5, 9);
  });

  it('single row and single column', () => {
    const row = synth([255], [500, 50, 5], (_g, lv) => [lv, lv > 10 ? 0.1 : 0.9]);
    const r = computeRecordStats(row, ALL);
    expect(r.cellCount).toBe(3);
    expect(r.fullWhiteSafeNits).toBe(50);
    expect(r.fullWhiteAllSafe).toBe(false);
    expect(r.fullWhiteGray).toBe(255);

    const col = synth([255, 128, 30], [200], (g) => [g, g < 100 ? 3 : 0.2]);
    const c = computeRecordStats(col, ALL);
    expect(c.cellCount).toBe(3);
    // gray edges [0 (clamped from -19), 79, 191.5, 255]: heights 79, 112.5, 63.5
    expect(c.criticalShare).toBeCloseTo(79 / 255, 9);
    expect(c.peak?.gray).toBe(30);
    expect(c.fullWhiteSafeNits).toBe(255);
    expect(c.fullWhiteAllSafe).toBe(true);
  });

  it('clip removing everything yields an empty, null-safe result', () => {
    const ds = synth([10, 5, 1], [300, 30, 3], () => [1, 2]);
    const s = computeRecordStats(ds, { clipLowGray: true, maxNits: null, sliceGray: 127 });
    expect(s.cellCount).toBe(0);
    expect(s.safeShare).toBeNull();
    expect(s.midShare).toBeNull();
    expect(s.criticalShare).toBeNull();
    expect(s.meanSvm).toBeNull();
    expect(s.peak).toBeNull();
    expect(s.coverage).toBeNull();
    expect(s.fullWhiteSafeNits).toBeNull();
    expect(s.fullWhiteGray).toBeNull();

    const capped = computeRecordStats(ds, { clipLowGray: false, maxNits: 1, sliceGray: 127 });
    expect(capped.cellCount).toBe(0);
    expect(capped.safeShare).toBeNull();
  });

  it('all-missing grid', () => {
    const ds = synth([255, 128], [100, 10], () => null);
    const s = computeRecordStats(ds, ALL);
    expect(s.cellCount).toBe(0);
    expect(s.meanSvm).toBeNull();
    expect(s.svmAt.every((x) => x.svm === null)).toBe(true);
    expect(s.sliceGray).toBeNull();
  });

  it('values outside the usual range: negative / huge SVM counted, NaN excluded', () => {
    const ds = synth([255], [99, 9, 0.5], (_g, lv) => (lv === 9 ? [9, -0.2] : lv === 99 ? [99, 42] : [0.5, NaN]));
    const s = computeRecordStats(ds, ALL);
    expect(s.cellCount).toBe(2);
    expect(s.peak?.svm).toBe(42);
    expect((s.safeShare ?? 0) + (s.midShare ?? 0) + (s.criticalShare ?? 0)).toBeCloseTo(1, 9);
    expect(s.safeShare! > 0 && s.criticalShare! > 0).toBe(true);
  });

  it('fullWhiteSafeNits: lowest nits from which all brighter samples are safe', () => {
    const pts: [number, number][] = [
      [2, 1.2],
      [10, 0.3],
      [50, 0.5],
      [200, 0.2],
      [500, 0.1],
    ];
    const ds = synth(
      [255, 100],
      pts.map((p) => p[0]).reverse(),
      (g, lv) => (g === 255 ? pts.find((p) => p[0] === lv)! : [lv / 5, 3]),
    );
    expect(computeRecordStats(ds, ALL).fullWhiteSafeNits).toBe(200);
    // cap below 200: only 2..50 remain, the brightest (50, 0.5) is unsafe -> never
    expect(computeRecordStats(ds, { ...ALL, maxNits: 100 }).fullWhiteSafeNits).toBeNull();
  });

  it('svmAt interpolates in log-nits on the gray slice and is null outside range', () => {
    const ds = synth([255, 127], [1000, 100, 10, 1], (g, lv) => {
      if (g === 255) return [lv, 0.1];
      const t: Record<number, [number, number]> = { 1000: [100, 0.2], 100: [10, 0.4], 10: [1, 0.8], 1: [0.5, 1.2] };
      return t[lv];
    });
    const s = computeRecordStats(ds, { ...ALL, sliceGray: 127 });
    expect(s.sliceGray).toBe(127);
    const at = Object.fromEntries(s.svmAt.map((x) => [x.nits, x.svm]));
    expect(at[2]).toBeCloseTo(0.8 - 0.4 * Math.log10(2), 9);
    expect(at[10]).toBeCloseTo(0.4, 9);
    expect(at[50]).toBeCloseTo(0.4 - 0.2 * Math.log10(5), 9);
    expect(at[100]).toBeCloseTo(0.2, 9);
    // G255 row: range 1..1000 nits, constant 0.1
    const top = computeRecordStats(ds, { ...ALL, sliceGray: 255 });
    expect(top.svmAt.map((x) => x.svm)).toEqual([0.1, 0.1, 0.1, 0.1].map((v) => expect.closeTo(v, 9)));
    // Slice gray outside the measured rows is clamped.
    const hi = computeRecordStats(ds, { ...ALL, sliceGray: 999 });
    expect(hi.sliceGray).toBe(255);
    const lo = computeRecordStats(ds, { ...ALL, sliceGray: -5 });
    expect(lo.sliceGray).toBe(127);
  });

  it('memoizes per matrix + options', () => {
    const ds = synth([255], [99, 9], () => [5, 0.2]);
    const a = computeRecordStats(ds, ALL);
    expect(computeRecordStats(ds, { ...ALL })).toBe(a);
    expect(computeRecordStats(ds, { ...ALL, sliceGray: 200 })).not.toBe(a);
    expect(computeRecordStats({ matrix: { ...ds.matrix } }, ALL)).not.toBe(a);
  });
});

describe('interpolateAtNits / safeFromNits', () => {
  it('handles empty, single, duplicates and bounds', () => {
    expect(interpolateAtNits([], 10)).toBeNull();
    expect(interpolateAtNits([{ nits: 10, svm: 0.3 }], 10)).toBe(0.3);
    expect(interpolateAtNits([{ nits: 10, svm: 0.3 }], 11)).toBeNull();
    expect(interpolateAtNits([{ nits: 1, svm: 1 }, { nits: 100, svm: 0 }], 10)).toBeCloseTo(0.5, 9);
    expect(interpolateAtNits([{ nits: 1, svm: 1 }, { nits: 100, svm: 0 }], 0)).toBeNull();
    expect(interpolateAtNits([{ nits: 5, svm: 1 }, { nits: 5, svm: 0 }], 5)).toBeCloseTo(0.5, 9);
  });
  it('safeFromNits', () => {
    expect(safeFromNits([])).toBeNull();
    expect(safeFromNits([{ nits: 10, svm: 0.5 }])).toBeNull();
    expect(safeFromNits([{ nits: 10, svm: 0.1 }, { nits: 1, svm: 0.1 }])).toBe(1);
    expect(safeFromNits([{ nits: 0, svm: 0.1 }, { nits: 3, svm: 0.1 }])).toBe(3); // nits <= 0 ignored
  });
});

describe('computeRecordStats — bundled records', () => {
  for (const f of BUNDLED) {
    it(`${f}: consistent with its grid`, () => {
      const ds = load(f);
      for (const opts of [ALL, DEFAULT]) {
        const s = computeRecordStats(ds, opts);
        const v = gridView(ds, opts);
        const vals = v.points.flat().filter((p): p is DataPoint => !!p).map((p) => p.svm);
        expect(s.cellCount).toBe(vals.length);
        expect(s.safeShare! + s.midShare! + s.criticalShare!).toBeCloseTo(1, 9);
        for (const x of [s.safeShare!, s.midShare!, s.criticalShare!]) expect(x).toBeGreaterThanOrEqual(0);
        expect(s.meanSvm!).toBeGreaterThanOrEqual(Math.min(...vals));
        expect(s.meanSvm!).toBeLessThanOrEqual(Math.max(...vals));
        expect(s.peak!.svm).toBe(Math.max(...vals));
        if (opts.clipLowGray) expect(s.peak!.gray).toBeGreaterThanOrEqual(15);
        if (opts.maxNits) expect(s.coverage!.levelMax).toBeLessThanOrEqual(opts.maxNits);
        expect(s.fullWhiteGray).toBe(255);

        // fullWhiteSafeNits: every brighter G255 sample is safe; the next dimmer one is not.
        const top = v.points[v.points.length - 1].filter((p): p is DataPoint => !!p).sort((a, b) => a.nits - b.nits);
        if (s.fullWhiteSafeNits !== null) {
          const i = top.findIndex((p) => p.nits === s.fullWhiteSafeNits);
          expect(i).toBeGreaterThanOrEqual(0);
          top.slice(i).forEach((p) => expect(p.svm).toBeLessThan(0.4));
          if (i > 0) expect(top[i - 1].svm).toBeGreaterThanOrEqual(0.4);
        } else {
          expect(top[top.length - 1].svm).toBeGreaterThanOrEqual(0.4);
        }

        // svmAt agrees with the gray slice
        const slice = sliceAtGray(ds, 127);
        s.svmAt.forEach(({ nits, svm }, k) => {
          expect(nits).toBe(SVM_AT_NITS[k]);
          if (nits < slice[0].nits || nits > slice[slice.length - 1].nits) expect(svm).toBeNull();
          else expect(svm).not.toBeNull();
        });
      }
    });
  }

  it('clip removes the noisy low-gray peak on the example-like data', () => {
    const iphone = load('iPhone17ProMax.json');
    const all = computeRecordStats(iphone, ALL);
    const clipped = computeRecordStats(iphone, DEFAULT);
    expect(clipped.peak!.svm).toBeLessThanOrEqual(all.peak!.svm);
    expect(clipped.cellCount).toBeLessThan(all.cellCount);
  });
});
