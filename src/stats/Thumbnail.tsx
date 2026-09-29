import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Color } from 'three';
import type { ColormapType, SvmRecord } from '../types';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges, fmtNits, gridView, logNits, type GridView } from '../data/grid';
import { getJsColor } from '../colormaps';
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
 * view. Missing cells are hatched (never drawn as 0). Stepped 0.4 / 1.0 contours follow cell
 * borders. Redraws only when inputs or the size change (no animation loop).
 */
export function Thumbnail({ rec, clipLowGray, maxNits, colormap, colorMax, sliceGray, extent }: Props) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const view = useMemo(() => gridView(rec, { clipLowGray, maxNits }), [rec, clipLowGray, maxNits]);

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
    const text = t('stats.thumb.hover', {
      g: view.grays[r],
      n: fmtNits(view.levelNits[c]),
      v: p ? p.svm.toFixed(2) : t('stats.thumb.missing'),
    });
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
        <span className="truncate">{t('stats.thumb.caption')}</span>
        <span className="inline-flex shrink-0 items-center gap-2.5" title={t('stats.thumb.contours')}>
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-3.5 rounded bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
            0.4
          </span>
          <span className="inline-flex items-center gap-1">
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
            <canvas
              ref={canvasRef}
              className="block h-full w-full cursor-crosshair"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
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
              <span key={v} className="absolute top-0" style={px < 8 ? { left: 0 } : px > width - 12 ? { right: 0 } : { left: px, transform: 'translateX(-50%)' }}>
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

let hatch: { key: number; pattern: CanvasPattern | null } | null = null;

function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  if (hatch && hatch.key === dpr) return hatch.pattern;
  const s = Math.round(6 * dpr);
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0e14';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = '#1e2430';
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
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

function drawHeatmap(ctx: CanvasRenderingContext2D, view: GridView, o: DrawOpts) {
  const { W, H, dpr, extent } = o;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = hatchPattern(ctx, dpr) ?? '#0b0e14';
  ctx.fillRect(0, 0, W, H);

  const X = (x: number) => Math.round(((x - extent.x0) / (extent.x1 - extent.x0)) * W);
  const Y = (g: number) => Math.round(H - ((g - extent.g0) / (extent.g1 - extent.g0)) * H);
  const xe = cellEdges(view.x, 0).map(X);
  const ge = cellEdges(view.grays, 0, 255).map(Y);
  const scale = 4 / Math.max(0.05, o.colorMax || 4);
  const col = new Color();

  for (let r = 0; r < view.grays.length; r++) {
    for (let c = 0; c < view.x.length; c++) {
      const p = view.points[r][c];
      if (!p || !Number.isFinite(p.svm)) continue;
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
