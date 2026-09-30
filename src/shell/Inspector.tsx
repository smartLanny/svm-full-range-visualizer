import React, { useEffect, useMemo, useRef } from 'react';
import {
  ArrowUpDown,
  Box,
  Camera,
  ChevronDown,
  Clapperboard,
  Crosshair,
  Eye,
  EyeOff,
  Info,
  LayoutGrid,
  Layers,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Ruler,
  SlidersHorizontal,
  Sigma,
  ScanLine,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { fillPanelIds, nextPanelCandidate, selectComparePanelIds, useAppStore, type AnimTab, type Overlays } from '../store/appStore';
import { useLang, useT } from '../i18n';
import { deviceLabel, modeLabel, recordLabel } from '../data/records';
import { fmtLevel, sweepParam } from '../chart2d/slices';
import { useActiveTimeline } from '../timeline/timeline';
import { colormapGradientCss } from '../colormaps';
import {
  ColormapType,
  MAX_COMPARE_PANELS,
  PANEL_LETTERS,
  type AxisMode,
  type LightingMode,
  type PanelLetter,
  type Representation,
  type SceneLayout,
  type SliceMode,
  type SvmRecord,
  type ViewPreset,
} from '../types';
import { Button, Field, Kbd, Section, Segmented, Select, Slider, Switch, cn } from '../ui';
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

/**
 * What the view's animation shows. Playing is done from the header's tab-specific button (or
 * Space), so the inspector no longer repeats a third play button.
 */
function AnimationInfo({ tab, hint }: { tab: AnimTab; hint: string }) {
  const t = useT();
  const animating = useAppStore((s) => s.animating[tab]);
  return (
    <>
      <p className="text-2xs leading-snug text-ink-2">{hint}</p>
      <p className="-mt-1.5 flex flex-wrap items-center gap-1 text-2xs leading-snug text-ink-3" data-testid={`inspector-anim-${tab}`}>
        {animating ? (
          <span className="inline-flex items-center gap-1.5 text-accent-hover">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            {t('shell.inspector.playing')}
          </span>
        ) : (
          <>
            <Kbd>{t('shell.shortcuts.spaceKey')}</Kbd>
            {t('shell.inspector.playHowTo')}
          </>
        )}
      </p>
    </>
  );
}

/**
 * Record picker of a panel (A, B, side-by-side C–F): grouped by device, and the closed control shows device and mode on two
 * lines so records of one device (which differ only at the end of the mode) stay distinguishable.
 * A transparent native <select> on top keeps keyboard and screen-reader behaviour.
 */
function RecordSelect({
  role,
  value,
  onChange,
  records,
  placeholder,
}: {
  role: PanelLetter;
  value: string | null;
  onChange: (id: string) => void;
  records: SvmRecord[];
  placeholder: string;
}) {
  const lang = useLang();
  const rec = records.find((r) => r.id === value) ?? null;
  const options = useMemo(
    () =>
      records.map((r) => ({
        value: r.id,
        label: modeLabel(r, lang) || deviceLabel(r, lang),
        group: deviceLabel(r, lang),
      })),
    [records, lang],
  );
  const full = rec ? recordLabel(rec, lang) : placeholder;
  return (
    <div className="group relative min-w-0 flex-1" title={full} data-testid={`record-select-${role}`}>
      <div
        aria-hidden="true"
        className="pointer-events-none flex h-9 min-w-0 flex-col justify-center rounded-md bg-surface-3 pl-2 pr-7 ring-1 ring-inset ring-line transition-colors group-hover:bg-surface-4 group-focus-within:ring-2 group-focus-within:ring-accent-ring"
      >
        {rec ? (
          <>
            <span className="truncate text-[10px] leading-3 text-ink-3">{deviceLabel(rec, lang)}</span>
            <span className="truncate text-xs leading-4 text-ink-1">{modeLabel(rec, lang) || deviceLabel(rec, lang)}</span>
          </>
        ) : (
          <span className="truncate text-xs text-ink-4">{placeholder}</span>
        )}
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3" />
      </div>
      <Select<string>
        aria-label={`${role} · ${full}`}
        className="!absolute inset-0 opacity-0 [&_select]:h-9 [&_select]:cursor-pointer"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={onChange}
        options={options}
      />
    </div>
  );
}

function RoleTag({ role }: { role: PanelLetter }) {
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

/**
 * Side-by-side panels C–F (docs/adr/0002): a picker and a remove button per extra panel, under the
 * A / B pickers. A record picked that is already in another panel swaps with it (setComparePanel).
 */
function ComparePanelRows() {
  const t = useT();
  const records = useAppStore((st) => st.records);
  const extras = useAppStore((st) => st.compareExtraIds);
  const { removeComparePanel, setComparePanel } = useAppStore.getState();
  return (
    <>
      {extras.map((id, i) => {
        const role = PANEL_LETTERS[i + 2];
        return (
          // Same columns as the A / B rows (the remove button sits in the swap button's column).
          <div key={role} className="flex items-center gap-1.5" data-testid={`compare-panel-${role}`}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <RoleTag role={role} />
              <RecordSelect role={role} value={id} onChange={(v) => setComparePanel(i + 2, v)} records={records} placeholder={t('shell.inspector.scene3d.pickPanel', { p: role })} />
            </div>
            <IconButton
              size="sm"
              label={t('shell.inspector.scene3d.removePanel', { p: role })}
              icon={<X size={14} />}
              data-testid={`remove-panel-${role}`}
              onClick={() => removeComparePanel(id)}
            />
          </div>
        );
      })}
    </>
  );
}

/** "Add record" (up to six panels), a quick fill with the visible records, and the panel count. */
function ComparePanelActions() {
  const t = useT();
  const records = useAppStore((st) => st.records);
  const panels = useAppStore(useShallow(selectComparePanelIds));
  const hiddenIds = useAppStore((st) => st.hiddenIds);
  const { addComparePanel, setComparePanels } = useAppStore.getState();
  const next = useMemo(() => nextPanelCandidate({ records, hiddenIds }, panels), [records, hiddenIds, panels]);
  const visible = useMemo(() => records.filter((r) => !hiddenIds.includes(r.id)).map((r) => r.id), [records, hiddenIds]);
  const filled = useMemo(() => fillPanelIds(panels, visible), [panels, visible]);
  const full = panels.length >= MAX_COMPARE_PANELS;
  const fillSame = filled.length === panels.length && filled.every((id, i) => id === panels[i]);
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          disabled={full || !next}
          title={full ? t('shell.inspector.scene3d.panelsFull') : undefined}
          onClick={() => next && addComparePanel(next)}
          data-testid="add-panel"
        >
          {t('shell.inspector.scene3d.addPanel')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<LayoutGrid size={13} />}
          disabled={fillSame}
          title={t('shell.inspector.scene3d.fillVisibleHint')}
          onClick={() => setComparePanels(filled)}
          data-testid="fill-panels"
        >
          {t('shell.inspector.scene3d.fillVisible')}
        </Button>
      </div>
      <p className="-mt-1 text-2xs leading-snug text-ink-3" data-testid="compare-count">
        {t('shell.inspector.scene3d.panelsHint', { n: panels.length, max: MAX_COMPARE_PANELS })}
      </p>
    </>
  );
}

/** Mini color bar for a colormap (SVM 0 → colorMax), with the 0.4 / 1.0 thresholds marked. */
function ColormapPreview({ type, max, disabled }: { type: ColormapType; max: number; disabled?: boolean }) {
  // The map spans 0 → max whatever max is: only the tick positions depend on it.
  const gradient = useMemo(() => colormapGradientCss(type, 32), [type]);
  const ticks = [0, 0.4, 1, ...[2, 3, 4, 5, 6, 7, 8].filter((v) => v < max - 0.35), max];
  const fmt = (v: number) => (v === max ? `${Number(v.toFixed(1))}+` : String(v));
  return (
    <div className={cn('select-none', disabled && 'opacity-40')} aria-hidden="true">
      <div className="relative h-2.5 rounded-sm ring-1 ring-inset ring-white/10" style={{ background: gradient }}>
        {[0.4, 1].map((v) => (
          <span key={v} className="absolute -bottom-0.5 -top-0.5 w-px bg-white/70" style={{ left: `${(v / max) * 100}%` }} />
        ))}
      </div>
      <div className="relative mt-1 h-3 font-mono text-[10px] text-ink-3">
        {ticks.map((v) => (
          <span
            key={v}
            className="absolute -translate-x-1/2"
            style={{
              left: `${(v / max) * 100}%`,
              transform: v === 0 ? 'none' : v === max ? 'translateX(-100%)' : undefined,
              // 0.4 and 1 crowd each other on a wide scale: keep 1 only.
              display: v === 0.4 && max > 5 ? 'none' : undefined,
            }}
          >
            {fmt(v)}
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
      colorMax: st.colorMax,
      overlays: st.overlays,
      activeId: st.activeId,
      compareId: st.compareId,
    })),
  );
  const records = useAppStore((st) => st.records);
  const { set, setOverlay, setActive, setCompare } = useAppStore.getState();
  const twoPlus = records.length >= 2;
  const showB = s.layout !== 'single';
  const diff = s.layout === 'diff';
  const overlayKeys: (keyof Overlays)[] = ['contours', 'values', 'axes', 'colorbar', 'title'];
  const overlayHints: Partial<Record<keyof Overlays, string>> = {
    // Diff contours are ± ΔSVM levels whose spacing follows the diverging color range.
    contours: t(diff ? 'shell.inspector.scene3d.contoursHintDiff' : 'shell.inspector.scene3d.contoursHint'),
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
        {/* A / B (+ side-by-side C–F): one column of pickers, 6 px apart. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-stretch gap-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <RoleTag role="A" />
                {records.length > 0 ? (
                  <RecordSelect role="A" value={s.activeId} onChange={setActive} records={records} placeholder={t('shell.inspector.scene3d.pickA')} />
                ) : (
                  <span className="text-xs text-ink-4">{t('common.none')}</span>
                )}
              </div>
              {showB && (
                <div className="flex items-center gap-2">
                  <RoleTag role="B" />
                  <RecordSelect role="B" value={s.compareId} onChange={setCompare} records={records} placeholder={t('shell.inspector.scene3d.pickB')} />
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
          {s.layout === 'sideBySide' && <ComparePanelRows />}
        </div>
        {s.layout === 'sideBySide' && <ComparePanelActions />}
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
        <ColormapPreview type={s.colormap} max={s.colorMax} disabled={diff} />
        <div>
          <Slider
            label={t('shell.inspector.scene3d.colorMax')}
            value={s.colorMax}
            min={2}
            max={8}
            step={0.5}
            disabled={diff}
            format={(v) => `SVM ${v.toFixed(1)}`}
            onChange={(v) => set('colorMax', Math.round(v * 2) / 2)}
            presets={[
              { value: 3, label: '3' },
              { value: 4, label: '4' },
              { value: 6, label: '6' },
            ]}
          />
          <p className="mt-1 text-2xs leading-snug text-ink-3">{t('shell.inspector.scene3d.colorMaxHint')}</p>
        </div>
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
            format={(v) => (diff ? `ΔSVM ±${v.toFixed(1)}` : `SVM ${v.toFixed(1)}`)}
            onChange={(v) => set('heightCap', Math.round(v * 2) / 2)}
          />
          <p className="mt-1 text-2xs leading-snug text-ink-3">{t(diff ? 'shell.inspector.scene3d.heightCapHintDiff' : 'shell.inspector.scene3d.heightCapHint')}</p>
        </div>
      </Section>

      <Section title={t('shell.inspector.scene3d.range')} icon={<Ruler size={12} />}>
        <DataRangeControls />
      </Section>

      <Section title={t('shell.inspector.scene3d.animation')} icon={<Clapperboard size={12} />}>
        <AnimationInfo tab="scene3d" hint={t('shell.inspector.scene3d.intro')} />
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
  const sweeping = useAppStore((st) => st.animating.chart2d);
  const { set, setHidden } = useAppStore.getState();
  const allIds = () => useAppStore.getState().records.map((r) => r.id);
  const gray = s.sliceMode === 'gray';
  const axisHint: Record<AxisMode, string> = {
    // The standard x range depends on the slice: measured nits (gray slice) or gray 0–255.
    standard: t(gray ? 'shell.inspector.chart2d.standardHint' : 'shell.inspector.chart2d.standardHintBrightness'),
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
        {sweeping ? (
          <SweepReadout mode={s.sliceMode} />
        ) : s.sliceMode === 'gray' ? (
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
        <AnimationInfo tab="chart2d" hint={t(gray ? 'shell.inspector.chart2d.sweepHint' : 'shell.inspector.chart2d.sweepHintLevel')} />
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

/**
 * The slice slider while the 2D sweep plays: disabled, showing the swept value live (the chart's
 * title value), so it is clear what is on screen. Written straight to the DOM from the timeline's
 * clock — no React state per frame. The slider comes back with the setting when the sweep ends.
 */
function SweepReadout({ mode }: { mode: SliceMode }) {
  const t = useT();
  const tl = useActiveTimeline();
  const valueRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [lo, hi] = mode === 'gray' ? [0, 255] : [2, 500];
  const toPos = (v: number) => (mode === 'gray' ? ((v - lo) / (hi - lo)) * 1000 : (Math.log(v / lo) / Math.log(hi / lo)) * 1000);
  const text = (v: number) => (mode === 'gray' ? `G${Math.round(v)}` : `${fmtLevel(v)} nits`);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const frame = () => {
      const v = sweepParam(mode, tl ? tl.time : 0);
      const label = text(v);
      if (label !== last) {
        last = label;
        if (valueRef.current) valueRef.current.textContent = label;
        const pos = Math.max(0, Math.min(1000, toPos(v)));
        if (inputRef.current) {
          inputRef.current.value = String(pos);
          inputRef.current.style.setProperty('--pos', `${pos / 10}%`);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl, mode]);
  return (
    <div className="flex flex-col gap-1.5" data-testid="sweep-readout">
      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-2">{t(mode === 'gray' ? 'shell.inspector.chart2d.gray' : 'shell.inspector.chart2d.level')}</span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-accent-muted px-1 text-2xs text-accent-hover">{t('shell.inspector.chart2d.sweeping')}</span>
          <span ref={valueRef} className="font-mono tabular-nums text-ink-1" />
        </span>
      </div>
      <input ref={inputRef} type="range" min={0} max={1000} disabled aria-label={t('shell.inspector.chart2d.sweeping')} className="svm-range w-full" />
      <p className="text-2xs leading-snug text-ink-3">{t('shell.inspector.chart2d.sweepLocked')}</p>
    </div>
  );
}

function InspectorStats() {
  const t = useT();
  const metrics = ['safeShare', 'criticalShare', 'whitePass', 'typical', 'peak', 'mean', 'coverage'];
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
