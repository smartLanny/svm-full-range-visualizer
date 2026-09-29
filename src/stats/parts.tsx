import React from 'react';
import type { RecordStyle } from '../data/colors';
import type { RecordStats } from '../data/stats';
import { useT } from '../i18n';
import { cn } from '../ui';
import { band, BAND_COLORS, fmtPct } from './model';

/** Device colour chip + a line sample in the record's mode dash (same encoding as the 2D chart). */
export function RecordKey({ style, className }: { style: RecordStyle | undefined; className?: string }) {
  const color = style?.color ?? '#7d8796';
  const dash = style?.dash ?? [];
  // Scale the canvas dash (px at 1x, 2px line) to this 22px sample.
  const dashArray = dash.length ? dash.map((d) => d * 0.6).join(' ') : undefined;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)} aria-hidden>
      <span className="h-3 w-3 rounded-[3px] ring-1 ring-inset ring-white/15" style={{ background: color }} />
      <svg width="22" height="8" viewBox="0 0 22 8" className="overflow-visible">
        <line x1="0" y1="4" x2="22" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashArray} strokeLinecap={dash.length ? 'butt' : 'round'} />
      </svg>
    </span>
  );
}

const BANDS = ['safe', 'mid', 'critical'] as const;

/**
 * Stacked safe / mid / critical share bar. Colours are always paired with text: segments wide
 * enough carry their percentage; `legend` adds a labelled line underneath.
 */
export function ShareBar({ stats, height = 'h-5', legend = true, compact = false }: { stats: RecordStats; height?: string; legend?: boolean; compact?: boolean }) {
  const t = useT();
  const shares = { safe: stats.safeShare ?? 0, mid: stats.midShare ?? 0, critical: stats.criticalShare ?? 0 };
  const title = BANDS.map((b) => `${t(`stats.band.${b}`)} (${t(`stats.band.${b}Range`)}): ${fmtPct(shares[b])}`).join('\n');
  return (
    <div title={title}>
      <div className={cn('flex w-full overflow-hidden rounded', height, compact ? 'bg-surface-4' : 'bg-surface-3')}>
        {BANDS.map((b) =>
          shares[b] > 0 ? (
            <div
              key={b}
              className="flex min-w-0 items-center justify-center overflow-hidden text-2xs font-semibold tabular-nums text-black/75 [&:not(:last-child)]:border-r [&:not(:last-child)]:border-black/40"
              style={{ width: `${shares[b] * 100}%`, background: BAND_COLORS[b] }}
            >
              {!compact && shares[b] >= 0.13 ? fmtPct(shares[b], 0) : null}
            </div>
          ) : null,
        )}
      </div>
      {legend && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-3">
          {BANDS.map((b) => (
            <span key={b} className="inline-flex items-center gap-1 whitespace-nowrap">
              <span className="h-2 w-2 rounded-sm" style={{ background: BAND_COLORS[b] }} />
              {t(`stats.band.${b}`)}
              <span className="tabular-nums text-ink-2">{fmtPct(shares[b])}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** SVM value with its status: coloured dot + number; band name in the tooltip. */
export function SvmValue({ v, className, digits = 2 }: { v: number | null; className?: string; digits?: number }) {
  const t = useT();
  if (v === null || !Number.isFinite(v)) return <span className={cn('text-ink-4', className)}>—</span>;
  const b = band(v);
  return (
    <span className={cn('inline-flex items-center gap-1.5 tabular-nums', className)} title={`${t(`stats.band.${b}`)} · ${t(`stats.band.${b}Range`)}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: BAND_COLORS[b] }} />
      {v.toFixed(digits)}
    </span>
  );
}
