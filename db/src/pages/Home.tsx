import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import type { Catalog, DataType, Device } from '../../catalog/types';
import { deviceHref, replaceRoute } from '../lib/route';
import { filterDevices, matchReason } from '../lib/search';
import { DataVersion } from '../components/Shell';
import { loadUniformity, uniformityAsset, useAsync } from '../lib/data';
import { uniformityViews } from '../lib/uniformity';
import { fmtFixed, fmtSig } from '../lib/format';
import { useMedia } from '../lib/useWidth';
import { Glow, hasStatusData, Missing, Pills, STATUS_SHORT, STATUS_TEXT, TYPE_META, TYPE_ORDER, TypeIcon } from '../components/ui';
import { cn } from '../../../src/ui/cn';

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[30px] font-semibold leading-none tracking-tight text-ink-1 sm:text-[40px]">{value}</div>
      <div className="mt-2 text-xs text-ink-3 sm:text-[13px]">{label}</div>
    </div>
  );
}

function StatusTile({ device, type }: { device: Device; type: DataType }) {
  const a = device.availability[type];
  const on = hasStatusData(a.status);
  const short = STATUS_SHORT[a.status];
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-center',
        on ? 'bg-surface-3/70' : 'bg-transparent ring-1 ring-inset ring-line/80',
      )}
      title={`${TYPE_META[type].label}：${STATUS_TEXT[a.status]}${a.note ? `\n${a.note}` : ''}`}
    >
      <TypeIcon type={type} size={15} className={on ? 'text-accent-hover' : 'text-ink-4'} />
      <span className={cn('text-[11px] font-medium leading-none', on ? 'text-ink-1' : 'text-ink-4')}>{TYPE_META[type].label}</span>
      <span className={cn('h-3 text-[10px] leading-3', on ? 'text-ink-3' : 'text-ink-4')}>{short ?? '已收录'}</span>
    </div>
  );
}

function DeviceCard({ device, brand, q }: { device: Device; brand: string; q: string }) {
  const reason = matchReason(device, q);
  const panels = device.units.map((u) => u.panel).filter((p): p is string => !!p);
  const n = TYPE_ORDER.filter((t) => hasStatusData(device.availability[t].status)).length;
  const foldable = device.displays.includes('inner') && device.displays.includes('outer');
  return (
    <a
      href={deviceHref(device.id)}
      className="group flex min-w-0 flex-col rounded-[22px] bg-surface-1 p-4 ring-1 ring-inset ring-line transition duration-200 hover:-translate-y-0.5 hover:bg-surface-2 hover:ring-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring sm:p-5"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
        <span>{brand}</span>
        <span className="inline-flex items-center gap-0.5 tabular-nums">
          {n} / 4 项
          <ChevronRight size={14} className="text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" aria-hidden />
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[17px] font-semibold leading-6 tracking-tight text-ink-1">{device.name.zh}</div>
      {(panels.length > 0 || foldable || reason) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {panels.map((p) => (
            <span key={p} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-ink-2 ring-1 ring-inset ring-line-strong">
              面板 {p}
            </span>
          ))}
          {foldable && <span className="rounded-md px-1.5 py-0.5 text-[11px] leading-4 text-ink-3 ring-1 ring-inset ring-line">内屏 + 外屏</span>}
          {reason && !panels.some((p) => reason.endsWith(p)) && <span className="text-[11px] text-ink-3">匹配：{reason}</span>}
        </div>
      )}
      <div className="mt-auto grid grid-cols-4 gap-1.5 pt-4">
        {TYPE_ORDER.map((t) => (
          <StatusTile key={t} device={device} type={t} />
        ))}
      </div>
    </a>
  );
}

/**
 * Desktop hero visual: the real 300 nits white-field heatmaps of up to three devices, each with its
 * area uniformity and typical luminance on it (same rule as the uniformity section: the colours are
 * relative to the device's own typical luminance). Not rendered (nor downloaded) below 1280 px.
 */
function HeroSpotlight({ catalog }: { catalog: Catalog }) {
  const uni = useAsync(loadUniformity, 'uniformity');
  if (uni.status !== 'ready') return null;
  const picks = catalog.devices
    .map((d) => ({ d, v: uniformityViews(d, uni.data).find((x) => x.cond.id === '300') }))
    .filter((x) => x.v?.cond.maps?.luminance && x.v.cond.metrics.luminance)
    .slice(0, 3);
  if (!picks.length) return null;
  const H = 260;
  return (
    <div className="absolute right-0 top-1/2 hidden -translate-y-1/2 xl:block" aria-label="均匀度热力图示例">
      <div className="flex items-end gap-5">
        {picks.map(({ d, v }, i) => {
          const map = v!.cond.maps!.luminance!;
          const lum = v!.cond.metrics.luminance!;
          const [w, h] = map.displayResolution ?? [670, 1440];
          return (
            <a key={d.id} href={deviceHref(d.id, 'uniformity')} className={cn('group flex flex-col items-center', i === 1 && '-translate-y-6')}>
              <div className="relative transition-transform duration-300 group-hover:-translate-y-1" style={{ height: H, width: Math.round((H * w) / h) }}>
                <img
                  src={uniformityAsset(map.asset)}
                  alt={`${d.name.zh} 300 nits 白场亮度热力图`}
                  className="h-full w-full select-none object-contain drop-shadow-[0_24px_40px_rgba(0,0,0,0.6)]"
                  draggable={false}
                />
                <div className="absolute inset-x-[8%] bottom-[6%] rounded-xl bg-black/60 px-2 py-1.5 text-center ring-1 ring-inset ring-white/15 backdrop-blur-md">
                  <div className="text-[9px] text-white/70">面均匀性</div>
                  <div className="text-[16px] font-semibold leading-5 text-white">{fmtFixed(lum.areaUniformityPct, 1)} %</div>
                  <div className="text-[9px] tabular-nums text-white/70">典型 {fmtSig(lum.typical)} nits</div>
                </div>
              </div>
              <div className="mt-3 max-w-[140px] truncate text-xs text-ink-2 group-hover:text-ink-1">{d.name.zh}</div>
            </a>
          );
        })}
      </div>
      <div className="mt-4 text-center text-[11px] text-ink-4">均匀度实测 · 300 nits 白场 · 颜色相对各机典型亮度</div>
    </div>
  );
}

export function Home({ catalog, q: q0, has: has0 }: { catalog: Catalog; q: string; has: DataType | null }) {
  const [q, setQ] = useState(q0);
  const [has, setHas] = useState<DataType | null>(has0);
  // Follow the address when it changes from outside (logo link to #/, back / forward, a pasted link).
  useEffect(() => {
    setQ(q0);
    setHas(has0);
  }, [q0, has0]);
  const list = useMemo(() => filterDevices(catalog, q, has), [catalog, q, has]);
  const wide = useMedia('(min-width: 1280px)');
  const c = catalog.counts;

  const update = (nq: string, nh: DataType | null) => {
    setQ(nq);
    setHas(nh);
    // Shareable URL without filling the history with every keystroke.
    replaceRoute({ page: 'home', q: nq, has: nh });
  };

  return (
    <div>
      <section className="relative pb-10 pt-12 sm:pb-14 sm:pt-20">
        <Glow />
        <div className="text-[13px] font-medium tracking-wide text-accent-hover">野生的装机宅 · 手机屏幕实测</div>
        <h1 className="db-title-gradient mt-3 text-[44px] font-semibold leading-[1.05] tracking-tight sm:text-[68px] lg:text-[80px]">屏幕数据库</h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-7 text-ink-2 sm:text-[17px] sm:leading-8">
          均匀度、频闪、反射率、可视角，一台机型一页，两台可以并排对比。数字全部来自实测原始数据；没测的就写「待测」，不估算、不补齐。
        </p>
        <div className="mt-8 grid max-w-3xl grid-cols-3 gap-x-6 gap-y-6 sm:mt-10 sm:grid-cols-5">
          <Stat value={c.devices} label="台机型" />
          <Stat value={c.uniformityMaps} label="张均匀度热力图" />
          <Stat value={c.svmRecords} label="条频闪记录" />
          <Stat value={c.reflectanceSamples} label="个反射率样品" />
          <Stat value={c.angleProfilesMeasured} label="组可视角实测" />
        </div>
        <DataVersion className="mt-6 inline-block text-xs text-ink-3" />
        {wide && <HeroSpotlight catalog={catalog} />}
      </section>

      <div className="sticky top-14 z-30 py-3">
        <div className="absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 border-b border-line/50 bg-canvas/80 backdrop-blur-xl" aria-hidden />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative block w-full lg:max-w-sm">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => update(e.target.value, has)}
              placeholder="搜索机型、别名或面板码（如 GH3）"
              aria-label="搜索机型"
              className="h-10 w-full rounded-full bg-surface-2 pl-10 pr-10 text-[14px] text-ink-1 ring-1 ring-inset ring-line placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-accent-ring [&::-webkit-search-cancel-button]:hidden"
            />
            {q && (
              <button
                type="button"
                onClick={() => update('', has)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-ink-3 hover:bg-surface-4 hover:text-ink-1"
                aria-label="清除搜索"
              >
                <X size={14} />
              </button>
            )}
          </label>
          <div className="db-scroll-x -mx-1 flex items-center gap-3 px-1">
            <Pills
              size="sm"
              label="按数据类型筛选"
              className="flex-nowrap"
              value={has ?? 'all'}
              onChange={(v) => update(q, v === 'all' ? null : (v as DataType))}
              options={[{ value: 'all', label: '全部' }, ...TYPE_ORDER.map((t) => ({ value: t, label: `有${TYPE_META[t].label}` }))]}
            />
          </div>
          <div className="hidden shrink-0 text-xs tabular-nums text-ink-3 lg:ml-auto lg:block">{list.length} 台</div>
        </div>
      </div>

      <div className="mt-6">
        {list.length === 0 ? (
          <Missing text="没有找到符合条件的机型" detail="可以搜机型名、英文名、别名（如 ip18pm）或面板码（如 GH3）。" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((d) => (
              <DeviceCard key={d.id} device={d} brand={catalog.brands[d.brand]?.zh ?? d.brand} q={q} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
