import React from 'react';
import { cn } from './cn';

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded border border-line-strong bg-surface-3 px-1 font-mono text-[10px] leading-none text-ink-2', className)}>
      {children}
    </kbd>
  );
}

/** Small color swatch that opens the native color picker. */
export function ColorSwatch({ color, onChange, label, className }: { color: string; onChange: (c: string) => void; label: string; className?: string }) {
  return (
    <label title={label} className={cn('relative inline-flex h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[4px] ring-1 ring-inset ring-white/15', className)} style={{ background: color }}>
      <input type="color" aria-label={label} value={color} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div className={cn('inline-flex h-7 items-center rounded-md bg-surface-3 ring-1 ring-inset ring-line focus-within:ring-2 focus-within:ring-accent-ring', className)}>
      <input
        type="number"
        aria-label={ariaLabel}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
        }}
        className="h-full w-full min-w-0 bg-transparent px-2 font-mono text-xs tabular-nums text-ink-1 outline-none"
      />
      {suffix && <span className="pr-2 text-2xs text-ink-3">{suffix}</span>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'safe' | 'critical'; className?: string }) {
  const tones = {
    neutral: 'bg-surface-4 text-ink-2',
    accent: 'bg-accent-muted text-accent-hover',
    safe: 'bg-safe/15 text-green-300',
    critical: 'bg-critical/15 text-red-300',
  };
  return <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium', tones[tone], className)}>{children}</span>;
}
