import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, SvmRecord } from '../types';
import { gridView, sliceAtGray, sliceAtLevel } from '../data/grid';
import { buildSpline, evalSpline, monotoneSlopes } from './spline';
import { smoothSliceAtGray, smoothSliceAtLevel, sweepExtent, sweepParam, SWEEP_DURATION } from './slices';
import { buildAxes, logAxisTicks } from './scales';
import { buildScene, graySliceSvmAt, type ChartInputs } from './scene';
import { recordStyles } from '../data/colors';
import { buildTable, tableToTsv } from './table';
import { processRecord } from '../data/denoise';

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
    // (points fading in / out next to a missing cell are extra, with opacity < 1)
    const opaque = <T extends { a: number }>(pts: T[]) => pts.filter((p) => p.a >= 1 - 1e-9);
    for (const g of gridView(mate).grays) {
      const a = sliceAtGray(mate, g);
      const b = opaque(smoothSliceAtGray(mate, g));
      expect(b.length).toBe(a.length);
      b.forEach((p, i) => {
        expect(p.svm).toBeCloseTo(a[i].svm, 9);
        expect(p.nits).toBeCloseTo(a[i].nits, 6);
      });
    }
    for (const n of gridView(iphone).levelNits) {
      const a = sliceAtLevel(iphone, n, { clipLowGray: true });
      const b = opaque(smoothSliceAtLevel(iphone, n, { clipLowGray: true }));
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
  it('free axes follow the sweep (fix round 3: no longer fixed for the whole sweep)', () => {
    const i2 = { ...inputs, axisMode: 'free' as const };
    const a = buildScene(i2, { t: 1, interactive: false }).axes;
    const b = buildScene(i2, { t: 7.3, interactive: false }).axes;
    expect(a.x.u0).toBeGreaterThan(b.x.u0 + 0.5);
    expect(a.x.motion?.settle).toBe(0);
  });
  it('builds a table and TSV', () => {
    const tb = buildTable(buildScene(inputs, { t: null, interactive: false }));
    expect(tb.rows.length).toBe(2);
    expect(tb.xs.length).toBeGreaterThan(3);
    const tsv = tableToTsv(tb, { record: 'Record', unit: 'nits' });
    expect(tsv.split('\n').length).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// v2 fix round: fading curves, gaps, title slot, legend placement, overlays, exclusions.

import { buildCurve, evalCurve, segmentBezier, bezierAt } from './spline';
import { fmtLevel } from './slices';
import { renderChart, computeLayout } from './render';

/** Minimal CanvasRenderingContext2D stand-in: records fillText, measures 10 px per digit. */
function mockCtx() {
  const texts: { text: string; x: number; y: number }[] = [];
  const target: Record<string, unknown> = {
    texts,
    measureText: (s: string) => ({ width: [...s].reduce((a, ch) => a + (ch >= '0' && ch <= '9' ? 10 : ch === '.' ? 4 : 12), 0) }),
    fillText: (text: string, x: number, y: number) => texts.push({ text, x, y }),
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { texts: typeof texts };
}

describe('fmtLevel', () => {
  it('prints levels without a trailing .0', () => {
    expect([2, 7.5, 35, 500, 9.97, 3.14].map(fmtLevel)).toEqual(['2', '7.5', '35', '500', '10', '3.1']);
  });
});

describe('curves with opacity', () => {
  const pts = [0, 1, 2, 3, 4, 5].map((i) => ({ x: i, y: [0, 1, 1.5, 3, 3.2, 5][i], a: 1, key: i }));
  it('equal the monotone spline when every point is opaque and there is no gap', () => {
    const c = buildCurve(pts)!;
    const s = buildSpline(pts)!;
    for (let x = 0; x <= 5; x += 0.05) expect(evalCurve(c, x)!).toBeCloseTo(evalSpline(s, x)!, 3);
    expect(c.bridges).toEqual([]);
  });
  it('break at a missing key and mark the gap with a (dotted) bridge', () => {
    const c = buildCurve(pts.filter((p) => p.key !== 2))!;
    expect(c.seg[1]).toBe(0);
    expect(c.bridges.map((b) => [b.i0, b.i1, b.alpha])).toEqual([[1, 2, 1]]);
    expect(evalCurve(c, 2)).toBeNull();
  });
  it('cross-fade continuously while a point in the middle fades out', () => {
    const at = (a: number) => buildCurve(pts.map((p) => (p.key === 2 ? { ...p, a } : p)))!;
    const half = at(0.5);
    expect(half.bridges.find((b) => b.i0 === 1 && b.i1 === 3)!.alpha).toBeCloseTo(0.5);
    // the solid segment 0 -> 1 keeps its shape as the neighbour disappears
    const gone = buildCurve(pts.filter((p) => p.key !== 2))!;
    const almost = at(1e-7);
    const a = segmentBezier(almost, 0);
    const b = segmentBezier(gone, 0);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
  });
  it('stay continuous when two readings share an x or swap order', () => {
    const tie = buildCurve([
      { x: 0, y: 0, a: 1, key: 0 },
      { x: 1, y: 2, a: 1, key: 1 },
      { x: 1, y: 3, a: 1, key: 2 },
      { x: 2, y: 4, a: 1, key: 3 },
    ])!;
    const near = buildCurve([
      { x: 0, y: 0, a: 1, key: 0 },
      { x: 1, y: 2, a: 1, key: 1 },
      { x: 1 + 1e-6, y: 3, a: 1, key: 2 },
      { x: 2, y: 4, a: 1, key: 3 },
    ])!;
    for (let i = 0; i < 3; i++) {
      for (let u = 0; u <= 1; u += 0.25) {
        const p = bezierAt(segmentBezier(tie, i), u);
        const q = bezierAt(segmentBezier(near, i), u);
        expect(p[0]).toBeCloseTo(q[0], 4);
        expect(p[1]).toBeCloseTo(q[1], 4);
      }
    }
  });
});

describe('scene: overlays, exclusions, title slot, sweep glide', () => {
  const pro = records0('xiaomi18promax_adaptive_pro_off.json', 'x', 'Xiaomi 18 Pro Max', 'Pro off');
  const recs = [iphone, mate, pro];
  const base: ChartInputs = {
    records: recs,
    hiddenIds: [],
    styles: recordStyles(recs),
    lang: 'zh',
    sliceMode: 'gray',
    sliceGray: 127,
    sliceNits: 100,
    axisMode: 'standard',
    clipLowGray: true,
    presenting: false,
    presentBlack: false,
  };
  it('series of a denoised record carry its summary and hollow marks at interpolated points (static frames only)', () => {
    // Mate 80 RS 标准: G96 / 27 % and G96 / 80 % are repeated readings filled by interpolation.
    const m80 = processRecord(records0('huawei_mate80rs.json', 'm', 'Mate 80 RS', 'std'), { denoise: true }).record;
    const recs2 = [iphone, m80];
    const inp: ChartInputs = { ...base, records: recs2, styles: recordStyles(recs2), sliceGray: 96 };
    const sc = buildScene(inp, { t: null, interactive: true });
    const se = sc.series.find((s) => s.id === 'm')!;
    expect(se.denoise!.interpolated).toBeGreaterThan(0);
    expect(se.hollow.length).toBe(2);
    expect(se.hollow.every((h) => h.a === 1)).toBe(true);
    // a raw record has no summary and no marks; the legend has no '*' marker any more
    expect(sc.series.find((s) => s.id === 'a')!.denoise).toBeNull();
    expect(sc.series.find((s) => s.id === 'a')!.hollow).toEqual([]);
    // sweep frames stay clean
    expect(buildScene(inp, { t: 4, interactive: false }).series.every((s) => s.hollow.length === 0)).toBe(true);
    // the table marks the values read off the interpolated readings and explains the gaps
    const tb = buildTable(sc);
    const row = tb.rows.find((r) => r.id === 'm')!;
    expect(row.notes.some((n) => n?.interpolated)).toBe(true);
    expect(tb.rows.find((r) => r.id === 'a')!.notes.every((n) => n === null)).toBe(true);
    expect(tableToTsv(tb, { record: 'r', unit: 'nits' })).not.toContain('*');
  });
  it('honours overlays.title / overlays.colorbar (H)', () => {
    const sc = buildScene({ ...base, showTitle: false, showLegend: false }, { t: null, interactive: false });
    const ctx = mockCtx();
    const res = renderChart(ctx, 1600, 900, 1, sc);
    expect(res.title).toBeNull();
    expect(res.legend).toBeNull();
    expect(ctx.texts.some((t) => t.text.includes('SVM 测试'))).toBe(false);
    const on = renderChart(mockCtx(), 1600, 900, 1, buildScene(base, { t: null, interactive: false }));
    expect(on.title).not.toBeNull();
    expect(on.legend).not.toBeNull();
  });
  it('keeps the sweep title still while the value changes width (G100 -> G99, 500 -> 7.5 nits)', () => {
    for (const mode of ['gray', 'brightness'] as const) {
      const pos = new Set<string>();
      const ts = mode === 'gray' ? [6.6, 6.7, 6.8, 9.9] : [0, 5, 8.3, 10];
      for (const t of ts) {
        const ctx = mockCtx();
        renderChart(ctx, 1600, 900, 1, buildScene({ ...base, sliceMode: mode }, { t, interactive: false }));
        const sc = buildScene({ ...base, sliceMode: mode }, { t, interactive: false });
        const pre = ctx.texts.find((x) => x.text === sc.title[0])!;
        const post = ctx.texts.find((x) => x.text === sc.title[2])!;
        pos.add(`${pre.x.toFixed(2)}|${post.x.toFixed(2)}`);
      }
      expect([...pos].length).toBe(1);
    }
  });
  it('glides into a sweep: blend p=0 is the static frame, p→1 the sweep start', () => {
    const inp = { ...base, axisMode: 'free' as const };
    const st = buildScene(inp, { t: null, interactive: false });
    const b0 = buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 0 } });
    const b1 = buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 1 } });
    const sw = buildScene(inp, { t: 0, interactive: false });
    expect(b0.param).toBeCloseTo(st.param);
    expect(b0.axes.y.u1).toBeCloseTo(st.axes.y.u1);
    expect(b0.titleSlot.mix).toBe(0);
    expect(b1.param).toBeCloseTo(sw.param);
    expect(b1.axes.y.u1).toBeCloseTo(sw.axes.y.u1);
    expect(b1.titleSlot.mix).toBe(1);
    const mid = buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 0.5 } });
    expect(mid.param).toBeGreaterThan(st.param);
    expect(mid.param).toBeLessThan(sw.param);
  });
  it('places the legend where it covers no curve (brightness slice, small plot)', () => {
    const all = [iphone, mate, mate60, pro];
    for (const [w, h] of [
      [1008, 612],
      [1320, 790],
      [506, 840],
    ]) {
      for (const sliceNits of [2, 7.5]) {
        const sc = buildScene({ ...base, records: all, styles: recordStyles(all), sliceMode: 'brightness', sliceNits }, { t: null, interactive: false });
        const res = renderChart(mockCtx(), w, h, 1, sc);
        const L = res.legend!;
        const { plot } = computeLayout(w, h, 1);
        const X = (u: number) => plot.x + ((u - sc.axes.x.u0) / (sc.axes.x.u1 - sc.axes.x.u0)) * plot.w;
        const Y = (v: number) => plot.y + plot.h - ((v - sc.axes.y.u0) / (sc.axes.y.u1 - sc.axes.y.u0)) * plot.h;
        let inside = 0;
        for (const se of sc.series) {
          for (let g = 0; g <= 255; g += 1) {
            const v = se.curve ? evalCurve(se.curve, g) : null;
            if (v === null || v > sc.axes.y.u1) continue;
            const x = X(g);
            const y = Y(v);
            if (x > L.x && x < L.x + L.w && y > L.y && y < L.y + L.h) inside++;
          }
        }
        expect(inside).toBe(0);
        // compact: never more than about a quarter of the plot
        expect((L.w * L.h) / (plot.w * plot.h)).toBeLessThan(0.3);
      }
    }
  });
});

function records0(file: string, id: string, device: string, mode: string): SvmRecord {
  return asRec(load(file), id, device, mode);
}

describe('read-out helper for stats (docs/adr/0009)', () => {
  it('graySliceSvmAt equals the 2D table value', () => {
    const records = [iphone];
    const sc = buildScene(
      { records, hiddenIds: [], styles: recordStyles(records), lang: 'zh', sliceMode: 'gray', sliceGray: 127, sliceNits: 100, axisMode: 'standard', clipLowGray: false, presenting: false, presentBlack: false },
      { t: null, interactive: false },
    );
    const tb = buildTable(sc);
    tb.xs.forEach((x, i) => {
      const v = tb.rows[0].values[i];
      if (v !== null) expect(graySliceSvmAt(iphone, 127, x)).toBeCloseTo(v, 9);
    });
  });
});
