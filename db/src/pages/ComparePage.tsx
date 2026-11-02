import React from 'react';
import { ArrowLeft, ArrowLeftRight } from 'lucide-react';
import type { Catalog, Device } from '../../catalog/types';
import { compareHref, deviceHref } from '../lib/route';
import { findDevice } from '../lib/data';
import { hasStatusData, Missing, STATUS_TEXT, TYPE_META, TYPE_ORDER, TypeIcon } from '../components/ui';
import { DevicePicker, renderSection } from './DevicePage';
import { cn } from '../../../src/ui/cn';

function SlotHeader({ catalog, device, other, slot }: { catalog: Catalog; device: Device | undefined; other: string | undefined; slot: 0 | 1 }) {
  const go = (id: string) => {
    const ids = slot === 0 ? [id, other] : [other, id];
    window.location.hash = compareHref(ids.filter((x): x is string => !!x));
  };
  return (
    <div className={cn('min-w-0 rounded-[22px] bg-surface-1 p-4 ring-1 ring-inset ring-line sm:p-5', 'relative overflow-hidden')}>
      <div className={cn('absolute inset-x-0 top-0 h-1', slot === 0 ? 'bg-slot-a' : 'bg-slot-b')} aria-hidden />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-ink-3">{slot === 0 ? '机型 A' : '机型 B'}</span>
        {device && (
          <a href={deviceHref(device.id)} className="text-xs text-ink-3 hover:text-ink-1">
            机型页 →
          </a>
        )}
      </div>
      <div className="mt-2 truncate text-[24px] font-semibold tracking-tight text-ink-1 sm:text-[28px]">{device ? device.name.zh : '选择机型'}</div>
      <DevicePicker
        catalog={catalog}
        exclude={[device?.id ?? '', other ?? ''].filter(Boolean)}
        value=""
        label={slot === 0 ? '更换机型 A' : '更换机型 B'}
        placeholder={device ? '更换机型…' : '选择机型…'}
        onPick={go}
        className="mt-3 w-full max-w-[260px]"
      />
      {device && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {TYPE_ORDER.map((t) => {
            const on = hasStatusData(device.availability[t].status);
            return (
              <span
                key={t}
                className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', on ? 'bg-surface-3 text-ink-1' : 'text-ink-4 ring-1 ring-inset ring-line')}
              >
                <TypeIcon type={t} size={12} className={on ? 'text-accent-hover' : ''} />
                {TYPE_META[t].label}
                {!on && ` · ${STATUS_TEXT[device.availability[t].status]}`}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ComparePage({ catalog, ids }: { catalog: Catalog; ids: string[] }) {
  const a = findDevice(catalog, ids[0]);
  const b = ids[1] ? findDevice(catalog, ids[1]) : undefined;
  const unknown = ids.filter((id) => !findDevice(catalog, id));
  const devices = [a, b].filter((d): d is Device => !!d);
  const shared = TYPE_ORDER.filter((t) => devices.some((d) => hasStatusData(d.availability[t].status)));
  const neither = TYPE_ORDER.filter((t) => !shared.includes(t));

  return (
    <div>
      <section className="db-glow relative -mx-4 px-4 pb-8 pt-6 sm:-mx-6 sm:px-6 sm:pb-10 sm:pt-8 lg:-mx-8 lg:px-8">
        <a href={a ? deviceHref(a.id) : '#/'} className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 transition-colors hover:text-ink-1">
          <ArrowLeft size={14} aria-hidden />
          {a ? a.name.zh : '全部机型'}
        </a>
        <div className="mt-6 flex items-end justify-between gap-4">
          <h1 className="db-title-gradient text-[36px] font-semibold leading-[1.1] tracking-tight sm:text-[52px]">两台对比</h1>
          {a && b && (
            <a
              href={compareHref([b.id, a.id])}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-3 px-4 text-[13px] font-medium text-ink-1 ring-1 ring-inset ring-line hover:bg-surface-4"
            >
              <ArrowLeftRight size={14} aria-hidden />
              交换
            </a>
          )}
        </div>
        <p className="mt-2 text-[13px] text-ink-3">同一套指标左右并排；测试条件与状态两边共用。窄屏上下排列。</p>
        {unknown.length > 0 && <div className="mt-3 text-xs text-amber-300">目录里没有：{unknown.join('、')}</div>}
        <div className="mt-6 grid gap-3 sm:grid-cols-2 sm:gap-4">
          <SlotHeader catalog={catalog} device={a} other={b?.id} slot={0} />
          <SlotHeader catalog={catalog} device={b} other={a?.id} slot={1} />
        </div>
      </section>

      {devices.length < 2 ? (
        <Missing className="mt-6" text="再选一台机型开始对比" detail="在上面的「机型 B」里选择。" />
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-6 sm:gap-8">{shared.map((t) => renderSection(t, devices, catalog, `sec-${t}`))}</div>
          {neither.length > 0 && (
            <div className="mt-8 rounded-[22px] px-5 py-4 text-xs text-ink-3 ring-1 ring-inset ring-line/80">
              两台都没有收录：{neither.map((t) => TYPE_META[t].label).join('、')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
