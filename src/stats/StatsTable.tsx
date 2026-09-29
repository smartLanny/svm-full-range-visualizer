import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Box } from 'lucide-react';
import type { Lang } from '../types';
import type { RecordStyle } from '../data/colors';
import { deviceLabel, modeLabel } from '../data/records';
import { fmtNits } from '../data/grid';
import { SVM_AT_NITS } from '../data/stats';
import { useT } from '../i18n';
import { IconButton, cn } from '../ui';
import { fmtNitsOrDash, fmtPct, markOf, metricByKey, type MetricKey, type Ranking, type SortDir, type SortKey, type StatsRow } from './model';
import { CaveatMark, caveatText, CoverageValue, ExclusionBadge, RecordKey, ShareBar, SvmValue } from './parts';

interface Props {
  rows: StatsRow[];
  styles: Map<string, RecordStyle>;
  lang: Lang;
  rank: Ranking;
  /** The scroll container is scrolled horizontally: the sticky record column casts a shadow. */
  scrolledX: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Gray level of the slice behind the SVM@nits columns. */
  sliceGray: number;
  onSort: (key: SortKey) => void;
  onOpen3d: (id: string) => void;
}

/** Height of the first header row; the second row sticks right below it. */
const ROW1 = 26;
const TH = 'sticky z-20 border-b border-line-strong bg-surface-2 p-0 font-medium';

interface HeaderProps {
  k: SortKey;
  label: string;
  sub?: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
  rowSpan?: number;
  top?: number;
  title?: string;
}

function SortHeader({ k, label, sub, sortKey, sortDir, onSort, align = 'right', className, rowSpan, top = 0, title }: HeaderProps) {
  const active = sortKey === k;
  const Icon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      scope="col"
      rowSpan={rowSpan}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(TH, className)}
      style={{ top }}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'group/h relative flex h-full w-full items-center whitespace-nowrap py-1.5 text-xs transition-colors hover:text-ink-1',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring',
          align === 'right' ? 'justify-end pl-3 pr-[22px] text-right' : 'justify-start gap-1 px-4 text-left',
          active ? 'text-ink-1' : 'text-ink-3',
        )}
      >
        <span className={cn('flex flex-col leading-tight', align === 'right' ? 'items-end' : 'items-start')}>
          <span>{label}</span>
          {sub && <span className="text-2xs font-normal text-ink-4">{sub}</span>}
        </span>
        <Icon
          size={11}
          className={cn(
            'shrink-0',
            align === 'right' && 'absolute right-1.5 top-1/2 -translate-y-1/2',
            active ? 'text-accent-hover' : 'opacity-0 group-hover/h:opacity-60',
          )}
        />
      </button>
    </th>
  );
}

type Mark = 'best' | 'caveat' | null;

function Cell({ children, mark, caveat, className }: { children: React.ReactNode; mark?: Mark; caveat?: string; className?: string }) {
  return (
    <td className={cn('whitespace-nowrap px-2 py-2 text-right tabular-nums', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-end gap-1 rounded px-1.5 py-0.5',
          mark === 'best' ? 'bg-accent/15 font-semibold text-accent-hover ring-1 ring-inset ring-accent/30' : 'text-ink-1',
        )}
      >
        {mark === 'caveat' && caveat && <CaveatMark title={caveat} />}
        {children}
      </span>
    </td>
  );
}

export function StatsTable({ rows, styles, lang, rank, scrolledX, sortKey, sortDir, sliceGray, onSort, onOpen3d }: Props) {
  const t = useT();
  const hp = { sortKey, sortDir, onSort };
  const markFor = (k: MetricKey, row: StatsRow) => markOf(rank, k, row, metricByKey(k).value(row.stats));
  const valueCaveat = t('stats.caveat.value');
  // Shadow on the sticky record column once the table is scrolled sideways (content slides under it).
  const stickyShadow = scrolledX ? 'shadow-[6px_0_10px_-4px_rgba(0,0,0,0.65)] [clip-path:inset(0_-16px_0_0)]' : '';

  return (
    <div className="rounded-xl bg-surface-1 ring-1 ring-inset ring-line">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr style={{ height: ROW1 }}>
            <SortHeader
              k="name"
              rowSpan={2}
              label={t('stats.col.record')}
              align="left"
              className={cn('left-0 z-30 rounded-tl-xl transition-shadow', stickyShadow)}
              {...hp}
            />
            <th rowSpan={2} scope="col" className={cn(TH, 'top-0 px-2 text-left text-xs text-ink-3')}>
              {t('stats.col.dist')}
            </th>
            <SortHeader k="safe" rowSpan={2} label={t('stats.col.safe')} sub="SVM < 0.4" {...hp} />
            <SortHeader k="mid" rowSpan={2} label={t('stats.col.mid')} sub="0.4 – 1.0" {...hp} />
            <SortHeader k="critical" rowSpan={2} label={t('stats.col.critical')} sub="≥ 1.0" {...hp} />
            <SortHeader k="fullWhite" rowSpan={2} label={t('stats.col.fullWhite')} sub="nits" title={t('stats.metric.fullWhiteHint')} {...hp} />
            <SortHeader k="peak" rowSpan={2} label={t('stats.col.peak')} sub={t('stats.col.peakWhere')} title={t('stats.metric.peakHint')} {...hp} />
            <SortHeader k="mean" rowSpan={2} label={t('stats.col.mean')} sub={t('stats.metric.meanHint')} {...hp} />
            <th
              colSpan={SVM_AT_NITS.length}
              scope="colgroup"
              className="sticky top-0 z-20 border-b border-line bg-surface-2 px-3 pt-1.5 text-center text-xs font-medium text-ink-2"
              title={t('stats.metric.svmAtHint')}
            >
              {t('stats.col.atGroup', { g: Math.round(sliceGray) })}
            </th>
            <SortHeader
              k="coverage"
              rowSpan={2}
              label={t('stats.col.coverage')}
              sub={t('stats.col.coverageSub')}
              title={t('stats.metric.coverageHint')}
              {...hp}
            />
            <th rowSpan={2} className={cn(TH, 'top-0 w-9 rounded-tr-xl')} />
          </tr>
          <tr>
            {SVM_AT_NITS.map((n, i) => (
              <SortHeader key={n} k={`at${i}` as MetricKey} label={String(n)} sub="nits" top={ROW1} {...hp} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const { rec, stats: s } = row;
            const last = i === rows.length - 1;
            const mode = modeLabel(rec, lang);
            const caveat = caveatText(rank, rec, s, t);
            return (
              <tr key={rec.id} className={cn('group', !last && '[&>td]:border-b [&>td]:border-line')}>
                <td
                  className={cn(
                    'sticky left-0 z-10 max-w-[280px] bg-surface-1 py-2 pl-4 pr-3 transition-[background-color,box-shadow] group-hover:bg-surface-3',
                    stickyShadow,
                    last && 'rounded-bl-xl',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <RecordKey style={styles.get(rec.id)} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink-1">{deviceLabel(rec, lang)}</div>
                      {(!!mode || !!caveat || !!rec.excluded?.length) && (
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          {mode && (
                            <span className="max-w-full truncate text-2xs text-ink-3" title={mode}>
                              {mode}
                            </span>
                          )}
                          <ExclusionBadge rec={rec} stats={s} />
                          {caveat && <CaveatMark title={caveat} />}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="w-24 min-w-[88px] px-2 py-2 transition-colors group-hover:bg-surface-3">
                  {s.cellCount > 0 ? <ShareBar stats={s} height="h-2" legend={false} compact /> : null}
                </td>
                {/* remaining cells share the row hover */}
                <Cell className="group-hover:bg-surface-3" mark={markFor('safe', row)} caveat={valueCaveat}>
                  {fmtPct(s.safeShare)}
                </Cell>
                <Cell className="group-hover:bg-surface-3">{fmtPct(s.midShare)}</Cell>
                <Cell className="group-hover:bg-surface-3" mark={markFor('critical', row)} caveat={valueCaveat}>
                  {fmtPct(s.criticalShare)}
                </Cell>
                <Cell className="group-hover:bg-surface-3" mark={markFor('fullWhite', row)} caveat={valueCaveat}>
                  {s.fullWhiteSafeNits === null ? <span className="text-ink-4">—</span> : fmtNitsOrDash(s.fullWhiteSafeNits)}
                </Cell>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums group-hover:bg-surface-3">
                  <span
                    className={cn(
                      'inline-flex flex-col items-end rounded px-1.5 py-0.5',
                      markFor('peak', row) === 'best' && 'bg-accent/15 ring-1 ring-inset ring-accent/30',
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {markFor('peak', row) === 'caveat' && <CaveatMark title={valueCaveat} />}
                      <SvmValue v={s.peak?.svm ?? null} className={markFor('peak', row) === 'best' ? 'font-semibold text-accent-hover' : 'text-ink-1'} />
                    </span>
                    {s.peak && <span className="text-2xs text-ink-3">{t('stats.metric.peakWhere', { g: s.peak.gray, n: fmtNits(s.peak.levelNits) })}</span>}
                  </span>
                </td>
                <Cell className="group-hover:bg-surface-3" mark={markFor('mean', row)} caveat={valueCaveat}>
                  <SvmValue v={s.meanSvm} />
                </Cell>
                {s.svmAt.map((a, k) => (
                  <Cell key={a.nits} className="group-hover:bg-surface-3" mark={markFor(`at${k}` as MetricKey, row)} caveat={valueCaveat}>
                    <SvmValue v={a.svm} />
                  </Cell>
                ))}
                <td className="whitespace-nowrap px-2 py-2 pr-3 text-right group-hover:bg-surface-3">
                  <CoverageValue stats={s} caveat={caveat} className="px-1.5 py-0.5" />
                </td>
                <td className={cn('px-1 py-2 text-right group-hover:bg-surface-3', last && 'rounded-br-xl')}>
                  <IconButton
                    size="xs"
                    label={t('stats.openIn3d')}
                    icon={<Box size={13} />}
                    onClick={() => onOpen3d(rec.id)}
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
