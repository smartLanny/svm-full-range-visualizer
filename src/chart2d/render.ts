/**
 * Canvas2D renderer for the 2D chart (docs/adr/0006). Draws a Scene into a context at any
 * size: every font / line / margin is multiplied by the UI scale `s` (1 = the 1600×900
 * reference layout), so on-screen, 1080p, 4K, 9:16 and 1:1 exports share one design.
 */
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import type { Scene, LegendGroup, LegendProbe } from './scene';
import { bezierAt, bridgeBezier, evalCurve, segmentBezier, type Bezier, type Curve } from './spline';
import type { Axis } from './scales';

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
  /** '*' marker of records with excluded anomalous points (docs/adr/0012). */
  warn: '#f5b454',
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
}

export interface HoverValue {
  id: string;
  svm: number;
  py: number;
}

export interface RenderResult {
  plot: Rect;
  /** Title + subtitle band actually drawn (null when hidden). */
  title: Rect | null;
  legend: Rect | null;
  hits: LegendHit[];
  /** Crosshair read-out (null when the pointer is outside the plot / over the legend). */
  hover: { u: number; px: number; py: number; values: HoverValue[] } | null;
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

function drawTitle(ctx: CanvasRenderingContext2D, scene: Scene, cx: number, cy: number, px: number): Rect {
  ctx.font = font(600, px);
  ctx.fillStyle = C.title;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const [pre, val, post] = scene.title;
  const slot = scene.titleSlot;
  let digitW = 0;
  for (let d = 0; d <= 9; d++) digitW = Math.max(digitW, ctx.measureText(String(d)).width);
  const charW = (ch: string) => (ch >= '0' && ch <= '9' ? digitW : ctx.measureText(ch).width);
  const width = (str: string) => [...str].reduce((a, ch) => a + charW(ch), 0);
  const preW = ctx.measureText(pre).width;
  const postW = ctx.measureText(post).width;
  const valW = width(val);
  const reserveW = Math.max(valW, width(slot.reserve));
  const mix = Math.min(1, Math.max(0, slot.mix));
  const slotW = valW + (reserveW - valW) * mix;
  const total = preW + slotW + postW;
  const x0 = cx - total / 2;
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

// ---------------------------------------------------------------------------------------------
// Legend (inside the plot, top-right).

interface LegendItem {
  kind: 'header' | 'row';
  group: LegendGroup;
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

function legendMetrics(s: number, k: number) {
  const u = s * k;
  return {
    fs: 12.5 * u,
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
  const items: LegendItem[][] = groups.map((g) => {
    ctx.font = font(600, m.fs);
    const out: LegendItem[] = [{ kind: 'header', group: g, rowIndex: -1, h: m.headH, w: m.chip + m.gap + ctx.measureText(g.label).width }];
    ctx.font = font(500, m.fs);
    g.rows.forEach((r, i) =>
      out.push({ kind: 'row', group: g, rowIndex: i, h: m.rowH, w: m.sampleW + m.gap + ctx.measureText(r.label).width + (r.excluded ? ctx.measureText(' *').width + 2 * s * k : 0) }),
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

/**
 * Largest legend layout (scale k ≤ kStart, one or two columns) within the size limits. Narrow
 * or short plots get a compact legend: at most ~52 % of the plot width, ~72 % of its height and
 * ~24 % of its area.
 */
function fitLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, plot: Rect, kStart: number): LegendLayout {
  const maxH = plot.h * 0.72;
  const maxW = plot.w * 0.52;
  const maxArea = plot.w * plot.h * 0.24;
  let last: LegendLayout | null = null;
  for (let k = kStart; k >= 0.6 - 1e-9; k -= 0.05) {
    for (const n of [1, 2]) {
      const L = layoutLegend(ctx, groups, s, k, n);
      last = L;
      if (L.h <= maxH && L.w <= maxW && L.w * L.h <= maxArea) return L;
      if (L.w > maxW) break; // two columns only get wider
    }
  }
  return last ?? layoutLegend(ctx, groups, s, 0.6, 1);
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

/**
 * Screen samples (x, y, weight = drawn curve length in px per frame) of the probe's curves,
 * inside the plot. Cached per probe and mapping.
 */
const probeSamples = new WeakMap<LegendProbe, { key: string; pts: Float64Array }>();
function sampleProbe(probe: LegendProbe, map: Mapping, plot: Rect): Float64Array {
  const key = `${map.ax},${map.bx},${map.ay},${map.by},${plot.x},${plot.y},${plot.w},${plot.h}`;
  const hit = probeSamples.get(probe);
  if (hit && hit.key === key) return hit.pts;
  const out: number[] = [];
  const frames = Math.max(1, probe.frames.length);
  const push = (x: number, y: number, w: number) => {
    if (x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h && w > 0) out.push(x, y, w / frames);
  };
  for (const frame of probe.frames) {
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
  }
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
}

const placementCache = new WeakMap<LegendProbe, { key: string; value: LegendPlacement }>();

/**
 * Legend auto-placement (docs/adr/0006 keeps the legend inside the plot, preferably top-right):
 * the preferred top-right corner is kept whenever it covers no curve; otherwise the other
 * corners, then compacter layouts, are tried; if every option covers something, the one covering
 * the least curve length wins. For a sweep the probe holds samples of the whole sweep, so one
 * corner is chosen for the entire animation (the legend never jumps while it plays).
 */
function placeLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, plot: Rect, probe: LegendProbe, map: Mapping, sig: string): LegendPlacement {
  const key = `${sig}|${s}|${map.ax},${map.bx},${map.ay},${map.by}|${plot.x},${plot.y},${plot.w},${plot.h}`;
  const hit = placementCache.get(probe);
  if (hit && hit.key === key) return hit.value;
  const inset = 12 * s;
  const pad = 4 * s;
  const tol = 2 * s;
  const pts = sampleProbe(probe, map, plot);
  const L0 = fitLegend(ctx, groups, s, plot, 1);
  const layouts = [L0];
  for (const f of [0.85, 0.72]) {
    const k = Math.max(0.6, L0.k * f);
    if (k < layouts[layouts.length - 1].k - 1e-6) layouts.push(fitLegend(ctx, groups, s, plot, k));
  }
  let best: { score: number; value: LegendPlacement } | null = null;
  let chosen: LegendPlacement | null = null;
  outer: for (let li = 0; li < layouts.length; li++) {
    const L = layouts[li];
    for (let ci = 0; ci < CORNERS.length; ci++) {
      const pos = cornerPos(CORNERS[ci], L, plot, inset);
      const ov = overlap(pts, { x: pos.x, y: pos.y, w: L.w, h: L.h }, pad);
      if (ov <= tol) {
        chosen = { L, ...pos };
        break outer;
      }
      const score = ov * (1 + 0.25 * li) + ci * 0.5 * s;
      if (!best || score < best.score) best = { score, value: { L, ...pos } };
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

function drawLegend(ctx: CanvasRenderingContext2D, scene: Scene, s: number, plot: Rect, map: Mapping, view: RenderView, hits: LegendHit[]): Rect | null {
  const groups = scene.legend;
  if (groups.length === 0 || !scene.showLegend) return null;
  const sig = `${scene.lang}|${groups.map((g) => `${g.label}:${g.rows.map((r) => r.label + (r.excluded ? '*' : '')).join(',')}`).join(';')}`;
  const to = placeLegend(ctx, groups, s, plot, scene.legendProbe, map, sig);
  let { L, x: x0, y: y0 } = to;
  if (scene.legendProbeFrom && scene.legendMix < 1) {
    // Transition into / out of a sweep: glide from the static placement to the sweep's.
    const from = placeLegend(ctx, groups, s, plot, scene.legendProbeFrom, map, sig);
    const p = Math.min(1, Math.max(0, scene.legendMix));
    if (from.L.k === to.L.k && from.L.cols.length === to.L.cols.length) {
      x0 = from.x + (to.x - from.x) * p;
      y0 = from.y + (to.y - from.y) * p;
    } else if (p < 0.5) ({ L, x: x0, y: y0 } = from);
  }
  const m = legendMetrics(s, L.k);
  const black = scene.background === '#000000';

  ctx.save();
  roundRect(ctx, x0, y0, L.w, L.h, 8 * s);
  ctx.fillStyle = black ? 'rgba(0,0,0,0.78)' : 'rgba(11,14,20,0.84)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();

  let cx = x0 + m.pad;
  for (const col of L.cols) {
    let y = y0 + m.pad - (m.headH - m.rowH) * 0.25;
    let prevGroup: LegendGroup | null = null;
    for (const it of col.items) {
      if (prevGroup && it.group !== prevGroup) y += m.groupGap;
      prevGroup = it.group;
      const mid = y + it.h / 2;
      const hitRect = { x: cx - m.pad * 0.5, y, w: col.w + m.pad, h: it.h };
      if (it.kind === 'header') {
        const g = it.group;
        const hot = scene.interactive && view.hoverDevice === g.device;
        if (hot) {
          roundRect(ctx, hitRect.x, hitRect.y + 1 * s, hitRect.w, hitRect.h - 2 * s, 5 * s);
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fill();
        }
        ctx.globalAlpha = g.hidden ? 0.4 : 1;
        roundRect(ctx, cx + (m.sampleW - m.chip) / 2, mid - m.chip / 2, m.chip, m.chip, 2.5 * s * L.k);
        ctx.fillStyle = g.color;
        ctx.fill();
        ctx.font = font(600, m.fs);
        ctx.fillStyle = g.hidden ? C.ink4 : C.title;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.label, cx + m.sampleW + m.gap, mid + 0.5 * s);
        ctx.globalAlpha = 1;
        if (scene.interactive) hits.push({ ...hitRect, kind: 'device', device: g.device });
      } else {
        const r = it.group.rows[it.rowIndex];
        const hot = scene.interactive && view.hoverId === r.id;
        if (hot) {
          roundRect(ctx, hitRect.x, hitRect.y + 1 * s, hitRect.w, hitRect.h - 2 * s, 5 * s);
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          ctx.fill();
        }
        ctx.globalAlpha = r.hidden ? 0.5 : 1;
        drawDashSample(ctx, cx, mid, m.sampleW, r.style.color, r.style.dash, 2.5 * s * Math.max(0.8, L.k), s * L.k);
        ctx.font = font(500, m.fs);
        ctx.fillStyle = r.hidden ? C.ink4 : C.ink2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.label, cx + m.sampleW + m.gap, mid + 0.5 * s);
        if (r.excluded) {
          ctx.fillStyle = r.hidden ? C.ink4 : C.warn;
          ctx.fillText('*', cx + m.sampleW + m.gap + ctx.measureText(r.label).width + 2 * s * L.k, mid + 0.5 * s);
        }
        if (r.hidden) {
          const tw = ctx.measureText(r.label).width;
          ctx.strokeStyle = C.ink4;
          ctx.lineWidth = Math.max(1, s);
          ctx.beginPath();
          ctx.moveTo(cx + m.sampleW + m.gap, mid + 0.5 * s);
          ctx.lineTo(cx + m.sampleW + m.gap + tw, mid + 0.5 * s);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (scene.interactive) hits.push({ ...hitRect, kind: 'record', id: r.id });
      }
      y += it.h;
    }
    cx += col.w + m.colGap;
  }
  ctx.restore();
  return { x: x0, y: y0, w: L.w, h: L.h };
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
    const tr = drawTitle(ctx, scene, w / 2, 32 * s, 24 * s);
    ctx.font = font(400, 12 * s);
    ctx.fillStyle = C.axisText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(scene.subtitle, w / 2, 60 * s);
    const sw = ctx.measureText(scene.subtitle).width;
    const x0 = Math.min(tr.x, w / 2 - sw / 2);
    const x1 = Math.max(tr.x + tr.w, w / 2 + sw / 2);
    titleRect = { x: x0, y: tr.y, w: x1 - x0, h: 60 * s + 9 * s - tr.y };
  }

  // ----- grid
  ctx.lineWidth = hair;
  for (const t of xAxis.ticks) {
    if (t.u < xAxis.u0 - 1e-9 || t.u > xAxis.u1 + 1e-9) continue;
    const px = Math.round(X(t.u)) + 0.5;
    ctx.strokeStyle = t.major ? C.grid : C.gridMinor;
    ctx.beginPath();
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.stroke();
  }
  for (const t of yAxis.ticks) {
    if (t.u < yAxis.u0 - 1e-9 || t.u > yAxis.u1 + 1e-9) continue;
    const py = Math.round(Y(t.u)) + 0.5;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, py);
    ctx.lineTo(plot.x + plot.w, py);
    ctx.stroke();
  }
  // axis lines (left + bottom)
  ctx.strokeStyle = C.axisLine;
  ctx.beginPath();
  ctx.moveTo(Math.round(plot.x) + 0.5, plot.y);
  ctx.lineTo(Math.round(plot.x) + 0.5, plot.y + plot.h);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
  ctx.stroke();

  // ----- tick labels
  ctx.font = font(500, 11.5 * s);
  ctx.fillStyle = C.axisText;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const t of xAxis.ticks) {
    if (!t.label || t.u < xAxis.u0 - 1e-9 || t.u > xAxis.u1 + 1e-9) continue;
    const tw = ctx.measureText(t.label).width;
    const px = Math.min(w - tw / 2 - 4 * s, Math.max(tw / 2 + 4 * s, X(t.u)));
    ctx.fillText(t.label, px, plot.y + plot.h + 9 * s);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yAxis.ticks) {
    if (!t.label || t.u < yAxis.u0 - 1e-9 || t.u > yAxis.u1 + 1e-9) continue;
    ctx.fillText(t.label, plot.x - 9 * s, Y(t.u));
  }
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

  // ----- reference lines (0.4 safe, 1.0 critical) with labels in the right margin
  const refs = [
    { v: SVM_SAFE, color: C.safe, label: scene.refLabels.safe },
    { v: SVM_CRITICAL, color: C.critical, label: scene.refLabels.critical },
  ].filter((r) => r.v > yAxis.u0 && r.v < yAxis.u1);
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
    ctx.save();
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5 * s;
    ctx.setLineDash([6 * s, 5 * s]);
    ctx.beginPath();
    ctx.moveTo(plot.x, Math.round(refY[i]) + 0.5);
    ctx.lineTo(plot.x + plot.w, Math.round(refY[i]) + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.font = font(600, 11.5 * s);
    ctx.fillStyle = r.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.label, plot.x + plot.w + 8 * s, labelY[i]);
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
  const legendRect = drawLegend(ctx, scene, s, plot, map, view, hits);

  // ----- crosshair + dots
  let hover: RenderResult['hover'] = null;
  const p = view.pointer;
  const inPlot = p && p.x >= plot.x && p.x <= plot.x + plot.w && p.y >= plot.y && p.y <= plot.y + plot.h;
  const inLegend = p && legendRect && p.x >= legendRect.x && p.x <= legendRect.x + legendRect.w && p.y >= legendRect.y && p.y <= legendRect.y + legendRect.h;
  if (p && inPlot && !inLegend) {
    const u = (p.x - mx.b) / mx.a;
    const values: HoverValue[] = [];
    for (const se of scene.series) {
      if (!se.curve) continue;
      const v = evalCurve(se.curve, u);
      if (v === null) continue;
      values.push({ id: se.id, svm: v, py: Y(v) });
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
    hover = { u, px: p.x, py: p.y, values };
  }

  ctx.restore();
  return { plot, title: titleRect, legend: legendRect, hits, hover };
}
