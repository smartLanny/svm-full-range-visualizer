import React from 'react';
import { cn } from './cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Single-choice pill group. */
export function Segmented<T extends string>({ value, onChange, options, size = 'sm', fullWidth, className, ...rest }: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className={cn('inline-flex rounded-lg bg-surface-1 p-0.5 ring-1 ring-inset ring-line', fullWidth && 'flex w-full', className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-sm',
              fullWidth && 'flex-1',
              selected ? 'bg-surface-4 text-ink-1 shadow-sm shadow-black/40 ring-1 ring-inset ring-line-strong' : 'text-ink-3 hover:text-ink-1',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
