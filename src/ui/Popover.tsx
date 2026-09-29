import React, { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

export interface PopoverProps {
  /** Render the trigger; call toggle() on click. */
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  align?: 'left' | 'right';
  className?: string;
}

/** Click-to-open floating panel anchored under its trigger. Closes on outside click / Esc. */
export function Popover({ trigger, children, align = 'right', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cn(
            'absolute top-full z-40 mt-2 min-w-[220px] rounded-xl bg-surface-2 p-1.5 shadow-panel ring-1 ring-line',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
}

export function MenuItem({ icon, hint, danger, className, children, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-40',
        danger ? 'text-red-300 hover:bg-critical/15' : 'text-ink-1 hover:bg-surface-4',
        className,
      )}
      {...rest}
    >
      {icon && <span className="text-ink-3">{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-2xs text-ink-3">{hint}</span>}
    </button>
  );
}
