import React, { useMemo, useRef, useState } from 'react';
import { useWidth } from '../lib/useWidth';
import type { Device } from '../../catalog/types';
import { loadReflectance, useAsync } from '../lib/data';
import { fmtFixed, isoDate } from '../lib/format';
import { axisMax, meanOf, reflectanceViews, snapIndex, type ReflectanceView } from '../lib/reflectance';
import { Loading, Missing, Pills, SectionCard, SLOT_COLOR, SlotKey, STATUS_TEXT } from '../components/ui';
import { cn } from '../../../src/ui/cn';

const NM0 = 400;
const NM1 = 700;
const ACCENT = '#6aa1ff';

/** SCI solid / SCE dashed, 400–700 nm, hover snapping to the measured 10 nm points. */
function Chart({
  view,
  ghosts,
  yMax,
  color,
  hoverNm,
  onHover,
  label,
}: {
  view: ReflectanceView;
  /** Other conditions of the same device, drawn faint for context. */
  ghosts: ReflectanceView[];
  yMax: number;
  color: string;
  hoverNm: number | null;
  onHover: (nm: number | null) => void;
  label: string;
}) {
  // Drawn at the container's own width so axis text stays 11 px on phones and desktops alike.
  const [wrapRef, measured] = useWidth<HTMLDivElement>();
  const W = measured || 640;
  const H = Math.round(Math.min(320, Math.max(220, W * 0.46)));
  const m = { l: 40, r: 14, t: 14, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const x = (nm: number) => m.l + ((nm - NM0) / (NM1 - NM0)) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;
  const path = (s: [number, number][] | undefined) => (s ? s.map(([nm, v], i) => `${i ? 'L' : 'M'}${x(nm).toFixed(1)},${y(v).toFixed(1)}`).join('') : '');
  const sci = view.cond.curves.total?.samples ?? [];
  const sce = view.cond.curves.diffuse?.samples ?? [];
  const nms = sci.map(([nm]) => nm);
  const step = yMax > 6 ? 2 : 1;
  const yTicks = Array.from({ length: Math.floor(yMax / step) + 1 }, (_, i) => i * step);
  const xTicks = W < 420 ? [400, 500, 600, 700] : [400, 450, 500, 550, 600, 650, 700];
  const svgRef = useRef<SVGSVGElement>(null);

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const nm = NM0 + ((px - m.l) / iw) * (NM1 - NM0);
    const k = snapIndex(nms, nm);
    onHover(k >= 0 ? nms[k] : null);
  };

  const hv = hoverNm !== null ? { sci: sci.find(([w]) => w === hoverNm)?.[1] ?? null, sce: sce.find(([w]) => w === hoverNm)?.[1] ?? null } : null;
  const tipLeft = hoverNm !== null ? x(hoverNm) / W : 0;

  return (
    <div className="relative" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-pan-y select-none"
        role="img"
        aria-label={label}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => onHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="#232a36" strokeWidth={1} />
            <text x={m.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="#7d8796" className="tabular-nums">
              {v}%
            </text>
          </g>
        ))}
        {xTicks.map((nm) => (
          <text key={nm} x={x(nm)} y={H - 8} textAnchor="middle" fontSize={11} fill="#7d8796" className="tabular-nums">
            {nm}
          </text>
        ))}
        {ghosts.map((g) => (
          <g key={g.cond.id} opacity={0.32}>
            <path d={path(g.cond.curves.total?.samples)} fill="none" stroke="#7d8796" strokeWidth={1.5} strokeLinejoin="round" />
            <path d={path(g.cond.curves.diffuse?.samples)} fill="none" stroke="#7d8796" strokeWidth={1.5} strokeDasharray="5 4" />
          </g>
        ))}
        <path d={`${path(sci)}L${x(NM1)},${y(0)}L${x(NM0)},${y(0)}Z`} fill={color} opacity={0.08} />
        <path d={path(sci)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path(sce)} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" />
        {hoverNm !== null && hv && (
          <g>
            <line x1={x(hoverNm)} x2={x(hoverNm)} y1={m.t} y2={m.t + ih} stroke="#b6bfcc" strokeWidth={1} opacity={0.6} />
            {hv.sci !== null && <circle cx={x(hoverNm)} cy={y(hv.sci)} r={4.5} fill={color} stroke="#0b0e14" strokeWidth={2} />}
            {hv.sce !== null && <circle cx={x(hoverNm)} cy={y(hv.sce)} r={4.5} fill="#0b0e14" stroke={color} strokeWidth={2} />}
          </g>
        )}
      </svg>
      {hoverNm !== null && hv && (
        <div
          className="pointer-events-none absolute top-2 z-10 whitespace-nowrap rounded-lg bg-black/85 px-2.5 py-2 text-xs ring-1 ring-white/10"
          style={tipLeft > 0.6 ? { right: `${(1 - tipLeft) * 100 + 2}%` } : { left: `${tipLeft * 100 + 2}%` }}
        >
          <div className="mb-1 text-[11px] text-ink-3">{hoverNm} nm</div>
          <div className="flex items-center gap-2">
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke={color} strokeWidth="2" />
            </svg>
            <span className="font-semibold tabular-nums text-ink-1">{hv.sci !== null ? `${fmtFixed(hv.sci, 3)} %` : '—'}</span>
            <span className="text-ink-3">SCI</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke={color} strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            <span className="font-semibold tabular-nums text-ink-1">{hv.sce !== null ? `${fmtFixed(hv.sce, 3)} %` : '—'}</span>
            <span className="text-ink-3">SCE</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ color, ghosts }: { color: string; ghosts: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <svg width="18" height="4" aria-hidden>
          <line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2" />
        </svg>
        SCI 全反射（含镜面反射）
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="18" height="4" aria-hidden>
          <line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2" strokeDasharray="5 3" />
        </svg>
        SCE 漫反射（去除镜面反射）
      </span>
      {ghosts && (
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="4" aria-hidden>
            <line x1="0" y1="2" x2="18" y2="2" stroke="#7d8796" strokeWidth="1.5" opacity="0.6" />
          </svg>
          本机其他状态
        </span>
      )}
      <span className="text-ink-4">横轴：波长 nm</span>
    </div>
  );
}

function DevicePanel({
  device,
  views,
  yMax,
  slot,
  hoverNm,
  onHover,
}: {
  device: Device;
  views: ReflectanceView[];
  yMax: number;
  slot: 0 | 1 | null;
  hoverNm: number | null;
  onHover: (nm: number | null) => void;
}) {
  const [sel, setSel] = useState(0);
  const header = slot !== null && <SlotKey slot={slot} name={device.name.zh} className="mb-4" />;
  const a = device.availability.reflectance;
  if (!views.length)
    return (
      <div className="min-w-0">
        {header}
        <Missing text={`反射率${STATUS_TEXT[a.status]}`} detail={a.note} />
      </div>
    );
  const i = Math.min(sel, views.length - 1);
  const v = views[i];
  const sciMean = meanOf(v.cond.curves.total?.samples);
  const sceMean = meanOf(v.cond.curves.diffuse?.samples);
  const color = slot === 1 ? SLOT_COLOR[1] : slot === 0 ? SLOT_COLOR[0] : ACCENT;
  const inst = v.cond.curves.total?.instrument;
  const ghosts = views.filter((_, k) => k !== i);

  return (
    <div className="min-w-0">
      {header}
      {views.length > 1 ? (
        <Pills
          className="mb-5"
          size="sm"
          label="样品状态"
          value={String(i)}
          onChange={(x) => setSel(Number(x))}
          options={views.map((w, k) => ({ value: String(k), label: w.entry.label }))}
        />
      ) : (
        <div className="mb-5 text-[13px] text-ink-2">{v.entry.label}</div>
      )}
      <div className={cn('grid gap-6', slot === null && 'lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-10')}>
        <div className="min-w-0">
          <Chart
            view={v}
            ghosts={ghosts}
            yMax={yMax}
            color={color}
            hoverNm={hoverNm}
            onHover={onHover}
            label={`${device.name.zh} ${v.entry.label} 反射率光谱`}
          />
          <div className="mt-3">
            <Legend color={color} ghosts={ghosts.length > 0} />
          </div>
        </div>
        <div className={cn('grid min-w-0 grid-cols-2 gap-4', slot === null && 'lg:block')}>
          <div>
            <div className="text-[13px] text-ink-2">SCI 平均</div>
            <div className="mt-1.5 text-[44px] font-semibold leading-none tracking-tight text-ink-1">
              {sciMean === null ? '—' : fmtFixed(sciMean, 2)}
              <span className="ml-1 text-xl font-medium text-ink-3">%</span>
            </div>
            <div className="mt-1.5 text-[11px] text-ink-4">400–700 nm 31 个测点的平均</div>
          </div>
          <div className={cn(slot === null && 'lg:mt-6')}>
            <div className="text-[13px] text-ink-2">SCE 平均</div>
            <div className="mt-1.5 text-[28px] font-semibold leading-none tracking-tight text-ink-1">
              {sceMean === null ? '—' : fmtFixed(sceMean, 2)}
              <span className="ml-1 text-base font-medium text-ink-3">%</span>
            </div>
          </div>
          <div className={cn('col-span-2 text-[11px] leading-5 text-ink-4', slot === null && 'lg:mt-6')}>
            测量日期 {isoDate(v.entry.measuredAt) ?? '—'}
            {inst?.Instrument ? ` · ${inst.Instrument}` : ''}
            {inst?.OpticalStruct ? ` · ${inst.OpticalStruct}` : ''}
            {v.entry.panel ? ` · 面板 ${v.entry.panel}` : ''}
            <br />
            源记录名：{v.entry.sourceName}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReflectanceSection({ devices, id }: { devices: Device[]; id?: string }) {
  const index = useAsync(loadReflectance, 'reflectance');
  const [hoverNm, setHoverNm] = useState<number | null>(null);
  const compare = devices.length > 1;
  const all = useMemo(() => (index.status === 'ready' ? devices.map((d) => reflectanceViews(d, index.data)) : []), [index, devices]);
  // One y scale for every curve on the page, so two devices compare at a glance.
  const yMax = axisMax(Math.max(0, ...all.flat().flatMap((v) => (v.cond.curves.total?.samples ?? []).map(([, r]) => r))));

  return (
    <SectionCard id={id} type="reflectance" sub="SCI 含屏幕表面的镜面反射，SCE 去除镜面反射；数值越低，屏幕在环境光下反光越少。">
      {index.status === 'loading' ? (
        <Loading className="h-[320px]" />
      ) : index.status === 'error' ? (
        <Missing text="反射率数据加载失败" detail={index.error} />
      ) : (
        <div className={cn(compare && 'grid gap-10 lg:grid-cols-2 lg:gap-8')}>
          {devices.map((d, k) => (
            <DevicePanel key={d.id} device={d} views={all[k]} yMax={yMax} slot={compare ? (k as 0 | 1) : null} hoverNm={hoverNm} onHover={setHoverNm} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
