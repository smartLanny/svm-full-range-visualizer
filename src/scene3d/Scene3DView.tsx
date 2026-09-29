import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Box, Maximize2, Minus, Plus } from 'lucide-react';
import { getAppState, selectActiveRecord, selectCompareRecord, useAppStore, type AppState } from '../store/appStore';
import { getT, useT } from '../i18n';
import { IconButton, Segmented } from '../ui';
import { cn } from '../ui/cn';
import { TimelineBar } from '../timeline/TimelineBar';
import { useRegisterActiveTimeline, useTimeline, useTimelineSnapshot } from '../timeline/timeline';
import { getExportTarget, registerExportTarget, safeFileName } from '../export/registry';
import type { ViewPreset } from '../types';
import { Engine, setDebugClock, type EngineSettings, type HoverInfo } from './engine/engine';
import { INTRO_CHAPTERS, INTRO_DURATION } from './engine/intro';
import type { ModelResult } from './engine/model';
import { SceneTooltip } from './SceneTooltip';

const BG = '#07090d';

function readSettings(st: AppState): EngineSettings {
  return {
    lang: st.lang,
    a: selectActiveRecord(st),
    b: selectCompareRecord(st),
    clipLowGray: st.clipLowGray,
    maxNits: st.maxNits,
    representation: st.representation,
    view: st.view,
    layout: st.layout,
    colormap: st.colormap,
    lighting: st.lighting,
    heightScale: st.heightScale,
    heightCap: st.heightCap,
    colorMax: st.colorMax,
    overlays: st.overlays,
    background: st.presenting && st.presentBlack ? '#000000' : BG,
  };
}

const RELEVANT: (keyof AppState)[] = [
  'lang',
  'records',
  'activeId',
  'compareId',
  'clipLowGray',
  'maxNits',
  'representation',
  'view',
  'layout',
  'colormap',
  'lighting',
  'heightScale',
  'heightCap',
  'colorMax',
  'overlays',
  'presenting',
  'presentBlack',
];

/** Bridges R3F (canvas, size, frameloop) and the imperative engine. */
function EngineHost({ engine }: { engine: Engine }) {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    engine.attach(gl);
    engine.invalidate = () => invalidate();
    invalidate();
    return () => {
      engine.invalidate = () => {};
      engine.detach();
    };
  }, [engine, gl, invalidate]);
  useEffect(() => {
    if (size.width > 1 && size.height > 1) engine.setViewport(size.width, size.height, dpr);
    invalidate();
  }, [engine, size.width, size.height, dpr, invalidate]);
  useFrame(() => {
    if (engine.frameTick()) invalidate();
  }, 1);
  return null;
}

/** 3D terrain view (surface / bars, perspective / top / front / side, single / side-by-side / diff). */
export default function Scene3DView() {
  const t = useT();
  const [engine] = useState(() => new Engine());
  const tab = useAppStore((s) => s.tab);
  const ready = useAppStore((s) => s.ready);
  const presenting = useAppStore((s) => s.presenting);
  const view = useAppStore((s) => s.view);
  const layout = useAppStore((s) => s.layout);
  const visible = tab === 'scene3d';
  const [model, setModel] = useState<ModelResult | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tl = useTimeline(INTRO_DURATION);
  const snap = useTimelineSnapshot(tl);
  const [introOpen, setIntroOpen] = useState(false);
  const introOpenRef = useRef(false);
  introOpenRef.current = introOpen;

  // --- store -> engine ------------------------------------------------------------------
  useEffect(() => {
    engine.onModel = (res) => setModel(res);
    engine.sync(readSettings(getAppState()));
    const unsub = useAppStore.subscribe((st, prev) => {
      if (RELEVANT.some((k) => st[k] !== prev[k])) engine.sync(readSettings(st));
    });
    return () => {
      unsub();
      engine.onModel = () => {};
    };
  }, [engine]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      // Debug / visual-test hooks (dev server only).
      const w = window as unknown as { __svm3d?: Engine; __svm3dExport?: () => unknown; __svm3dClock?: (t: number | null) => void };
      w.__svm3d = engine;
      w.__svm3dExport = () => getExportTarget('scene3d');
      w.__svm3dClock = (t) => {
        setDebugClock(t);
        engine.invalidate();
      };
    }
    return () => engine.dispose();
  }, [engine]);

  // Redraw canvas text once web fonts are available (Inter is bundled; CJK uses system fonts).
  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    Promise.all(['500 12px Inter', '600 12px Inter', '600 19px Inter'].map((f) => fonts.load(f).catch(() => null)))
      .then(() => fonts.ready)
      .then(() => {
        if (alive) engine.refreshText();
      });
    return () => {
      alive = false;
    };
  }, [engine]);

  // --- intro ----------------------------------------------------------------------------
  const playNonce = useAppStore((s) => s.playNonce.scene3d);
  const stopNonce = useAppStore((s) => s.stopNonce.scene3d);
  const firstPlay = useRef(playNonce);
  const firstStop = useRef(stopNonce);

  const stopIntro = () => {
    tl.pause();
    engine.stopIntro();
    setIntroOpen(false);
  };

  useEffect(() => {
    if (playNonce === firstPlay.current) return;
    firstPlay.current = playNonce;
    const st = getAppState();
    if (!selectActiveRecord(st)) return;
    if (st.layout !== 'single') st.set('layout', 'single');
    if (st.tab !== 'scene3d') st.set('tab', 'scene3d');
    engine.startIntro(tl);
    setIntroOpen(true);
    tl.restart();
    engine.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playNonce]);

  useEffect(() => {
    if (stopNonce === firstStop.current) return;
    firstStop.current = stopNonce;
    if (introOpenRef.current) stopIntro();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopNonce]);

  // End state of the intro becomes the static state (surface · top · contours) — applied by the
  // engine right before it hands over, so nothing moves.
  useEffect(() => {
    engine.onIntroEnd = () => {
      const st = getAppState();
      st.patch({ representation: 'surface', view: 'top', overlays: { ...st.overlays, contours: true } });
    };
    return () => {
      engine.onIntroEnd = () => {};
    };
  }, [engine]);

  // Coarse timeline changes (play / seek) -> render.
  useEffect(() => tl.subscribe(() => engine.invalidate()), [tl, engine]);

  // Pause when the view is hidden.
  useEffect(() => {
    if (!visible && tl.playing) tl.pause();
  }, [visible, tl]);

  useRegisterActiveTimeline(tl, introOpen && visible);
  const animating = introOpen && !snap.ended;
  useEffect(() => {
    getAppState().setAnimating('scene3d', animating);
  }, [animating]);
  useEffect(() => () => getAppState().setAnimating('scene3d', false), []);

  const chapters = useMemo(() => INTRO_CHAPTERS.map((c) => ({ t: c.t, label: t(`scene3d.intro.chapters.${c.key}`) })), [t]);

  // Presentation mode: the transport bar auto-hides after the pointer rests.
  const [barIdle, setBarIdle] = useState(false);
  useEffect(() => {
    if (!presenting || !introOpen) {
      setBarIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setBarIdle(true), 2200);
    const onMove = () => {
      setBarIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBarIdle(true), 2200);
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
    };
  }, [presenting, introOpen]);

  // --- export ---------------------------------------------------------------------------
  useEffect(() => {
    let copy: HTMLCanvasElement | null = null;
    return registerExportTarget({
      id: 'scene3d',
      fileName: () => safeFileName(engine.exportName()),
      animation: () => ({ duration: INTRO_DURATION, label: getT()('scene3d.export.intro') }),
      begin: async ({ width, height }) => {
        engine.beginExport(Math.round(width), Math.round(height));
      },
      renderFrame: async (time) => {
        engine.renderExport(time);
        const src = engine.gl?.domElement;
        if (!copy) copy = document.createElement('canvas');
        if (!src) return copy;
        if (copy.width !== src.width || copy.height !== src.height) {
          copy.width = src.width;
          copy.height = src.height;
        }
        const ctx = copy.getContext('2d');
        ctx?.clearRect(0, 0, copy.width, copy.height);
        ctx?.drawImage(src, 0, 0);
        return copy;
      },
      end: () => {
        engine.endExport(introOpenRef.current ? tl : null);
        engine.invalidate();
      },
    });
  }, [engine, tl]);

  // --- hover ----------------------------------------------------------------------------
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  const hoverKey = useRef<string | null>(null);
  const onPointerMove = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (tipRef.current) {
      const tw = tipRef.current.offsetWidth;
      const th = tipRef.current.offsetHeight;
      const left = x + 16 + tw > r.width ? x - 16 - tw : x + 16;
      const top = y + 16 + th > r.height ? y - 12 - th : y + 16;
      tipRef.current.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
    if (e.buttons !== 0) {
      if (hoverKey.current) {
        hoverKey.current = null;
        setHover(null);
        engine.pick(9, 9);
      }
      return;
    }
    pending.current = { x: (x / r.width) * 2 - 1, y: -((y / r.height) * 2 - 1) };
    if (!raf.current)
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const p = pending.current;
        if (!p) return;
        const info = engine.pick(p.x, p.y);
        const key = info?.key ?? null;
        if (key !== hoverKey.current || (info && hover && info.label !== hover.label)) {
          hoverKey.current = key;
          setHover(info);
        }
      });
  };
  const onPointerLeave = () => {
    pending.current = null;
    hoverKey.current = null;
    setHover(null);
    engine.pick(9, 9);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const empty = model && !model.ok ? model.reason : null;
  const views: { value: ViewPreset; label: string; title: string }[] = [
    { value: 'perspective', label: t('scene3d.views.perspective'), title: t('scene3d.views.perspectiveHint') },
    { value: 'top', label: t('scene3d.views.top'), title: t('scene3d.views.topHint') },
    { value: 'front', label: t('scene3d.views.front'), title: t('scene3d.views.frontHint') },
    { value: 'side', label: t('scene3d.views.side'), title: t('scene3d.views.sideHint') },
  ];

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden bg-canvas"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      data-testid="scene3d"
    >
      <Canvas
        frameloop={visible ? 'demand' : 'never'}
        dpr={[1, 2]}
        flat
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false }}
        style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: introOpen && animating ? 'default' : 'grab' }}
      >
        <EngineHost engine={engine} />
      </Canvas>

      {ready && empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl bg-surface-2/90 px-5 py-4 text-center shadow-panel ring-1 ring-line">
            <Box size={22} className="mx-auto mb-2 text-ink-3" />
            <div className="text-sm font-medium text-ink-1">{t(`scene3d.empty.${empty}`)}</div>
            <div className="mt-1 text-xs leading-relaxed text-ink-3">{t(`scene3d.empty.${empty}Hint`)}</div>
          </div>
        </div>
      )}

      <SceneTooltip ref={tipRef} info={hover} layout={layout} />

      {!presenting && !introOpen && !empty && (
        <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-1 rounded-xl bg-surface-2/85 p-1 shadow-panel ring-1 ring-line backdrop-blur-md">
          <Segmented<ViewPreset> aria-label={t('scene3d.controls.viewPresets')} value={view} onChange={(v) => getAppState().set('view', v)} options={views} />
          <div className="mx-0.5 h-5 w-px bg-line" />
          <IconButton size="sm" label={t('scene3d.controls.zoomOut')} icon={<Minus size={14} />} onClick={() => engine.zoomBy(-1)} />
          <IconButton size="sm" label={t('scene3d.controls.zoomIn')} icon={<Plus size={14} />} onClick={() => engine.zoomBy(1)} />
          <IconButton size="sm" label={t('scene3d.controls.fit')} icon={<Maximize2 size={14} />} onClick={() => engine.fitView()} />
        </div>
      )}

      {introOpen && (
        <div className={cn('pointer-events-none absolute inset-x-0 bottom-4 flex justify-center transition-opacity duration-300', barIdle && 'opacity-0')}>
          <TimelineBar timeline={tl} chapters={chapters} title={t('scene3d.intro.title')} onClose={stopIntro} />
        </div>
      )}
    </div>
  );
}
