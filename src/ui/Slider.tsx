import React, { useId } from 'react';
import { cn } from './cn';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Logarithmic mapping of the thumb position (min must be > 0). */
  log?: boolean;
  label?: React.ReactNode;
  /** Formats the value shown at the right of the label. */
  format?: (v: number) => string;
  /** Quick-pick values shown as chips under the slider. */
  presets?: { value: number; label: string }[];
  className?: string;
  disabled?: boolean;
}

const RES = 1000;

/** Range slider with label/value row and optional preset chips. */
export function Slider({ value, onChange, min, max, step = 1, log, label, format, presets, className, disabled }: SliderProps) {
  const id = useId();
  const toPos = (v: number) =>
    log ? (Math.log(v / min) / Math.log(max / min)) * RES : ((v - min) / (max - min)) * RES;
  const fromPos = (p: number) => {
    const raw = log ? min * Math.pow(max / min, p / RES) : min + ((max - min) * p) / RES;
    if (log) return Number(raw.toPrecision(3));
    return Math.round(raw / step) * step;
  };
  const pos = Math.max(0, Math.min(RES, toPos(value)));
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || format) && (
        <div className="flex items-center justify-between text-xs">
          <label htmlFor={id} className="text-ink-2">
            {label}
          </label>
          <span className="font-mono tabular-nums text-ink-1">{format ? format(value) : value}</span>
        </div>
      )}
      <input
        id={id}
        type="range"
        min={0}
        max={RES}
        step={log ? 1 : (step / (max - min)) * RES}
        value={pos}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, fromPos(Number(e.target.value)))))}
        className="svm-range w-full"
        style={{ ['--pos' as string]: `${(pos / RES) * 100}%` }}
      />
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(p.value)}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-2xs tabular-nums ring-1 ring-inset transition-colors',
                Math.abs(p.value - value) < 1e-9
                  ? 'bg-accent-muted text-accent-hover ring-accent/40'
                  : 'text-ink-3 ring-line hover:text-ink-1 hover:ring-line-strong',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
