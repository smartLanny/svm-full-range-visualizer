import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  group?: string;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  disabled?: boolean;
  /** Shown (disabled) when `value` matches no option, instead of the browser showing the first option. */
  placeholder?: string;
  title?: string;
}

/** Styled native select (keyboard + screen-reader friendly). Options with `group` are grouped. */
export function Select<T extends string>({ value, onChange, options, className, size = 'sm', disabled, placeholder, title, ...rest }: SelectProps<T>) {
  const known = options.some((o) => o.value === value);
  const groups: { name: string | undefined; items: SelectOption<T>[] }[] = [];
  for (const o of options) {
    const g = groups.find((x) => x.name === o.group);
    if (g) g.items.push(o);
    else groups.push({ name: o.group, items: [o] });
  }
  return (
    <div className={cn('relative inline-flex', className)}>
      <select
        aria-label={rest['aria-label']}
        title={title}
        value={known ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          'w-full appearance-none rounded-md bg-surface-3 pr-7 text-ink-1 ring-1 ring-inset ring-line transition-colors hover:bg-surface-4',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40',
          size === 'sm' ? 'h-7 pl-2 text-xs' : 'h-8 pl-3 text-sm',
        )}
      >
        {!known && (
          <option value="" disabled hidden={!placeholder}>
            {placeholder ?? ''}
          </option>
        )}
        {groups.map((g) =>
          g.name ? (
            <optgroup key={g.name} label={g.name}>
              {g.items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.items.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ),
        )}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3" />
    </div>
  );
}
