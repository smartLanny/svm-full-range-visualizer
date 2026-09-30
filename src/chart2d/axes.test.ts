/**
 * Moving adaptive / free axes (docs/adr/0006, fix round 3): during sweeps and the glides into /
 * out of them the chosen axis mode is kept. Standard stays fixed; adaptive's x-axis and free's x
 * and y axes follow the current frame, calmly.
 *
 * - The axis range is a pure function of the sweep time t (any evaluation order, any memo state).
 * - Per 60 fps frame the range moves by a bounded share of its span, with no frame jumping out of
 *   its neighbourhood, over whole sweeps, for all bundled records and for small subsets.
 * - Opaque points never leave the plot; fading points only briefly.
 * - Ticks and labels fade (no pop), a label's text never changes, a steady span never shows a
 *   mixed tick set, and the log axis keeps 1-2-5 labels.
 * - Standard mode and every static frame are exactly as before; adaptive keeps SVM 0–6.
 * - Glides start exactly on the static picture and land exactly on the sweep's.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AxisMode, Dataset, SliceMode, SvmRecord } from '../types';
import { recordStyles } from '../data/colors';
import { buildScene, type ChartInputs, type Scene } from './scene';
import { buildAxes, linearTicks, logAxisTicks, STANDARD_GRAY, STANDARD_NITS, STANDARD_SVM, type Axes, type Axis } from './scales';
import { sweepParam, SWEEP_DURATION, sliceFor, type Extent } from './slices';
import { renderChart } from './render';
import { FULL_WEIGHT_ALPHA, smoothTrack, weightedRange } from './axisTrack';

const dir = path.resolve(__dirname, '../../public/datasets');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { file: string; device: string; deviceEn?: string; mode: string; modeEn?: string }[];
const records: SvmRecord[] = manifest.map((m) => ({
  ...(JSON.parse(fs.readFileSync(path.join(dir, m.file), 'utf8')) as Dataset),
  id: m.file,
  device: m.device,
  deviceEn: m.deviceEn,
  mode: m.mode,
  modeEn: m.modeEn,
  source: 'bundled',
}));

const only = (pred: (id: string) => boolean) => records.filter((r) => !pred(r.id)).map((r) => r.id);
const SUBSETS: Record<string, string[]> = {
  all: [],
  'Xiaomi 18 Pro Max': only((id) => id.startsWith('xiaomi18promax')),
  'iPhone 18 Pro Max': only((id) => id.startsWith('iPhone18ProMax')),
  'Xiaomi 18 off + iPhone 18 + Mate 80 RS': only((id) => ['xiaomi18promax_adaptive_pro_off.json', 'iPhone18ProMax.json', 'huawei_mate80rs.json'].includes(id)),
};

const inputs = (over: Partial<ChartInputs> = {}): ChartInputs => ({
  records,
  hiddenIds: [],
  styles: recordStyles(records),
  lang: 'zh',
  sliceMode: 'gray',
  sliceGray: 127,
  sliceNits: 100,
  axisMode: 'adaptive',
  clipLowGray: true,
  presenting: false,
  presentBlack: false,
  ...over,
});

const FPS = 60;
const N = SWEEP_DURATION * FPS;
const dom = (a: Axes) => [a.x.u0, a.x.u1, a.y.u0, a.y.u1];
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** The legacy (pre fix round 3) buildAxes, verbatim: static frames must match it exactly. */
function legacyBuildAxes(slice: SliceMode, mode: AxisMode, extent: Extent | null): Axes {
  let x: Axis;
  if (slice === 'gray') {
    let lo = STANDARD_NITS[0];
    let hi = STANDARD_NITS[1];
    if (mode !== 'standard' && extent && extent.xMin > 0) {
      const a = Math.log10(extent.xMin);
      const b = Math.log10(Math.max(extent.xMax, extent.xMin * 1.01));
      const pad = Math.max(0.04 * (b - a), 0.02);
      lo = Math.pow(10, a - pad);
      hi = Math.pow(10, b + pad);
    }
    x = { log: true, u0: Math.log10(lo), u1: Math.log10(hi), ticks: logAxisTicks(lo, hi, mode === 'standard') };
  } else {
    let lo = STANDARD_GRAY[0];
    let hi = STANDARD_GRAY[1];
    if (mode !== 'standard' && extent) {
      lo = extent.xMin;
      hi = Math.max(extent.xMax, extent.xMin + 1);
    }
    const ticks =
      mode === 'standard'
        ? [0, 32, 64, 96, 128, 160, 192, 224, 255].map((v) => ({ u: v, label: String(v), major: true }))
        : linearTicks(lo, hi, 8).map((t) => ({ ...t, label: t.label === null ? null : String(Math.round(t.u)) }));
    x = { log: false, u0: lo, u1: hi, ticks };
  }
  let y0 = STANDARD_SVM[0];
  let y1 = STANDARD_SVM[1];
  if (mode === 'free' && extent) {
    const span = Math.max(extent.yMax - extent.yMin, 0.1);
    y0 = extent.yMin - span * 0.1;
    y1 = extent.yMax + span * 0.1;
    if (extent.yMin >= 0) y0 = Math.max(0, y0);
  }
  const y: Axis = { log: false, u0: y0, u1: y1, ticks: mode === 'free' ? linearTicks(y0, y1, 6) : [0, 1, 2, 3, 4, 5, 6].map((v) => ({ u: v, label: String(v), major: true })) };
  return { x, y };
}

/** Sweep frames' axes at 60 fps (buildScene only for the axes: the fast path of the test). */
function sweepAxes(inp: ChartInputs): Axes[] {
  return Array.from({ length: N + 1 }, (_, f) => buildScene(inp, { t: f / FPS, interactive: false }).axes);
}

describe('moving axes: range', () => {
  it('is a pure function of t (any order, any memo state)', () => {
    const inp = inputs({ axisMode: 'free' });
    const ts = [7.3, 0, 5.55, 10, 2.2, 9.99, 0.017];
    const first = ts.map((t) => dom(buildScene(inp, { t, interactive: false }).axes));
    // evict the memo with other inputs, then evaluate in reverse order
    for (const sliceMode of ['brightness', 'gray'] as const) for (const hid of Object.values(SUBSETS)) buildScene(inputs({ axisMode: 'free', sliceMode, hiddenIds: hid }), { t: 1, interactive: false });
    const again = [...ts].reverse().map((t) => dom(buildScene({ ...inp, records: [...records] }, { t, interactive: false }).axes)).reverse();
    expect(again).toEqual(first);
    // the export path (non-interactive) and the on-screen one (interactive) agree
    expect(dom(buildScene(inp, { t: 5.55, interactive: true }).axes)).toEqual(first[2]);
  });

  it('moves by a bounded share of its span per frame, never jumps, keeps opaque points inside (60 fps, whole sweeps)', () => {
    const bad: string[] = [];
    let checked = 0;
    let moved = 0;
    let maxStep = 0;
    let fadingOutRun = 0;
    const still: string[] = [];
    let worstRun = '';
    for (const [name, hiddenIds] of Object.entries(SUBSETS)) {
      for (const sliceMode of ['gray', 'brightness'] as const) {
        for (const axisMode of ['adaptive', 'free'] as const) {
          const inp = inputs({ sliceMode, axisMode, hiddenIds });
          const at = `${name} ${sliceMode}/${axisMode}`;
          const ax = sweepAxes(inp);
          const steps: number[] = [];
          for (let f = 1; f <= N; f++) {
            const a = ax[f - 1];
            const b = ax[f];
            const sx = b.x.u1 - b.x.u0;
            const sy = b.y.u1 - b.y.u0;
            steps.push(Math.max(Math.abs(b.x.u0 - a.x.u0) / sx, Math.abs(b.x.u1 - a.x.u1) / sx, Math.abs(b.y.u0 - a.y.u0) / sy, Math.abs(b.y.u1 - a.y.u1) / sy));
          }
          for (let f = 0; f < steps.length; f++) {
            const local = med(steps.slice(Math.max(0, f - 15), f + 16));
            maxStep = Math.max(maxStep, steps[f]);
            if (steps[f] > 0.025) bad.push(`${at} f=${f + 1}: range moves ${(steps[f] * 100).toFixed(2)} % of its span`);
            // no single frame jumps out of its neighbourhood (tiny motions excluded)
            if (steps[f] > 0.002 && steps[f] > 2 * local + 0.001) bad.push(`${at} f=${f + 1}: ${(steps[f] * 100).toFixed(3)} % vs local median ${(local * 100).toFixed(3)} %`);
          }
          if (steps.some((s) => s > 1e-4)) moved++;
          else still.push(at);
          if (axisMode === 'adaptive') {
            for (const a of ax) if (a.y.u0 !== 0 || a.y.u1 !== 6 || a.y.motion || a.y.ticks.map((t) => t.label).join() !== '0,1,2,3,4,5,6') bad.push(`${at}: adaptive SVM axis is not 0–6`);
          }
          // points: a visible one (a ≥ FULL_WEIGHT_ALPHA) never leaves the domain; a faint one (a ≥ 0.05) is not
          // more than 0.5 % of the span outside for more than a few frames
          const run = new Map<string, number>();
          for (let f = 0; f <= N; f += 2) {
            const prm = sweepParam(sliceMode, f / FPS);
            const { x, y } = ax[f];
            for (const r of inp.records) {
              if (hiddenIds.includes(r.id)) continue;
              for (const p of sliceFor(r, sliceMode, prm, true)) {
                const u = sliceMode === 'gray' ? Math.log10(p.x) : p.x;
                const out = Math.max(x.u0 - u, u - x.u1) / (x.u1 - x.u0) > 1e-9 || (axisMode === 'free' && Math.max(y.u0 - p.svm, p.svm - y.u1) / (y.u1 - y.u0) > 1e-9);
                const k = `${r.id}#${p.key}`;
                if (out && p.a >= FULL_WEIGHT_ALPHA) bad.push(`${at} t=${(f / FPS).toFixed(3)}: opaque point ${k} (a ${p.a.toFixed(3)}) outside the plot`);
                const far = Math.max(x.u0 - u, u - x.u1) / (x.u1 - x.u0) > 0.005 || (axisMode === 'free' && Math.max(y.u0 - p.svm, p.svm - y.u1) / (y.u1 - y.u0) > 0.005);
                const n = far && p.a >= 0.05 ? (run.get(k) ?? 0) + 2 : 0;
                run.set(k, n);
                if (n > fadingOutRun) {
                  const ox = Math.max(x.u0 - u, u - x.u1) / (x.u1 - x.u0);
                  const oy = Math.max(y.u0 - p.svm, p.svm - y.u1) / (y.u1 - y.u0);
                  worstRun = `${at} t=${(f / FPS).toFixed(3)} ${k} a=${p.a.toFixed(2)} out x ${(ox * 100).toFixed(1)}% y ${(oy * 100).toFixed(1)}%`;
                }
                fadingOutRun = Math.max(fadingOutRun, n);
              }
            }
          }
          checked++;
        }
      }
    }
    expect(bad.slice(0, 12)).toEqual([]);
    expect(checked).toBe(16);
    // Only where the data's range really stays put: some record (Mate 80 RS among them) covers
    // G15–G255 at every level, so the adaptive gray axis of a level sweep over it holds still.
    expect(still).toEqual(['all brightness/adaptive', 'Xiaomi 18 off + iPhone 18 + Mate 80 RS brightness/adaptive']);
    expect(moved).toBe(14);
    expect(maxStep).toBeGreaterThan(0.002);
    // a faint point outside the plot for at most a few frames (the renderer clips it)
    expect(fadingOutRun, worstRun).toBeLessThanOrEqual(6);
  }, 120000);

  it('smoothing never tightens around the raw weighted range (containment) and is zero-phase', () => {
    const raw = Array.from({ length: 601 }, (_, i) => (i === 300 ? { x0: -1, x1: 5, y0: 0, y1: 9 } : { x0: 0, x1: 1, y0: 0, y1: 1 }));
    const tr = smoothTrack(raw, 1 / 60, 0.35, 0.35, 1)!;
    for (let i = 0; i < 601; i++) {
      expect(tr.x0[i]).toBeLessThanOrEqual(raw[i].x0 + 1e-12);
      expect(tr.y1[i]).toBeGreaterThanOrEqual(raw[i].y1 - 1e-12);
    }
    // symmetric around the spike
    expect(tr.y1[300 - 40]).toBeCloseTo(tr.y1[300 + 40], 9);
    // a weighted range: a half-faded point counts half-way
    const w = weightedRange('brightness', [[{ x: 0, svm: 0, nits: 1, gray: 0, a: 1, key: 0 }, { x: 10, svm: 0, nits: 1, gray: 10, a: 0.8, key: 1 }, { x: 40, svm: 0, nits: 1, gray: 40, a: FULL_WEIGHT_ALPHA / 2, key: 2 }]])!;
    expect(w.x0).toBe(0);
    expect(w.x1).toBeGreaterThan(10);
    expect(w.x1).toBeLessThan(40);
  });
});

describe('moving axes: ticks', () => {
  type Seen = { alpha: number; label: number; text: string };
  const tickMap = (a: Axis) => {
    const m = new Map<string, Seen>();
    for (const t of a.ticks) {
      const k = `${t.u.toFixed(9)}|${t.major ? 'M' : 'm'}`;
      const prev = m.get(k);
      m.set(k, { alpha: Math.max(prev?.alpha ?? 0, t.alpha ?? 1), label: Math.max(prev?.label ?? 0, t.labelAlpha ?? 1), text: t.label ?? '' });
    }
    return m;
  };

  it('fade in / out without popping, keep their labels, and the log axis keeps 1-2-5 labels', () => {
    const bad: string[] = [];
    let fades = 0;
    for (const [name, hiddenIds] of Object.entries(SUBSETS)) {
      for (const sliceMode of ['gray', 'brightness'] as const) {
        for (const axisMode of ['adaptive', 'free'] as const) {
          const ax = sweepAxes(inputs({ sliceMode, axisMode, hiddenIds }));
          const at = `${name} ${sliceMode}/${axisMode}`;
          const texts = new Map<string, Set<string>>();
          for (const key of ['x', 'y'] as const) {
            let prev = tickMap(ax[0][key]);
            for (let f = 1; f <= N; f++) {
              const axis = ax[f][key];
              const cur = tickMap(axis);
              for (const k of new Set([...cur.keys(), ...prev.keys()])) {
                const a = cur.get(k);
                const b = prev.get(k);
                const da = Math.abs((a?.alpha ?? 0) - (b?.alpha ?? 0));
                const dl = Math.abs((a?.label ?? 0) - (b?.label ?? 0));
                if (da > 0.2 || dl > 0.2) bad.push(`${at} ${key} f=${f} tick ${k}: alpha ${(b?.alpha ?? 0).toFixed(2)}→${(a?.alpha ?? 0).toFixed(2)}, label ${(b?.label ?? 0).toFixed(2)}→${(a?.label ?? 0).toFixed(2)}`);
                if (da > 0.01 || dl > 0.01) fades++;
                if (a?.text) {
                  const s = texts.get(`${key}${k}`) ?? new Set();
                  s.add(a.text);
                  texts.set(`${key}${k}`, s);
                }
              }
              // log axis: a clearly visible label is 1, 2 or 5 × 10^e (the span is > 0.9 decades here)
              if (key === 'x' && sliceMode === 'gray') {
                for (const t of axis.ticks) {
                  const mant = Number((Math.pow(10, t.u) / Math.pow(10, Math.floor(t.u + 1e-9))).toPrecision(3));
                  if (t.label && (t.labelAlpha ?? 1) > 0.05 && ![1, 2, 5].includes(mant)) bad.push(`${at} f=${f}: log label ${t.label}`);
                }
              }
              prev = cur;
            }
          }
          for (const [k, s] of texts) if (s.size > 1) bad.push(`${at} tick ${k} changes its label: ${[...s].join(' / ')}`);
        }
      }
    }
    expect(bad.slice(0, 12)).toEqual([]);
    expect(fades).toBeGreaterThan(100);
  }, 120000);

  it('shows no label beyond an edge that does not move (the gray axis ends at G255)', () => {
    let n = 0;
    for (const hiddenIds of Object.values(SUBSETS)) {
      for (const axisMode of ['adaptive', 'free'] as const) {
        for (const a of sweepAxes(inputs({ sliceMode: 'brightness', axisMode, hiddenIds }))) {
          expect(a.x.u1).toBeCloseTo(255, 9);
          const beyond = a.x.ticks.filter((t) => t.u > 255 && (t.labelAlpha ?? 0) > 0);
          expect(beyond.map((t) => t.label)).toEqual([]);
          n++;
        }
      }
    }
    expect(n).toBe(8 * (N + 1));
  }, 60000);

  it('a steady span shows one tick set (no permanent cross-fade at a step boundary)', () => {
    // brightness slice, adaptive: gray 15–255 for seconds (span 240 / 8 = 30 sits exactly on the
    // 20 ↔ 50 step boundary of niceStep) — the moving axis must show one step, not both.
    const ax = sweepAxes(inputs({ sliceMode: 'brightness', axisMode: 'adaptive' }));
    let steady = 0;
    for (let f = 0; f <= 2 * FPS; f++) {
      const a = ax[f].x;
      if (Math.abs(a.u0 - 15) > 1e-6 || Math.abs(a.u1 - 255) > 1e-6) continue;
      steady++;
      const partial = a.ticks.filter((t) => t.label && (t.labelAlpha ?? 1) > 0.02 && (t.labelAlpha ?? 1) < 0.98 && t.u > a.u0 && t.u < a.u1);
      expect(partial.map((t) => t.label)).toEqual([]);
    }
    expect(steady).toBeGreaterThan(30);
  });
});

describe('still axes and glides', () => {
  it('standard mode is identical to before, in static slices and in every sweep / glide frame', () => {
    for (const sliceMode of ['gray', 'brightness'] as const) {
      const legacy = legacyBuildAxes(sliceMode, 'standard', null);
      const inp = inputs({ sliceMode, axisMode: 'standard' });
      const frames: Scene[] = [
        buildScene(inp, { t: null, interactive: false }),
        buildScene(inp, { t: 3.3, interactive: false }),
        buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 0.4 } }),
        buildScene(inp, { t: null, interactive: false, blend: { from: 6, p: 0.7 } }),
      ];
      for (const sc of frames) {
        expect(sc.axes).toEqual(legacy);
        expect(sc.subtitleMix).toBe(0);
        expect(sc.legendAxes).toBe(sc.axes);
      }
    }
  });

  it('static frames build exactly the legacy axes (adaptive / free, all slices)', () => {
    let n = 0;
    for (const sliceMode of ['gray', 'brightness'] as const) {
      for (const axisMode of ['adaptive', 'free'] as const) {
        for (const prm of sliceMode === 'gray' ? [255, 127, 64, 32] : [500, 100, 7.5, 2]) {
          for (const hiddenIds of Object.values(SUBSETS)) {
            const sc = buildScene(inputs({ sliceMode, axisMode, hiddenIds, sliceGray: prm, sliceNits: prm }), { t: null, interactive: true });
            let e: Extent | null = null;
            for (const se of sc.series)
              for (const p of se.points) e = e ? { xMin: Math.min(e.xMin, p.x), xMax: Math.max(e.xMax, p.x), yMin: Math.min(e.yMin, p.svm), yMax: Math.max(e.yMax, p.svm) } : { xMin: p.x, xMax: p.x, yMin: p.svm, yMax: p.svm };
            expect(sc.axes).toEqual(legacyBuildAxes(sliceMode, axisMode, e));
            expect(sc.subtitleMix).toBe(0);
            n++;
          }
        }
      }
    }
    expect(n).toBe(64);
    // and buildAxes without motion is the legacy function for arbitrary extents
    for (const e of [{ xMin: 0.013, xMax: 480, yMin: 0.2, yMax: 7.7 }, { xMin: 21, xMax: 255, yMin: 0.31, yMax: 2.2 }])
      for (const sl of ['gray', 'brightness'] as const) for (const m of ['adaptive', 'free'] as const) expect(buildAxes(sl, m, e)).toEqual(legacyBuildAxes(sl, m, e));
  });

  it('glides start on the static axes, land on the sweep axes and move continuously', () => {
    const bad: string[] = [];
    const G = 60;
    for (const [name, hiddenIds] of Object.entries(SUBSETS)) {
      for (const sliceMode of ['gray', 'brightness'] as const) {
        for (const axisMode of ['adaptive', 'free'] as const) {
          const inp = inputs({ sliceMode, axisMode, hiddenIds, sliceGray: 96, sliceNits: 20 });
          const at = `${name} ${sliceMode}/${axisMode}`;
          const st = buildScene(inp, { t: null, interactive: false });
          for (const dirn of ['enter', 'exit'] as const) {
            const tSweep = dirn === 'enter' ? 0 : 6.5;
            const sw = buildScene(inp, { t: tSweep, interactive: false });
            const frame = (p: number) => (dirn === 'enter' ? buildScene(inp, { t: 0, interactive: false, blend: { from: null, p } }) : buildScene(inp, { t: null, interactive: false, blend: { from: tSweep, p } }));
            const [a, b] = dirn === 'enter' ? [st, sw] : [sw, st];
            const f0 = frame(0);
            const f1 = frame(1 - 1e-9);
            // exact ends (the static end with its exact tick set: every opacity 0 or 1, same labels)
            const close = (u: number[], v: number[]) => u.every((x, i) => Math.abs(x - v[i]) < 1e-6 * Math.max(1, Math.abs(v[i])));
            if (!close(dom(f0.axes), dom(a.axes))) bad.push(`${at} ${dirn}: p=0 ${dom(f0.axes)} vs ${dom(a.axes)}`);
            if (!close(dom(f1.axes), dom(b.axes))) bad.push(`${at} ${dirn}: p=1 ${dom(f1.axes)} vs ${dom(b.axes)}`);
            if (dirn === 'enter') {
              const vis = (ax: Axis) => ax.ticks.filter((t) => (t.alpha ?? 1) > 0.5 && t.u >= ax.u0 - 1e-9 && t.u <= ax.u1 + 1e-9).map((t) => `${t.u.toFixed(6)}${t.major ? 'M' : 'm'}`).sort().join();
              const lab = (ax: Axis) => ax.ticks.filter((t) => t.label && (t.labelAlpha ?? (t.u >= ax.u0 - 1e-9 && t.u <= ax.u1 + 1e-9 ? 1 : 0)) > 0.5).map((t) => t.label).sort().join();
              const partial = f0.axes.x.ticks.filter((t) => (t.alpha ?? 1) % 1 > 1e-9 || (t.labelAlpha ?? 1) % 1 > 1e-9);
              if (vis(f0.axes.x) !== vis(st.axes.x) || lab(f0.axes.x) !== lab(st.axes.x) || lab(f0.axes.y) !== lab(st.axes.y) || partial.length) bad.push(`${at}: glide start ticks differ from the static ticks`);
            }
            // continuity: per step ≤ a small share of the total change (a snap moves all of it)
            const total = Math.max(...dom(a.axes).map((v, i) => Math.abs(v - dom(b.axes)[i]) / (i < 2 ? a.axes.x.u1 - a.axes.x.u0 : a.axes.y.u1 - a.axes.y.u0)));
            let prev = dom(f0.axes);
            for (let i = 1; i <= G; i++) {
              const cur = dom(frame(i / G).axes);
              const sx = cur[1] - cur[0];
              const sy = cur[3] - cur[2];
              const d = Math.max(Math.abs(cur[0] - prev[0]) / sx, Math.abs(cur[1] - prev[1]) / sx, Math.abs(cur[2] - prev[2]) / sy, Math.abs(cur[3] - prev[3]) / sy);
              if (d > Math.max(0.02, (6 * total) / G)) bad.push(`${at} ${dirn} p=${(i / G).toFixed(3)}: range moves ${(d * 100).toFixed(1)} % (whole glide ${(total * 100).toFixed(1)} %)`);
              prev = cur;
            }
          }
        }
      }
    }
    expect(bad.slice(0, 12)).toEqual([]);
  }, 120000);

  it('keeps the subtitle text still while the range values change, and the legend in one place', () => {
    const calls = (sc: Scene) => {
      const texts: { text: string; x: number }[] = [];
      const ctx = new Proxy(
        {
          measureText: (s: string) => ({ width: [...s].reduce((a, ch) => a + (ch >= '0' && ch <= '9' ? 7 : ch === '.' ? 3 : ch === ' ' ? 3.5 : /[一-鿿]/.test(ch) ? 12 : 7.5), 0) }),
          fillText: (text: string, x: number) => texts.push({ text, x }),
        } as Record<string, unknown>,
        { get: (t, k) => (k in t ? t[k as string] : () => undefined), set: () => true },
      ) as unknown as CanvasRenderingContext2D;
      const res = renderChart(ctx, 1280, 720, 1, sc);
      return { texts, legend: res.legend! };
    };
    for (const sliceMode of ['gray', 'brightness'] as const) {
      const inp = inputs({ sliceMode, axisMode: 'free' });
      const pos = new Set<string>();
      const legend = new Set<string>();
      const values = new Set<string>();
      for (const t of [0.5, 2.5, 5, 7.5, 9.5]) {
        const sc = buildScene(inp, { t, interactive: false });
        expect(sc.subtitleMix).toBe(1);
        const { texts, legend: L } = calls(sc);
        const plain = sc.subtitleParts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
        pos.add(plain.map((p) => texts.find((x) => x.text === p)!.x.toFixed(3)).join('|'));
        legend.add(`${L.x.toFixed(2)},${L.y.toFixed(2)},${L.w.toFixed(2)},${L.h.toFixed(2)}`);
        values.add(sc.subtitle);
      }
      expect(values.size).toBeGreaterThan(2);
      expect([...pos].length).toBe(1);
      expect([...legend].length).toBe(1);
    }
  });
});
