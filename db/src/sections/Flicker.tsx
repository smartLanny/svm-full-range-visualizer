import React, { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import type { Device } from '../../catalog/types';
import type { SvmRecord } from '../../../src/types';
import { loadSvmRecord } from '../lib/data';
import { svmChipLabel, svmView, thumbExtent, LOW_GRAY_CLIP, SLICE_GRAY, CLIP_LOW_GRAY, type SvmView } from '../lib/svm';
import { fmtNits } from '../../../src/data/grid';
import { fmtSvmOrDash, rankRows, type StatsRow } from '../../../src/stats/model';
import { ScenarioBlock, ShareBar, SvmValue, CoverageValue, DenoiseBadge } from '../../../src/stats/parts';
import { Thumbnail, type ThumbExtent } from '../../../src/stats/Thumbnail';
import { DEFAULT_SCENARIOS } from '../../../src/data/scenarios';
import { ColormapType } from '../../../src/types';
import { LinkButton, Loading, Missing, Pills, SectionCard, SlotKey, STATUS_TEXT, SVM_TOOL_URL } from '../components/ui';
import { cn } from '../../../src/ui/cn';

const COLORMAP = ColormapType.RD_YL_BU_ENHANCED;
const COLOR_MAX = 4;

type Loaded = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; views: SvmView[] };

const viewCache = new Map<string, Promise<SvmView[]>>();

function loadViews(device: Device): Promise<SvmView[]> {
  let p = viewCache.get(device.id);
  if (!p) {
    p = Promise.all(device.svm.map((e) => loadSvmRecord(e.record))).then((recs: SvmRecord[]) => device.svm.map((e, i) => svmView(e, recs[i])));
    p.catch(() => viewCache.delete(device.id));
    viewCache.set(device.id, p);
  }
  return p;
}

/** All SVM records of a device, parsed and computed once per page load (shared by every user). */
export function useSvmViews(device: Device): Loaded {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    if (!device.svm.length) {
      setState({ status: 'ready', views: [] });
      return;
    }
    setState({ status: 'loading' });
    loadViews(device).then(
      (views) => alive && setState({ status: 'ready', views }),
      (e: unknown) => alive && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [device]);
  return state;
}

function mergeExtents(list: (ThumbExtent | null)[]): ThumbExtent | null {
  const xs = list.filter((x): x is ThumbExtent => x !== null);
  if (!xs.length) return null;
  return {
    x0: Math.min(...xs.map((e) => e.x0)),
    x1: Math.max(...xs.map((e) => e.x1)),
    g0: Math.min(...xs.map((e) => e.g0)),
    g1: Math.max(...xs.map((e) => e.g1)),
    grayMin: Math.min(...xs.map((e) => e.grayMin)),
    grayMax: Math.max(...xs.map((e) => e.grayMax)),
  };
}

const extentOf = (v: SvmView) => thumbExtent([v.rec], { clipLowGray: CLIP_LOW_GRAY, maxNits: v.cap.maxNits });

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-ink-3">{label}</div>
      <div className="mt-1 truncate text-[17px] font-semibold leading-6 tabular-nums text-ink-1">{value}</div>
      {sub && <div className="truncate text-[11px] tabular-nums text-ink-3">{sub}</div>}
    </div>
  );
}

/** StatsCard-like read-out of one record (the workbench's StatsCard minus its 3D button). */
function RecordReadout({ view, extent, compact }: { view: SvmView; extent: ThumbExtent | null; compact: boolean }) {
  const s = view.stats;
  const row: StatsRow = { rec: view.rec, order: 0, stats: s };
  const rank = useMemo(() => rankRows([row]), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const scope = [
    CLIP_LOW_GRAY ? `G ≥ ${LOW_GRAY_CLIP}` : '全部灰阶',
    view.cap.maxNits !== null ? `档位亮度 ≤ ${view.cap.maxNits} nits` : '全部档位',
    '降噪开',
    `截面 G${SLICE_GRAY}`,
  ].join(' · ');
  const empty = s.cellCount === 0;

  return (
    <div className={cn('grid gap-8', compact ? '' : 'lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12')}>
      <div className="min-w-0">
        {view.cap.widened && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2.5 text-xs leading-5 text-amber-200 ring-1 ring-inset ring-amber-400/25" data-testid="cap-widened">
            <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              超出默认 ≤500 nits 显示范围：这条记录的档位亮度为 {view.cap.range ? `${fmtNits(view.cap.range[0])}–${fmtNits(view.cap.range[1])}` : '—'} nits，
              {view.cap.maxNits !== null ? `显示上限已放宽到 ${view.cap.maxNits} nits` : '已显示全部档位'}。场景参考只看 ≤500 nits，所以没有数值。
            </span>
          </div>
        )}
        {extent ? (
          <Thumbnail rec={view.rec} clipLowGray={CLIP_LOW_GRAY} maxNits={view.cap.maxNits} colormap={COLORMAP} colorMax={COLOR_MAX} sliceGray={s.sliceGray} extent={extent} />
        ) : (
          <Missing text="统计范围内没有有效测量点" />
        )}
        <div className="mt-3 text-[11px] text-ink-4">统计范围：{scope}（与频闪工具默认设置相同）</div>
      </div>

      <div className="min-w-0">
        {empty ? (
          <Missing text="统计范围内没有有效测量点" />
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[13px] text-ink-2">
                  安全占比
                  <DenoiseBadge rec={view.rec} stats={s} />
                </div>
                <div className="mt-1.5 text-[52px] font-semibold leading-none tracking-tight text-ink-1">
                  {s.safeShare === null ? '—' : (s.safeShare * 100).toFixed(1)}
                  <span className="ml-1 text-2xl font-medium text-ink-3">%</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[13px] text-ink-2">临界占比</div>
                <div className="mt-1.5 text-[28px] font-semibold leading-none tracking-tight text-ink-1">
                  {s.criticalShare === null ? '—' : (s.criticalShare * 100).toFixed(1)}
                  <span className="ml-0.5 text-base font-medium text-ink-3">%</span>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <ShareBar
                stats={s}
                extra={
                  <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap">
                    覆盖率
                    <CoverageValue stats={s} caveat={null} sub={false} />
                  </span>
                }
              />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-4 border-t border-line pt-4">
              <Metric
                label="全白达标亮度"
                value={s.fullWhiteSafeNits === null ? <span className="text-ink-4">—</span> : <>{fmtNits(s.fullWhiteSafeNits)}<span className="ml-1 text-[11px] font-normal text-ink-3">nits</span></>}
                sub={s.fullWhiteSafeNits === null ? '始终未达标' : s.fullWhiteAllSafe ? '全程达标' : '此亮度及以上'}
              />
              <Metric label="峰值 SVM" value={fmtSvmOrDash(s.peak?.svm ?? null)} sub={s.peak ? `G${s.peak.gray} · ${fmtNits(s.peak.levelNits)} nits` : undefined} />
              <Metric label="平均 SVM" value={fmtSvmOrDash(s.meanSvm)} sub="面积加权" />
            </div>
            <div className="mt-4 rounded-xl bg-surface-2/70 px-3 py-2.5 ring-1 ring-inset ring-line">
              <div className="flex items-baseline justify-between text-[11px] text-ink-3">
                <span>SVM @ 2 / 10 / 50 / 100 nits</span>
                {s.sliceGray !== null && <span className="tabular-nums">G{Math.round(s.sliceGray)} 截面</span>}
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-2">
                {s.svmAt.map((a) => (
                  <div key={a.nits} className="min-w-0">
                    <div className="text-[10px] tabular-nums text-ink-4">{a.nits} nits</div>
                    <SvmValue v={a.svm} className="text-sm font-medium text-ink-1" />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="-mx-4 mt-1 [&>div]:mb-0">
          <ScenarioBlock row={row} rank={rank} config={DEFAULT_SCENARIOS} />
        </div>
        {view.entry.note && <p className="mt-3 text-[11px] leading-4 text-ink-4">{view.entry.note}</p>}
      </div>
    </div>
  );
}

function DevicePanel({ device, compact, slot }: { device: Device; compact: boolean; slot: 0 | 1 | null }) {
  const loaded = useSvmViews(device);
  const [sel, setSel] = useState(0);
  const multi = device.displays.length > 1;
  const header = slot !== null && <SlotKey slot={slot} name={device.name.zh} className="mb-4" />;
  const a = device.availability.svm;

  if (!device.svm.length)
    return (
      <div className="min-w-0">
        {header}
        <Missing text={`频闪${STATUS_TEXT[a.status]}`} detail={a.note} />
      </div>
    );
  if (loaded.status === 'loading')
    return (
      <div className="min-w-0">
        {header}
        <Loading className="h-[420px]" />
      </div>
    );
  if (loaded.status === 'error')
    return (
      <div className="min-w-0">
        {header}
        <Missing text="频闪数据加载失败" detail={loaded.error} />
      </div>
    );
  const views = loaded.views;
  const i = Math.min(sel, views.length - 1);
  // One scale for every mode of the device, so switching modes keeps the heatmap comparable.
  const extent = mergeExtents(views.map(extentOf));

  return (
    <div className="min-w-0">
      {header}
      {views.length > 1 && (
        <Pills
          className="mb-5"
          size="sm"
          label="模式"
          value={String(i)}
          onChange={(v) => setSel(Number(v))}
          options={views.map((v, k) => ({ value: String(k), label: svmChipLabel(v.entry, multi) }))}
        />
      )}
      {views.length === 1 && <div className="mb-5 text-[13px] text-ink-2">模式：{svmChipLabel(views[0].entry, multi)}</div>}
      <RecordReadout view={views[i]} extent={extent} compact={compact} />
    </div>
  );
}

export function FlickerSection({ devices, id }: { devices: Device[]; id?: string }) {
  const compare = devices.length > 1;
  return (
    <SectionCard
      id={id}
      type="svm"
      sub="SVM（Stroboscopic Visibility Measure）在 亮度 × 灰阶 全范围上的分布。< 0.4 安全，≥ 1.0 临界。"
      controls={
        <LinkButton href={SVM_TOOL_URL} external>
          在频闪工具中打开
        </LinkButton>
      }
    >
      <div className={cn(compare && 'grid gap-10 lg:grid-cols-2 lg:gap-8')}>
        {devices.map((d, k) => (
          <DevicePanel key={d.id} device={d} compact={compare} slot={compare ? (k as 0 | 1) : null} />
        ))}
      </div>
    </SectionCard>
  );
}
