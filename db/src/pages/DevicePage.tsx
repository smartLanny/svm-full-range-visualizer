import React, { useEffect } from 'react';
import { ArrowLeft, ChevronDown, GitCompare } from 'lucide-react';
import type { Catalog, DataType, Device } from '../../catalog/types';
import { compareHref, type Section } from '../lib/route';
import { findDevice } from '../lib/data';
import { Overview } from '../components/Overview';
import { hasStatusData, Missing, STATUS_TEXT, TYPE_META, TYPE_ORDER } from '../components/ui';
import { UniformitySection } from '../sections/Uniformity';
import { FlickerSection } from '../sections/Flicker';
import { ReflectanceSection } from '../sections/Reflectance';
import { AngleSection } from '../sections/Angle';

export const sectionId = (t: DataType) => `sec-${t}`;

/** Native select (accessible, good on phones) styled as a pill; picking a device navigates. */
export function DevicePicker({
  catalog,
  exclude,
  value,
  onPick,
  label,
  placeholder,
  className,
}: {
  catalog: Catalog;
  exclude: string[];
  value: string;
  onPick: (id: string) => void;
  label: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={`relative inline-flex h-9 items-center ${className ?? ''}`}>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => e.target.value && onPick(e.target.value)}
        className="h-9 w-full cursor-pointer appearance-none rounded-full bg-surface-3 pl-4 pr-9 text-[13px] font-medium text-ink-1 ring-1 ring-inset ring-line hover:bg-surface-4 focus:outline-none focus:ring-2 focus:ring-accent-ring"
      >
        <option value="">{placeholder}</option>
        {catalog.devices
          .filter((d) => !exclude.includes(d.id))
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.name.zh}
            </option>
          ))}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 text-ink-3" aria-hidden />
    </label>
  );
}

export function renderSection(t: DataType, devices: Device[], catalog: Catalog, id?: string) {
  switch (t) {
    case 'uniformity':
      return <UniformitySection key={t} devices={devices} id={id} />;
    case 'svm':
      return <FlickerSection key={t} devices={devices} id={id} />;
    case 'reflectance':
      return <ReflectanceSection key={t} devices={devices} id={id} />;
    case 'angle':
      return <AngleSection key={t} devices={devices} catalog={catalog} id={id} />;
  }
}

export function DevicePage({ catalog, id, section }: { catalog: Catalog; id: string; section: Section | null }) {
  const device = findDevice(catalog, id);

  useEffect(() => {
    if (!section) return;
    // Sections grow as their data arrives: scroll now and once more after the first loads.
    const go = () => document.getElementById(sectionId(section))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const t1 = window.setTimeout(go, 30);
    const t2 = window.setTimeout(go, 600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [section]);

  if (!device) return <Missing className="mt-24" text="目录里没有这台机型" detail={<a className="text-accent-hover hover:underline" href="#/">回到全部机型</a>} />;

  const brand = catalog.brands[device.brand];
  const panels = device.units.filter((u) => u.panel);
  const present = TYPE_ORDER.filter((t) => hasStatusData(device.availability[t].status));
  const absent = TYPE_ORDER.filter((t) => !present.includes(t));

  return (
    <div>
      <section className="db-glow relative -mx-4 px-4 pb-8 pt-6 sm:-mx-6 sm:px-6 sm:pb-10 sm:pt-8 lg:-mx-8 lg:px-8">
        <a href="#/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 transition-colors hover:text-ink-1">
          <ArrowLeft size={14} aria-hidden />
          全部机型
        </a>
        <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-accent-hover">
              {brand?.zh ?? device.brand}
              {brand && brand.en !== brand.zh ? <span className="text-ink-3"> · {brand.en}</span> : null}
            </div>
            <h1 className="db-title-gradient mt-2 text-[36px] font-semibold leading-[1.1] tracking-tight sm:text-[52px] lg:text-[60px]">{device.name.zh}</h1>
            {device.name.en !== device.name.zh && <div className="mt-2 text-[15px] text-ink-3">{device.name.en}</div>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {panels.map((u) => (
                <span key={u.id} className="rounded-full bg-surface-3 px-3 py-1 text-xs font-medium text-ink-1 ring-1 ring-inset ring-line-strong" title={u.note}>
                  面板 {u.panel}
                </span>
              ))}
              {device.displays.length > 1 && (
                <span className="rounded-full px-3 py-1 text-xs text-ink-2 ring-1 ring-inset ring-line">{device.displays.map((d) => catalog.vocabulary.displays[d]?.zh ?? d).join(' + ')}</span>
              )}
              <span className="text-xs text-ink-4">
                {present.length} / 4 类数据已收录
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <GitCompare size={16} className="text-ink-3" aria-hidden />
            <DevicePicker
              catalog={catalog}
              exclude={[device.id]}
              value=""
              label="选择对比机型"
              placeholder="与另一台机型对比…"
              onPick={(other) => {
                window.location.hash = compareHref([device.id, other]);
              }}
              className="w-[220px]"
            />
          </div>
        </div>
        <div className="mt-8">
          <Overview device={device} />
        </div>
      </section>

      <div className="mt-2 flex flex-col gap-6 sm:gap-8">
        {present.map((t) => renderSection(t, [device], catalog, sectionId(t)))}
      </div>

      {absent.length > 0 && (
        <div className="mt-8 rounded-[22px] px-5 py-4 ring-1 ring-inset ring-line/80">
          <div className="text-[13px] font-medium text-ink-2">尚未收录</div>
          <ul className="mt-2 flex flex-col gap-1.5 text-xs leading-5 text-ink-3">
            {absent.map((t) => (
              <li key={t} id={sectionId(t)} className="scroll-mt-20">
                <span className="text-ink-2">{TYPE_META[t].label}</span> · {STATUS_TEXT[device.availability[t].status]}
                {device.availability[t].note ? `：${device.availability[t].note}` : device.availability[t].status === 'pending-import' ? '：源数据已测量，数值还没导入本库。' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
