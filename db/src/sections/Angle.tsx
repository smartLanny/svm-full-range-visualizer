import React, { useMemo, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { AngleProfileSummary, Catalog, Device, StateKey } from '../../catalog/types';
import { loadAngle, useAsync } from '../lib/data';
import { fmtFixed, isoDate } from '../lib/format';
import { angleViews, atTheta, DIRECTIONS, halfLuminance, rangeOver, THETAS, VIEW_ANGLE_SIM_URL, type AngleView } from '../lib/angle';
import { LinkButton, Loading, Missing, Pills, SectionCard, SlotKey, STATUS_TEXT } from '../components/ui';
import { cn } from '../../../src/ui/cn';

const range = (r: [number, number] | null, digits: number, unit: string) =>
  r === null ? '—' : Math.abs(r[1] - r[0]) < 10 ** -digits ? `${fmtFixed(r[0], digits)}${unit}` : `${fmtFixed(r[0], digits)}–${fmtFixed(r[1], digits)}${unit}`;

function Hero({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className="mt-1.5 whitespace-nowrap text-[22px] font-semibold leading-none tracking-tight tabular-nums text-ink-1 sm:text-[30px] lg:text-[34px]">
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-4">{sub}</div>
    </div>
  );
}

function ProfileTable({ p }: { p: AngleProfileSummary }) {
  return (
    <div>
      <table className="w-full table-fixed border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr className="text-ink-3">
            <th className="w-10 pb-2 font-normal sm:w-16">观看角</th>
            <th colSpan={2} className="pb-2 text-center font-normal">
              水平
            </th>
            <th colSpan={2} className="pb-2 text-center font-normal">
              垂直
            </th>
          </tr>
          <tr className="text-ink-4">
            <th className="border-b border-line pb-2 font-normal" />
            {DIRECTIONS.map((d) => (
              <th key={d.key} className="border-b border-line pb-2 text-center font-normal">
                {d.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {THETAS.map((t) => (
            <tr key={t}>
              <td className="border-b border-line/70 py-2.5 text-[13px] font-medium tabular-nums text-ink-2">{t}°</td>
              {DIRECTIONS.map((d) => {
                const v = atTheta(p, d.key, t);
                return (
                  <td
                    key={d.key}
                    className="border-b border-line/70 px-0.5 py-2.5 text-center sm:px-2"
                    title={`亮度 ${fmtFixed(v.luminancePct, 2)} % · Δu′v′ ${v.duv.toFixed(4)} · ${fmtFixed(v.jncd, 2)} JNCD`}
                  >
                    <div className="text-[14px] font-semibold tabular-nums text-ink-1 sm:text-[15px]">
                      {fmtFixed(v.luminancePct, 1)}
                      <span className="ml-0.5 text-[10px] font-normal text-ink-3">%</span>
                    </div>
                    <div className="mx-auto mt-1 h-1 w-10 overflow-hidden rounded-full bg-surface-3 sm:w-12">
                      <div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.min(100, v.luminancePct)}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] tabular-nums text-ink-3">{v.duv.toFixed(4)}</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-ink-4">每格：上为白场亮度（相对正视 %），下为色偏 Δu′v′。悬停可看 JNCD。</div>
    </div>
  );
}

function ProfilePanel({ view, compact }: { view: AngleView; compact: boolean }) {
  const p = view.profile;
  if (!p)
    return <Missing text={`${view.entry.display === 'outer' ? '外屏' : view.entry.display === 'inner' ? '内屏' : ''}可视角未测`} detail={view.entry.note} />;
  const lum45 = rangeOver(p, (d) => atTheta(p, d, '45').luminancePct);
  const duv45 = rangeOver(p, (d) => atTheta(p, d, '45').duv);
  const half = rangeOver(p, (d) => halfLuminance(p, d));
  const halfBeyond = DIRECTIONS.some((d) => halfLuminance(p, d.key) === null);
  return (
    <div className={cn('grid gap-8', !compact && 'lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14')}>
      <div className={cn('grid grid-cols-3 gap-4 self-start', !compact && 'lg:grid-cols-1 lg:gap-7')}>
        <Hero label="45° 亮度" value={range(lum45, 0, '%')} sub="四方向 · 相对正视" />
        <Hero label="45° 色偏" value={duv45 ? duv45[1].toFixed(3) : '—'} sub="Δu′v′ · 四方向最大" />
        <Hero label="半亮度角" value={half ? range(half, 0, '°') : '—'} sub={halfBeyond ? '部分方向 70° 内未降到一半' : '亮度降到正视一半'} />
      </div>
      <ProfileTable p={p} />
    </div>
  );
}

function DevicePanel({
  device,
  views,
  state,
  slot,
  compact,
  states,
}: {
  device: Device;
  views: AngleView[];
  state: StateGroup;
  slot: 0 | 1 | null;
  compact: boolean;
  states: Catalog['vocabulary']['states'];
}) {
  const header = slot !== null && <SlotKey slot={slot} name={device.name.zh} className="mb-5" />;
  const a = device.availability.angle;
  if (!views.length)
    return (
      <div className="min-w-0">
        {header}
        <Missing text={`可视角${STATUS_TEXT[a.status]}`} detail={a.note} />
      </div>
    );
  const view = views.find((v) => groupOf(v.entry.state) === state);
  const stateText = view ? (states[view.entry.state]?.zh ?? view.entry.state) : null;
  const simName = views[0].entry.standaloneDevice;
  return (
    <div className="min-w-0">
      {header}
      {compact && stateText && <div className="-mt-2 mb-4 text-xs text-ink-3">状态：{stateText}</div>}
      {view ? (
        <ProfilePanel view={view} compact={compact} />
      ) : (
        <Missing text={`${state === 'privacy-any' ? '防窥状态' : (states[state as StateKey]?.zh ?? state)}未测`} />
      )}
      <div className="mt-6 flex flex-col gap-3 rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs leading-5 text-ink-3">
          完整的角度扫描、色偏方向图和手机画面仿真在可视角仿真里。打开后选择机型
          <span className="mx-1 whitespace-nowrap rounded-md bg-surface-3 px-1.5 py-0.5 font-medium text-ink-1 ring-1 ring-inset ring-line-strong">
            {simName}
          </span>
          {view?.entry.state && view.entry.state !== 'default' ? `，并切换到「${states[view.entry.state]?.zh ?? view.entry.state}」` : ''}。
        </div>
        <LinkButton href={VIEW_ANGLE_SIM_URL} external variant="primary" icon={<Maximize2 size={14} aria-hidden />}>
          全屏打开可视角仿真
        </LinkButton>
      </div>
    </div>
  );
}

/**
 * Shared state selector of the compare page: built-in privacy mode and privacy film are different
 * states (never merged in the data), but one "防窥" choice shows each device's own privacy state,
 * labelled with what it actually is.
 */
type StateGroup = 'default' | 'privacy-any' | 'inner' | 'outer' | StateKey;
const groupOf = (s: StateKey): StateGroup => (s === 'privacy' || s === 'privacy-film' ? 'privacy-any' : s);

export function AngleSection({ devices, catalog, id }: { devices: Device[]; catalog: Catalog; id?: string }) {
  const summary = useAsync(loadAngle, 'angle');
  const compare = devices.length > 1;
  const all = useMemo(() => devices.map((d) => angleViews(d, summary.status === 'ready' ? summary.data : null)), [devices, summary]);
  const states = catalog.vocabulary.states;
  const groups = useMemo(() => {
    const out: { value: StateGroup; members: StateKey[] }[] = [];
    for (const vs of all)
      for (const v of vs) {
        const g = groupOf(v.entry.state);
        const e = out.find((x) => x.value === g);
        if (!e) out.push({ value: g, members: [v.entry.state] });
        else if (!e.members.includes(v.entry.state)) e.members.push(v.entry.state);
      }
    return out;
  }, [all]);
  const [state, setState] = useState<StateGroup | null>(null);
  const stateNow: StateGroup = state && groups.some((g) => g.value === state) ? state : (groups[0]?.value ?? 'default');
  const groupLabel = (g: { value: StateGroup; members: StateKey[] }) =>
    g.members.length === 1 ? (states[g.members[0]]?.zh ?? g.members[0]) : g.members.map((m) => states[m]?.zh ?? m).join(' / ');
  const standalone = summary.status === 'ready' ? summary.data.standalone : null;

  return (
    <SectionCard
      id={id}
      type="angle"
      sub={
        <>
          白场亮度相对正视（0°）的百分比，与色偏 Δu′v′。数字由独立项目
          <a
            className="mx-1 text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink-1"
            href={VIEW_ANGLE_SIM_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            可视角仿真
          </a>
          自己的模型算出{standalone ? `（${standalone.commit.slice(0, 7)} · ${isoDate(standalone.commitDate)}）` : ''}；各机型的绝对亮度条件不同，只比相对值。
        </>
      }
      controls={
        groups.length > 1 ? (
          <Pills label="状态" value={stateNow} onChange={(v) => setState(v)} options={groups.map((g) => ({ value: g.value, label: groupLabel(g) }))} />
        ) : null
      }
    >
      {summary.status === 'loading' ? (
        <Loading className="h-[300px]" />
      ) : summary.status === 'error' ? (
        <Missing text="可视角摘要加载失败" detail={summary.error} />
      ) : (
        <div className={cn(compare && 'grid gap-10 lg:grid-cols-2 lg:gap-8')}>
          {devices.map((d, k) => (
            <DevicePanel key={d.id} device={d} views={all[k]} state={stateNow} slot={compare ? (k as 0 | 1) : null} compact={compare} states={states} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
