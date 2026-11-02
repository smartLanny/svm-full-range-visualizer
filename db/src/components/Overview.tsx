import React from 'react';
import type { DataType, Device } from '../../catalog/types';
import { loadAngle, loadReflectance, loadUniformity, useAsync } from '../lib/data';
import { fmtFixed } from '../lib/format';
import { uniformityViews } from '../lib/uniformity';
import { meanOf, reflectanceViews } from '../lib/reflectance';
import { angleViews, atTheta, rangeOver } from '../lib/angle';
import { svmChipLabel } from '../lib/svm';
import { useSvmViews } from '../sections/Flicker';
import { deviceHref } from '../lib/route';
import { GradeWord } from '../../../src/stats/parts';
import { hasStatusData, STATUS_TEXT, TYPE_META, TYPE_ORDER, TypeIcon } from './ui';
import { cn } from '../../../src/ui/cn';

interface Figure {
  value: React.ReactNode;
  caption: string;
}

function Tile({ device, type, figure }: { device: Device; type: DataType; figure: Figure | null | 'loading' }) {
  const a = device.availability[type];
  const on = hasStatusData(a.status);
  return (
    <a
      href={deviceHref(device.id, type)}
      className={cn(
        'group flex min-w-0 flex-col rounded-[22px] p-4 ring-1 ring-inset transition-colors sm:p-5',
        on ? 'bg-surface-1 ring-line hover:bg-surface-2 hover:ring-line-strong' : 'bg-transparent ring-line/70 hover:ring-line',
      )}
    >
      <div className={cn('flex items-center gap-1.5 text-[13px] font-medium', on ? 'text-ink-2' : 'text-ink-4')}>
        <TypeIcon type={type} size={15} className={on ? 'text-accent-hover' : 'text-ink-4'} />
        {TYPE_META[type].label}
      </div>
      {!on ? (
        <>
          <div className="mt-3 text-[24px] font-semibold leading-none tracking-tight text-ink-4 sm:text-[28px]">{STATUS_TEXT[a.status]}</div>
          <div className="mt-2 line-clamp-2 text-[11px] leading-4 text-ink-4">
            {a.status === 'pending-import' ? '源数据已测量，数值还没导入' : '本库暂无这项测量'}
          </div>
        </>
      ) : figure === 'loading' ? (
        <div className="mt-3 h-[52px] animate-pulse rounded-lg bg-surface-2" />
      ) : figure === null ? (
        <div className="mt-3 text-[24px] font-semibold leading-none text-ink-3">—</div>
      ) : (
        <>
          <div className="mt-3 flex items-baseline gap-1.5 whitespace-nowrap text-[26px] font-semibold leading-none tracking-tight text-ink-1 sm:text-[30px]">
            {figure.value}
          </div>
          <div className="mt-2 line-clamp-2 text-[11px] leading-4 text-ink-3">{figure.caption}</div>
        </>
      )}
    </a>
  );
}

const unit = (u: string) => <span className="text-[15px] font-medium text-ink-3">{u}</span>;

/** Four key numbers, one per data type (or its status word), linking to the sections. */
export function Overview({ device }: { device: Device }) {
  const uni = useAsync(loadUniformity, 'uniformity');
  const refl = useAsync(loadReflectance, 'reflectance');
  const ang = useAsync(loadAngle, 'angle');
  const svm = useSvmViews(device);

  const figures: Record<DataType, Figure | null | 'loading'> = {
    uniformity: (() => {
      if (uni.status !== 'ready') return 'loading';
      const views = uniformityViews(device, uni.data);
      const v = views.find((x) => x.cond.id === '300') ?? views[0];
      const lum = v?.cond.metrics.luminance;
      return lum
        ? {
            value: (
              <>
                {fmtFixed(lum.areaUniformityPct, 1)}
                {unit('%')}
              </>
            ),
            caption: `面均匀性 · ${v.cond.label}`,
          }
        : null;
    })(),
    svm: (() => {
      if (svm.status !== 'ready') return svm.status === 'loading' ? 'loading' : null;
      const v = svm.views[0];
      if (!v) return null;
      const c = v.stats.scenario.composite;
      const mode = svmChipLabel(v.entry, device.displays.length > 1);
      if (c === null)
        return {
          value: <span className="text-ink-3">—</span>,
          caption: v.cap.widened ? `${mode} · 超出 ≤500 nits 范围，无场景参考` : `${mode} · 场景参考数据不足`,
        };
      return {
        value: (
          <>
            {c.toFixed(2)}
            <GradeWord v={c} className="text-[13px]" />
          </>
        ),
        caption: `场景参考综合 SVM · ${mode}`,
      };
    })(),
    reflectance: (() => {
      if (refl.status !== 'ready') return 'loading';
      const v = reflectanceViews(device, refl.data)[0];
      const m = meanOf(v?.cond.curves.total?.samples);
      return m === null
        ? null
        : {
            value: (
              <>
                {fmtFixed(m, 2)}
                {unit('%')}
              </>
            ),
            caption: `SCI 平均 · ${v.entry.label}`,
          };
    })(),
    angle: (() => {
      if (ang.status !== 'ready') return 'loading';
      const v = angleViews(device, ang.data).find((x) => x.profile);
      if (!v?.profile) return null;
      const p = v.profile;
      const r = rangeOver(p, (d) => atTheta(p, d, '45').luminancePct);
      if (!r) return null;
      const txt = Math.round(r[0]) === Math.round(r[1]) ? fmtFixed(r[0], 0) : `${fmtFixed(r[0], 0)}–${fmtFixed(r[1], 0)}`;
      return {
        value: (
          <>
            {txt}
            {unit('%')}
          </>
        ),
        caption: `45° 亮度 · ${v.entry.state === 'default' ? '默认' : v.entry.display === 'inner' ? '内屏' : v.entry.state}`,
      };
    })(),
  };

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      {TYPE_ORDER.map((t) => (
        <Tile key={t} device={device} type={t} figure={figures[t]} />
      ))}
    </div>
  );
}
