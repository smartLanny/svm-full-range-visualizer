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
  liftText,
  NOMINAL_WHITE_ERROR,
  uniformityViews,
  whiteFieldContext,
  type GammaReadout,
  type UniformityView,
} from '../lib/uniformity';
import { KV, Loading, Missing, More, SectionCard, SlotKey, STATUS_TEXT, Toggle, Pills } from '../components/ui';
import { cn } from '../../../src/ui/cn';
import { useMedia } from '../lib/useWidth';

type MapKind = 'luminance' | 'colorTemperature';
type CondId = (typeof CONDITION_ORDER)[number];

const CONDITION_LABEL: Record<CondId, string> = { '300': '300 nits 白场', '100': '100 nits G20', '10': '10 nits G20' };

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
          {g20 && readout ? (
            <div className="mt-1.5 border-t border-white/15 pt-1.5 text-[10px] leading-[14px] text-white/75">
              <div className="whitespace-nowrap">
                Gamma 2.2 参考 <span className="tabular-nums text-white">{fmtSig(readout.ref)}</span>
              </div>
              <div className="whitespace-nowrap font-semibold text-white">{liftText(readout.lift)}</div>
            </div>
          ) : !g20 ? (
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

/** Measured / reference gauge: 70–140 %, reference at 100 %, the ±10 % setting error shaded. */
function LiftGauge({ readout }: { readout: GammaReadout }) {
  const lo = 70;
  const hi = 140;
  const pct = (1 + readout.lift) * 100;
  const pos = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const err = readout.basis === 'nominal' ? NOMINAL_WHITE_ERROR * 100 : 0;
  return (
    <div className="mt-4" aria-label={`实测为参考的 ${fmtFixed(pct, 1)} %`}>
      <div className="relative h-2 rounded-full bg-surface-3">
        {err > 0 && (
          <div className="absolute inset-y-0 rounded-full bg-white/[0.09]" style={{ left: pos(100 - err), right: `calc(100% - ${pos(100 + err)})` }} />
        )}
        <div className="absolute -top-1 h-4 w-px bg-ink-3" style={{ left: pos(100) }} />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-1 ring-[3px] ring-surface-1"
          style={{ left: pos(pct) }}
          title={`实测 / 参考 = ${fmtFixed(pct, 1)} %`}
        />
      </div>
      <div className="relative mt-2 h-3 text-[10px] tabular-nums text-ink-4">
        {[70, 85, 100, 115, 130].map((v) => (
          <span key={v} className={cn('absolute', v === lo ? '' : '-translate-x-1/2', v === 100 && 'text-ink-2')} style={{ left: pos(v) }}>
            {v === 100 ? '参考' : `${v}%`}
          </span>
        ))}
      </div>
    </div>
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
      <div
        className={cn('font-semibold leading-none tracking-tight text-ink-1', compact ? 'mt-2 text-[52px]' : 'mt-2 text-[64px] sm:text-[76px]')}
        data-testid="area-uniformity"
      >
        {fmtFixed(lum.areaUniformityPct, 1)}
        <span className={cn('ml-1 font-medium text-ink-3', compact ? 'text-2xl' : 'text-3xl')}>%</span>
      </div>
      <div className="mt-2 text-xs text-ink-3">
        {CONDITION_LABEL[cond.id as CondId] ?? cond.label} · {cond.pattern === 'G20' ? 'G20 全屏灰阶测试图' : '全白测试图'}
      </div>

      {readout ? (
        <div className="mt-6 rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="text-[13px] font-medium text-ink-1">对照 Gamma 2.2 参考亮度</div>
            <div className="text-[13px] font-semibold tabular-nums text-ink-1">{fmtSignedPct(readout.lift)}</div>
          </div>
          <div className="mt-1.5 text-xs leading-5 text-ink-3">
            实测典型 <span className="tabular-nums text-ink-2">{fmtSig(lum.typical)} nits</span>，参考{' '}
            <span className="tabular-nums text-ink-2">{fmtSig(readout.ref)} nits</span> = {readout.basis === 'nominal' ? readout.white : fmtSig(readout.white)}{' '}
            nits × (20/255)<sup>2.2</sup>
          </div>
          <LiftGauge readout={readout} />
          {readout.flag ? (
            <div className="mt-3 inline-flex items-center rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
              {FLAG_TEXT[readout.flag]}
            </div>
          ) : null}
          {readout.basis === 'nominal' && (
            <div className="mt-3 text-xs leading-5 text-ink-3" data-testid="white-not-measured">
              <span className="text-ink-2">白场未实测，约 ±10%</span>：参考按设定的 {readout.white} nits 白场计算。
              {white && (
                <>
                  {' '}
                  同机 {white.set} nits 白场实测 {fmtSig(white.typical)} nits，为设定的 {fmtFixed(white.ratio * 100, 1)} %。
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl bg-surface-2/70 p-4 text-xs leading-5 text-ink-3 ring-1 ring-inset ring-line">
          白场实测 <span className="tabular-nums text-ink-1">{fmtSig(lum.typical)} nits</span>，设定 {cond.referenceNits} nits（实测为设定的{' '}
          <span className="tabular-nums text-ink-2">{fmtFixed((lum.typical / cond.referenceNits) * 100, 1)} %</span>）。
        </div>
      )}

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
            ...(readout ? ([['等效 gamma（γ_eff）', fmtFixed(readout.gammaEff, 3)]] as [string, string][]) : []),
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
                  典型 {fmtSig(lum.typical)} nits{r ? ` · 参考 ${fmtSignedPct(r.lift)}` : ''}
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
        <Pills label="测试条件" value={condNow} onChange={setCond} options={available.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} />
        <Toggle
          label="热力图类型"
          value={kindNow}
          onChange={setKind}
          options={[
            { value: 'luminance', label: '亮度' },
            { value: 'colorTemperature', label: '色温', disabled: !cctAvailable, title: cctAvailable ? undefined : '此档未测色温' },
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
      )}
    </SectionCard>
  );
}
