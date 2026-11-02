import React from 'react';
import { ArrowUpRight, AudioWaveform, ChevronRight, Eye, Grid3x3, SunMedium, type LucideIcon } from 'lucide-react';
import type { AvailabilityStatus, DataType } from '../../catalog/types';
import { cn } from '../../../src/ui/cn';

/** Section order on device / compare pages and in every status row (the user's priorities). */
export const TYPE_ORDER: DataType[] = ['uniformity', 'svm', 'reflectance', 'angle'];

export const TYPE_META: Record<DataType, { label: string; icon: LucideIcon; sub: string }> = {
  uniformity: { label: '均匀度', icon: Grid3x3, sub: 'Radiant 成像色度计 · 全屏热力图' },
  svm: { label: '频闪', icon: AudioWaveform, sub: 'SVM · 亮度 × 灰阶全范围' },
  reflectance: { label: '反射率', icon: SunMedium, sub: 'SCI / SCE 光谱 · 400–700 nm' },
  angle: { label: '可视角', icon: Eye, sub: '白场亮度与色偏随观看角度变化' },
};

/** Device page wording (catalog vocabulary). */
export const STATUS_TEXT: Record<AvailabilityStatus, string> = {
  complete: '完整',
  partial: '部分已测',
  'metrics-only': '仅指标',
  'pending-import': '已测待导入',
  'not-measured': '未测',
};

/** Short wording on home cards: missing = 待测. */
export const STATUS_SHORT: Record<AvailabilityStatus, string | null> = {
  complete: null,
  partial: '部分',
  'metrics-only': '仅指标',
  'pending-import': '待导入',
  'not-measured': '待测',
};

export const hasStatusData = (s: AvailabilityStatus) => s === 'complete' || s === 'partial' || s === 'metrics-only';

export const SVM_TOOL_URL = 'https://smartlanny.github.io/svm-full-range-visualizer/';

export function TypeIcon({ type, size = 16, className }: { type: DataType; size?: number; className?: string }) {
  const Icon = TYPE_META[type].icon;
  return <Icon size={size} className={className} aria-hidden strokeWidth={1.75} />;
}

/** Pill selector (single choice). Wraps on narrow screens rather than scrolling out of sight. */
export function Pills<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: React.ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap gap-1.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
              size === 'md' ? 'h-8 px-3.5 text-[13px]' : 'h-7 px-3 text-xs',
              on
                ? 'bg-ink-1 text-canvas shadow-[0_1px_12px_rgba(255,255,255,0.12)]'
                : 'bg-surface-2 text-ink-2 ring-1 ring-inset ring-line hover:bg-surface-3 hover:text-ink-1',
              o.disabled && 'cursor-not-allowed opacity-40 hover:bg-surface-2 hover:text-ink-2',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Two-way segmented switch (亮度 | 色温). */
export function Toggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-surface-2 p-0.5 ring-1 ring-inset ring-line">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors',
              on ? 'bg-surface-4 text-ink-1 ring-1 ring-inset ring-line-strong' : 'text-ink-3 hover:text-ink-1',
              o.disabled && 'cursor-not-allowed opacity-40 hover:text-ink-3',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Link styled as a button; external links open a new tab. */
export function LinkButton({
  href,
  children,
  variant = 'secondary',
  external,
  icon,
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  external?: boolean;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
        variant === 'primary' && 'bg-accent text-white shadow-[0_6px_24px_rgba(76,141,255,0.35)] hover:bg-accent-hover',
        variant === 'secondary' && 'bg-surface-3 text-ink-1 ring-1 ring-inset ring-line hover:bg-surface-4',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-3 hover:text-ink-1',
        className,
      )}
    >
      {icon}
      {children}
      {external && <ArrowUpRight size={14} className="-mr-0.5 opacity-70" aria-hidden />}
    </a>
  );
}

/** One data-type section of the device / compare page. */
export function SectionCard({
  id,
  type,
  title,
  sub,
  controls,
  children,
  className,
}: {
  id?: string;
  type: DataType;
  title?: string;
  sub?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('scroll-mt-20 rounded-[28px] bg-surface-1/80 p-4 ring-1 ring-inset ring-line sm:p-6 lg:p-8', className)}>
      <header className="mb-5 flex flex-col gap-4 lg:mb-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-ink-3">
            <TypeIcon type={type} size={16} />
            <span className="text-xs font-medium tracking-wide">{TYPE_META[type].sub}</span>
          </div>
          <h2 className="mt-1.5 text-[26px] font-semibold leading-8 tracking-tight text-ink-1 sm:text-[30px] sm:leading-9">{title ?? TYPE_META[type].label}</h2>
          {sub && <div className="mt-1.5 text-[13px] leading-5 text-ink-3">{sub}</div>}
        </div>
        {controls && <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">{controls}</div>}
      </header>
      {children}
    </section>
  );
}

/** Collapsed details block (closed by default). */
export function More({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <details className={cn('group rounded-2xl bg-surface-2/60 ring-1 ring-inset ring-line', className)}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-[13px] font-medium text-ink-2 hover:text-ink-1">
        <ChevronRight size={15} className="transition-transform group-open:rotate-90" aria-hidden />
        {title}
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

/** "label · value" rows inside More. */
export function KV({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line/70 pb-2">
          <dt className="shrink-0 text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-right tabular-nums text-ink-1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Explicit empty state: the status word, never a blank area. */
export function Missing({ text, detail, className }: { text: string; detail?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-[120px] flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center',
        className,
      )}
    >
      <div className="text-[15px] font-medium text-ink-2">{text}</div>
      {detail && <div className="mt-1.5 max-w-md text-xs leading-5 text-ink-3">{detail}</div>}
    </div>
  );
}

export function Loading({ className }: { className?: string }) {
  return <div className={cn('h-40 animate-pulse rounded-2xl bg-surface-2/60', className)} aria-label="加载中" />;
}

/** Compare slot key (A blue / B orange): a coloured bar + the device name. */
export function SlotKey({ slot, name, className }: { slot: 0 | 1; name: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className={cn('h-4 w-1.5 shrink-0 rounded-full', slot === 0 ? 'bg-slot-a' : 'bg-slot-b')} aria-hidden />
      <span className="truncate text-[15px] font-semibold text-ink-1" title={name}>
        {name}
      </span>
    </div>
  );
}

export const SLOT_COLOR = ['#4c8dff', '#e0703a'] as const;

/** Full-bleed soft glow behind a page hero (the hero itself stays in the content column). */
export function Glow() {
  return <div className="db-glow pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2" aria-hidden />;
}
