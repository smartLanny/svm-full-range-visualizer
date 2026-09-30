import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ColormapType, SvmRecord } from '../types';
import { cellEdges, fmtNits, gridView } from '../data/grid';
import { displayNotes } from '../data/denoise';
import { noteLines } from '../data/denoiseText';
import { useT } from '../i18n';
import { drawHeatmap, HATCH_CSS, hasNoDataCells, THUMB_HEIGHT as HEIGHT, thumbGrayLabels, thumbTicks, type ThumbExtent } from './heatmap';

export { thumbExtent, type ThumbExtent } from './heatmap';

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
 * view. Cells without a valid value (missing, or no data after the denoise) get a neutral grey hatch, never a
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
  /** What the denoise did to the displayed record (docs/adr/0012 addendum), or null. */
  const notes = displayNotes(rec);

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

  const ticks = useMemo(() => thumbTicks(width, extent), [width, extent]);

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
    const note = notes?.noteAt(view.grays[r], view.percents[c]) ?? null;
    let text: string;
    if (p && Number.isFinite(p.svm)) {
      text = t('stats.thumb.hover', { g: view.grays[r], n: fmtNits(view.levelNits[c]), v: p.svm.toFixed(2) });
      // interpolated / luminance estimated: say so, with the raw reading
      if (note) text += ` · ${noteLines(note, t).action} (${noteLines(note, t).raw})`;
    } else {
      const what = note ? `${noteLines(note, t).action} · ${noteLines(note, t).reason}` : t('common.noValidData');
      text = t('stats.thumb.hoverNoData', { g: view.grays[r], n: fmtNits(view.levelNits[c]), what });
    }
    setHover({ x: e.clientX - rect.left, text });
  };

  const grayLabels = thumbGrayLabels(extent, sliceGray);

  return (
    <div>
      {/* The legend keys move under the caption when both do not fit on one line (narrow cards,
          or the extra "no valid data" key), so the caption is not cut down to "Heatmap · gr…". */}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 pl-9 text-2xs text-ink-3">
        <span className="max-w-full truncate" title={t('stats.thumb.caption')}>
          {t('stats.thumb.caption')}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-2.5">
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
          {grayLabels.map(({ g, top, accent }) => (
            <span key={`${g}-${accent ? 's' : ''}`} className={accent ? 'absolute right-0 font-medium text-accent-hover' : 'absolute right-0'} style={{ top }}>
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
