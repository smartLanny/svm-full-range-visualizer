import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Play, Square, Table2 } from 'lucide-react';
import { useAppStore, getAppState } from '../store/appStore';
import { useRecordStyles } from '../store/hooks';
import { translate, useT } from '../i18n';
import { Button, IconButton, cn } from '../ui';
import { useRegisterActiveTimeline, useTimeline } from '../timeline/timeline';
import { TimelineBar } from '../timeline/TimelineBar';
import { registerExportTarget, safeFileName } from '../export/registry';
import { exclusionSummary } from '../data/anomalies';
import { buildScene, CHART_BG, exclusionText, sliceParam, sweepProgressOf, titleText, type ChartInputs, type SceneOptions } from './scene';
import { exportScale, font, renderChart, screenScale, type LegendHit } from './render';
import { easeInOutSine, fmtLevel, GRAY_SWEEP, LEVEL_SWEEP, SWEEP_DURATION } from './slices';
import { ChartTooltip } from './tooltip';
import { DataTablePanel } from './DataTablePanel';

const sweepLabelKey = (mode: ChartInputs['sliceMode']) => (mode === 'gray' ? 'chart2d.sweep.gray' : 'chart2d.sweep.level');

/**
 * Height (CSS px) of the transport band under the chart: in the workbench a docked strip that is
 * always there (idle: a play button; sweeping: the timeline bar), in presentation an empty band
 * reserved inside the picture for the overlaid timeline bar. Either way the plot never reflows
 * when a sweep starts or ends, and the bar never covers the axes.
 */
const BAND_H = 60;

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

/**
 * Sweep lifecycle. Starting a sweep glides from the current frame to the sweep's first frame
 * ('enter', then the timeline plays); closing it glides back to the static slice ('exit').
 * The glides are UI transitions outside the timeline: exported videos are unaffected.
 */
type Phase =
  | { kind: 'static' }
  | { kind: 'enter'; start: number; dur: number; from: number | null }
  | { kind: 'sweep' }
  | { kind: 'exit'; start: number; dur: number; from: number };

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
  phase: Phase;
  /**
   * Presentation chrome idle (pointer resting, cursor hidden): the crosshair, its markers, the
   * tooltip and any legend highlight are hidden until the pointer moves again.
   */
  idle: boolean;
  /** useAppStore.presentSafeLeft: the in-canvas title keeps clear of the exit button. */
  safeLeft: number;
}

/** Glide duration for a jump of `dq` sweep lengths: short hops are quick, long ones ≤ 1.2 s. */
const glideDuration = (dq: number) => Math.min(1.2, 0.35 + 0.9 * Math.abs(dq));

/** Tooltip text for a record with excluded anomalous points (docs/adr/0012). */
function exclusionTip(recId: string): string | null {
  const st = getAppState();
  const rec = st.records.find((r) => r.id === recId);
  const sum = rec ? exclusionSummary(rec) : null;
  return sum ? exclusionText(st.lang, sum) : null;
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
  const presentSafeLeft = useAppStore((s) => s.presentSafeLeft);
  // H shortcut (C2): overlays.title -> title + subtitle, overlays.colorbar -> legend.
  const showTitle = useAppStore((s) => s.overlays.title);
  const showLegend = useAppStore((s) => s.overlays.colorbar);
  const tab = useAppStore((s) => s.tab);
  const playNonce = useAppStore((s) => s.playNonce.chart2d);
  const stopNonce = useAppStore((s) => s.stopNonce.chart2d);
  const styles = useRecordStyles();
  const isActiveTab = tab === 'chart2d';

  const tl = useTimeline(SWEEP_DURATION);
  const [sweeping, setSweeping] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tableNonce, setTableNonce] = useState(0);

  const inputs: ChartInputs = useMemo(
    () => ({ records, hiddenIds, styles, lang, sliceMode, sliceGray, sliceNits, axisMode, clipLowGray, presenting, presentBlack, showTitle, showLegend }),
    [records, hiddenIds, styles, lang, sliceMode, sliceGray, sliceNits, axisMode, clipLowGray, presenting, presentBlack, showTitle, showLegend],
  );
  const visibleCount = useMemo(() => records.filter((r) => !hiddenIds.includes(r.id)).length, [records, hiddenIds]);

  const inputsRef = useRef(inputs);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const tooltipElRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<ChartTooltip | null>(null);
  const rt = useRef<Runtime>({ w: 0, h: 0, dpr: 1, raf: 0, visible: false, pointer: null, hoverId: null, hoverDevice: null, hits: [], phase: { kind: 'static' }, idle: false, safeLeft: 0 });

  /** Scene options of the frame on screen now (advances finished glides). */
  const frameOptions = useCallback(
    (interactive: boolean): SceneOptions => {
      const r = rt.current;
      const ph = r.phase;
      const now = performance.now() / 1000;
      // dp/dt of the eased glide progress (moving axes widen their edge fades with it)
      const rate = (q: number, dur: number) => ((Math.PI / 2) * Math.sin(Math.PI * Math.min(1, Math.max(0, q)))) / dur;
      if (ph.kind === 'enter') {
        const p = (now - ph.start) / ph.dur;
        if (p < 1) return { t: tl.time, interactive, blend: { from: ph.from, p: easeInOutSine(p), rate: rate(p, ph.dur) } };
        r.phase = { kind: 'sweep' };
        if (!tl.playing && tl.time === 0) tl.play();
      } else if (ph.kind === 'exit') {
        const p = (now - ph.start) / ph.dur;
        if (p < 1) return { t: null, interactive, blend: { from: ph.from, p: easeInOutSine(p), rate: rate(p, ph.dur) } };
        r.phase = { kind: 'static' };
        tl.seek(0);
      }
      return { t: r.phase.kind === 'sweep' ? tl.time : null, interactive };
    },
    [tl],
  );

  // ---------------------------------------------------------------- drawing
  const draw = useCallback(() => {
    const r = rt.current;
    const cv = canvasRef.current;
    if (!cv || r.w <= 0 || r.h <= 0) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    const inp = inputsRef.current;
    const scene = buildScene(inp, frameOptions(!inp.presenting));
    const s = screenScale(r.w, r.h);
    const res = renderChart(ctx, r.w, r.h, s, scene, {
      hoverId: r.idle ? null : r.hoverId,
      hoverDevice: r.idle ? null : r.hoverDevice,
      pointer: r.idle ? null : r.pointer,
      insetBottom: inp.presenting ? BAND_H : 0,
      safeLeft: inp.presenting ? r.safeLeft : 0,
    });
    r.hits = res.hits;
    if (tooltipElRef.current) {
      if (!tooltipRef.current) tooltipRef.current = new ChartTooltip(tooltipElRef.current);
      tooltipRef.current.update(res, scene, r.w, r.h);
    }
    // Presentation toolbar (C1): an icon column at the top of the plot's right margin, which is
    // never over the title (any stage aspect), the axes or the plot.
    const tb = toolbarRef.current;
    if (tb) {
      tb.style.top = `${Math.round(res.plot.y)}px`;
      tb.style.right = `${Math.max(4, Math.round((r.w - res.plot.x - res.plot.w - 28) / 2))}px`;
    }
  }, [frameOptions]);

  const requestDraw = useCallback(() => {
    const r = rt.current;
    if (!r.visible || r.raf) return;
    r.raf = requestAnimationFrame(() => {
      r.raf = 0;
      draw();
      // keep rendering every frame while the sweep plays or a glide runs
      const k = r.phase.kind;
      if (k === 'enter' || k === 'exit' || (k === 'sweep' && tl.playing)) requestDraw();
    });
  }, [draw, tl]);

  // Inputs changed -> one redraw.
  useLayoutEffect(() => {
    inputsRef.current = inputs;
    requestDraw();
  }, [inputs, requestDraw]);

  // Title clear of the presentation exit button.
  useLayoutEffect(() => {
    rt.current.safeLeft = presentSafeLeft;
    requestDraw();
  }, [presentSafeLeft, requestDraw]);

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

  // Hidden tab: the sweep pauses (as the 3D intro does) instead of running on unseen; back on
  // the tab it waits where it was. A glide into the sweep lands on its first frame, paused
  // (the glide would otherwise start the sweep by itself on return).
  useEffect(() => {
    if (isActiveTab) return;
    const r = rt.current;
    if (r.phase.kind === 'enter') r.phase = { kind: 'sweep' };
    if (tl.playing) tl.pause();
  }, [isActiveTab, tl]);

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

  // Timeline: coarse events (play / pause / seek / end) -> redraw and refresh an open table;
  // the frame loop continues while playing.
  useEffect(
    () =>
      tl.subscribe(() => {
        requestDraw();
        setTableNonce((n) => n + 1);
      }),
    [tl, requestDraw],
  );

  // ---------------------------------------------------------------- sweep
  const startSweep = useCallback(() => {
    const r = rt.current;
    const inp = inputsRef.current;
    // glide from where the chart is now (static slice, or the current sweep frame on a restart)
    const from = r.phase.kind === 'sweep' || r.phase.kind === 'enter' ? tl.time : null;
    tl.pause();
    tl.seek(0);
    const dq = sweepProgressOf(inp.sliceMode, sliceParam(inp, from));
    // Build the first frame once before the glide's clock starts: moving adaptive / free axes
    // precompute the sweep's range track (~0.1 s for every bundled record), which must not eat
    // into the glide (its first frames would jump).
    buildScene(inp, { t: 0, interactive: !inp.presenting, blend: { from, p: 0 } });
    r.phase = Math.abs(dq) < 1e-3 ? { kind: 'sweep' } : { kind: 'enter', start: performance.now() / 1000, dur: glideDuration(dq), from };
    if (r.phase.kind === 'sweep') tl.play();
    setSweeping(true);
    requestDraw();
  }, [tl, requestDraw]);

  const closeSweep = useCallback(() => {
    const r = rt.current;
    const inp = inputsRef.current;
    const from = r.phase.kind === 'sweep' || r.phase.kind === 'enter' ? tl.time : null;
    tl.pause();
    if (from === null) r.phase = { kind: 'static' };
    else {
      const dq = sweepProgressOf(inp.sliceMode, sliceParam(inp, null)) - sweepProgressOf(inp.sliceMode, sliceParam(inp, from));
      buildScene(inp, { t: null, interactive: !inp.presenting, blend: { from, p: 0 } }); // warm the glide's range track
      r.phase = { kind: 'exit', start: performance.now() / 1000, dur: glideDuration(dq), from };
    }
    setSweeping(false);
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
  // Idle (no pointer activity for 2.5 s): the chrome fades and the hover read-out (crosshair,
  // markers, tooltip, legend highlight) goes too, so a recording never keeps a stale tooltip.
  // The next pointer move brings both back.
  useEffect(() => {
    const r = rt.current;
    const setIdle = (idle: boolean) => {
      if (r.idle === idle) return;
      r.idle = idle;
      if (idle) {
        r.hoverId = null;
        r.hoverDevice = null;
        const cv = canvasRef.current;
        if (cv) {
          cv.style.cursor = '';
          cv.title = '';
        }
      }
      requestDraw();
    };
    if (!presenting) {
      setChromeVisible(true);
      setIdle(false);
      return;
    }
    const el = rootRef.current;
    let timer = 0;
    const poke = () => {
      setChromeVisible(true);
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setChromeVisible(false);
        setIdle(true);
      }, 2500);
    };
    poke();
    el?.addEventListener('pointermove', poke);
    el?.addEventListener('pointerdown', poke);
    return () => {
      window.clearTimeout(timer);
      el?.removeEventListener('pointermove', poke);
      el?.removeEventListener('pointerdown', poke);
      setIdle(false);
    };
  }, [presenting, requestDraw]);

  // ---------------------------------------------------------------- pointer
  const hitAt = (x: number, y: number) => rt.current.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) ?? null;

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const r = rt.current;
    r.pointer = { x, y };
    const hit = hitAt(x, y);
    const id = hit?.kind === 'record' ? hit.id : null;
    // legend row of a record with excluded points: native tooltip with the breakdown (C4)
    if (id !== r.hoverId) e.currentTarget.title = (id && exclusionTip(id)) || '';
    r.hoverId = id;
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
    e.currentTarget.title = '';
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
      /**
       * kind 'video' = the sweep: SVM_2D_sweep_G255-G50 / SVM_2D_sweep_500-2nits. Otherwise the
       * frame on screen, named after its own gray / level (mid-sweep too).
       */
      fileName: (kind?: 'image' | 'video') => {
        const i = inputsRef.current;
        if (kind === 'video') {
          return safeFileName(i.sliceMode === 'gray' ? `SVM_2D_sweep_G${GRAY_SWEEP[0]}-G${GRAY_SWEEP[1]}` : `SVM_2D_sweep_${LEVEL_SWEEP[0]}-${LEVEL_SWEEP[1]}nits`);
        }
        const p = buildScene(i, frameOptions(false)).param;
        return safeFileName(`SVM_2D_${i.sliceMode === 'gray' ? `G${Math.round(p)}` : `${fmtLevel(p)}nits`}`);
      },
      animation: () => {
        const i = inputsRef.current;
        return { duration: SWEEP_DURATION, label: translate(i.lang, sweepLabelKey(i.sliceMode)) };
      },
      // "Current view" preset (C5): the on-screen drawing buffer in device px (the view's aspect).
      viewSize: () => {
        const cv = canvasRef.current;
        const r = rt.current;
        return { width: cv?.width || Math.round(r.w * r.dpr), height: cv?.height || Math.round(r.h * r.dpr) };
      },
      begin: async ({ width, height }) => {
        await ensureFonts();
        buildScene(inputsRef.current, { t: 0, interactive: false }); // warm the sweep's range track
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
        const scene = buildScene(inputsRef.current, time === null ? frameOptions(false) : { t: time, interactive: false });
        renderChart(ctx, canvas.width, canvas.height, exportScale(canvas.width, canvas.height), scene, { emptyMessage: true });
        return canvas;
      },
      end: () => {
        canvas = null;
      },
    });
  }, [frameOptions]);

  // ---------------------------------------------------------------- data table
  const tableScene = useMemo(
    () => (tableOpen ? buildScene(inputs, frameOptions(false)) : null),
    // `tableNonce` / `sweeping` are dependencies on purpose: re-read the frame when the sweep
    // is paused / scrubbed / closed.
    [tableOpen, inputs, sweeping, tableNonce, frameOptions], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const chromeHidden = presenting && !chromeVisible;
  const bg = presenting && presentBlack ? '#000000' : CHART_BG;
  const sweepLabel = t(sweepLabelKey(sliceMode));
  const ariaTitle = titleText(lang, sliceMode, sliceMode === 'gray' ? sliceGray : sliceNits);
  const timelineBar = sweeping ? <TimelineBar timeline={tl} title={sweepLabel} onClose={closeSweep} /> : null;
  const tableToggle = (
    <Button size="sm" variant="secondary" active={tableOpen} icon={<Table2 size={13} />} title={t('chart2d.toolbar.tableTitle')} aria-pressed={tableOpen} onClick={() => setTableOpen((o) => !o)}>
      {t('chart2d.toolbar.table')}
    </Button>
  );

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

        {/* presentation: auto-hidden icon column in the plot's right margin (positioned in draw) */}
        {presenting && (
          <div
            ref={toolbarRef}
            data-testid="chart2d-toolbar"
            className={cn('absolute right-3 top-3 z-20 flex flex-col items-center gap-1.5 transition-opacity duration-300', chromeHidden && 'pointer-events-none opacity-0')}
          >
            <IconButton
              size="sm"
              variant="secondary"
              label={sweeping ? t('chart2d.toolbar.stop') : `${t('chart2d.toolbar.play')} · ${sweepLabel}`}
              icon={sweeping ? <Square size={11} /> : <Play size={13} />}
              onClick={sweeping ? closeSweep : startSweep}
              disabled={visibleCount === 0}
            />
            <IconButton size="sm" variant="secondary" active={tableOpen} label={t('chart2d.toolbar.tableTitle')} aria-pressed={tableOpen} icon={<Table2 size={13} />} onClick={() => setTableOpen((o) => !o)} />
          </div>
        )}

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

        {/* presentation: the timeline overlays the band reserved below the axes (insetBottom) */}
        {presenting && timelineBar && (
          <div
            className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-center transition-opacity duration-300', chromeHidden && 'opacity-0 [&>*]:pointer-events-none')}
            style={{ height: BAND_H }}
          >
            {timelineBar}
          </div>
        )}
      </div>
      {/* workbench: a transport strip that is always there (the plot never reflows) and keeps
          the chart's own controls out of the picture and away from the shell's floating buttons */}
      {!presenting && (
        <div
          className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-1 px-3"
          style={{ height: BAND_H }}
          data-testid="chart2d-transport"
          // toasts keep clear of the band and of the x-axis labels right above it (computeLayout:
          // 62 px × the UI scale, at most 1.25)
          data-toast-avoid="78"
        >
          <div className="hidden min-w-0 flex-1 lg:block" />
          <div className="flex min-w-0 flex-[0_1_720px] justify-center">
            {timelineBar ?? (
              <div className="flex w-full min-w-0 items-center gap-3 px-1">
                <Button size="sm" variant="secondary" icon={<Play size={13} />} onClick={startSweep} disabled={visibleCount === 0} title={sweepLabel}>
                  {t('chart2d.toolbar.play')}
                </Button>
                <span className="truncate text-xs text-ink-3">{sweepLabel}</span>
              </div>
            )}
          </div>
          <div className="flex flex-1 justify-end">{tableToggle}</div>
        </div>
      )}
    </div>
  );
}
