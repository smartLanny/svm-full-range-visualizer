import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

export interface SectionProps {
  title: React.ReactNode;
  icon?: React.ReactNode;
  /** Right-aligned content in the header row (not part of the toggle). */
  right?: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** Inspector panel section with an uppercase caption and optional collapse. */
export function Section({ title, icon, right, defaultOpen = true, collapsible = true, children, className }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('border-b border-line px-4 py-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!collapsible}
          onClick={() => setOpen((o) => !o)}
          className="group flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink-2 disabled:cursor-default"
        >
          {collapsible && <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />}
          {icon}
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      {(open || !collapsible) && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </section>
  );
}

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Label left, control right on one row. */
  inline?: boolean;
}

export function Field({ label, hint, children, className, inline }: FieldProps) {
  return (
    <div className={cn(inline ? 'flex items-center justify-between gap-3' : 'flex flex-col gap-1.5', className)}>
      <div className="min-w-0">
        <div className="text-xs text-ink-2">{label}</div>
        {hint && <div className="mt-0.5 text-2xs leading-snug text-ink-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
