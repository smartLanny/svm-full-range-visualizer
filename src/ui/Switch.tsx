import React, { useId } from 'react';
import { cn } from './cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Labelled toggle switch. */
export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-3', disabled && 'opacity-40', className)}>
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
        <div className="text-xs text-ink-1">{label}</div>
        {description && <div className="mt-0.5 text-2xs leading-snug text-ink-3">{description}</div>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
          checked ? 'bg-accent' : 'bg-surface-4 ring-1 ring-inset ring-line-strong',
        )}
      >
        <span className={cn('inline-block h-3 w-3 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}
