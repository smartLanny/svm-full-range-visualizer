/**
 * Canvas2D renderer for the 2D chart (docs/adr/0006). Draws a Scene into a context at any
 * size: every font / line / margin is multiplied by the UI scale `s` (1 = the 1600×900
 * reference layout), so on-screen, 1080p, 4K, 9:16 and 1:1 exports share one design.
 */
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import type { Scene, LegendGroup, LegendProbe, ProbeAxes, SubtitleSlot } from './scene';
import { bezierAt, bridgeBezier, curveSpanAt, evalCurve, segmentBezier, type Bezier, type Curve } from './spline';
import { edgeAlpha, type Axes, type Axis } from './scales';

export const FONT_STACK = 'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif';

const C = {
  grid: '#1c222c',
  gridMinor: '#141920',
  axisLine: '#2a3140',
  axisText: '#7d8796',
  title: '#f3f5f8',
  ink2: '#b6bfcc',
  ink4: '#566070',
  safe: '#22c55e',
  critical: '#ef4444',
  crosshair: 'rgba(182,191,204,0.55)',
};

const REF_AREA = 1600 * 900;

/** UI scale for an on-screen chart of w×h CSS px (kept legible on small panels). */
export function screenScale(w: number, h: number): number {
  return Math.min(1.25, Math.max(0.85, Math.sqrt((w * h) / REF_AREA)));
}

/** UI scale for an export of w×h px: proportional to the reference layout by area. */
export function exportScale(w: number, h: number): number {
  return Math.sqrt((w * h) / REF_AREA);
}

export const font = (weight: number, px: number) => `${weight} ${px.toFixed(2)}px ${FONT_STACK}`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LegendHit = Rect & ({ kind: 'record'; id: string } | { kind: 'device'; device: string });

export interface RenderView {
  /** Legend hover: highlight one record or one device. */
  hoverId?: string | null;
  hoverDevice?: string | null;
  /** Pointer position (CSS px) for the crosshair; null = none. */
  pointer?: { x: number; y: number } | null;
  /** Draw "no records" inside the plot when there are no series (exports). */
  emptyMessage?: boolean;
  /**
   * Extra empty band below the axes (units), kept free for an overlaid timeline bar: the
   * on-screen presentation view reserves it permanently so nothing ever covers the axes and the
   * plot never reflows when the bar appears.
   */
  insetBottom?: number;
  /**
   * Presentation: the title band must start at x ≥ safeLeft (CSS px; the shell's exit button sits
   * at the stage's top-left, useAppStore.presentSafeLeft). 0 / absent = no constraint.
   */
  safeLeft?: number;
}

export interface HoverValue {
  id: string;
  svm: number;
  py: number;
  /** Key of the curve node within snapping distance of the crosshair (tooltip: denoise notes). */
  node?: number;
}

/** A visible record whose curve has a gap under the crosshair: the keys of the drawn nodes around it. */
export interface HoverGap {
  id: string;
  keys: [number, number];
}

export interface RenderResult {
  plot: Rect;
  /** Title + subtitle band actually drawn (null when hidden). */
  title: Rect | null;
  legend: Rect | null;
  hits: LegendHit[];
  /** Crosshair read-out (null when the pointer is outside the plot / over the legend). */
  hover: { u: number; px: number; py: number; values: HoverValue[]; gaps: HoverGap[] } | null;
}

export interface Layout {
  plot: Rect;
  s: number;
}

export function computeLayout(w: number, h: number, s: number, insetBottom = 0): Layout {
  const top = 84 * s;
  const left = 64 * s;
  const right = 80 * s;
  const bottom = 62 * s + Math.max(0, insetBottom);
  return { plot: { x: left, y: top, w: Math.max(10, w - left - right), h: Math.max(10, h - top - bottom) }, s };
}

const mapper = (axis: Axis, p0: number, len: number, flip: boolean) => {
  const k = len / (axis.u1 - axis.u0 || 1);
  return flip ? { a: -k, b: p0 + len + axis.u0 * k } : { a: k, b: p0 - axis.u0 * k };
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------------------------
// Title with a tabular value slot: during a sweep the slot has the width of the widest value
// (titleSlot.mix = 1), so neither the text before nor the text after the value ever moves;
// a static title (mix = 0) is set tight. Digits are tabular (every digit as wide as the widest).

function drawTitle(ctx: CanvasRenderingContext2D, scene: Scene, cx: number, cy: number, px: number, minX: number, maxX: number): Rect {
  const [pre, val, post] = scene.title;
  const slot = scene.titleSlot;
  const mix = Math.min(1, Math.max(0, slot.mix));
  const measure = (fpx: number) => {
    ctx.font = font(600, fpx);
    let digitW = 0;
    for (let d = 0; d <= 9; d++) digitW = Math.max(digitW, ctx.measureText(String(d)).width);
    const charW = (ch: string) => (ch >= '0' && ch <= '9' ? digitW : ctx.measureText(ch).width);
    const width = (str: string) => [...str].reduce((a, ch) => a + charW(ch), 0);
    const preW = ctx.measureText(pre).width;
    const postW = ctx.measureText(post).width;
    const valW = width(val);
    const reserveW = Math.max(valW, width(slot.reserve));
    const slotW = valW + (reserveW - valW) * mix;
    return { charW, preW, valW, slotW, total: preW + slotW + postW };
  };
  let M = measure(px);
  // Too wide for the free band (narrow stage with the exit button at its top-left): shrink.
  if (M.total > maxX - minX && maxX > minX) {
    px *= (maxX - minX) / M.total;
    M = measure(px);
  }
  ctx.fillStyle = C.title;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const { charW, preW, valW, slotW, total } = M;
  // centred, unless that would put it left of minX
  const x0 = Math.max(minX, Math.min(cx - total / 2, maxX - total));
  ctx.fillText(pre, x0, cy);
  let x = slot.align === 'left' ? x0 + preW : x0 + preW + slotW - valW;
  for (const ch of val) {
    const cw = charW(ch);
    ctx.fillText(ch, x + (cw - ctx.measureText(ch).width) / 2, cy);
    x += cw;
  }
  ctx.fillText(post, x0 + preW + slotW, cy);
  return { x: x0, y: cy - px * 0.7, w: total, h: px * 1.4 };
}

/**
 * Subtitle with moving axis ranges (scene.subtitleMix > 0): each range value sits in a slot as
 * wide as the widest value of the motion, its digits tabular, so the text around the changing
 * numbers (and the centred subtitle as a whole) stays put. subtitleMix blends slot widths and
 * digit advances from the static (tight, proportional) layout, so a glide never shifts it in
 * one frame. Uses the current font; draws left-aligned from x0.
 */
function subtitleLayout(ctx: CanvasRenderingContext2D, scene: Scene): { width: number; draw: (x0: number, y: number) => void } {
  const mix = Math.min(1, Math.max(0, scene.subtitleMix));
  let digitW = 0;
  for (let d = 0; d <= 9; d++) digitW = Math.max(digitW, ctx.measureText(String(d)).width);
  const adv = (ch: string) => {
    const nat = ctx.measureText(ch).width;
    return ch >= '0' && ch <= '9' ? nat + (digitW - nat) * mix : nat;
  };
  const tab = (str: string) => [...str].reduce((a, ch) => a + (ch >= '0' && ch <= '9' ? digitW : ctx.measureText(ch).width), 0);
  const items = scene.subtitleParts.map((pt) => {
    if (typeof pt === 'string') return { pt, w: ctx.measureText(pt).width, valW: 0 };
    const valW = [...pt.value].reduce((a, ch) => a + adv(ch), 0);
    const full = Math.max(valW, tab(pt.reserve), tab(pt.value));
    return { pt, w: valW + (full - valW) * mix, valW };
  });
  const width = items.reduce((a, it) => a + it.w, 0);
  const draw = (x0: number, y: number) => {
    ctx.textAlign = 'left';
    let x = x0;
    for (const it of items) {
      if (typeof it.pt === 'string') ctx.fillText(it.pt, x, y);
      else {
        const slot = it.pt as SubtitleSlot;
        let cx = slot.align === 'left' ? x : x + it.w - it.valW;
        for (const ch of slot.value) {
          const a = adv(ch);
          ctx.fillText(ch, cx + (a - ctx.measureText(ch).width) / 2, y);
          cx += a;
        }
      }
      x += it.w;
    }
  };
  return { width, draw };
}

// ---------------------------------------------------------------------------------------------
// Legend (inside the plot, top-right).

/**
 * A legend line. Layouts are cached across frames (placeLegend), so an item refers to its group
 * by index: it is painted from the CURRENT scene's groups (hidden state, colours), never from the
 * scene the layout was measured for.
 */
interface LegendItem {
  kind: 'header' | 'row';
  gi: number;
  rowIndex: number;
  h: number;
  w: number;
}

interface LegendLayout {
  k: number;
  cols: { items: LegendItem[]; w: number; h: number }[];
  w: number;
  h: number;
}

/** Legend font size at k = 1 (units). */
const LEGEND_FS = 12.5;
/** Legend text floor (px at the reference layout, docs/adr/0006): legible on a 1280×720 screen. */
export const LEGEND_MIN_FS = 9;

/**
 * Smallest legend scale k at UI scale s: the text never gets smaller than LEGEND_MIN_FS CSS px
 * on screen (s ≤ 1), and never smaller than the same share of the picture in larger exports.
 */
export function legendMinK(s: number): number {
  return LEGEND_MIN_FS / (LEGEND_FS * Math.min(1, s));
}

function legendMetrics(s: number, k: number) {
  const u = s * k;
  return {
    fs: LEGEND_FS * u,
    pad: 10 * u,
    rowH: 21 * u,
    headH: 23 * u,
    groupGap: 5 * u,
    sampleW: 24 * u,
    chip: 9 * u,
    gap: 8 * u,
    colGap: 16 * u,
  };
}

function layoutLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, k: number, ncols: number): LegendLayout {
  const m = legendMetrics(s, k);
  const items: LegendItem[][] = groups.map((g, gi) => {
    ctx.font = font(600, m.fs);
    const out: LegendItem[] = [{ kind: 'header', gi, rowIndex: -1, h: m.headH, w: m.chip + m.gap + ctx.measureText(g.label).width }];
    ctx.font = font(500, m.fs);
    g.rows.forEach((r, i) =>
      out.push({ kind: 'row', gi, rowIndex: i, h: m.rowH, w: m.sampleW + m.gap + ctx.measureText(r.label).width }),
    );
    return out;
  });
  const groupH = items.map((its) => its.reduce((a, it) => a + it.h, 0));
  // Split groups into columns minimising the tallest column (groups are never broken).
  let split: number[] = [groups.length];
  if (ncols === 2 && groups.length > 1) {
    let best = Infinity;
    for (let i = 1; i < groups.length; i++) {
      const a = groupH.slice(0, i).reduce((x, y) => x + y, 0) + (i - 1) * m.groupGap;
      const b = groupH.slice(i).reduce((x, y) => x + y, 0) + (groups.length - i - 1) * m.groupGap;
      if (Math.max(a, b) < best) {
        best = Math.max(a, b);
        split = [i, groups.length];
      }
    }
  }
  const cols: LegendLayout['cols'] = [];
  let start = 0;
  for (const end of split) {
    const colItems = items.slice(start, end);
    const flat = colItems.flat();
    const h = colItems.reduce((a, its) => a + its.reduce((x, it) => x + it.h, 0), 0) + Math.max(0, colItems.length - 1) * m.groupGap;
    const w = flat.reduce((a, it) => Math.max(a, it.w), 0);
    cols.push({ items: flat, w, h });
    start = end;
  }
  const w = cols.reduce((a, c) => a + c.w, 0) + (cols.length - 1) * m.colGap + 2 * m.pad;
  const h = cols.reduce((a, c) => Math.max(a, c.h), 0) + 2 * m.pad - (m.headH - m.rowH) * 0.25;
  return { k, cols, w, h };
}

/** Size limits of the legend inside the plot (share of the plot's width / height / area). */
const LEGEND_LIMITS = [
  // compact: the preferred size
  { w: 0.52, h: 0.72, area: 0.24 },
  // when the text floor does not fit the compact limits (long labels, small plots): wider
  // two-column layouts before anything else gives
  { w: 0.62, h: 0.8, area: 0.3 },
];

/**
 * Largest legend layout (scale k from kStart down to the text floor kMin, one or two columns)
 * within the size limits (LEGEND_LIMITS, compact first). If nothing at the floor is within the
 * limits, the smallest layout at the floor that still fits inside the plot; only a plot too
 * small for even that gets smaller text.
 */
function fitLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, plot: Rect, kStart: number, kMin: number): LegendLayout {
  const k0 = Math.max(kStart, kMin);
  const ks: number[] = [];
  for (let k = k0; k > kMin + 1e-6; k -= 0.05) ks.push(k);
  ks.push(kMin);
  for (const lim of LEGEND_LIMITS) {
    const maxW = plot.w * lim.w;
    const maxH = plot.h * lim.h;
    const maxArea = plot.w * plot.h * lim.area;
    for (const k of ks) {
      for (const n of [1, 2]) {
        const L = layoutLegend(ctx, groups, s, k, n);
        if (L.h <= maxH && L.w <= maxW && L.w * L.h <= maxArea) return L;
        if (L.w > maxW) break; // two columns only get wider
      }
    }
  }
  const inset = 12 * s;
  const fits = (L: LegendLayout) => L.w <= plot.w - 2 * inset && L.h <= plot.h - 2 * inset;
  for (let k = kMin; k >= 0.4 - 1e-9; k -= 0.05) {
    const opts = [1, 2].map((n) => layoutLegend(ctx, groups, s, k, n)).filter(fits);
    if (opts.length) return opts.reduce((a, b) => (b.w * b.h < a.w * a.h ? b : a));
  }
  return layoutLegend(ctx, groups, s, 0.4, 1);
}

type Corner = 'tr' | 'tl' | 'br' | 'bl';
/** The user's preferred corner first (docs/adr/0006), then the others. */
const CORNERS: Corner[] = ['tr', 'tl', 'br', 'bl'];

interface Mapping {
  ax: number;
  bx: number;
  ay: number;
  by: number;
}

function cornerPos(corner: Corner, L: { w: number; h: number }, plot: Rect, inset: number) {
  return {
    x: corner === 'tr' || corner === 'br' ? plot.x + plot.w - inset - L.w : plot.x + inset,
    y: corner === 'tr' || corner === 'tl' ? plot.y + inset : plot.y + plot.h - inset - L.h,
  };
}

/** Mapping of axes onto the plot. */
function mappingOf(axes: Axes, plot: Rect): Mapping {
  const mx = mapper(axes.x, plot.x, plot.w, false);
  const my = mapper(axes.y, plot.y, plot.h, true);
  return { ax: mx.a, bx: mx.b, ay: my.a, by: my.b };
}

/** Identity of a per-frame axes list (stable while its sweep's memo lives). */
const axesIds = new WeakMap<object, number>();
let nextAxesId = 1;
function probeAxesKey(axes: ProbeAxes): string {
  if (!Array.isArray(axes)) return `${axes.x.u0},${axes.x.u1},${axes.y.u0},${axes.y.u1}`;
  let id = axesIds.get(axes);
  if (!id) axesIds.set(axes, (id = nextAxesId++));
  return `frames#${id}`;
}

/**
 * Screen samples (x, y, weight = drawn curve length in px per frame) of the probe's curves,
 * inside the plot, each frame mapped with its own axes (ProbeAxes). Cached per probe and mapping.
 */
const probeSamples = new WeakMap<LegendProbe, { key: string; pts: Float64Array }>();
function sampleProbe(probe: LegendProbe, axes: ProbeAxes, plot: Rect): Float64Array {
  const key = `${probeAxesKey(axes)}|${plot.x},${plot.y},${plot.w},${plot.h}`;
  const hit = probeSamples.get(probe);
  if (hit && hit.key === key) return hit.pts;
  const out: number[] = [];
  const frames = Math.max(1, probe.frames.length);
  const push = (x: number, y: number, w: number) => {
    if (x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h && w > 0) out.push(x, y, w / frames);
  };
  const single = Array.isArray(axes) ? null : mappingOf(axes, plot);
  probe.frames.forEach((frame, fi) => {
    const map = single ?? mappingOf((axes as Axes[])[Math.min(fi, (axes as Axes[]).length - 1)], plot);
    for (const c of frame) {
      const n = c.xs.length;
      for (let i = 0; i < n - 1; i++) {
        const al = c.seg[i];
        if (al <= 0) continue;
        const b = segmentBezier(c, i);
        const x0 = map.ax * b[0] + map.bx;
        const y0 = map.ay * b[1] + map.by;
        const x1 = map.ax * b[6] + map.bx;
        const y1 = map.ay * b[7] + map.by;
        const steps = Math.max(2, Math.min(48, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6)));
        let px = x0;
        let py = y0;
        for (let k = 1; k <= steps; k++) {
          const [u, v] = bezierAt(b, k / steps);
          const x = map.ax * u + map.bx;
          const y = map.ay * v + map.by;
          push((x + px) / 2, (y + py) / 2, al * Math.hypot(x - px, y - py));
          px = x;
          py = y;
        }
      }
      for (let i = 0; i < n; i++) if (c.dot[i] > 0) push(map.ax * c.xs[i] + map.bx, map.ay * c.ys[i] + map.by, 4 * c.dot[i]);
    }
  });
  const pts = Float64Array.from(out);
  probeSamples.set(probe, { key, pts });
  return pts;
}

function overlap(pts: Float64Array, r: Rect, pad: number): number {
  const x0 = r.x - pad;
  const y0 = r.y - pad;
  const x1 = r.x + r.w + pad;
  const y1 = r.y + r.h + pad;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 3) if (pts[i] >= x0 && pts[i] <= x1 && pts[i + 1] >= y0 && pts[i + 1] <= y1) sum += pts[i + 2];
  return sum;
}

interface LegendPlacement {
  L: LegendLayout;
  x: number;
  y: number;
  corner: Corner;
}

const placementCache = new WeakMap<LegendProbe, { key: string; value: LegendPlacement }>();

/**
 * Legend auto-placement (docs/adr/0006 keeps the legend inside the plot, preferably top-right):
 * the preferred top-right corner is kept whenever it covers no curve; otherwise the other
 * corners, then compacter layouts (never below the text floor, legendMinK), then the other
 * column count are tried; if every option covers something, the one covering the least curve
 * length wins. For a sweep the probe holds samples of the whole sweep (each drawn with the axes
 * of its own time when adaptive / free axes move), so one corner is chosen for the entire
 * animation (the legend never jumps while it plays).
 */
function placeLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, plot: Rect, probe: LegendProbe, axes: ProbeAxes, sig: string): LegendPlacement {
  const key = `${sig}|${s}|${probeAxesKey(axes)}|${plot.x},${plot.y},${plot.w},${plot.h}`;
  const hit = placementCache.get(probe);
  if (hit && hit.key === key) return hit.value;
  const inset = 12 * s;
  const pad = 4 * s;
  const tol = 2 * s;
  const pts = sampleProbe(probe, axes, plot);
  const kMin = legendMinK(s);
  const L0 = fitLegend(ctx, groups, s, plot, 1, kMin);
  const layouts = [L0];
  for (const f of [0.85, 0.72]) {
    const k = Math.max(kMin, L0.k * f);
    if (k < layouts[layouts.length - 1].k - 1e-6) layouts.push(fitLegend(ctx, groups, s, plot, k, kMin));
  }
  // The other column count at the most compact scale, when it stays within the size limits: a
  // short, wide legend can clear curves that a tall, narrow one covers (and vice versa).
  const last = layouts[layouts.length - 1];
  if (groups.length > 1) {
    const alt = layoutLegend(ctx, groups, s, last.k, last.cols.length === 1 ? 2 : 1);
    const lim = LEGEND_LIMITS[LEGEND_LIMITS.length - 1];
    if (alt.w <= plot.w * lim.w && alt.h <= plot.h * lim.h && alt.w * alt.h <= plot.w * plot.h * lim.area) layouts.push(alt);
  }
  let best: { score: number; value: LegendPlacement } | null = null;
  let chosen: LegendPlacement | null = null;
  outer: for (let li = 0; li < layouts.length; li++) {
    const L = layouts[li];
    for (let ci = 0; ci < CORNERS.length; ci++) {
      const pos = cornerPos(CORNERS[ci], L, plot, inset);
      const ov = overlap(pts, { x: pos.x, y: pos.y, w: L.w, h: L.h }, pad);
      if (ov <= tol) {
        chosen = { L, ...pos, corner: CORNERS[ci] };
        break outer;
      }
      const score = ov * (1 + 0.25 * li) + ci * 0.5 * s;
      if (!best || score < best.score) best = { score, value: { L, ...pos, corner: CORNERS[ci] } };
    }
  }
  const value = chosen ?? best!.value;
  placementCache.set(probe, { key, value });
  return value;
}

function drawDashSample(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, color: string, dash: number[], lw: number, s: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = dash.length ? 'butt' : 'round';
  ctx.setLineDash(dash.map((d) => d * s * 0.8));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  ctx.restore();
}

/** Smooth 0→1 ramp (zero slope at both ends). */
const smooth01 = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/** Anchor of a placement: the corner point it hugs, and that corner as fractions of its box. */
function anchorOf(pl: LegendPlacement) {
  const fx = pl.corner === 'tr' || pl.corner === 'br' ? 1 : 0;
  const fy = pl.corner === 'br' || pl.corner === 'bl' ? 1 : 0;
  return { ax: pl.x + fx * pl.L.w, ay: pl.y + fy * pl.L.h, fx, fy };
}

function drawLegend(ctx: CanvasRenderingContext2D, scene: Scene, s: number, plot: Rect, view: RenderView, hits: LegendHit[]): Rect | null {
  const groups = scene.legend;
  if (groups.length === 0 || !scene.showLegend) return null;
  const sig = `${scene.lang}|${groups.map((g) => `${g.label}:${g.rows.map((r) => r.label).join(',')}`).join(';')}`;
  const to = placeLegend(ctx, groups, s, plot, scene.legendProbe, scene.legendAxes, sig);
  if (!scene.legendProbeFrom || scene.legendMix >= 1) return paintLegend(ctx, scene, s, to.L, to.x, to.y, 1, view, hits);
  // Transition into / out of a sweep: the static placement and the sweep's may differ in corner
  // and in scale. Never switch in one frame (docs/adr/0003):
  const from = placeLegend(ctx, groups, s, plot, scene.legendProbeFrom, scene.legendAxesFrom ?? scene.legendAxes, sig);
  const p = Math.min(1, Math.max(0, scene.legendMix));
  if (from.L.cols.length === to.L.cols.length) {
    // same columns: scale and position glide together (the box hugs the corner(s) it glides between)
    const k = from.L.k + (to.L.k - from.L.k) * p;
    const L = Math.abs(k - to.L.k) < 1e-9 ? to.L : Math.abs(k - from.L.k) < 1e-9 ? from.L : layoutLegend(ctx, groups, s, k, to.L.cols.length);
    const A = anchorOf(from);
    const B = anchorOf(to);
    const lerp = (u: number, v: number) => u + (v - u) * p;
    const x = lerp(A.ax, B.ax) - lerp(A.fx, B.fx) * L.w;
    const y = lerp(A.ay, B.ay) - lerp(A.fy, B.fy) * L.h;
    return paintLegend(ctx, scene, s, L, x, y, 1, view, hits);
  }
  // one column <-> two: fade the one out, then the other in (never two legends at once)
  const aFrom = 1 - smooth01(p * 2);
  const aTo = smooth01(p * 2 - 1);
  if (aFrom > 0) {
    const r = paintLegend(ctx, scene, s, from.L, from.x, from.y, aFrom, view, p < 0.5 ? hits : null);
    if (p < 0.5) return r;
  }
  return paintLegend(ctx, scene, s, to.L, to.x, to.y, aTo, view, p >= 0.5 ? hits : null);
}

function paintLegend(ctx: CanvasRenderingContext2D, scene: Scene, s: number, L: LegendLayout, x0: number, y0: number, alpha: number, view: RenderView, hits: LegendHit[] | null): Rect | null {
  const box = { x: x0, y: y0, w: L.w, h: L.h };
  if (!(alpha > 0)) return box;
  const m = legendMetrics(s, L.k);
  const black = scene.background === '#000000';

  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, x0, y0, L.w, L.h, 8 * s);
  ctx.fillStyle = black ? 'rgba(0,0,0,0.78)' : 'rgba(11,14,20,0.84)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();

  const groups = scene.legend;
  let cx = x0 + m.pad;
  for (const col of L.cols) {
    let y = y0 + m.pad - (m.headH - m.rowH) * 0.25;
    let prevGroup = -1;
    for (const it of col.items) {
      if (prevGroup >= 0 && it.gi !== prevGroup) y += m.groupGap;
      prevGroup = it.gi;
      const mid = y + it.h / 2;
      const hitRect = { x: cx - m.pad * 0.5, y, w: col.w + m.pad, h: it.h };
      if (it.kind === 'header') {
        const g = groups[it.gi];
        const hot = scene.interactive && view.hoverDevice === g.device;
        if (hot) {
          roundRect(ctx, hitRect.x, hitRect.y + 1 * s, hitRect.w, hitRect.h - 2 * s, 5 * s);
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fill();
        }
        ctx.globalAlpha = alpha * (g.hidden ? 0.4 : 1);
        roundRect(ctx, cx + (m.sampleW - m.chip) / 2, mid - m.chip / 2, m.chip, m.chip, 2.5 * s * L.k);
        ctx.fillStyle = g.color;
        ctx.fill();
        ctx.font = font(600, m.fs);
        ctx.fillStyle = g.hidden ? C.ink4 : C.title;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.label, cx + m.sampleW + m.gap, mid + 0.5 * s);
        ctx.globalAlpha = alpha;
        if (scene.interactive && hits) hits.push({ ...hitRect, kind: 'device', device: g.device });
      } else {
        const r = groups[it.gi].rows[it.rowIndex];
        const hot = scene.interactive && view.hoverId === r.id;
        if (hot) {
          roundRect(ctx, hitRect.x, hitRect.y + 1 * s, hitRect.w, hitRect.h - 2 * s, 5 * s);
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          ctx.fill();
        }
        ctx.globalAlpha = alpha * (r.hidden ? 0.5 : 1);
        drawDashSample(ctx, cx, mid, m.sampleW, r.style.color, r.style.dash, 2.5 * s * Math.max(0.8, L.k), s * L.k);
        ctx.font = font(500, m.fs);
        ctx.fillStyle = r.hidden ? C.ink4 : C.ink2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.label, cx + m.sampleW + m.gap, mid + 0.5 * s);
        if (r.hidden) {
          const tw = ctx.measureText(r.label).width;
          ctx.strokeStyle = C.ink4;
          ctx.lineWidth = Math.max(1, s);
          ctx.beginPath();
          ctx.moveTo(cx + m.sampleW + m.gap, mid + 0.5 * s);
          ctx.lineTo(cx + m.sampleW + m.gap + tw, mid + 0.5 * s);
          ctx.stroke();
        }
        ctx.globalAlpha = alpha;
        if (scene.interactive && hits) hits.push({ ...hitRect, kind: 'record', id: r.id });
      }
      y += it.h;
    }
    cx += col.w + m.colGap;
  }
  ctx.restore();
  return box;
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Curves with per-segment opacity (points entering / leaving a sweep fade, docs/adr/0003).

interface CurveStyle {
  color: string;
  casing: string;
  dash: number[];
  width: number;
  casingWidth: number;
  alpha: number;
  casingAlpha: number;
  s: number;
}

const toScreen = (b: Bezier, m: Mapping): Bezier => [
  m.ax * b[0] + m.bx,
  m.ay * b[1] + m.by,
  m.ax * b[2] + m.bx,
  m.ay * b[3] + m.by,
  m.ax * b[4] + m.bx,
  m.ay * b[5] + m.by,
  m.ax * b[6] + m.bx,
  m.ay * b[7] + m.by,
];

function bezierLength(b: Bezier): number {
  let len = 0;
  let px = b[0];
  let py = b[1];
  for (let k = 1; k <= 8; k++) {
    const [x, y] = bezierAt(b, k / 8);
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

/**
 * Stroke a curve: consecutive segments of equal opacity form one path (the dash pattern runs
 * on across paths via lineDashOffset, see offs), each path is stroked with a background-coloured casing
 * that separates crossing lines, then in colour. Isolated points are dots; gaps get a faint
 * dotted bridge (never a solid line: an excluded sample is not bridged silently).
 */
function drawCurve(ctx: CanvasRenderingContext2D, c: Curve, map: Mapping, st: CurveStyle) {
  const n = c.xs.length;
  const segs: Bezier[] = [];
  const offs: number[] = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const b = toScreen(segmentBezier(c, i), map);
    segs.push(b);
    offs.push(acc);
    // Dash phase = opacity-weighted arc length: a segment fading in / out at the start of the
    // curve shifts the dash pattern gradually instead of making every dash jump at once.
    acc += bezierLength(b) * c.seg[i];
  }
  const runs: { i0: number; i1: number; a: number }[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = c.seg[i];
    if (a < 0.004) continue;
    const last = runs[runs.length - 1];
    if (last && last.i1 === i && Math.abs(last.a - a) < 0.004) last.i1 = i + 1;
    else runs.push({ i0: i, i1: i + 1, a });
  }
  const pass = (color: string, width: number, alpha: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(st.dash);
    ctx.lineCap = st.dash.length ? 'butt' : 'round';
    for (const r of runs) {
      ctx.globalAlpha = alpha * r.a;
      ctx.lineDashOffset = offs[r.i0];
      ctx.beginPath();
      ctx.moveTo(segs[r.i0][0], segs[r.i0][1]);
      for (let i = r.i0; i < r.i1; i++) {
        const b = segs[i];
        ctx.bezierCurveTo(b[2], b[3], b[4], b[5], b[6], b[7]);
      }
      ctx.stroke();
    }
  };
  pass(st.casing, st.casingWidth, st.casingAlpha);
  pass(st.color, st.width, st.alpha);
  ctx.lineDashOffset = 0;

  // isolated points
  ctx.fillStyle = st.color;
  for (let i = 0; i < n; i++) {
    if (c.dot[i] < 0.004) continue;
    ctx.globalAlpha = st.alpha * c.dot[i];
    ctx.beginPath();
    ctx.arc(map.ax * c.xs[i] + map.bx, map.ay * c.ys[i] + map.by, st.width * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }

  // gaps: faint dotted bridge
  if (c.bridges.length) {
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width * 0.7;
    ctx.lineCap = 'round';
    ctx.setLineDash([0.01, 5 * st.s]);
    for (const br of c.bridges) {
      const b = toScreen(bridgeBezier(c, br), map);
      ctx.globalAlpha = st.alpha * 0.6 * br.alpha;
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.bezierCurveTo(b[2], b[3], b[4], b[5], b[6], b[7]);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/**
 * Draw the scene into ctx (already transformed so 1 unit = 1 CSS / output px), w×h units,
 * UI scale s.
 */
export function renderChart(ctx: CanvasRenderingContext2D, w: number, h: number, s: number, scene: Scene, view: RenderView = {}): RenderResult {
  const { plot } = computeLayout(w, h, s, view.insetBottom ?? 0);
  const { x: xAxis, y: yAxis } = scene.axes;
  const mx = mapper(xAxis, plot.x, plot.w, false);
  const my = mapper(yAxis, plot.y, plot.h, true);
  const X = (u: number) => mx.a * u + mx.b;
  const Y = (u: number) => my.a * u + my.b;
  const hair = Math.max(1, s);

  ctx.save();
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, w, h);

  // ----- title + subtitle (overlays.title, H)
  let titleRect: Rect | null = null;
  if (scene.showTitle) {
    // Centred; in presentation never left of the exit button (view.safeLeft).
    const minX = Math.max(0, view.safeLeft ?? 0);
    const maxX = w - (minX > 0 ? 8 * s : 0);
    const tr = drawTitle(ctx, scene, w / 2, 32 * s, 24 * s, minX, maxX);
    ctx.font = font(400, 12 * s);
    ctx.fillStyle = C.axisText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const sub = scene.subtitleMix > 0 ? subtitleLayout(ctx, scene) : null;
    const sw = sub ? sub.width : ctx.measureText(scene.subtitle).width;
    // under the title (which may have moved right of the exit button), inside the free band
    const sx = minX > 0 ? Math.max(minX + sw / 2, Math.min(tr.x + tr.w / 2, maxX - sw / 2)) : w / 2;
    if (sub) sub.draw(sx - sw / 2, 60 * s);
    else ctx.fillText(scene.subtitle, sx, 60 * s);
    const x0 = Math.min(tr.x, sx - sw / 2);
    const x1 = Math.max(tr.x + tr.w, sx + sw / 2);
    titleRect = { x: x0, y: tr.y, w: x1 - x0, h: 60 * s + 9 * s - tr.y };
  }

  // ----- grid (a moving axis, docs/adr/0006 fix round 3: every tick has its own opacity, and
  // lines sit at their exact positions instead of snapping to whole pixels)
  ctx.lineWidth = hair;
  const linePos = (axis: Axis, v: number) => {
    const snapped = Math.round(v) + 0.5;
    return axis.motion ? snapped + (v - snapped) * (1 - axis.motion.settle) : snapped;
  };
  for (const t of xAxis.ticks) {
    if (t.u < xAxis.u0 - 1e-9 || t.u > xAxis.u1 + 1e-9) continue;
    const a = t.alpha ?? 1;
    if (a < 0.004) continue;
    const px = linePos(xAxis, X(t.u));
    ctx.globalAlpha = a;
    ctx.strokeStyle = t.major ? C.grid : C.gridMinor;
    ctx.beginPath();
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.stroke();
  }
  for (const t of yAxis.ticks) {
    if (t.u < yAxis.u0 - 1e-9 || t.u > yAxis.u1 + 1e-9) continue;
    const a = t.alpha ?? 1;
    if (a < 0.004) continue;
    const py = linePos(yAxis, Y(t.u));
    ctx.globalAlpha = a;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, py);
    ctx.lineTo(plot.x + plot.w, py);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // axis lines (left + bottom)
  ctx.strokeStyle = C.axisLine;
  ctx.beginPath();
  ctx.moveTo(Math.round(plot.x) + 0.5, plot.y);
  ctx.lineTo(Math.round(plot.x) + 0.5, plot.y + plot.h);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
  ctx.stroke();

  // ----- tick labels (a still axis: inside the domain; a moving one: by labelAlpha, which also
  // fades a label out just beyond the domain's edge as it slides off)
  const labelAlpha = (axis: Axis, t: Axis['ticks'][number]) =>
    t.labelAlpha === undefined ? (t.u < axis.u0 - 1e-9 || t.u > axis.u1 + 1e-9 ? 0 : 1) : t.labelAlpha;
  ctx.font = font(500, 11.5 * s);
  ctx.fillStyle = C.axisText;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const t of xAxis.ticks) {
    const a = labelAlpha(xAxis, t);
    if (!t.label || a < 0.004) continue;
    const tw = ctx.measureText(t.label).width;
    const px = Math.min(w - tw / 2 - 4 * s, Math.max(tw / 2 + 4 * s, X(t.u)));
    ctx.globalAlpha = a;
    ctx.fillText(t.label, px, plot.y + plot.h + 9 * s);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yAxis.ticks) {
    const a = labelAlpha(yAxis, t);
    if (!t.label || a < 0.004) continue;
    ctx.globalAlpha = a;
    ctx.fillText(t.label, plot.x - 9 * s, Y(t.u));
  }
  ctx.globalAlpha = 1;
  // axis titles
  ctx.font = font(500, 12.5 * s);
  ctx.fillStyle = C.axisText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(scene.xTitle, plot.x + plot.w / 2, plot.y + plot.h + 42 * s);
  ctx.save();
  ctx.translate(20 * s, plot.y + plot.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = font(600, 12.5 * s);
  ctx.fillText(scene.yTitle, 0, 0);
  ctx.restore();

  // ----- reference lines (0.4 safe, 1.0 critical) with labels in the right margin; on a moving
  // SVM axis a line fades out at the plot's edge and its label just beyond it
  const refs = [
    { v: SVM_SAFE, color: C.safe, label: scene.refLabels.safe },
    { v: SVM_CRITICAL, color: C.critical, label: scene.refLabels.critical },
  ]
    .map((r) => ({ ...r, line: edgeAlpha(yAxis, r.v, 'line', true), text: edgeAlpha(yAxis, r.v, 'label', true) }))
    .filter((r) => r.line > 0.004 || r.text > 0.004);
  const refY = refs.map((r) => Y(r.v));
  // keep the two labels apart when the lines are close
  const minGap = 15 * s;
  const labelY = [...refY];
  if (labelY.length === 2 && Math.abs(labelY[0] - labelY[1]) < minGap) {
    const c = (labelY[0] + labelY[1]) / 2;
    labelY[0] = c + minGap / 2; // 0.4 is lower on screen
    labelY[1] = c - minGap / 2;
  }
  refs.forEach((r, i) => {
    if (r.line > 0.004 && r.v > yAxis.u0 && r.v < yAxis.u1) {
      ctx.save();
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 0.85 * r.line;
      ctx.lineWidth = 1.5 * s;
      ctx.setLineDash([6 * s, 5 * s]);
      ctx.beginPath();
      const py = linePos(yAxis, refY[i]);
      ctx.moveTo(plot.x, py);
      ctx.lineTo(plot.x + plot.w, py);
      ctx.stroke();
      ctx.restore();
    }
    if (r.text > 0.004) {
      ctx.font = font(600, 11.5 * s);
      ctx.fillStyle = r.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = r.text;
      ctx.fillText(r.label, plot.x + plot.w + 8 * s, labelY[i]);
      ctx.globalAlpha = 1;
    }
  });

  // ----- curves (clipped to the plot)
  const highlight = new Set<string>();
  if (scene.interactive && view.hoverId) highlight.add(view.hoverId);
  if (scene.interactive && view.hoverDevice) for (const se of scene.series) if (se.device === view.hoverDevice) highlight.add(se.id);
  const dimOthers = highlight.size > 0;
  const map: Mapping = { ax: mx.a, bx: mx.b, ay: my.a, by: my.b };

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineJoin = 'round';
  const lw = 2.5 * s;
  const ordered = [...scene.series.filter((x) => !highlight.has(x.id)), ...scene.series.filter((x) => highlight.has(x.id))];
  for (const se of ordered) {
    if (!se.curve) continue;
    const hot = highlight.has(se.id);
    const dim = dimOthers && !hot;
    drawCurve(ctx, se.curve, map, {
      color: se.style.color,
      casing: scene.background,
      dash: se.style.dash.map((d) => d * s),
      width: hot ? lw * 1.35 : lw,
      casingWidth: (hot ? lw * 1.35 : lw) + 2.5 * s,
      alpha: dimOthers && !hot ? 0.2 : 1,
      casingAlpha: dimOthers && !hot ? 0.18 : 0.9,
      s,
    });
    // Points filled by the denoise's interpolation (docs/adr/0012 addendum): hollow rings.
    for (const hm of se.hollow) {
      ctx.globalAlpha = hm.a * (dim ? 0.2 : 1);
      ctx.beginPath();
      ctx.arc(map.ax * hm.x + map.bx, map.ay * hm.y + map.by, 3.6 * s, 0, Math.PI * 2);
      ctx.fillStyle = scene.background;
      ctx.fill();
      ctx.lineWidth = 1.6 * s;
      ctx.strokeStyle = se.style.color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // ----- empty
  if (scene.series.length === 0 && view.emptyMessage) {
    ctx.font = font(500, 15 * s);
    ctx.fillStyle = C.axisText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(scene.emptyText, plot.x + plot.w / 2, plot.y + plot.h / 2);
  }

  // ----- legend
  const hits: LegendHit[] = [];
  const legendRect = drawLegend(ctx, scene, s, plot, view, hits);

  // ----- crosshair + dots
  let hover: RenderResult['hover'] = null;
  const p = view.pointer;
  const inPlot = p && p.x >= plot.x && p.x <= plot.x + plot.w && p.y >= plot.y && p.y <= plot.y + plot.h;
  const inLegend = p && legendRect && p.x >= legendRect.x && p.x <= legendRect.x + legendRect.w && p.y >= legendRect.y && p.y <= legendRect.y + legendRect.h;
  if (p && inPlot && !inLegend) {
    const u = (p.x - mx.b) / mx.a;
    const values: HoverValue[] = [];
    const gaps: HoverGap[] = [];
    const snap = 7 * s;
    for (const se of scene.series) {
      if (!se.curve) continue;
      const c = se.curve;
      const v = evalCurve(c, u);
      if (v === null) {
        const span = curveSpanAt(c, u);
        if (span?.gap) gaps.push({ id: se.id, keys: [c.keys[span.nodes[0]], c.keys[span.nodes[1]]] });
        continue;
      }
      // the drawn node nearest the crosshair, when it is close (a reading the pointer is on)
      let node: number | undefined;
      let best = snap;
      for (let i = 0; i < c.xs.length; i++) {
        if (c.a[i] < 0.5) continue;
        const d = Math.abs(X(c.xs[i]) - p.x);
        if (d <= best) {
          best = d;
          node = c.keys[i];
        }
      }
      values.push({ id: se.id, svm: v, py: Y(v), node });
    }
    ctx.save();
    ctx.strokeStyle = C.crosshair;
    ctx.lineWidth = hair;
    ctx.setLineDash([4 * s, 4 * s]);
    ctx.beginPath();
    ctx.moveTo(Math.round(p.x) + 0.5, plot.y);
    ctx.lineTo(Math.round(p.x) + 0.5, plot.y + plot.h);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const hv of values) {
      if (hv.py < plot.y || hv.py > plot.y + plot.h) continue;
      const se = scene.series.find((x) => x.id === hv.id)!;
      ctx.beginPath();
      ctx.arc(p.x, hv.py, 4 * s, 0, Math.PI * 2);
      ctx.fillStyle = se.style.color;
      ctx.fill();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = scene.background;
      ctx.stroke();
    }
    ctx.restore();
    hover = { u, px: p.x, py: p.y, values, gaps };
  }

  ctx.restore();
  return { plot, title: titleRect, legend: legendRect, hits, hover };
}
