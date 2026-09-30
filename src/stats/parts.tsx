import React from 'react';
import { Sparkles, TriangleAlert } from 'lucide-react';
import type { SvmRecord } from '../types';
import type { RecordStyle } from '../data/colors';
import type { RecordStats } from '../data/stats';
import { displayNotes } from '../data/denoise';
import { countParts, kindParts } from '../data/denoiseText';
import { useT, type TFunction } from '../i18n';
import { cn } from '../ui';
import { band, BAND_COLORS, fmtPct, type Ranking } from './model';

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
export function ShareBar({
  stats,
  height = 'h-5',
  legend = true,
  compact = false,
  extra,
}: {
  stats: RecordStats;
  height?: string;
  legend?: boolean;
  compact?: boolean;
  /** Appended to the legend line (e.g. the coverage read-out). */
  extra?: React.ReactNode;
}) {
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
          {extra}
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

/** Cells the denoise changed inside the stats scope (docs/adr/0012 addendum). */
export const denoisedInScope = (stats: RecordStats) => stats.denoise.interpolated + stats.denoise.noData + stats.denoise.lumEstimated;

/**
 * Tooltip of a record's denoise badge: counts inside the scope ("降噪：插值补全 2 格，无有效数据 9 格"),
 * what the denoise found in the whole record, the coverage rule and where the raw readings are.
 */
export function denoiseTooltip(rec: SvmRecord, stats: RecordStats, t: TFunction): string | null {
  const sum = displayNotes(rec)?.summary;
  if (!sum) return null;
  return [
    t('stats.denoise.inScope', { parts: countParts(stats.denoise, t).join('，') || t('stats.denoise.none') }),
    t('stats.denoise.record', { parts: countParts(sum, t).join('，') }),
    kindParts(sum.byKind, t).join(' · '),
    t('stats.denoise.coverage'),
    '',
    t('common.denoise.detail'),
  ].join('\n');
}

/** Calm badge '降噪 N 格' (cells the denoise changed inside the scope); nothing when none. */
export function DenoiseBadge({ rec, stats, className }: { rec: SvmRecord; stats: RecordStats; className?: string }) {
  const t = useT();
  const n = denoisedInScope(stats);
  if (!n) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 cursor-help items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-2xs font-medium leading-4',
        'bg-surface-4 text-ink-2 ring-1 ring-inset ring-line-strong',
        className,
      )}
      title={denoiseTooltip(rec, stats, t) ?? undefined}
      data-testid="stats-denoise-badge"
    >
      <Sparkles size={10} className="shrink-0 text-sky-300/90" aria-hidden />
      {t('common.denoise.badge', { n })}
    </span>
  );
}

/** Row-level caveat text for a low-coverage record (null when the row is comparable). */
export function caveatText(rank: Ranking, rec: SvmRecord, stats: RecordStats, t: TFunction): string | null {
  if (!rank.low.has(rec.id) || stats.coverageShare === null || rank.medianCoverage === null) return null;
  return t('stats.caveat.row', { c: fmtPct(stats.coverageShare), m: fmtPct(rank.medianCoverage) });
}

/** Small amber marker used instead of the "best" highlight on low-coverage rows. */
export function CaveatMark({ title, className }: { title: string; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 cursor-help items-center text-amber-300', className)} title={title} aria-label={title} role="img">
      <TriangleAlert size={11} />
    </span>
  );
}

/** Coverage value (valid area share) with the valid / nominal cell count; amber + marker when low. */
export function CoverageValue({ stats, caveat, className, sub = true }: { stats: RecordStats; caveat: string | null; className?: string; sub?: boolean }) {
  const t = useT();
  const title = [t('stats.metric.coverageHint'), t('common.denoise.coverage', { valid: stats.cellCount, nominal: stats.nominalCount }), caveat]
    .filter(Boolean)
    .join('\n\n');
  return (
    <span className={cn('inline-flex flex-col items-end tabular-nums', className)} title={title}>
      <span className={cn('inline-flex items-center gap-1', caveat ? 'text-amber-300' : 'text-ink-1')}>
        {caveat && <TriangleAlert size={11} className="shrink-0" aria-hidden />}
        {fmtPct(stats.coverageShare)}
      </span>
      {sub && <span className="text-2xs text-ink-3">{t('common.denoise.coverage', { valid: stats.cellCount, nominal: stats.nominalCount })}</span>}
    </span>
  );
}
