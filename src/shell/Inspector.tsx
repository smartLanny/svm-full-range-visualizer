import React, { useMemo } from 'react';
import * as THREE from 'three';
import {
  ArrowUpDown,
  Box,
  Camera,
  Clapperboard,
  Crosshair,
  Eye,
  EyeOff,
  Info,
  Layers,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Ruler,
  Square,
  SlidersHorizontal,
  Sigma,
  ScanLine,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type AnimTab, type Overlays } from '../store/appStore';
import { useLang, useT } from '../i18n';
import { recordLabel } from '../data/records';
import { getJsColor } from '../colormaps';
import { ColormapType, type AxisMode, type LightingMode, type Representation, type SceneLayout, type SliceMode, type ViewPreset } from '../types';
import { Button, Field, Section, Segmented, Select, Slider, Switch, cn } from '../ui';
import { IconButton } from './IconBtn';
import { DataRangeControls } from './SettingsPanel';

/** Colormaps in menu order (recommended first). */
const COLORMAPS: ColormapType[] = [
  ColormapType.RD_YL_BU_ENHANCED,
  ColormapType.TRAFFIC_LIGHT,
  ColormapType.COOL_WARM,
  ColormapType.TURBO,
  ColormapType.MAGMA,
  ColormapType.VIRIDIS,
  ColormapType.PLASMA,
  ColormapType.INFERNO,
  ColormapType.RD_YL_BU,
  ColormapType.RD_YL_BU_R,
  ColormapType.JET,
];

const TAB_TITLE: Record<string, string> = {
  scene3d: 'shell.tabs.scene3d',
  chart2d: 'shell.tabs.chart2d',
  stats: 'shell.tabs.stats',
};

export function InspectorHeader({ onClose, overlay }: { onClose: () => void; overlay?: boolean }) {
  const t = useT();
  const tab = useAppStore((s) => s.tab);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-1.5">
      <SlidersHorizontal size={13} className="text-ink-3" />
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">{t('shell.inspector.title')}</span>
      <span className="truncate text-xs text-ink-2">· {t(TAB_TITLE[tab])}</span>
      <div className="flex-1" />
      <IconButton
        size="sm"
        label={t('shell.inspector.collapse')}
        icon={overlay ? <X size={15} /> : <PanelRightClose size={15} />}
        onClick={onClose}
        data-testid="inspector-collapse"
      />
    </div>
  );
}

export function InspectorBody() {
  const tab = useAppStore((s) => s.tab);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid={`inspector-${tab}`}>
      {tab === 'scene3d' ? <Inspector3D /> : tab === 'chart2d' ? <Inspector2D /> : <InspectorStats />}
    </div>
  );
}

/** Collapsed docked inspector: a thin rail with an expand button. */
export function InspectorRail({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <div className="flex w-11 flex-col items-center py-2">
      <IconButton size="sm" label={t('shell.inspector.expand')} icon={<PanelRightOpen size={15} />} onClick={onOpen} data-testid="inspector-expand" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function AnimationControl({ tab, label, hint }: { tab: AnimTab; label: string; hint: string }) {
  const t = useT();
  const animating = useAppStore((s) => s.animating[tab]);
  const requestPlay = useAppStore((s) => s.requestPlay);
  const requestStop = useAppStore((s) => s.requestStop);
  return (
    <>
      {animating ? (
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          icon={<Square size={11} fill="currentColor" />}
          onClick={() => requestStop(tab)}
          data-testid="inspector-stop"
        >
          {t('common.stop')}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="subtle"
          className="w-full"
          icon={<Play size={12} fill="currentColor" />}
          onClick={() => requestPlay(tab)}
          data-testid="inspector-play"
        >
          {label}
        </Button>
      )}
      <p className="-mt-1 text-2xs leading-snug text-ink-3">{hint}</p>
    </>
  );
}

function RoleTag({ role }: { role: 'A' | 'B' }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[10px] font-bold',
        role === 'A' ? 'bg-accent text-white' : 'bg-ink-2 text-canvas',
      )}
    >
      {role}
    </span>
  );
}

/** Mini color bar for a colormap (SVM 0–4), with the 0.4 / 1.0 thresholds marked. */
function ColormapPreview({ type, disabled }: { type: ColormapType; disabled?: boolean }) {
  const gradient = useMemo(() => {
    const c = new THREE.Color();
    const stops: string[] = [];
    const N = 32;
    for (let i = 0; i <= N; i++) {
      const svm = (i / N) * 4;
      getJsColor(svm, type, c);
      stops.push(`#${c.getHexString()} ${((i / N) * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [type]);
  return (
    <div className={cn('select-none', disabled && 'opacity-40')} aria-hidden="true">
      <div className="relative h-2.5 rounded-sm ring-1 ring-inset ring-white/10" style={{ background: gradient }}>
        {[0.4, 1].map((v) => (
          <span key={v} className="absolute -bottom-0.5 -top-0.5 w-px bg-white/70" style={{ left: `${(v / 4) * 100}%` }} />
        ))}
      </div>
      <div className="relative mt-1 h-3 font-mono text-[10px] text-ink-3">
        {[0, 0.4, 1, 2, 3, 4].map((v) => (
          <span
            key={v}
            className="absolute -translate-x-1/2"
            style={{
              left: `${(v / 4) * 100}%`,
              transform: v === 0 ? 'none' : v === 4 ? 'translateX(-100%)' : undefined,
            }}
          >
            {v === 4 ? '4+' : v}
          </span>
        ))}
      </div>
    </div>
  );
}

function Inspector3D() {
  const t = useT();
  const lang = useLang();
  const s = useAppStore(
    useShallow((st) => ({
      layout: st.layout,
      representation: st.representation,
      view: st.view,
      colormap: st.colormap,
      lighting: st.lighting,
      heightScale: st.heightScale,
      heightCap: st.heightCap,
      overlays: st.overlays,
      activeId: st.activeId,
      compareId: st.compareId,
    })),
  );
  const records = useAppStore((st) => st.records);
  const { set, setOverlay, setActive, setCompare } = useAppStore.getState();
  const recordOptions = useMemo(() => records.map((r) => ({ value: r.id, label: recordLabel(r, lang) })), [records, lang]);
  const twoPlus = records.length >= 2;
  const showB = s.layout !== 'single';
  const overlayKeys: (keyof Overlays)[] = ['contours', 'values', 'axes', 'colorbar', 'title'];
  const overlayHints: Partial<Record<keyof Overlays, string>> = {
    contours: t('shell.inspector.scene3d.contoursHint'),
    values: t('shell.inspector.scene3d.valuesHint'),
  };

  return (
    <>
      <Section title={t('shell.inspector.scene3d.layout')} icon={<Layers size={12} />}>
        <Segmented<SceneLayout>
          fullWidth
          aria-label={t('shell.inspector.scene3d.layout')}
          value={s.layout}
          onChange={(v) => set('layout', v)}
          options={[
            {
              value: 'single',
              label: t('shell.inspector.scene3d.layoutSingle'),
            },
            {
              value: 'sideBySide',
              label: t('shell.inspector.scene3d.layoutSide'),
              disabled: !twoPlus,
              title: twoPlus ? undefined : t('shell.inspector.scene3d.needTwo'),
            },
            {
              value: 'diff',
              label: t('shell.inspector.scene3d.layoutDiff'),
              disabled: !twoPlus,
              title: twoPlus ? undefined : t('shell.inspector.scene3d.needTwo'),
            },
          ]}
        />
        <div className="flex items-stretch gap-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <RoleTag role="A" />
              {records.length > 0 ? (
                <Select<string> className="min-w-0 flex-1" aria-label="A" value={s.activeId ?? ''} onChange={(v) => setActive(v)} options={recordOptions} />
              ) : (
                <span className="text-xs text-ink-4">{t('common.none')}</span>
              )}
            </div>
            {showB && (
              <div className="flex items-center gap-2">
                <RoleTag role="B" />
                <Select<string> className="min-w-0 flex-1" aria-label="B" value={s.compareId ?? ''} onChange={(v) => setCompare(v)} options={recordOptions} />
              </div>
            )}
          </div>
          {showB && (
            <IconButton
              size="sm"
              label={t('shell.inspector.scene3d.swap')}
              icon={<ArrowUpDown size={14} />}
              className="self-center"
              data-testid="swap-ab"
              disabled={!s.activeId || !s.compareId}
              onClick={() => s.compareId && setActive(s.compareId)}
            />
          )}
        </div>
        {s.layout === 'diff' && <p className="text-2xs leading-snug text-ink-3">{t('shell.inspector.scene3d.diffHint')}</p>}
      </Section>

      <Section title={t('shell.inspector.scene3d.view')} icon={<Camera size={12} />}>
        <Field label={t('shell.inspector.scene3d.representation')} inline>
          <Segmented<Representation>
            aria-label={t('shell.inspector.scene3d.representation')}
            value={s.representation}
            onChange={(v) => set('representation', v)}
            options={[
              { value: 'surface', label: t('shell.inspector.scene3d.surface') },
              { value: 'bars', label: t('shell.inspector.scene3d.bars') },
            ]}
          />
        </Field>
        <Field label={t('shell.inspector.scene3d.view')} hint={t('shell.inspector.scene3d.viewHint')}>
          <Segmented<ViewPreset>
            fullWidth
            aria-label={t('shell.inspector.scene3d.view')}
            value={s.view}
            onChange={(v) => set('view', v)}
            options={[
              {
                value: 'perspective',
                label: t('shell.inspector.scene3d.perspective'),
              },
              { value: 'top', label: t('shell.inspector.scene3d.top') },
              { value: 'front', label: t('shell.inspector.scene3d.front') },
              { value: 'side', label: t('shell.inspector.scene3d.side') },
            ]}
          />
        </Field>
        <Field label={t('shell.inspector.scene3d.lighting')} inline>
          <Segmented<LightingMode>
            aria-label={t('shell.inspector.scene3d.lighting')}
            value={s.lighting}
            onChange={(v) => set('lighting', v)}
            options={[
              { value: 'studio', label: t('shell.inspector.scene3d.studio') },
              { value: 'flat', label: t('shell.inspector.scene3d.flat') },
            ]}
          />
        </Field>
      </Section>

      <Section title={t('shell.inspector.scene3d.colormap')} icon={<Palette size={12} />}>
        <Select<ColormapType>
          aria-label={t('shell.inspector.scene3d.colormap')}
          className="w-full"
          value={s.colormap}
          disabled={s.layout === 'diff'}
          onChange={(v) => set('colormap', v)}
          options={COLORMAPS.map((c) => ({
            value: c,
            label: t(`shell.colormaps.${c}`),
          }))}
        />
        <ColormapPreview type={s.colormap} disabled={s.layout === 'diff'} />
        {s.layout === 'diff' && (
          <p className="flex items-start gap-1.5 text-2xs leading-snug text-ink-3">
            <Info size={12} className="mt-px shrink-0" />
            {t('shell.inspector.scene3d.colormapDiff')}
          </p>
        )}
      </Section>

      <Section title={t('shell.inspector.scene3d.overlays')} icon={<ScanLine size={12} />}>
        {overlayKeys.map((k) => (
          <Switch key={k} checked={s.overlays[k]} onChange={(v) => setOverlay(k, v)} label={t(`shell.inspector.scene3d.${k}`)} description={overlayHints[k]} />
        ))}
      </Section>

      <Section title={t('shell.inspector.scene3d.height')} icon={<Box size={12} />}>
        <Slider
          label={t('shell.inspector.scene3d.heightScale')}
          value={s.heightScale}
          min={0.3}
          max={2.5}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => set('heightScale', Math.round(v * 10) / 10)}
          presets={[
            { value: 0.5, label: '0.5×' },
            { value: 1, label: '1×' },
            { value: 1.5, label: '1.5×' },
            { value: 2, label: '2×' },
          ]}
        />
        <div>
          <Slider
            label={t('shell.inspector.scene3d.heightCap')}
            value={s.heightCap}
            min={2}
            max={12}
            step={0.5}
            format={(v) => `SVM ${v.toFixed(1)}`}
            onChange={(v) => set('heightCap', Math.round(v * 2) / 2)}
          />
          <p className="mt-1 text-2xs leading-snug text-ink-3">{t('shell.inspector.scene3d.heightCapHint')}</p>
        </div>
      </Section>

      <Section title={t('shell.inspector.scene3d.range')} icon={<Ruler size={12} />}>
        <DataRangeControls />
      </Section>

      <Section title={t('shell.inspector.scene3d.animation')} icon={<Clapperboard size={12} />}>
        <AnimationControl tab="scene3d" label={t('shell.inspector.scene3d.playIntro')} hint={t('shell.inspector.scene3d.intro')} />
      </Section>
    </>
  );
}

const GRAY_PRESETS = [255, 192, 127, 64, 32];
const NITS_PRESETS = [2, 10, 50, 100, 200, 500];

function Inspector2D() {
  const t = useT();
  const s = useAppStore(
    useShallow((st) => ({
      sliceMode: st.sliceMode,
      sliceGray: st.sliceGray,
      sliceNits: st.sliceNits,
      axisMode: st.axisMode,
    })),
  );
  const { total, visible } = useAppStore(
    useShallow((st) => ({
      total: st.records.length,
      visible: st.records.filter((r) => !st.hiddenIds.includes(r.id)).length,
    })),
  );
  const { set, setHidden } = useAppStore.getState();
  const allIds = () => useAppStore.getState().records.map((r) => r.id);
  const axisHint: Record<AxisMode, string> = {
    standard: t('shell.inspector.chart2d.standardHint'),
    adaptive: t('shell.inspector.chart2d.adaptiveHint'),
    free: t('shell.inspector.chart2d.freeHint'),
  };

  return (
    <>
      <Section title={t('shell.inspector.chart2d.slice')} icon={<Crosshair size={12} />}>
        <Segmented<SliceMode>
          fullWidth
          aria-label={t('shell.inspector.chart2d.slice')}
          value={s.sliceMode}
          onChange={(v) => set('sliceMode', v)}
          options={[
            { value: 'gray', label: t('shell.inspector.chart2d.sliceGray') },
            {
              value: 'brightness',
              label: t('shell.inspector.chart2d.sliceBrightness'),
            },
          ]}
        />
        <p className="-mt-1 text-2xs leading-snug text-ink-3">
          {s.sliceMode === 'gray' ? t('shell.inspector.chart2d.sliceGrayHint') : t('shell.inspector.chart2d.sliceBrightnessHint')}
        </p>
        {s.sliceMode === 'gray' ? (
          <Slider
            label={t('shell.inspector.chart2d.gray')}
            value={s.sliceGray}
            min={0}
            max={255}
            step={1}
            format={(v) => `G${Math.round(v)}`}
            onChange={(v) => set('sliceGray', Math.round(v))}
            presets={GRAY_PRESETS.map((g) => ({ value: g, label: String(g) }))}
          />
        ) : (
          <Slider
            label={t('shell.inspector.chart2d.level')}
            value={s.sliceNits}
            min={2}
            max={500}
            log
            format={(v) => `${v >= 100 ? Math.round(v) : Number(v.toPrecision(3))} nits`}
            onChange={(v) => set('sliceNits', v)}
            presets={NITS_PRESETS.map((n) => ({ value: n, label: String(n) }))}
          />
        )}
      </Section>

      <Section title={t('shell.inspector.chart2d.axis')} icon={<Ruler size={12} />}>
        <Segmented<AxisMode>
          fullWidth
          aria-label={t('shell.inspector.chart2d.axis')}
          value={s.axisMode}
          onChange={(v) => set('axisMode', v)}
          options={(['standard', 'adaptive', 'free'] as AxisMode[]).map((m) => ({
            value: m,
            label: t(`shell.inspector.chart2d.${m}`),
            title: axisHint[m],
          }))}
        />
        <p className="-mt-1 text-2xs leading-snug text-ink-3">{axisHint[s.axisMode]}</p>
      </Section>

      <Section title={t('shell.inspector.chart2d.animation')} icon={<Clapperboard size={12} />}>
        <AnimationControl tab="chart2d" label={t('shell.inspector.chart2d.playSweep')} hint={t('shell.inspector.chart2d.sweepHint')} />
      </Section>

      <Section title={t('shell.inspector.chart2d.display')} icon={<Eye size={12} />}>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<Eye size={13} />}
            disabled={visible === total}
            onClick={() => setHidden(allIds(), false)}
            data-testid="show-all"
          >
            {t('shell.inspector.chart2d.showAll')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<EyeOff size={13} />}
            disabled={visible === 0}
            onClick={() => setHidden(allIds(), true)}
            data-testid="hide-all"
          >
            {t('shell.inspector.chart2d.hideAll')}
          </Button>
        </div>
        <p className="-mt-1 text-2xs leading-snug text-ink-3">{t('shell.inspector.chart2d.visibleCount', { v: visible, n: total })}</p>
      </Section>
    </>
  );
}

function InspectorStats() {
  const t = useT();
  const metrics = ['safeShare', 'criticalShare', 'whitePass', 'typical', 'peak', 'mean'];
  return (
    <>
      <Section title={t('shell.inspector.stats.range')} icon={<Ruler size={12} />}>
        <DataRangeControls />
      </Section>
      <Section title={t('shell.inspector.stats.metrics')} icon={<Sigma size={12} />}>
        <p className="text-2xs leading-snug text-ink-3">{t('shell.inspector.stats.scope')}</p>
        <dl className="flex flex-col gap-2.5">
          {metrics.map((m) => (
            <div key={m}>
              <dt className="text-xs font-medium text-ink-1">{t(`shell.inspector.stats.${m}`)}</dt>
              <dd className="mt-0.5 text-2xs leading-snug text-ink-3">{t(`shell.inspector.stats.${m}Def`)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
