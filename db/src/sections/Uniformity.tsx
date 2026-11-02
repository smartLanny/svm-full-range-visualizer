import React, { useMemo, useState } from 'react';
import type { Device } from '../../catalog/types';
import type { UniformityIndex, UniformityMapInfo } from '../lib/types';
import { loadUniformity, uniformityAsset, useAsync } from '../lib/data';
import { fmtFixed, fmtSig, fmtSignedPct } from '../lib/format';
import {
  barPosition,
  CONDITION_ORDER,
  FLAG_TEXT,
  gammaReadout,
  uniformityViews,
  whiteFieldContext,
  type GammaReadout,
  type UniformityView,
} from '../lib/uniformity';
import { KV, Loading, Missing, More, SectionCard, SlotKey, STATUS_TEXT, Toggle, Pills } from '../components/ui';
import { cn } from '../../../src/ui/cn';
import { useMedia } from '../lib/useWidth';
import { rankHref } from '../lib/route';

type MapKind = 'luminance' | 'colorTemperature';
type CondId = (typeof CONDITION_ORDER)[number];

const CONDITION_LABEL: Record<CondId, string> = {
  '300': '300 nits 白场',
  '100': '100 nits G20',
  '10': '10 nits G20',
};

function gradientCss(stops: UniformityIndex['colorStops']): string {
  return `linear-gradient(to top, ${stops.map(([p, [r, g, b]]) => `rgb(${r},${g},${b}) ${(p * 100).toFixed(1)}%`).join(', ')})`;
}

/**
 * Vertical colour bar of a heatmap. The PNG colours are linear in "% of this device's typical
 * luminance" (or K offset from its typical colour temperature) between the scale ends stored in
 * the index; the labels give both the relative value and the device's absolute value, plus the
 * typical (100 %) and, for G20, where the Gamma 2.2 reference falls on the same scale.
 */
function ColorBar({
  map,
  kind,
  typical,
  readout,
  stops,
  height,
}: {
  map: UniformityMapInfo;
  kind: MapKind;
  typical: number;
  readout: GammaReadout | null;
  stops: UniformityIndex['colorStops'];
  height: number;
}) {
  const lum = kind === 'luminance';
  const min = lum ? map.scale.minPercentOfTypical : map.scale.minOffsetFromTypicalK;
  const max = lum ? map.scale.maxPercentOfTypical : map.scale.maxOffsetFromTypicalK;
  if (min === undefined || max === undefined) return null;
  const zero = lum ? 100 : 0;
  const typPos = barPosition(zero, min, max);
  const refPct = lum && readout ? (readout.ref / typical) * 100 : null;
  const refPos = refPct !== null ? barPosition(refPct, min, max) : null;
  const barH = height;
  const close = typPos !== null && refPos !== null && Math.abs(typPos - refPos) * barH < 30;

  const endLabel = (v: number) =>
    lum ? (
      <>
        <span className="text-ink-2">{fmtFixed(v, 0)} %</span>
        <span className="block text-ink-4">{fmtSig((typical * v) / 100, 3)} nits</span>
      </>
    ) : (
      <>
        <span className="text-ink-2">
          {v > 0 ? '+' : ''}
          {fmtFixed(v, 0)} K
        </span>
        <span className="block text-ink-4">{fmtFixed(typical + v, 0)} K</span>
      </>
    );

  return (
    <div className="relative shrink-0 text-[10px] leading-3 tabular-nums" style={{ height: barH, width: 78 }} aria-label="色阶">
      <div className="absolute left-0 top-0 w-2.5 rounded-full ring-1 ring-inset ring-white/10" style={{ height: barH, background: gradientCss(stops) }} />
      <div className="absolute left-4 top-0">{endLabel(max)}</div>
      <div className="absolute bottom-0 left-4">{endLabel(min)}</div>
      {typPos !== null && (
        <div className="absolute left-0 flex items-center" style={{ bottom: `calc(${typPos * 100}% - 0.5px)` }}>
          <span className="h-px w-3.5 bg-white" />
          <span className="ml-1 -translate-y-px whitespace-nowrap font-medium text-ink-1">{close ? '典型≈参考' : '典型'}</span>
        </div>
      )}
      {refPos !== null && !close && (
        <div className="absolute left-0 flex items-center" style={{ bottom: `calc(${refPos * 100}% - 0.5px)` }}>
          <span className="h-0 w-3.5 border-t border-dashed border-white/80" />
          <span className="ml-1 -translate-y-px whitespace-nowrap text-ink-2">参考</span>
        </div>
      )}
      {refPct !== null && refPos === null && (
        <div className="absolute left-4 whitespace-nowrap text-ink-3" style={refPct < (min ?? 0) ? { bottom: 26 } : { top: 26 }}>
          参考 {fmtFixed(refPct, 0)} %{refPct < (min ?? 0) ? ' ↓' : ' ↑'}
        </div>
      )}
    </div>
  );
}

/**
 * The heatmap with the typical luminance (and the Gamma 2.2 reference) printed on it. A metrics-only
 * condition (numbers imported without a heatmap) gets an empty phone outline with the same read-out:
 * nothing is drawn that was not measured.
 */
function Heatmap({
  view,
  kind,
  stops,
  height,
  deviceName,
}: {
  view: UniformityView;
  kind: MapKind;
  stops: UniformityIndex['colorStops'];
  height: number;
  deviceName: string;
}) {
  const { cond } = view;
  const map = cond.maps?.[kind] ?? cond.maps?.luminance;
  const shownKind: MapKind = cond.maps?.[kind] ? kind : 'luminance';
  const lum = cond.metrics.luminance!;
  const cct = cond.metrics.colorTemperature;
  const readout = gammaReadout(cond, lum.typical);
  const [w, h] = map?.displayResolution ?? [670, 1440];
  const typicalForBar = shownKind === 'luminance' ? lum.typical : (cct?.typical ?? 0);
  const g20 = cond.pattern === 'G20';

  return (
    <figure className="flex items-start gap-3 sm:gap-4">
      <div className="relative shrink-0" style={{ height, width: Math.round((height * w) / h) }}>
        {map ? (
          <img
            src={uniformityAsset(map.asset)}
            alt={`${deviceName} ${CONDITION_LABEL[cond.id as CondId] ?? cond.label} ${shownKind === 'luminance' ? '亮度' : '色温'}热力图`}
            className="h-full w-full select-none object-contain drop-shadow-[0_24px_48px_rgba(0,0,0,0.55)]"
            draggable={false}
            decoding="async"
          />
        ) : (
          <div
            className="flex h-full w-full flex-col items-center rounded-[13%/6%] border border-dashed border-line-strong bg-surface-2/40 px-4 pt-[18%] text-center"
            data-testid="no-heatmap"
          >
            <div className="text-[13px] font-medium text-ink-2">仅指标</div>
            <div className="mt-1 text-[11px] leading-4 text-ink-3">这一档只导入了数值，没有热力图</div>
          </div>
        )}
        {/* Typical luminance on the visual itself: the colours only show the shape relative to it. */}
        <div
          className="absolute inset-x-[7%] bottom-[7%] rounded-2xl bg-black/60 px-2.5 py-2.5 text-center ring-1 ring-inset ring-white/15 backdrop-blur-md"
          data-testid="typical-overlay"
        >
          <div className="text-[10px] font-medium tracking-wide text-white/70">典型亮度</div>
          <div className="mt-0.5 whitespace-nowrap text-[19px] font-semibold leading-6 tracking-tight text-white tabular-nums">
            {fmtSig(lum.typical)}
            <span className="ml-1 text-[11px] font-medium text-white/70">nits</span>
          </div>
          {!g20 ? (
            <div className="mt-1 whitespace-nowrap text-[10px] leading-[14px] text-white/75">
              设定 {cond.referenceNits} nits · 实测 {fmtFixed((lum.typical / cond.referenceNits) * 100, 1)} %
            </div>
          ) : null}
          {shownKind === 'colorTemperature' && cct && (
            <div className="mt-1.5 whitespace-nowrap border-t border-white/15 pt-1.5 text-[10px] leading-[14px] text-white/75">
              典型色温 <span className="tabular-nums text-white">{fmtFixed(cct.typical, 0)} K</span>
            </div>
          )}
        </div>
      </div>
      {map && (
        <ColorBar map={map} kind={shownKind} typical={typicalForBar} readout={shownKind === 'luminance' ? readout : null} stops={stops} height={height} />
      )}
    </figure>
  );
}

function Metrics({ view, views, kind, compact }: { view: UniformityView; views: UniformityView[]; kind: MapKind; compact: boolean }) {
  const { cond } = view;
  const lum = cond.metrics.luminance!;
  const cct = cond.metrics.colorTemperature;
  const readout = gammaReadout(cond, lum.typical);
  const white = whiteFieldContext(views);
  const map = cond.maps?.[kind] ?? cond.maps?.luminance;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="text-[13px] text-ink-2">面均匀性</div>
      <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div
          className={cn('font-semibold leading-none tracking-tight text-ink-1', compact ? 'text-[52px]' : 'text-[64px] sm:text-[76px]')}
          data-testid="area-uniformity"
        >
          {fmtFixed(lum.areaUniformityPct, 1)}
          <span className={cn('ml-1 font-medium text-ink-3', compact ? 'text-2xl' : 'text-3xl')}>%</span>
        </div>
        {readout && (
          <div className="mb-1 flex flex-wrap items-center gap-2" data-testid="reference-nits">
            <span
              className="inline-flex items-baseline gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs text-ink-3 ring-1 ring-inset ring-line"
              title={`Gamma 2.2 参考 = ${readout.basis === 'nominal' ? readout.white : fmtSig(readout.white)} nits × (20/255)^2.2${readout.basis === 'nominal' ? '；白场未实测，约 ±10%' : ''}`}
            >
              参考亮度
              <span className="font-semibold tabular-nums text-ink-1">{fmtSig(readout.ref)}</span>
              nits
            </span>
            {readout.flag && (
              <span className="inline-flex items-center rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
                {FLAG_TEXT[readout.flag]}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="mt-3 text-xs text-ink-3">
        {CONDITION_LABEL[cond.id as CondId] ?? cond.label} · {cond.pattern === 'G20' ? 'G20 全屏灰阶测试图' : '全白测试图'}
        {cond.pattern !== 'G20' && (
          <>
            {' '}
            · 实测为设定的 <span className="tabular-nums text-ink-2">{fmtFixed((lum.typical / cond.referenceNits) * 100, 1)} %</span>
          </>
        )}
      </div>

      <p className="mt-4 text-xs leading-5 text-ink-3">
        {!map
          ? '这台机型的均匀度只导入了指标数值（仅指标），没有热力图，所以看不到亮度分布的形状。'
          : kind === 'colorTemperature' && cond.maps?.colorTemperature && cct
            ? `色温图的颜色相对本机典型色温（${fmtFixed(cct.typical, 0)} K），只表示分布形状。`
            : `热力图颜色相对本机典型亮度（100 % = ${fmtSig(lum.typical)} nits），只表示亮度分布的形状；整体偏亮还是偏暗，看图上的典型亮度。`}
      </p>

      <More title="更多指标" className="mt-4">
        <KV
          rows={[
            ['9 点均匀性', `${fmtFixed(lum.ninePointUniformityPct, 1)} %`],
            ['偏离典型值 >10 % 的面积', `${fmtFixed(lum.deviation10PctArea, 2)} %`],
            ['典型亮度', `${fmtSig(lum.typical, 6)} nits`],
            ...(readout
              ? ([
                  ['参考亮度（Gamma 2.2）', `${fmtSig(readout.ref)} nits`],
                  ['典型 / 参考', fmtSignedPct(readout.lift)],
                  ['等效 gamma（γ_eff）', fmtFixed(readout.gammaEff, 3)],
                ] as [string, string][])
              : []),
            ...(cct
              ? ([
                  ['典型色温', `${fmtFixed(cct.typical, 0)} K`],
                  ['面色温差', `${fmtFixed(cct.areaSpreadK, 0)} K`],
                  ['9 点色温差', `${fmtFixed(cct.ninePointSpreadK, 0)} K`],
                ] as [string, string][])
              : ([['色温', '此档未测']] as [string, string][])),
            ...(map?.measurementResolution ? ([['测量分辨率', map.measurementResolution.join(' × ')]] as [string, string][]) : []),
          ]}
        />
        {readout && (
          <div className="mt-3 text-[11px] leading-4 text-ink-4" data-testid="white-not-measured">
            参考亮度 = {readout.basis === 'nominal' ? readout.white : fmtSig(readout.white)} nits × (20/255)<sup>2.2</sup>。
            {readout.basis === 'nominal' && (
              <>
                白场未实测，按设定值计算，约 ±10%
                {white && `（同机 ${white.set} nits 白场实测为设定的 ${fmtFixed(white.ratio * 100, 1)} %）`}。
              </>
            )}
          </div>
        )}
        {map?.measurementSource && <div className="mt-3 break-all text-[11px] leading-4 text-ink-4">源文件：{map.measurementSource}</div>}
        {view.entry.stateBasis === 'convention' && (
          <div className="mt-2 text-[11px] leading-4 text-ink-4">测量状态：源数据未标注，按常规记为默认（待确认）。</div>
        )}
      </More>
    </div>
  );
}

/** All conditions of the device at a glance (desktop): area uniformity, typical, lift. Click = select. */
function ConditionList({ views, current, onPick }: { views: UniformityView[]; current: CondId; onPick: (c: CondId) => void }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-ink-2">三档面均匀性</div>
      <div className="mt-3 flex flex-col gap-2">
        {CONDITION_ORDER.map((c) => {
          const v = views.find((x) => x.cond.id === c);
          const lum = v?.cond.metrics.luminance;
          const r = v && lum ? gammaReadout(v.cond, lum.typical) : null;
          const on = c === current;
          return (
            <button
              key={c}
              type="button"
              disabled={!lum}
              onClick={() => onPick(c)}
              className={cn(
                'rounded-2xl px-4 py-3 text-left ring-1 ring-inset transition-colors',
                on ? 'bg-surface-3 ring-line-strong' : 'ring-line hover:bg-surface-2',
                !lum && 'cursor-default opacity-50 hover:bg-transparent',
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('text-xs', on ? 'text-ink-1' : 'text-ink-3')}>{CONDITION_LABEL[c]}</span>
                <span className="text-[17px] font-semibold tabular-nums text-ink-1">{lum ? `${fmtFixed(lum.areaUniformityPct, 1)} %` : '未测'}</span>
              </div>
              {lum && (
                <div className="mt-1 text-[11px] tabular-nums text-ink-3">
                  典型 {fmtSig(lum.typical)}
                  {r ? ` · 参考 ${fmtSig(r.ref)}` : ''} nits
                </div>
              )}
              {lum && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-4">
                  <div className="h-full rounded-full bg-ink-2" style={{ width: `${lum.areaUniformityPct}%` }} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DevicePanel({
  device,
  index,
  cond,
  kind,
  compact,
  slot,
  onPick,
}: {
  device: Device;
  index: UniformityIndex;
  cond: CondId;
  kind: MapKind;
  compact: boolean;
  slot: 0 | 1 | null;
  onPick: (c: CondId) => void;
}) {
  const wide = useMedia('(min-width: 768px)');
  const views = uniformityViews(device, index);
  const view = views.find((v) => v.cond.id === cond);
  const a = device.availability.uniformity;
  const header = slot !== null && <SlotKey slot={slot} name={device.name.zh} className="mb-5" />;
  if (!views.length)
    return (
      <div className="min-w-0">
        {header}
        <Missing
          text={`均匀度${STATUS_TEXT[a.status]}`}
          detail={a.note ?? (a.status === 'pending-import' ? '源数据已测量，数值还没导入本库。' : '本库没有这台机型的均匀度测量。')}
        />
      </div>
    );
  if (!view || !view.cond.metrics.luminance)
    return (
      <div className="min-w-0">
        {header}
        <Missing text={`${CONDITION_LABEL[cond]} 未测`} />
      </div>
    );
  const height = compact ? (wide ? 400 : 380) : wide ? 480 : 420;
  return (
    <div className="min-w-0">
      {header}
      <div
        className={cn(
          'grid gap-8',
          compact ? '2xl:grid-cols-[auto_minmax(0,1fr)]' : 'md:grid-cols-[auto_minmax(0,1fr)] md:gap-10 lg:gap-14 xl:grid-cols-[auto_minmax(0,1fr)_236px]',
        )}
      >
        <div className="flex justify-center md:justify-start">
          <Heatmap view={view} kind={kind} stops={index.colorStops} height={height} deviceName={device.name.zh} />
        </div>
        <Metrics view={view} views={views} kind={kind} compact={compact} />
        {!compact && (
          <div className="hidden xl:block">
            <ConditionList views={views} current={cond} onPick={onPick} />
          </div>
        )}
      </div>
    </div>
  );
}

type CompareRow = {
  label: string;
  get: (v: UniformityView) => number | null;
  fmt: (n: number) => string;
  better: 'high' | 'low' | null;
  diff?: (a: number, b: number) => string;
};

const COMPARE_ROWS: CompareRow[] = [
  {
    label: '面均匀性',
    get: (v) => v.cond.metrics.luminance?.areaUniformityPct ?? null,
    fmt: (n) => `${fmtFixed(n, 1)} %`,
    better: 'high',
    diff: (a, b) => `${fmtSignedNum(a - b, 1)} pt`,
  },
  {
    label: '9 点均匀性',
    get: (v) => v.cond.metrics.luminance?.ninePointUniformityPct ?? null,
    fmt: (n) => `${fmtFixed(n, 1)} %`,
    better: 'high',
    diff: (a, b) => `${fmtSignedNum(a - b, 1)} pt`,
  },
  {
    label: '偏离 >10 % 面积',
    get: (v) => v.cond.metrics.luminance?.deviation10PctArea ?? null,
    fmt: (n) => `${fmtFixed(n, 2)} %`,
    better: 'low',
    diff: (a, b) => `${fmtSignedNum(a - b, 2)} pt`,
  },
  {
    label: '典型亮度',
    get: (v) => v.cond.metrics.luminance?.typical ?? null,
    fmt: (n) => `${fmtSig(n)} nits`,
    better: null,
  },
  {
    label: '参考亮度',
    get: (v) => (v.cond.metrics.luminance ? (gammaReadout(v.cond, v.cond.metrics.luminance.typical)?.ref ?? null) : null),
    fmt: (n) => `${fmtSig(n)} nits`,
    better: null,
  },
  {
    label: '面色温差',
    get: (v) => v.cond.metrics.colorTemperature?.areaSpreadK ?? null,
    fmt: (n) => `${fmtFixed(n, 0)} K`,
    better: 'low',
    diff: (a, b) => `${fmtSignedNum(a - b, 0)} K`,
  },
];

function fmtSignedNum(v: number, digits: number): string {
  const s = fmtFixed(Math.abs(v), digits);
  return Number(s) === 0 ? s : `${v < 0 ? '−' : '+'}${s}`;
}

/**
 * Compare page: the numbers of both devices for all three conditions in one table, the better value
 * of each pair in its slot colour, and A − B. Click a condition header to show its heatmaps below.
 */
function CompareTable({ devices, index, current, onPick }: { devices: Device[]; index: UniformityIndex; current: CondId; onPick: (c: CondId) => void }) {
  const [a, b] = devices;
  const va = uniformityViews(a, index);
  const vb = uniformityViews(b, index);
  if (!va.length && !vb.length) return null;
  let winsA = 0;
  let winsB = 0;
  const groups = CONDITION_ORDER.map((c) => {
    const x = va.find((v) => v.cond.id === c);
    const y = vb.find((v) => v.cond.id === c);
    const rows = COMPARE_ROWS.map((row) => {
      const p = x ? row.get(x) : null;
      const q = y ? row.get(y) : null;
      let win: 0 | 1 | null = null;
      if (row.better && p !== null && q !== null && row.fmt(p) !== row.fmt(q)) win = (row.better === 'high' ? p > q : p < q) ? 0 : 1;
      if (win === 0 && row.label === '面均匀性') winsA++;
      if (win === 1 && row.label === '面均匀性') winsB++;
      return { row, p, q, win };
    }).filter((r) => r.p !== null || r.q !== null);
    // Same reference on both sides (same white setting): say it once in the condition header.
    const ref = rows.find((r) => r.row.label === '参考亮度');
    const sharedRef = ref && ref.p !== null && ref.q !== null && ref.row.fmt(ref.p) === ref.row.fmt(ref.q) ? ref.p : null;
    return { c, rows: sharedRef !== null ? rows.filter((r) => r !== ref) : rows, sharedRef };
  }).filter((g) => g.rows.length > 0);

  const cell = (v: number | null, row: CompareRow, won: boolean, slot: 0 | 1) => (
    <td
      className={cn(
        'px-3 py-2 text-right tabular-nums',
        won ? (slot === 0 ? 'font-semibold text-slot-a' : 'font-semibold text-slot-b') : 'text-ink-1',
        v === null && 'text-ink-4',
      )}
    >
      {v === null ? '未测' : row.fmt(v)}
    </td>
  );

  return (
    <div className="mb-10 overflow-hidden rounded-2xl ring-1 ring-inset ring-line" data-testid="uniformity-compare-table">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line/70 bg-surface-2/60 px-4 py-3">
        <div className="text-[13px] font-medium text-ink-1">三档指标对比</div>
        <div className="text-xs text-ink-3">
          面均匀性更高：<span className="text-slot-a">{a.name.zh}</span> {winsA} 档 · <span className="text-slot-b">{b.name.zh}</span> {winsB} 档
        </div>
      </div>
      <div className="db-scroll-x">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="text-xs text-ink-3">
              <th className="px-4 py-2 text-left font-normal">指标</th>
              <th className="px-3 py-2 text-right font-normal">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-1 rounded-full bg-slot-a" aria-hidden />
                  <span className="max-w-[160px] truncate">{a.name.zh}</span>
                </span>
              </th>
              <th className="px-3 py-2 text-right font-normal">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-1 rounded-full bg-slot-b" aria-hidden />
                  <span className="max-w-[160px] truncate">{b.name.zh}</span>
                </span>
              </th>
              <th className="px-4 py-2 text-right font-normal">A − B</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.c} className={cn(g.c === current && 'bg-surface-2/40')}>
              <tr>
                <th colSpan={4} className="border-t border-line/70 px-4 pb-1 pt-3 text-left">
                  <button
                    type="button"
                    onClick={() => onPick(g.c)}
                    className={cn('text-xs font-medium transition-colors', g.c === current ? 'text-ink-1' : 'text-ink-3 hover:text-ink-1')}
                    aria-pressed={g.c === current}
                  >
                    {CONDITION_LABEL[g.c]}
                    {g.c === current ? ' · 下方热力图' : ' · 看热力图'}
                  </button>
                  {g.sharedRef !== null && <span className="ml-2 text-xs font-normal tabular-nums text-ink-3">参考亮度 {fmtSig(g.sharedRef)} nits</span>}
                </th>
              </tr>
              {g.rows.map(({ row, p, q, win }) => (
                <tr key={row.label} className="text-ink-2">
                  <td className="px-4 py-2 text-ink-3">{row.label}</td>
                  {cell(p, row, win === 0, 0)}
                  {cell(q, row, win === 1, 1)}
                  <td className="px-4 py-2 text-right tabular-nums text-ink-3">{row.diff && p !== null && q !== null ? row.diff(p, q) : ''}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <div className="border-t border-line/70 px-4 py-2.5 text-[11px] leading-4 text-ink-4">
        彩色数字为该项更好的一方（均匀性越高越好，偏离面积和色温差越低越好）；典型亮度和参考亮度只列数值，不比高低。
      </div>
    </div>
  );
}

export function UniformitySection({ devices, id }: { devices: Device[]; id?: string }) {
  const index = useAsync(loadUniformity, 'uniformity');
  const available = useMemo(
    () => CONDITION_ORDER.filter((c) => index.status === 'ready' && devices.some((d) => uniformityViews(d, index.data).some((v) => v.cond.id === c))),
    [index, devices],
  );
  const [cond, setCond] = useState<CondId>('300');
  const [kind, setKind] = useState<MapKind>('luminance');
  const condNow: CondId = available.includes(cond) ? cond : (available[0] ?? '300');
  const cctAvailable =
    index.status === 'ready' && devices.some((d) => uniformityViews(d, index.data).some((v) => v.cond.id === condNow && v.cond.maps?.colorTemperature));
  const kindNow: MapKind = cctAvailable ? kind : 'luminance';
  const compare = devices.length > 1;

  const controls =
    available.length > 0 ? (
      <>
        <a href={rankHref(condNow)} className="mr-1 text-xs text-ink-3 hover:text-ink-1 hover:underline">
          均匀度排行 →
        </a>
        <Pills
          label="测试条件"
          value={condNow}
          onChange={setCond}
          options={available.map((c) => ({
            value: c,
            label: CONDITION_LABEL[c],
          }))}
        />
        <Toggle
          label="热力图类型"
          value={kindNow}
          onChange={setKind}
          options={[
            { value: 'luminance', label: '亮度' },
            {
              value: 'colorTemperature',
              label: '色温',
              disabled: !cctAvailable,
              title: cctAvailable ? undefined : '此档未测色温',
            },
          ]}
        />
      </>
    ) : null;

  return (
    <SectionCard id={id} type="uniformity" controls={controls}>
      {index.status === 'loading' ? (
        <Loading className="h-[480px]" />
      ) : index.status === 'error' ? (
        <Missing text="均匀度数据加载失败" detail={index.error} />
      ) : (
        <>
          {compare && devices.length === 2 && <CompareTable devices={devices} index={index.data} current={condNow} onPick={setCond} />}
          <div className={cn(compare && 'grid gap-10 lg:grid-cols-2 lg:gap-8')}>
            {devices.map((d, i) => (
              <DevicePanel
                key={d.id}
                device={d}
                index={index.data}
                cond={condNow}
                kind={kindNow}
                compact={compare}
                slot={compare ? (i as 0 | 1) : null}
                onPick={setCond}
              />
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}
