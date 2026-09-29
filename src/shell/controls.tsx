import React, { forwardRef, useId } from 'react';
import { cn } from '../ui';

/** Text input styled like the ui/ controls. */
export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type="text"
      spellCheck={false}
      {...rest}
      className={cn(
        'h-8 w-full min-w-0 rounded-md bg-surface-1 px-2.5 text-[13px] text-ink-1 ring-1 ring-inset ring-line placeholder:text-ink-4',
        'transition-shadow hover:ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
        className,
      )}
    />
  );
});

/** Label + control + hint, stacked. */
export function FormRow({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <div className="text-2xs leading-snug text-ink-3">{hint}</div>}
    </div>
  );
}

export function useFieldId(prefix: string) {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}
