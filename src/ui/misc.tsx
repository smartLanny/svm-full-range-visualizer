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

/**
 * Numeric field that lets the user type freely: the text is kept as typed and `onChange` fires
 * only for a finite value inside [min, max]. An out-of-range or unparsable entry is flagged
 * (with `errorText` below the field) instead of being rewritten; on blur / Enter the text is
 * normalised — clamped into range, or reverted to the last valid value when it is not a number.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className,
  errorText,
  id,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  /** Shown under the field while the typed text is not a valid value. */
  errorText?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  const [draft, setDraft] = React.useState(() => (Number.isFinite(value) ? String(value) : ''));
  const editing = React.useRef(false);
  // Follow outside changes (reset, presets) unless the user is typing.
  React.useEffect(() => {
    if (!editing.current) setDraft(Number.isFinite(value) ? String(value) : '');
  }, [value]);
  const parsed = draft.trim() === '' ? NaN : Number(draft.trim());
  const invalid = !(Number.isFinite(parsed) && parsed >= lo && parsed <= hi);
  const commit = () => {
    editing.current = false;
    if (Number.isFinite(parsed)) {
      const v = Math.min(hi, Math.max(lo, parsed));
      if (v !== value) onChange(v);
      setDraft(String(v));
    } else setDraft(Number.isFinite(value) ? String(value) : '');
  };
  const errId = React.useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          'inline-flex h-7 items-center rounded-md bg-surface-3 ring-1 ring-inset focus-within:ring-2',
          invalid ? 'ring-critical/60 focus-within:ring-critical/70' : 'ring-line focus-within:ring-accent-ring',
          className,
        )}
      >
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid && errorText ? errId : undefined}
          value={draft}
          onFocus={() => (editing.current = true)}
          onChange={(e) => {
            editing.current = true;
            const text = e.target.value;
            setDraft(text);
            const v = text.trim() === '' ? NaN : Number(text.trim());
            if (Number.isFinite(v) && v >= lo && v <= hi && v !== value) onChange(v);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const base = Number.isFinite(parsed) ? parsed : value;
              const next = Math.min(hi, Math.max(lo, Number((base + (e.key === 'ArrowUp' ? step : -step)).toFixed(6))));
              setDraft(String(next));
              if (next !== value) onChange(next);
            }
          }}
          className="h-full w-full min-w-0 bg-transparent px-2 font-mono text-xs tabular-nums text-ink-1 outline-none"
        />
        {suffix && <span className="pr-2 text-2xs text-ink-3">{suffix}</span>}
      </div>
      {invalid && errorText && (
        <span id={errId} role="alert" className="text-2xs leading-snug text-red-300">
          {errorText}
        </span>
      )}
    </div>
  );
}

/** Labelled checkbox (native input, accent-coloured). */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  className,
  'data-testid': testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  const id = React.useId();
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded accent-[#4c8dff]"
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
        <span className="text-xs text-ink-1">{label}</span>
        {description && <span className="mt-0.5 block text-2xs leading-snug text-ink-3">{description}</span>}
      </label>
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
