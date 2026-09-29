/**
 * Canvas2D renderer for the 2D chart (docs/adr/0006). Draws a Scene into a context at any
 * size: every font / line / margin is multiplied by the UI scale `s` (1 = the 1600×900
 * reference layout), so on-screen, 1080p, 4K, 9:16 and 1:1 exports share one design.
 */
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import type { Scene, LegendGroup } from './scene';
import { evalSpline, traceSpline } from './spline';
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
}

export interface HoverValue {
  id: string;
  svm: number;
  py: number;
}

export interface RenderResult {
  plot: Rect;
  legend: Rect | null;
  hits: LegendHit[];
  /** Crosshair read-out (null when the pointer is outside the plot / over the legend). */
  hover: { u: number; px: number; py: number; values: HoverValue[] } | null;
}

export interface Layout {
  plot: Rect;
  s: number;
}

export function computeLayout(w: number, h: number, s: number): Layout {
  const top = 84 * s;
  const left = 64 * s;
  const right = 80 * s;
  const bottom = 62 * s;
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
// Title with a tabular value slot (the title never shifts while the sweep value changes).

function drawTitle(ctx: CanvasRenderingContext2D, scene: Scene, cx: number, cy: number, px: number) {
  ctx.font = font(600, px);
  ctx.fillStyle = C.title;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const [pre, val, post] = scene.title;
  let digitW = 0;
  for (let d = 0; d <= 9; d++) digitW = Math.max(digitW, ctx.measureText(String(d)).width);
  const charW = (ch: string) => (ch >= '0' && ch <= '9' ? digitW : ctx.measureText(ch).width);
  const width = (str: string) => [...str].reduce((a, ch) => a + charW(ch), 0);
  const preW = ctx.measureText(pre).width;
  const postW = ctx.measureText(post).width;
  const reserveW = width(scene.titleReserve);
  const x0 = cx - (preW + reserveW + postW) / 2;
  ctx.fillText(pre, x0, cy);
  let x = x0 + preW;
  for (const ch of val) {
    const cw = charW(ch);
    ctx.fillText(ch, x + (cw - ctx.measureText(ch).width) / 2, cy);
    x += cw;
  }
  ctx.fillText(post, x, cy);
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
    g.rows.forEach((r, i) => out.push({ kind: 'row', group: g, rowIndex: i, h: m.rowH, w: m.sampleW + m.gap + ctx.measureText(r.label).width }));
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

function chooseLegend(ctx: CanvasRenderingContext2D, groups: LegendGroup[], s: number, plot: Rect): LegendLayout {
  const maxH = plot.h * 0.72;
  const maxW = plot.w * 0.52;
  let last: LegendLayout | null = null;
  for (let k = 1; k >= 0.6 - 1e-9; k -= 0.05) {
    for (const n of [1, 2]) {
      const L = layoutLegend(ctx, groups, s, k, n);
      last = L;
      if (L.h <= maxH && L.w <= maxW) return L;
      if (L.w > maxW) break; // two columns only get wider
    }
  }
  return last ?? layoutLegend(ctx, groups, s, 0.6, 1);
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

function drawLegend(ctx: CanvasRenderingContext2D, scene: Scene, s: number, plot: Rect, view: RenderView, hits: LegendHit[]): Rect | null {
  const groups = scene.legend;
  if (groups.length === 0) return null;
  const L = chooseLegend(ctx, groups, s, plot);
  const m = legendMetrics(s, L.k);
  const inset = 12 * s;
  const x0 = plot.x + plot.w - inset - L.w;
  const y0 = plot.y + inset;
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

/**
 * Draw the scene into ctx (already transformed so 1 unit = 1 CSS / output px), w×h units,
 * UI scale s.
 */
export function renderChart(ctx: CanvasRenderingContext2D, w: number, h: number, s: number, scene: Scene, view: RenderView = {}): RenderResult {
  const { plot } = computeLayout(w, h, s);
  const { x: xAxis, y: yAxis } = scene.axes;
  const mx = mapper(xAxis, plot.x, plot.w, false);
  const my = mapper(yAxis, plot.y, plot.h, true);
  const X = (u: number) => mx.a * u + mx.b;
  const Y = (u: number) => my.a * u + my.b;
  const hair = Math.max(1, s);

  ctx.save();
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, w, h);

  // ----- title + subtitle
  drawTitle(ctx, scene, w / 2, 32 * s, 24 * s);
  ctx.font = font(400, 12 * s);
  ctx.fillStyle = C.axisText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(scene.subtitle, w / 2, 60 * s);

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

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineJoin = 'round';
  const lw = 2.5 * s;
  const ordered = [...scene.series.filter((x) => !highlight.has(x.id)), ...scene.series.filter((x) => highlight.has(x.id))];
  for (const se of ordered) {
    if (!se.spline) continue;
    const hot = highlight.has(se.id);
    const width = hot ? lw * 1.35 : lw;
    const dash = se.style.dash.map((d) => d * s);
    ctx.beginPath();
    traceSpline(se.spline, ctx, mx.a, mx.b, my.a, my.b);
    // surface casing: separates crossing lines
    ctx.setLineDash(dash);
    ctx.lineCap = dash.length ? 'butt' : 'round';
    ctx.globalAlpha = dimOthers && !hot ? 0.18 : 0.9;
    ctx.strokeStyle = scene.background;
    ctx.lineWidth = width + 2.5 * s;
    ctx.stroke();
    ctx.globalAlpha = dimOthers && !hot ? 0.2 : 1;
    ctx.strokeStyle = se.style.color;
    ctx.lineWidth = width;
    ctx.stroke();
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
    for (const se of scene.series) {
      if (!se.spline) continue;
      const v = evalSpline(se.spline, u);
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
  return { plot, legend: legendRect, hits, hover };
}
