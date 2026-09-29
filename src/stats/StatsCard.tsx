import React from 'react';
import { Box } from 'lucide-react';
import type { ColormapType, Lang } from '../types';
import type { RecordStyle } from '../data/colors';
import { deviceLabel, modeLabel } from '../data/records';
import { fmtNits } from '../data/grid';
import { useT } from '../i18n';
import { Badge, Button, cn } from '../ui';
import { fmtSvmOrDash, markOf, type MetricKey, type Ranking, type StatsRow } from './model';
import { CaveatMark, caveatText, CoverageValue, ExclusionBadge, RecordKey, ShareBar, SvmValue } from './parts';
import { Thumbnail, type ThumbExtent } from './Thumbnail';

interface Props {
  row: StatsRow;
  style: RecordStyle | undefined;
  lang: Lang;
  rank: Ranking;
  clipLowGray: boolean;
  maxNits: number | null;
  colormap: ColormapType;
  colorMax: number;
  extent: ThumbExtent | null;
  onOpen3d: (id: string) => void;
}

type Mark = 'best' | 'caveat' | null;

function Metric({
  label,
  hint,
  children,
  sub,
  mark,
  caveat,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  mark?: Mark;
  caveat: string;
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="truncate text-[11px] leading-4 text-ink-3">{label}</div>
      <div
        className={cn(
          'mt-0.5 flex items-center gap-1 truncate text-[15px] font-semibold leading-5 tabular-nums',
          mark === 'best' ? 'text-accent-hover' : 'text-ink-1',
        )}
      >
        {mark === 'caveat' && <CaveatMark title={caveat} />}
        {children}
      </div>
      {sub && <div className="truncate text-2xs tabular-nums text-ink-3">{sub}</div>}
    </div>
  );
}

export function StatsCard({ row, style, lang, rank, clipLowGray, maxNits, colormap, colorMax, extent, onOpen3d }: Props) {
  const t = useT();
  const { rec, stats: s } = row;
  const device = deviceLabel(rec, lang);
  const mode = modeLabel(rec, lang);
  const empty = s.cellCount === 0;
  const mark = (k: MetricKey, v: number | null) => markOf(rank, k, row, v);
  const caveat = caveatText(rank, rec, s, t);
  const valueCaveat = t('stats.caveat.value');
  const safeMark = mark('safe', s.safeShare);
  const critMark = mark('critical', s.criticalShare);

  return (
    <article className="group flex min-w-0 flex-col rounded-xl bg-surface-2 ring-1 ring-inset ring-line transition-shadow hover:ring-line-strong">
      {/* header */}
      <header className="px-4 pb-3 pt-3.5">
        <div className="flex items-start gap-2.5">
          <RecordKey style={style} className="mt-1" />
          {/* a long name wraps (two lines at most) rather than losing its last word to the button */}
          <div className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold text-ink-1" title={device}>
            {device}
          </div>
          {/* -my-0.5: the 24 px button does not make the 20 px title row taller */}
          <Button size="xs" variant="ghost" icon={<Box size={13} />} onClick={() => onOpen3d(rec.id)} className="-my-0.5 -mr-1.5 shrink-0 text-ink-3 group-hover:text-ink-1">
            {t('stats.openIn3d')}
          </Button>
        </div>
        {/* The mode tells sibling cards apart ("… Pro off" / "… Pro on"): it gets its own line the
            full width of the card under the title row (aligned with the name, not sharing the row
            with the button), wraps onto a second line before it is cut, and the badge wraps under it. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pl-[50px]" data-testid="stats-card-mode">
          <span className="line-clamp-2 max-w-full break-words text-xs text-ink-3" title={mode}>
            {mode || ' '}
          </span>
          <ExclusionBadge rec={rec} stats={s} />
        </div>
      </header>

      {empty ? (
        <div className="mx-4 mb-4 flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-line-strong py-10 text-center">
          <div className="text-xs text-ink-2">{t('stats.noCells')}</div>
          <div className="mt-1 text-2xs text-ink-3">{t('stats.noCellsHint')}</div>
        </div>
      ) : (
        <>
          {/* hero: safe share */}
          <div className="px-4" title={t('stats.metric.safeShareHint')}>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="flex h-4 items-center gap-1.5 text-xs text-ink-2">
                  {t('stats.metric.safeShare')}
                  {safeMark === 'best' && (
                    <Badge tone="accent" className="py-0 leading-4">
                      {t('stats.best')}
                    </Badge>
                  )}
                  {safeMark === 'caveat' && <CaveatMark title={valueCaveat} />}
                </div>
                <div className="mt-0.5 text-[34px] font-semibold leading-none tracking-tight tabular-nums text-ink-1">
                  {s.safeShare === null ? '—' : (s.safeShare * 100).toFixed(1)}
                  <span className="ml-0.5 text-lg font-medium text-ink-3">%</span>
                </div>
              </div>
              <div className="text-right" title={t('stats.band.criticalRange')}>
                <div className="h-4 text-xs leading-4 text-ink-2">{t('stats.col.critical')}</div>
                <div
                  className={cn(
                    'mt-1 flex items-center justify-end gap-1 text-xl font-semibold leading-none tabular-nums',
                    critMark === 'best' ? 'text-accent-hover' : 'text-ink-1',
                  )}
                >
                  {critMark === 'caveat' && <CaveatMark title={valueCaveat} />}
                  {s.criticalShare === null ? '—' : (s.criticalShare * 100).toFixed(1)}
                  <span className="ml-0.5 text-sm font-medium text-ink-3">%</span>
                </div>
              </div>
            </div>
            <div className="mt-3">
              <ShareBar
                stats={s}
                extra={
                  <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap">
                    {t('stats.metric.coverage')}
                    <CoverageValue stats={s} caveat={caveat} sub={false} />
                  </span>
                }
              />
            </div>
          </div>

          {/* key metrics */}
          <div className="mx-4 mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
            <Metric
              label={t('stats.metric.fullWhite')}
              hint={t('stats.metric.fullWhiteHint')}
              mark={mark('fullWhite', s.fullWhiteSafeNits)}
              caveat={valueCaveat}
              sub={
                s.fullWhiteSafeNits === null ? (
                  <span className="text-red-300">{t('stats.metric.fullWhiteNever')}</span>
                ) : s.fullWhiteAllSafe ? (
                  t('stats.metric.fullWhiteAll')
                ) : (
                  t('stats.metric.fullWhiteFrom')
                )
              }
            >
              {s.fullWhiteSafeNits === null ? (
                <span className="text-ink-4">—</span>
              ) : (
                <>
                  {fmtNits(s.fullWhiteSafeNits)}
                  <span className="ml-1 text-2xs font-normal text-ink-3">nits</span>
                </>
              )}
            </Metric>
            <Metric
              label={t('stats.metric.peak')}
              hint={t('stats.metric.peakHint')}
              mark={mark('peak', s.peak?.svm ?? null)}
              caveat={valueCaveat}
              sub={s.peak ? t('stats.metric.peakWhere', { g: s.peak.gray, n: fmtNits(s.peak.levelNits) }) : undefined}
            >
              {fmtSvmOrDash(s.peak?.svm ?? null)}
            </Metric>
            <Metric
              label={t('stats.metric.mean')}
              hint={t('stats.metric.meanHint')}
              mark={mark('mean', s.meanSvm)}
              caveat={valueCaveat}
              sub={t('stats.metric.meanHint')}
            >
              {fmtSvmOrDash(s.meanSvm)}
            </Metric>
          </div>

          {/* heatmap thumbnail */}
          {extent && (
            <div className="mx-4 mt-4">
              <Thumbnail
                rec={rec}
                clipLowGray={clipLowGray}
                maxNits={maxNits}
                colormap={colormap}
                colorMax={colorMax}
                sliceGray={s.sliceGray}
                extent={extent}
              />
            </div>
          )}

          {/* SVM at typical luminances */}
          <div className="mx-4 mb-4 mt-3 rounded-lg bg-surface-1 px-3 py-2.5 ring-1 ring-inset ring-line" title={t('stats.metric.svmAtHint')}>
            <div className="flex items-baseline justify-between text-2xs text-ink-3">
              <span>{t('stats.metric.svmAt')}</span>
              {s.sliceGray !== null && <span className="tabular-nums">{t('stats.metric.svmAtSlice', { g: Math.round(s.sliceGray) })}</span>}
            </div>
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              {s.svmAt.map((a, i) => {
                const m = mark(`at${i}` as MetricKey, a.svm);
                return (
                  <div key={a.nits} className="min-w-0">
                    <div className="text-2xs tabular-nums text-ink-4">{a.nits} nits</div>
                    <span className="inline-flex items-center gap-1">
                      <SvmValue v={a.svm} className={cn('text-sm font-medium', m === 'best' ? 'text-accent-hover' : 'text-ink-1')} />
                      {m === 'caveat' && <CaveatMark title={valueCaveat} />}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </article>
  );
}
