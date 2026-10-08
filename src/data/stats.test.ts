import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, DataPoint, SvmRecord } from '../types';
import { gridView, sliceAtGray } from './grid';
import { cellAreas, computeRecordStats, denoiseInScope, interpolateAtNits, nominalScope, safeFromNits, SVM_AT_NITS, type StatsOptions } from './stats';
import { processRecord, rawDataset } from './denoise';
import { validateDataset } from './records';
import { recordStyles } from './colors';
import { buildScene, type ChartInputs } from '../chart2d/scene';
import { buildTable } from '../chart2d/table';
import { settleSlice, smoothSliceAtGray } from '../chart2d/slices';

// The first Xiaomi 18 Pro Max session (superseded by a re-test) lives on in test-fixtures/ as
// real-world defects: xiaomi18promax_v1_off/on.json (with the exclusions stored at the time).
const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, f.includes('_v1_') ? '../../test-fixtures' : '../../public/datasets', f), 'utf8')) as Dataset;
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
    expect(s.validExtent).toEqual({ grayMin: 100, grayMax: 200, levelMin: 9, levelMax: 99 });
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
    expect(s.validExtent).toBeNull();
    expect(s.coverageShare).toBeNull();
    expect(s.nominalCount).toBe(0);
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
    const ds = synth([255, 100], pts.map((p) => p[0]).reverse(), (g, lv) => (g === 255 ? pts.find((p) => p[0] === lv)! : [lv / 5, 3]));
    expect(computeRecordStats(ds, ALL).fullWhiteSafeNits).toBe(200);
    // cap below 200: only 2..50 remain, the brightest (50, 0.5) is unsafe -> never
    expect(computeRecordStats(ds, { ...ALL, maxNits: 100 }).fullWhiteSafeNits).toBeNull();
  });

  it('svmAt follows the 2D curve on the gray slice (monotone, exact at samples) and is null outside range', () => {
    const ds = synth([255, 127], [1000, 100, 10, 1], (g, lv) => {
      if (g === 255) return [lv, 0.1];
      const t: Record<number, [number, number]> = { 1000: [100, 0.2], 100: [10, 0.4], 10: [1, 0.8], 1: [0.5, 1.2] };
      return t[lv];
    });
    const s = computeRecordStats(ds, { ...ALL, sliceGray: 127 });
    expect(s.sliceGray).toBe(127);
    const at = Object.fromEntries(s.svmAt.map((x) => [x.nits, x.svm]));
    // Exact at measured nits; between samples a monotone cubic (never outside the neighbours).
    expect(at[10]).toBeCloseTo(0.4, 9);
    expect(at[100]).toBeCloseTo(0.2, 9);
    expect(at[2]).toBeGreaterThan(0.4);
    expect(at[2]).toBeLessThan(0.8);
    expect(at[50]).toBeGreaterThan(0.2);
    expect(at[50]).toBeLessThan(0.4);
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

describe('coverage (valid area / nominal area of the scope)', () => {
  it('counts missing rows / columns that gridView drops, on the nominal layout', () => {
    // 2 x 2 nominal grid, equal areas; the whole x=2 column is missing -> gridView drops it.
    const ds = synth([200, 100], [99, 9], (_g, lv) => (lv === 99 ? null : [1, 0.1]));
    const s = computeRecordStats(ds, ALL);
    expect(gridView(ds).x.length).toBe(1);
    expect(s.cellCount).toBe(2);
    expect(s.nominalCount).toBe(4);
    // nominal x edges 0.5 | 1.5 | 2.5 -> equal widths; gray heights equal -> half the area valid
    expect(s.coverageShare).toBeCloseTo(0.5, 9);
    const full = computeRecordStats(
      synth([200, 100], [99, 9], () => [1, 0.1]),
      ALL,
    );
    expect(full.coverageShare).toBeCloseTo(1, 9);
  });

  it('follows the clip / cap scope', () => {
    const ds = synth([255, 10], [999, 9], (g, lv) => (g === 10 || lv === 999 ? null : [1, 0.1]));
    expect(nominalScope(ds, { clipLowGray: true, maxNits: 100 }).areas.flat()).toHaveLength(1);
    const s = computeRecordStats(ds, { clipLowGray: true, maxNits: 100, sliceGray: 127 });
    expect(s.nominalCount).toBe(1);
    expect(s.coverageShare).toBeCloseTo(1, 9);
  });

  it('RecordStats.denoise: the displayed record\'s own counts inside the scope (first 18 Pro Max session, fixtures)', () => {
    for (const f of ['xiaomi18promax_v1_off.json', 'xiaomi18promax_v1_on.json']) {
      const raw = rawDataset(load(f));
      expect(computeRecordStats(raw, ALL).denoise).toEqual({ interpolated: 0, noData: 0, lumEstimated: 0 });
      const on = processRecord(raw, { denoise: true });
      const all = computeRecordStats(on.record, ALL);
      expect(all.denoise).toEqual({ interpolated: on.summary.interpolated, noData: on.summary.noData, lumEstimated: on.summary.lumEstimated });
      const def = computeRecordStats(on.record, DEFAULT);
      expect(def.denoise.noData).toBeGreaterThan(0);
      expect(def.denoise.noData).toBeLessThan(all.denoise.noData);
      expect(def.coverageShare!).toBeLessThan(0.95);
    }
  });

  it('cells the denoise shows as no data lower coverage by exactly those cells and leave the other stats well-defined', () => {
    const raw = rawDataset(load('iPhone17ProMax.json'));
    const before = computeRecordStats(raw, ALL);
    const on = processRecord(raw, { denoise: true });
    const after = computeRecordStats(on.record, ALL);
    expect(after.coverageShare!).toBeLessThanOrEqual(before.coverageShare! + 1e-12);
    expect(after.cellCount + after.denoise.noData).toBe(before.cellCount);
    expect(after.meanSvm).not.toBeNull();
  });
});

describe('svmAt equals the 2D chart data table (docs/adr/0009)', () => {
  const asRec = (f: string, id: string): SvmRecord => ({ ...load(f), id, device: id, mode: '', source: 'bundled' });
  const records = [asRec('iPhone17ProMax.json', 'a'), asRec('huawei_mate80rs.json', 'b'), asRec('xiaomi18promax_adaptive_pro_on.json', 'c')];
  for (const sliceGray of [127, 100.5, 255, 40]) {
    it(`G${sliceGray}`, () => {
      const inputs: ChartInputs = {
        records,
        hiddenIds: [],
        styles: recordStyles(records),
        lang: 'zh',
        sliceMode: 'gray',
        sliceGray,
        sliceNits: 100,
        axisMode: 'free',
        clipLowGray: true,
        presenting: false,
        presentBlack: false,
      };
      const table = buildTable(buildScene(inputs, { t: null, interactive: false }));
      let compared = 0;
      for (const row of table.rows) {
        const rec = records.find((r) => r.id === row.id)!;
        const s = computeRecordStats(rec, { ...DEFAULT, sliceGray });
        for (const a of s.svmAt) {
          const k = table.xs.findIndex((x) => Math.abs(x - a.nits) < 1e-9);
          if (k < 0) continue;
          compared++;
          if (a.svm === null) expect(row.values[k]).toBeNull();
          else expect(row.values[k]).toBeCloseTo(a.svm, 12);
        }
      }
      expect(compared).toBeGreaterThanOrEqual(records.length * 2);
    });
  }
});

describe('interpolateAtNits / safeFromNits', () => {
  it('handles empty, single, duplicates and bounds', () => {
    expect(interpolateAtNits([], 10)).toBeNull();
    expect(interpolateAtNits([{ nits: 10, svm: 0.3 }], 10)).toBe(0.3);
    expect(interpolateAtNits([{ nits: 10, svm: 0.3 }], 11)).toBeNull();
    expect(
      interpolateAtNits(
        [
          { nits: 1, svm: 1 },
          { nits: 100, svm: 0 },
        ],
        10,
      ),
    ).toBeCloseTo(0.5, 9);
    expect(
      interpolateAtNits(
        [
          { nits: 1, svm: 1 },
          { nits: 100, svm: 0 },
        ],
        0,
      ),
    ).toBeNull();
    expect(
      interpolateAtNits(
        [
          { nits: 5, svm: 1 },
          { nits: 5, svm: 0 },
        ],
        5,
      ),
    ).toBeCloseTo(0.5, 9);
  });
  it('safeFromNits', () => {
    expect(safeFromNits([])).toBeNull();
    expect(safeFromNits([{ nits: 10, svm: 0.5 }])).toBeNull();
    expect(
      safeFromNits([
        { nits: 10, svm: 0.1 },
        { nits: 1, svm: 0.1 },
      ]),
    ).toBe(1);
    expect(
      safeFromNits([
        { nits: 0, svm: 0.1 },
        { nits: 3, svm: 0.1 },
      ]),
    ).toBe(3); // nits <= 0 ignored
  });
});

describe('computeRecordStats — bundled records', () => {
  for (const f of BUNDLED) {
    it(`${f}: consistent with its grid`, () => {
      const ds = load(f);
      for (const opts of [ALL, DEFAULT]) {
        const s = computeRecordStats(ds, opts);
        const v = gridView(ds, opts);
        const vals = v.points
          .flat()
          .filter((p): p is DataPoint => !!p)
          .map((p) => p.svm);
        expect(s.cellCount).toBe(vals.length);
        if (vals.length === 0) {
          expect(s.safeShare).toBeNull();
          expect(s.midShare).toBeNull();
          expect(s.criticalShare).toBeNull();
          expect(s.meanSvm).toBeNull();
          expect(s.peak).toBeNull();
          expect(s.validExtent).toBeNull();
          continue;
        }
        expect(s.safeShare! + s.midShare! + s.criticalShare!).toBeCloseTo(1, 9);
        for (const x of [s.safeShare!, s.midShare!, s.criticalShare!]) expect(x).toBeGreaterThanOrEqual(0);
        expect(s.meanSvm!).toBeGreaterThanOrEqual(Math.min(...vals));
        expect(s.meanSvm!).toBeLessThanOrEqual(Math.max(...vals));
        expect(s.peak!.svm).toBe(Math.max(...vals));
        if (opts.clipLowGray) expect(s.peak!.gray).toBeGreaterThanOrEqual(15);
        if (opts.maxNits) expect(s.validExtent!.levelMax).toBeLessThanOrEqual(opts.maxNits);
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

        // svmAt agrees with the gray slice: null outside its range, and inside it only across a
        // gap of the 2D curve (a column whose reading was excluded or is missing at this gray).
        const slice = sliceAtGray(ds, 127);
        const kept = settleSlice(smoothSliceAtGray(ds, 127)).sort((a, b) => a.x - b.x);
        s.svmAt.forEach(({ nits, svm }, k) => {
          expect(nits).toBe(SVM_AT_NITS[k]);
          if (nits < slice[0].nits || nits > slice[slice.length - 1].nits) expect(svm).toBeNull();
          else if (svm === null) {
            const i = kept.findIndex((p, j) => j + 1 < kept.length && p.x <= nits && nits <= kept[j + 1].x);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(Math.abs(kept[i + 1].key - kept[i].key)).toBeGreaterThan(1);
          }
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

describe('stats on denoised records (docs/adr/0012 addendum)', () => {
  const rawOf = (f: string) => rawDataset(validateDataset(load(f)));
  const scope = { clipLowGray: true, maxNits: 500 as number | null, sliceGray: 127 };

  it('denoiseInScope counts the processed cells inside the clip / cap; nothing with denoise off', () => {
    const raw = rawOf('iPhone18ProMax.json');
    const on = processRecord(raw, { denoise: true });
    const inScope = denoiseInScope(on, scope);
    const all = denoiseInScope(on, { clipLowGray: false, maxNits: null });
    expect(all).toEqual({ interpolated: on.summary.interpolated, noData: on.summary.noData, lumEstimated: on.summary.lumEstimated });
    expect(inScope.noData).toBeLessThan(all.noData);
    expect(inScope.lumEstimated).toBeGreaterThan(20);
    expect(denoiseInScope(processRecord(raw, { denoise: false }), scope)).toEqual({ interpolated: 0, noData: 0, lumEstimated: 0 });
  });

  it('coverage counts measured + interpolated cells; no-data cells lower it', () => {
    const raw = rawOf('huawei_mate80rs.json');
    const on = processRecord(raw, { denoise: true });
    const s = computeRecordStats(on.record, { ...scope, clipLowGray: false, maxNits: null });
    const nominal = raw.matrix.rows.length * raw.matrix.cols.length;
    expect(s.nominalCount).toBe(nominal);
    expect(s.cellCount).toBe(nominal - on.summary.noData);
    expect(s.coverageShare!).toBeLessThan(1);
    expect(computeRecordStats(raw, { ...scope, clipLowGray: false, maxNits: null }).coverageShare).toBe(1);
  });

  it('a spike removed by the denoise no longer sets the peak (Xiaomi 17 Ultra DC, 22.73 at G21 / 0 %)', () => {
    const raw = rawOf('xiaomi17ultra_leica_dc_120hz.json');
    expect(computeRecordStats(raw, scope).peak!.svm).toBeCloseTo(22.725, 3);
    expect(computeRecordStats(processRecord(raw, { denoise: true }).record, scope).peak!.svm).toBeLessThan(6);
  });
});
