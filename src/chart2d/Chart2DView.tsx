import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Play, Square, Table2 } from 'lucide-react';
import { useAppStore, getAppState } from '../store/appStore';
import { useRecordStyles } from '../store/hooks';
import { translate, useT } from '../i18n';
import { Button, cn } from '../ui';
import { useRegisterActiveTimeline, useTimeline, useTimelineSnapshot } from '../timeline/timeline';
import { TimelineBar } from '../timeline/TimelineBar';
import { registerExportTarget, safeFileName } from '../export/registry';
import { buildScene, CHART_BG, titleText, type ChartInputs } from './scene';
import { exportScale, font, renderChart, screenScale, type LegendHit } from './render';
import { SWEEP_DURATION, fmtLevel } from './slices';
import { ChartTooltip } from './tooltip';
import { DataTablePanel } from './DataTablePanel';

const sweepLabelKey = (mode: ChartInputs['sliceMode']) => (mode === 'gray' ? 'chart2d.sweep.gray' : 'chart2d.sweep.level');

/** Make sure the canvas fonts are ready before drawing text that ends up in a PNG / video. */
async function ensureFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([400, 500, 600].map((w) => document.fonts.load(font(w, 16))));
    await document.fonts.ready;
  } catch {
    /* fall back to whatever is available */
  }
}

interface Runtime {
  w: number;
  h: number;
  dpr: number;
  raf: number;
  visible: boolean;
  pointer: { x: number; y: number } | null;
  hoverId: string | null;
  hoverDevice: string | null;
  hits: LegendHit[];
}

/**
 * 2D cross-section chart (docs/adr/0006): gray slice (SVM vs measured nits) or brightness
 * slice (SVM vs gray), drawn on a Canvas2D with the legend, title and reference lines inside
 * the picture, a hover crosshair, a data table and sweep animations driven by the timeline.
 * Nothing re-renders React per frame: the draw loop reads refs and the timeline clock.
 */
export default function Chart2DView() {
  const t = useT();
  const records = useAppStore((s) => s.records);
  const hiddenIds = useAppStore((s) => s.hiddenIds);
  const lang = useAppStore((s) => s.lang);
  const sliceMode = useAppStore((s) => s.sliceMode);
  const sliceGray = useAppStore((s) => s.sliceGray);
  const sliceNits = useAppStore((s) => s.sliceNits);
  const axisMode = useAppStore((s) => s.axisMode);
  const clipLowGray = useAppStore((s) => s.clipLowGray);
  const presenting = useAppStore((s) => s.presenting);
  const presentBlack = useAppStore((s) => s.presentBlack);
  const tab = useAppStore((s) => s.tab);
  const playNonce = useAppStore((s) => s.playNonce.chart2d);
  const stopNonce = useAppStore((s) => s.stopNonce.chart2d);
  const styles = useRecordStyles();
  const isActiveTab = tab === 'chart2d';

  const tl = useTimeline(SWEEP_DURATION);
  const snap = useTimelineSnapshot(tl);
  const [sweeping, setSweeping] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const inputs: ChartInputs = useMemo(
    () => ({ records, hiddenIds, styles, lang, sliceMode, sliceGray, sliceNits, axisMode, clipLowGray, presenting, presentBlack }),
    [records, hiddenIds, styles, lang, sliceMode, sliceGray, sliceNits, axisMode, clipLowGray, presenting, presentBlack],
  );
  const visibleCount = useMemo(() => records.filter((r) => !hiddenIds.includes(r.id)).length, [records, hiddenIds]);

  const inputsRef = useRef(inputs);
  const sweepingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipElRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<ChartTooltip | null>(null);
  const rt = useRef<Runtime>({ w: 0, h: 0, dpr: 1, raf: 0, visible: false, pointer: null, hoverId: null, hoverDevice: null, hits: [] });

  // ---------------------------------------------------------------- drawing
  const draw = useCallback(() => {
    const r = rt.current;
    const cv = canvasRef.current;
    if (!cv || r.w <= 0 || r.h <= 0) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    const inp = inputsRef.current;
    const scene = buildScene(inp, { t: sweepingRef.current ? tl.time : null, interactive: !inp.presenting });
    const res = renderChart(ctx, r.w, r.h, screenScale(r.w, r.h), scene, { hoverId: r.hoverId, hoverDevice: r.hoverDevice, pointer: r.pointer });
    r.hits = res.hits;
    if (tooltipElRef.current) {
      if (!tooltipRef.current) tooltipRef.current = new ChartTooltip(tooltipElRef.current);
      tooltipRef.current.update(res, scene, r.w, r.h);
    }
  }, [tl]);

  const requestDraw = useCallback(() => {
    const r = rt.current;
    if (!r.visible || r.raf) return;
    r.raf = requestAnimationFrame(() => {
      r.raf = 0;
      draw();
      // keep rendering every frame while the sweep plays
      if (sweepingRef.current && tl.playing) requestDraw();
    });
  }, [draw, tl]);

  // Inputs changed -> one redraw.
  useLayoutEffect(() => {
    inputsRef.current = inputs;
    requestDraw();
  }, [inputs, requestDraw]);

  // Visibility: inactive tabs stay mounted but must not run a render loop.
  useEffect(() => {
    const r = rt.current;
    r.visible = isActiveTab && r.w > 0 && r.h > 0;
    if (r.visible) requestDraw();
    else if (r.raf) {
      cancelAnimationFrame(r.raf);
      r.raf = 0;
    }
  }, [isActiveTab, requestDraw]);

  // Size: ResizeObserver + devicePixelRatio; redraw synchronously (no blank frame).
  useEffect(() => {
    const host = hostRef.current;
    const cv = canvasRef.current;
    if (!host || !cv) return;
    const apply = () => {
      const r = rt.current;
      const rect = host.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      r.visible = getAppState().tab === 'chart2d' && w > 0 && h > 0;
      if (w === r.w && h === r.h && dpr === r.dpr) {
        if (r.visible) requestDraw();
        return;
      }
      r.w = w;
      r.h = h;
      r.dpr = dpr;
      if (w > 0 && h > 0) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        if (r.visible) draw();
      }
    };
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    apply();
    // devicePixelRatio changes (moving between screens / browser zoom)
    let mq: MediaQueryList | null = null;
    const onDpr = () => {
      apply();
      watchDpr();
    };
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    watchDpr();
    void ensureFonts().then(() => requestDraw());
    return () => {
      ro.disconnect();
      mq?.removeEventListener('change', onDpr);
      const r = rt.current;
      if (r.raf) cancelAnimationFrame(r.raf);
      r.raf = 0;
    };
  }, [draw, requestDraw]);

  // Timeline: coarse events (play / pause / seek / end) -> redraw; the frame loop continues while playing.
  useEffect(() => tl.subscribe(() => requestDraw()), [tl, requestDraw]);

  // ---------------------------------------------------------------- sweep
  const startSweep = useCallback(() => {
    sweepingRef.current = true;
    setSweeping(true);
    tl.seek(0);
    tl.play();
    requestDraw();
  }, [tl, requestDraw]);

  const closeSweep = useCallback(() => {
    sweepingRef.current = false;
    setSweeping(false);
    tl.pause();
    tl.seek(0);
    requestDraw();
  }, [tl, requestDraw]);

  const lastPlay = useRef(playNonce);
  useEffect(() => {
    if (playNonce === lastPlay.current) return;
    lastPlay.current = playNonce;
    startSweep();
  }, [playNonce, startSweep]);

  const lastStop = useRef(stopNonce);
  useEffect(() => {
    if (stopNonce === lastStop.current) return;
    lastStop.current = stopNonce;
    closeSweep();
  }, [stopNonce, closeSweep]);

  useEffect(() => {
    getAppState().setAnimating('chart2d', sweeping);
  }, [sweeping]);
  useEffect(() => () => getAppState().setAnimating('chart2d', false), []);

  useRegisterActiveTimeline(tl, sweeping && isActiveTab);

  // ---------------------------------------------------------------- presentation chrome auto-hide
  useEffect(() => {
    if (!presenting) {
      setChromeVisible(true);
      return;
    }
    const el = rootRef.current;
    let timer = 0;
    const poke = () => {
      setChromeVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setChromeVisible(false), 2500);
    };
    poke();
    el?.addEventListener('pointermove', poke);
    el?.addEventListener('pointerdown', poke);
    return () => {
      window.clearTimeout(timer);
      el?.removeEventListener('pointermove', poke);
      el?.removeEventListener('pointerdown', poke);
    };
  }, [presenting]);

  // ---------------------------------------------------------------- pointer
  const hitAt = (x: number, y: number) => rt.current.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) ?? null;

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const r = rt.current;
    r.pointer = { x, y };
    const hit = hitAt(x, y);
    r.hoverId = hit?.kind === 'record' ? hit.id : null;
    r.hoverDevice = hit?.kind === 'device' ? hit.device : null;
    e.currentTarget.style.cursor = hit ? 'pointer' : '';
    requestDraw();
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rt.current;
    r.pointer = null;
    r.hoverId = null;
    r.hoverDevice = null;
    e.currentTarget.style.cursor = '';
    requestDraw();
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const st = getAppState();
    if (hit.kind === 'record') st.toggleHidden(hit.id);
    else {
      const ids = st.records.filter((r) => r.device === hit.device).map((r) => r.id);
      const anyVisible = ids.some((id) => !st.hiddenIds.includes(id));
      st.setHidden(ids, anyVisible);
    }
  };

  // ---------------------------------------------------------------- export (docs/adr/0010)
  useEffect(() => {
    let canvas: HTMLCanvasElement | null = null;
    return registerExportTarget({
      id: 'chart2d',
      fileName: () => {
        const i = inputsRef.current;
        return safeFileName(`SVM_2D_${i.sliceMode === 'gray' ? `G${Math.round(i.sliceGray)}` : `${fmtLevel(i.sliceNits)}nits`}`);
      },
      animation: () => {
        const i = inputsRef.current;
        return { duration: SWEEP_DURATION, label: translate(i.lang, sweepLabelKey(i.sliceMode)) };
      },
      begin: async ({ width, height }) => {
        await ensureFonts();
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
      },
      renderFrame: async (time) => {
        if (!canvas) {
          // renderFrame without begin(): fall back to the on-screen size
          const r = rt.current;
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((r.w || 1600) * r.dpr));
          canvas.height = Math.max(1, Math.round((r.h || 900) * r.dpr));
        }
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const tt = time ?? (sweepingRef.current ? tl.time : null);
        const scene = buildScene(inputsRef.current, { t: tt, interactive: false });
        renderChart(ctx, canvas.width, canvas.height, exportScale(canvas.width, canvas.height), scene, { emptyMessage: true });
        return canvas;
      },
      end: () => {
        canvas = null;
      },
    });
  }, [tl]);

  // ---------------------------------------------------------------- data table
  const tableScene = useMemo(
    () => (tableOpen ? buildScene(inputs, { t: sweeping ? tl.time : null, interactive: false }) : null),
    // `snap` is a dependency on purpose: re-read the frame when the sweep is paused / scrubbed.
    [tableOpen, inputs, sweeping, snap, tl],
  );

  const chromeHidden = presenting && !chromeVisible;
  const bg = presenting && presentBlack ? '#000000' : CHART_BG;
  const sweepLabel = t(sweepLabelKey(sliceMode));
  const ariaTitle = titleText(lang, sliceMode, sliceMode === 'gray' ? sliceGray : sliceNits);
  const timelineBar = sweeping ? <TimelineBar timeline={tl} title={sweepLabel} onClose={closeSweep} /> : null;

  return (
    <div ref={rootRef} className={cn('relative flex h-full w-full flex-col overflow-hidden', chromeHidden && 'cursor-none')} style={{ background: bg }}>
      <div ref={hostRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('chart2d.aria', { title: ariaTitle })}
          className="absolute inset-0 block h-full w-full touch-none select-none"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onClick={onClick}
        />
        <div
          ref={tooltipElRef}
          className="pointer-events-none absolute left-0 top-0 z-20 min-w-[150px] max-w-[340px] rounded-lg bg-surface-2/95 px-3 py-2 shadow-panel ring-1 ring-line backdrop-blur-sm"
          style={{ display: 'none' }}
        />

        {/* in-chart toolbar (top-right, in the title band above the plot) */}
        <div className={cn('absolute right-3 top-3 z-20 flex items-center gap-1.5 transition-opacity duration-300', chromeHidden && 'pointer-events-none opacity-0')}>
          <Button
            size="sm"
            variant={sweeping ? 'subtle' : 'secondary'}
            icon={sweeping ? <Square size={11} /> : <Play size={13} />}
            title={sweepLabel}
            onClick={sweeping ? closeSweep : startSweep}
            disabled={visibleCount === 0}
          >
            {sweeping ? t('chart2d.toolbar.stop') : t('chart2d.toolbar.play')}
          </Button>
          <Button size="sm" variant="secondary" active={tableOpen} icon={<Table2 size={13} />} title={t('chart2d.toolbar.tableTitle')} aria-pressed={tableOpen} onClick={() => setTableOpen((o) => !o)}>
            {t('chart2d.toolbar.table')}
          </Button>
        </div>

        {visibleCount === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-xl bg-surface-2/90 px-6 py-5 text-center shadow-panel ring-1 ring-line">
              <LineChart size={22} className="text-ink-3" />
              <div className="text-sm font-semibold text-ink-1">{t('chart2d.empty.title')}</div>
              <div className="text-xs leading-relaxed text-ink-3">{records.length > 0 ? t('chart2d.empty.hint') : t('chart2d.empty.hintNone')}</div>
              {records.length > 0 && (
                <Button size="sm" variant="primary" onClick={() => getAppState().setHidden(getAppState().records.map((r) => r.id), false)}>
                  {t('chart2d.empty.showAll')}
                </Button>
              )}
            </div>
          </div>
        )}

        {tableOpen && tableScene && <DataTablePanel scene={tableScene} onClose={() => setTableOpen(false)} />}

        {presenting && timelineBar && (
          <div className={cn('pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center transition-opacity duration-300', chromeHidden && 'opacity-0 [&>*]:pointer-events-none')}>
            {timelineBar}
          </div>
        )}
      </div>
      {!presenting && timelineBar && <div className="flex shrink-0 justify-center border-t border-line bg-surface-1 py-2">{timelineBar}</div>}
    </div>
  );
}
