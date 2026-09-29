/**
 * Static slices, legend legibility / glides and the presentation title (review findings N08,
 * N10, N16 and the presentSafeLeft contract):
 *
 * - A static slice draws readings only: no partially transparent point, segment, dot or bridge
 *   (the along-sweep fades are for sweeps). A glide between a static slice and a sweep stays
 *   continuous (no point pops while the static snapping blends in / out).
 * - The legend text never gets smaller than LEGEND_MIN_FS (9 px at the reference layout) and the
 *   legend stays inside the plot, also for long English labels on small plots.
 * - Gliding into / out of a sweep never switches the legend layout in one frame: its box moves
 *   and scales continuously, or (one column <-> two) it jumps only while fully faded out.
 * - The legend paints the current hidden state even when its layout comes from the cache.
 * - With presentSafeLeft set, the title starts right of it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, Lang, SvmRecord } from '../types';
import { recordStyles } from '../data/colors';
import { settleSlice, sliceFor, sweepParam, READING_ALPHA } from './slices';
import { buildScene, mixParam, type ChartInputs } from './scene';
import { computeLayout, legendMinK, LEGEND_MIN_FS, renderChart, screenScale } from './render';

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

const GRAYS = [255, 192, 128, 127, 100, 64, 50, 32];
const LEVELS = [2, 7.5, 10, 35, 50, 100, 200, 500];

const inputs = (over: Partial<ChartInputs> = {}): ChartInputs => ({
  records,
  hiddenIds: [],
  styles: recordStyles(records),
  lang: 'zh',
  sliceMode: 'gray',
  sliceGray: 127,
  sliceNits: 100,
  axisMode: 'standard',
  clipLowGray: true,
  presenting: false,
  presentBlack: false,
  ...over,
});

interface Call {
  text: string;
  x: number;
  y: number;
  font: string;
  alpha: number;
  fill: string;
}

/** Canvas stand-in: records every fillText with the font / alpha / fill in effect. */
function mockCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', globalAlpha: 1, fillStyle: '#000' };
  const stack: Record<string, unknown>[] = [];
  const target: Record<string, unknown> = {
    calls,
    measureText: (s: string) => ({ width: [...s].reduce((a, ch) => a + (ch >= '0' && ch <= '9' ? 0.56 : ch === ' ' ? 0.28 : /[一-鿿（）]/.test(ch) ? 1 : 0.6), 0) * parseFloat(String(state.font).split(' ')[1]) }),
    fillText: (text: string, x: number, y: number) => calls.push({ text, x, y, font: String(state.font), alpha: Number(state.globalAlpha), fill: String(state.fillStyle) }),
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop() ?? {}),
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : k in state ? state[k as string] : () => undefined),
    set: (t, k, v) => {
      state[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { calls: Call[] };
}
const px = (font: string) => parseFloat(font.split(' ')[1]);

describe('static slices draw readings only (N08)', () => {
  it('no partially transparent point, segment, dot or bridge in any static view', () => {
    const bad: string[] = [];
    let dropped = 0;
    let bridges = 0;
    for (const [mode, params] of [
      ['gray', GRAYS],
      ['brightness', LEVELS],
    ] as const) {
      for (const clipLowGray of mode === 'gray' ? [true] : [true, false]) {
        for (const prm of params) {
          const sc = buildScene(inputs({ sliceMode: mode, sliceGray: prm, sliceNits: prm, clipLowGray }), { t: null, interactive: false });
          for (const se of sc.series) {
            dropped += sliceFor(se.rec, mode, prm, clipLowGray).length - se.points.length;
            const c = se.curve;
            if (!c) continue;
            const at = `${se.id} ${mode} ${prm}`;
            if (c.a.some((a) => a !== 1)) bad.push(`${at}: node alpha ${[...c.a].filter((a) => a !== 1).join(',')}`);
            if (c.seg.some((a) => a !== 0 && a !== 1)) bad.push(`${at}: segment alpha`);
            if (c.dot.some((a) => a !== 0 && a !== 1)) bad.push(`${at}: dot alpha`);
            for (const b of c.bridges) if (b.alpha !== 1) bad.push(`${at}: bridge alpha ${b.alpha}`);
            bridges += c.bridges.length;
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // the bundled data does have faint ghosts (18 Pro Max around G127, 2 nits, ...) and gaps
    expect(dropped).toBeGreaterThan(10);
    expect(bridges).toBeGreaterThan(0);
  });

  it('keeps exactly the readings (the points the tooltip / table read: a >= 0.5)', () => {
    let n = 0;
    const bad: string[] = [];
    for (const r of records) {
      for (const g of GRAYS) {
        const raw = sliceFor(r, 'gray', g, false);
        const st = settleSlice(raw);
        const want = raw.filter((p) => p.a >= READING_ALPHA).map((p) => p.key);
        if (st.map((p) => p.key).join() !== want.join()) bad.push(`${r.id} G${g}`);
        n += st.length;
      }
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(1000);
  });

  it('glides between a static slice and a sweep without popping', () => {
    // Per key, the drawn opacity over a glide (param and static weight moving together) never
    // changes by much more than the sweep's own fades do over the same step.
    const N = 200;
    let worstSettled = 0;
    let worstRaw = 0;
    for (const [mode, params] of [
      ['gray', GRAYS],
      ['brightness', LEVELS],
    ] as const) {
      const target = sweepParam(mode, 0);
      for (const r of records) {
        for (const p0 of params) {
          const ref = sliceFor(r, mode, p0, true);
          let prevS = new Map<number, number>();
          let prevR = new Map<number, number>();
          for (let i = 0; i <= N; i++) {
            const p = i / N;
            const raw = sliceFor(r, mode, mixParam(mode, p0, target, p), true);
            const cur = new Map(settleSlice(raw, 1 - p, ref).map((q) => [q.key, q.a]));
            const curR = new Map(raw.map((q) => [q.key, q.a]));
            if (i > 0) {
              for (const k of new Set([...cur.keys(), ...prevS.keys()])) worstSettled = Math.max(worstSettled, Math.abs((cur.get(k) ?? 0) - (prevS.get(k) ?? 0)));
              for (const k of new Set([...curR.keys(), ...prevR.keys()])) worstRaw = Math.max(worstRaw, Math.abs((curR.get(k) ?? 0) - (prevR.get(k) ?? 0)));
            }
            prevS = cur;
            prevR = curR;
          }
        }
      }
    }
    expect(worstSettled).toBeLessThan(Math.max(0.35, 2 * worstRaw));
  });

  it('the glide ends match the static slice and the sweep frame', () => {
    for (const mode of ['gray', 'brightness'] as const) {
      const inp = inputs({ sliceMode: mode, sliceNits: 2, sliceGray: 127 });
      const st = buildScene(inp, { t: null, interactive: false });
      const enter0 = buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 0 } });
      const sweep = buildScene(inp, { t: 0, interactive: false });
      const enter1 = buildScene(inp, { t: 0, interactive: false, blend: { from: null, p: 1 - 1e-9 } });
      const exit1 = buildScene(inp, { t: null, interactive: false, blend: { from: 3, p: 1 - 1e-9 } });
      const sig = (sc: typeof st, tol: number) => sc.series.map((s) => s.points.map((p) => `${p.key}:${Math.round(p.a / tol)}`).join(' ')).join('|');
      expect(sig(enter0, 1e-6)).toBe(sig(st, 1e-6));
      expect(sig(enter1, 1e-3)).toBe(sig(sweep, 1e-3));
      expect(sig(exit1, 1e-3)).toBe(sig(st, 1e-3));
    }
  });
});

describe('legend legibility (N10) and glides (N16)', () => {
  const legendFonts = (ctx: ReturnType<typeof mockCtx>, lang: Lang) => {
    const labels = new Set(records.flatMap((r) => (lang === 'en' ? [r.deviceEn ?? r.device, r.modeEn ?? r.mode] : [r.device, r.mode])));
    return ctx.calls.filter((c) => labels.has(c.text));
  };

  it('never draws legend text below the floor, and keeps the legend inside the plot', () => {
    const bad: string[] = [];
    let checked = 0;
    // on-screen chart sizes (1280x720 workbench, 9:16 / 1:1 presentation, 1600x900) and exports
    const sizes: [number, number, number][] = [
      [708, 612, screenScale(708, 612)],
      [405, 720, screenScale(405, 720)],
      [720, 720, screenScale(720, 720)],
      [1028, 792, screenScale(1028, 792)],
      [1920, 1080, 1.2],
      [1080, 1920, 1.2],
      [3840, 2160, 2.4],
    ];
    for (const lang of ['en', 'zh'] as const) {
      for (const [w, h, s] of sizes) {
        for (const [mode, prm] of [
          ['brightness', 2],
          ['brightness', 7.5],
          ['brightness', 100],
          ['gray', 127],
          ['gray', 32],
        ] as const) {
          const sc = buildScene(inputs({ lang, sliceMode: mode, sliceGray: prm, sliceNits: prm }), { t: null, interactive: true });
          const ctx = mockCtx();
          const res = renderChart(ctx, w, h, s, sc);
          const { plot } = computeLayout(w, h, s);
          const L = res.legend!;
          const at = `${lang} ${w}x${h} ${mode} ${prm}`;
          const min = Math.min(...legendFonts(ctx, lang).map((c) => px(c.font)));
          if (!(min >= LEGEND_MIN_FS * Math.max(1, s) - 1e-6)) bad.push(`${at}: legend text ${min.toFixed(2)} px`);
          if (L.x < plot.x || L.y < plot.y || L.x + L.w > plot.x + plot.w || L.y + L.h > plot.y + plot.h) bad.push(`${at}: legend outside the plot`);
          checked++;
        }
      }
    }
    expect(bad).toEqual([]);
    expect(checked).toBe(70);
    expect(legendMinK(0.85) * 12.5 * 0.85).toBeCloseTo(LEGEND_MIN_FS);
  });

  it('glides the legend between the static and the sweep layout without a jump', () => {
    // A snap moves the whole size / position difference in one step. Here every step of the
    // glide moves the box by a small share of the total change at most, unless the legend is
    // invisible at that moment (one column <-> two: it fades out, then in).
    const bad: string[] = [];
    let resized = 0;
    const N = 40;
    for (const lang of ['en', 'zh'] as const) {
      for (const [w, h] of [
        [1028, 792],
        [708, 612],
      ] as const) {
        const s = screenScale(w, h);
        for (const [mode, prm, hidden] of [
          ['brightness', 100, false],
          ['brightness', 100, true],
          ['brightness', 2, false],
        ] as const) {
          const hiddenIds = hidden ? records.filter((r) => !r.id.startsWith('xiaomi18')).map((r) => r.id) : [];
          const inp = inputs({ lang, sliceMode: mode, sliceGray: prm, sliceNits: prm, hiddenIds });
          for (const dir of ['enter', 'exit'] as const) {
            const frames: { x: number; y: number; w: number; h: number; alpha: number }[] = [];
            for (let i = 0; i <= N; i++) {
              const p = i / N;
              const sc = dir === 'enter' ? buildScene(inp, { t: 0, interactive: true, blend: { from: null, p } }) : buildScene(inp, { t: null, interactive: true, blend: { from: 0, p } });
              const ctx = mockCtx();
              const L = renderChart(ctx, w, h, s, sc).legend!;
              frames.push({ ...L, alpha: Math.max(0, ...legendFonts(ctx, lang).map((c) => c.alpha)) });
            }
            const a = frames[0];
            const b = frames[N];
            const total = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
            if (Math.abs(a.w - b.w) > 1) resized++;
            for (let i = 1; i <= N; i++) {
              const [u, v] = [frames[i - 1], frames[i]];
              const d = Math.max(Math.abs(u.x - v.x), Math.abs(u.y - v.y), Math.abs(u.w - v.w), Math.abs(u.h - v.h));
              if (d > Math.max(3, (4 * total) / N) && Math.min(u.alpha, v.alpha) > 0.05) bad.push(`${lang} ${w}x${h} ${mode} ${prm} ${dir} p=${(i / N).toFixed(3)}: box jumps ${d.toFixed(1)} of ${total.toFixed(1)} px`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // the static and the sweep legends do differ in size in some of these views
    expect(resized).toBeGreaterThan(0);
  }, 20000);

  it('paints the current hidden state even with a cached layout', () => {
    const sc1 = buildScene(inputs({ lang: 'en' }), { t: null, interactive: true });
    renderChart(mockCtx(), 1028, 792, 1, sc1);
    const hid = records.find((r) => r.modeEn === 'DC 120Hz')!;
    const sc2 = buildScene(inputs({ lang: 'en', hiddenIds: [hid.id] }), { t: null, interactive: true });
    const ctx = mockCtx();
    renderChart(ctx, 1028, 792, 1, sc2);
    const row = ctx.calls.find((c) => c.text === 'DC 120Hz')!;
    const other = ctx.calls.find((c) => c.text === 'Smooth pulse')!;
    expect(row.alpha).toBeCloseTo(0.5);
    expect(other.alpha).toBe(1);
  });
});

describe('presentation title clears the exit button (presentSafeLeft)', () => {
  it('starts at safeLeft when centring would put it under the button, and stays centred otherwise', () => {
    const sc = buildScene(inputs({ lang: 'en', sliceMode: 'brightness', sliceNits: 200, presenting: true }), { t: null, interactive: false });
    const titleX = (w: number, safeLeft: number) => {
      const ctx = mockCtx();
      renderChart(ctx, w, 820, 0.85, sc, { safeLeft });
      return ctx.calls.find((c) => c.text === sc.title[0])!.x;
    };
    const free = titleX(420, 0);
    expect(free).toBeLessThan(56);
    expect(titleX(420, 56)).toBeGreaterThanOrEqual(56);
    // a wide stage: the centred title is already clear, nothing moves
    expect(titleX(1600, 56)).toBeCloseTo(titleX(1600, 0), 9);
  });
});
