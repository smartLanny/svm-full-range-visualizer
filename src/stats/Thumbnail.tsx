import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Color } from 'three';
import type { ColormapType, SvmRecord } from '../types';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges, fmtNits, gridView, logNits, type GridView } from '../data/grid';
import { getJsColor } from '../colormaps';
import { ANOMALY_KINDS, type AnomalyKind } from '../data/anomalies';
import { useT } from '../i18n';

/** Shared extent of all thumbnails, so cards compare at the same scale. */
export interface ThumbExtent {
  /** log1p-nits range. */
  x0: number;
  x1: number;
  /** Gray range (bottom, top). */
  g0: number;
  g1: number;
  /** Lowest / highest measured gray in scope (axis labels). */
  grayMin: number;
  grayMax: number;
}

export function thumbExtent(records: SvmRecord[], opts: { clipLowGray: boolean; maxNits: number | null }): ThumbExtent | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let g0 = Infinity;
  let g1 = -Infinity;
  let grayMin = Infinity;
  let grayMax = -Infinity;
  for (const r of records) {
    const v = gridView(r, opts);
    if (!v.x.length || !v.grays.length) continue;
    const xe = cellEdges(v.x, 0);
    const ge = cellEdges(v.grays, 0, 255);
    x0 = Math.min(x0, xe[0]);
    x1 = Math.max(x1, xe[xe.length - 1]);
    g0 = Math.min(g0, ge[0]);
    g1 = Math.max(g1, ge[ge.length - 1]);
    grayMin = Math.min(grayMin, v.grays[0]);
    grayMax = Math.max(grayMax, v.grays[v.grays.length - 1]);
  }
  if (!Number.isFinite(x1) || !Number.isFinite(g0) || !(x1 > x0) || !(g1 > g0)) return null;
  return { x0, x1, g0, g1, grayMin, grayMax };
}

const TICK_CANDIDATES = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const HEIGHT = 128;

interface Props {
  rec: SvmRecord;
  clipLowGray: boolean;
  maxNits: number | null;
  colormap: ColormapType;
  colorMax: number;
  sliceGray: number | null;
  extent: ThumbExtent;
}

/**
 * Mini heatmap (Canvas2D): gray up, level luminance (log) right, cells exactly as in the 3D top
 * view. Cells without a valid value (missing or excluded) get a neutral grey hatch, never a
 * colour (never drawn as 0); area outside the record's measured range stays flat background.
 * Stepped 0.4 / 1.0 contours follow cell borders. Redraws only when inputs or the size change (no animation loop).
 */
export function Thumbnail({ rec, clipLowGray, maxNits, colormap, colorMax, sliceGray, extent }: Props) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const view = useMemo(() => gridView(rec, { clipLowGray, maxNits }), [rec, clipLowGray, maxNits]);
  const noData = useMemo(() => hasNoDataCells(view), [view]);
  /** Excluded raw points by gray + brightness percent -> reason (docs/adr/0012). */
  const excludedAt = useMemo(() => new Map((rec.excluded ?? []).map((x) => [`${x.gray}|${x.brightnessPercent}`, x.reason])), [rec.excluded]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return; // hidden (0-size) container: nothing to draw
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawHeatmap(ctx, view, { W: canvas.width, H: canvas.height, dpr, colormap, colorMax, sliceGray, extent });
  }, [view, width, colormap, colorMax, sliceGray, extent]);

  const ticks = useMemo(() => {
    if (width <= 0) return [];
    const out: { v: number; px: number }[] = [];
    let last = -Infinity;
    for (const v of TICK_CANDIDATES) {
      const x = logNits(v);
      if (x < extent.x0 - 1e-9 || x > extent.x1 + 1e-9) continue;
      const px = ((x - extent.x0) / (extent.x1 - extent.x0)) * width;
      if (px - last < 30) continue;
      out.push({ v, px });
      last = px;
    }
    return out;
  }, [width, extent]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const x = extent.x0 + fx * (extent.x1 - extent.x0);
    const g = extent.g1 - fy * (extent.g1 - extent.g0);
    const xe = cellEdges(view.x, 0);
    const ge = cellEdges(view.grays, 0, 255);
    const c = xe.findIndex((e0, i) => i < view.x.length && x >= e0 && x <= xe[i + 1]);
    const r = ge.findIndex((e0, i) => i < view.grays.length && g >= e0 && g <= ge[i + 1]);
    if (c < 0 || r < 0) return setHover(null);
    const p = view.points[r][c];
    let text: string;
    if (p && Number.isFinite(p.svm)) {
      text = t('stats.thumb.hover', { g: view.grays[r], n: fmtNits(view.levelNits[c]), v: p.svm.toFixed(2) });
    } else {
      const reason = excludedAt.get(`${view.grays[r]}|${view.percents[c]}`);
      const what = reason
        ? t('common.exclusion.excludedCell', { reason: ANOMALY_KINDS.includes(reason as AnomalyKind) ? t(`common.exclusion.reasons.${reason}`) : reason })
        : t('common.exclusion.missingCell');
      text = t('stats.thumb.hoverNoData', { g: view.grays[r], n: fmtNits(view.levelNits[c]), what });
    }
    setHover({ x: e.clientX - rect.left, text });
  };

  const yOf = (g: number) => ((extent.g1 - g) / (extent.g1 - extent.g0)) * HEIGHT;
  const grayLabels: { g: number; y: number; accent?: boolean }[] = [];
  const sliceY = sliceGray !== null && sliceGray >= extent.g0 && sliceGray <= extent.g1 ? yOf(sliceGray) : null;
  for (const g of [extent.grayMax, extent.grayMin]) {
    const y = yOf(g);
    if (sliceY === null || Math.abs(y - sliceY) > 14) grayLabels.push({ g, y });
  }
  if (sliceY !== null && sliceGray !== null) grayLabels.push({ g: Math.round(sliceGray), y: sliceY, accent: true });

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 pl-9 text-2xs text-ink-3">
        <span className="truncate" title={t('stats.thumb.caption')}>
          {t('stats.thumb.caption')}
        </span>
        <span className="inline-flex shrink-0 items-center gap-2.5">
          {noData && (
            <span className="inline-flex items-center gap-1" title={t('stats.thumb.noDataHint')}>
              <span className="h-2.5 w-3.5 rounded-[2px] ring-1 ring-inset ring-white/10" style={{ background: HATCH_CSS }} />
              {t('common.noValidData')}
            </span>
          )}
          <span className="inline-flex items-center gap-1" title={t('stats.thumb.contours')}>
            <span className="h-[2px] w-3.5 rounded bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
            0.4
          </span>
          <span className="inline-flex items-center gap-1" title={t('stats.thumb.contours')}>
            <span className="h-[3px] w-3.5 rounded bg-[#0b0e14] shadow-[0_0_0_1px_rgba(255,255,255,0.75)]" />
            1.0
          </span>
        </span>
      </div>
      <div className="flex gap-2">
        <div className="relative w-7 shrink-0 text-right text-2xs tabular-nums text-ink-3" style={{ height: HEIGHT }}>
          {grayLabels.map(({ g, y, accent }) => (
            <span
              key={`${g}-${accent ? 's' : ''}`}
              className={accent ? 'absolute right-0 font-medium text-accent-hover' : 'absolute right-0'}
              style={{ top: Math.min(HEIGHT - 12, Math.max(-1, y - 7)) }}
            >
              G{g}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div ref={wrapRef} className="relative overflow-hidden rounded-md ring-1 ring-inset ring-line" style={{ height: HEIGHT }}>
            <canvas ref={canvasRef} className="block h-full w-full cursor-crosshair" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
            {hover && (
              <div
                className="pointer-events-none absolute top-1.5 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-2xs tabular-nums text-ink-1 ring-1 ring-white/10"
                style={hover.x > width / 2 ? { right: width - hover.x + 10 } : { left: hover.x + 10 }}
              >
                {hover.text}
              </div>
            )}
          </div>
          <div className="relative mt-1 h-3.5 text-2xs tabular-nums text-ink-3">
            {ticks.map(({ v, px }) => (
              <span
                key={v}
                className="absolute top-0"
                style={px < 8 ? { left: 0 } : px > width - 12 ? { right: 0 } : { left: px, transform: 'translateX(-50%)' }}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface DrawOpts {
  W: number;
  H: number;
  dpr: number;
  colormap: ColormapType;
  colorMax: number;
  sliceGray: number | null;
  extent: ThumbExtent;
}

/** Flat background outside the record's measured cells (not measured at all). */
const OUTSIDE = '#0b0e14';
/** Neutral "no valid data" hatch: mid-grey diagonal lines, unlike any colormap end. */
const HATCH_BASE = '#1b2029';
const HATCH_LINE = 'rgba(255,255,255,0.24)';

let hatch: { key: number; pattern: CanvasPattern | null } | null = null;

function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  if (hatch && hatch.key === dpr) return hatch.pattern;
  const s = Math.max(4, Math.round(5 * dpr));
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = HATCH_BASE;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = HATCH_LINE;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  // 45° lines, continuous across tiles.
  g.moveTo(0, s);
  g.lineTo(s, 0);
  g.moveTo(-s / 2, s / 2);
  g.lineTo(s / 2, -s / 2);
  g.moveTo(s / 2, s * 1.5);
  g.lineTo(s * 1.5, s / 2);
  g.stroke();
  hatch = { key: dpr, pattern: ctx.createPattern(c, 'repeat') };
  return hatch.pattern;
}

/** CSS twin of the canvas hatch, for the legend chip. */
const HATCH_CSS = `repeating-linear-gradient(135deg, ${HATCH_LINE} 0 1px, ${HATCH_BASE} 1px 4px)`;

/** True when the view has at least one cell without a valid value. */
export function hasNoDataCells(view: GridView): boolean {
  return view.points.some((row) => row.some((p) => !p || !Number.isFinite(p.svm)));
}

function drawHeatmap(ctx: CanvasRenderingContext2D, view: GridView, o: DrawOpts) {
  const { W, H, dpr, extent } = o;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(0, 0, W, H);

  const X = (x: number) => Math.round(((x - extent.x0) / (extent.x1 - extent.x0)) * W);
  const Y = (g: number) => Math.round(H - ((g - extent.g0) / (extent.g1 - extent.g0)) * H);
  const xe = cellEdges(view.x, 0).map(X);
  const ge = cellEdges(view.grays, 0, 255).map(Y);
  const scale = 4 / Math.max(0.05, o.colorMax || 4);
  const col = new Color();

  const noData = hatchPattern(ctx, dpr) ?? HATCH_BASE;
  for (let r = 0; r < view.grays.length; r++) {
    for (let c = 0; c < view.x.length; c++) {
      const p = view.points[r][c];
      if (!p || !Number.isFinite(p.svm)) {
        // Missing / excluded cell inside the measured grid: neutral hatch (never drawn as a value).
        ctx.fillStyle = noData;
        ctx.fillRect(xe[c], ge[r + 1], xe[c + 1] - xe[c], ge[r] - ge[r + 1]);
        continue;
      }
      getJsColor(p.svm * scale, o.colormap, col);
      ctx.fillStyle = `#${col.getHexString()}`;
      // Cell r spans gray edges [r, r+1] -> y from ge[r+1] (top) to ge[r] (bottom).
      ctx.fillRect(xe[c], ge[r + 1], xe[c + 1] - xe[c], ge[r] - ge[r + 1]);
    }
  }

  // Stepped contours along cell borders where the threshold is crossed.
  const segs = (th: number) => {
    const out: [number, number, number, number][] = [];
    const above = (r: number, c: number) => {
      const p = view.points[r]?.[c];
      return p && Number.isFinite(p.svm) ? p.svm >= th : null;
    };
    for (let r = 0; r < view.grays.length; r++) {
      for (let c = 0; c < view.x.length; c++) {
        const a = above(r, c);
        if (a === null) continue;
        const right = c + 1 < view.x.length ? above(r, c + 1) : null;
        if (right !== null && right !== a) out.push([xe[c + 1], ge[r + 1], xe[c + 1], ge[r]]);
        const up = r + 1 < view.grays.length ? above(r + 1, c) : null;
        if (up !== null && up !== a) out.push([xe[c], ge[r + 1], xe[c + 1], ge[r + 1]]);
      }
    }
    return out;
  };
  const stroke = (lines: [number, number, number, number][], core: string, halo: string, width: number) => {
    if (!lines.length) return;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of lines) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.strokeStyle = halo;
    ctx.lineWidth = (width + 1.5) * dpr;
    ctx.stroke();
    ctx.strokeStyle = core;
    ctx.lineWidth = width * dpr;
    ctx.stroke();
  };
  // 0.4: white line; 1.0: dark line — readable on light and dark colormap ends alike.
  stroke(segs(SVM_SAFE), '#ffffff', 'rgba(0,0,0,0.45)', 1.25);
  stroke(segs(SVM_CRITICAL), '#0b0e14', 'rgba(255,255,255,0.7)', 1.5);

  // Current gray slice marker (the row behind "SVM @ nits").
  if (o.sliceGray !== null && o.sliceGray >= extent.g0 && o.sliceGray <= extent.g1) {
    const y = Y(o.sliceGray) + 0.5;
    ctx.setLineDash([5 * dpr, 3 * dpr]);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.strokeStyle = '#6aa1ff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
