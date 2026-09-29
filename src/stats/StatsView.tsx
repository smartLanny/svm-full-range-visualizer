import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, BarChart3, ChevronRight, ClipboardCopy, LayoutGrid, Table2, TriangleAlert } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRecordStyles, useVisibleRecords } from '../store/hooks';
import { LOW_GRAY_CLIP } from '../types';
import { useT } from '../i18n';
import { Button, IconButton, Segmented, Select, Switch, cn, toast } from '../ui';
import { buildRows, copyText, defaultDir, METRICS, rankRows, sortRows, toTsv, type SortDir, type SortKey } from './model';
import { StatsCard } from './StatsCard';
import { StatsTable } from './StatsTable';
import { thumbExtent } from './Thumbnail';

type ViewMode = 'cards' | 'table';

const LS_KEY = 'svm.stats.ui';

/** Per-viewer UI convenience (view mode + sort); never required for correctness. */
function loadUi(): { mode: ViewMode; sortKey: SortKey; sortDir: SortDir } {
  const fallback = { mode: 'cards' as ViewMode, sortKey: 'order' as SortKey, sortDir: 'asc' as SortDir };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<typeof fallback>;
    const keys: SortKey[] = ['order', 'name', ...METRICS.map((m) => m.key)];
    return {
      mode: v.mode === 'table' ? 'table' : 'cards',
      sortKey: v.sortKey && keys.includes(v.sortKey) ? v.sortKey : 'order',
      sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
    };
  } catch {
    return fallback;
  }
}

/** Summary stats (docs/adr/0009): cards and a sortable table over the visible records. */
export default function StatsView() {
  const t = useT();
  const records = useVisibleRecords();
  const styles = useRecordStyles();
  const lang = useAppStore((s) => s.lang);
  const clipLowGray = useAppStore((s) => s.clipLowGray);
  const maxNits = useAppStore((s) => s.maxNits);
  const sliceGray = useAppStore((s) => s.sliceGray);
  const colormap = useAppStore((s) => s.colormap);
  const colorMax = useAppStore((s) => s.colorMax);
  const set = useAppStore((s) => s.set);
  const setActive = useAppStore((s) => s.setActive);
  // Pure-black presentation background (recording / keying): the page and its bars are #000.
  const presenting = useAppStore((s) => s.presenting);
  const black = useAppStore((s) => s.presenting && s.presentBlack);

  const [ui, setUi] = useState(loadUi);
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(ui));
    } catch {
      // storage unavailable (private mode / file://): keep in memory only
    }
  }, [ui]);

  const rows = useMemo(() => buildRows(records, { clipLowGray, maxNits, sliceGray }), [records, clipLowGray, maxNits, sliceGray]);
  const sorted = useMemo(() => sortRows(rows, ui.sortKey, ui.sortDir, lang), [rows, ui.sortKey, ui.sortDir, lang]);
  const rank = useMemo(() => rankRows(rows), [rows]);
  const extent = useMemo(() => thumbExtent(records, { clipLowGray, maxNits }), [records, clipLowGray, maxNits]);

  const onSort = useCallback((key: SortKey) => {
    setUi((u) => (u.sortKey === key ? { ...u, sortDir: u.sortDir === 'asc' ? 'desc' : 'asc' } : { ...u, sortKey: key, sortDir: defaultDir(key) }));
  }, []);

  const onOpen3d = useCallback(
    (id: string) => {
      setActive(id);
      set('tab', 'scene3d');
    },
    [set, setActive],
  );

  // ---- scroll body: reset when the view changes; horizontal-overflow affordance (table) ----
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hScroll, setHScroll] = useState({ left: false, right: false, gutter: 0 });
  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // Hidden overflow smaller than the body padding (p-5) is only padding: no affordance for it.
    const next = { left: el.scrollLeft > 1, right: max - el.scrollLeft > 24, gutter: el.offsetWidth - el.clientWidth };
    // Only commit real changes: scroll events never cause a re-render while nothing flips.
    setHScroll((h) => (h.left === next.left && h.right === next.right && h.gutter === next.gutter ? h : next));
  }, []);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    measure();
  }, [ui.mode, measure]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure, ui.mode, records.length]);

  const onCopy = async () => {
    try {
      await copyText(toTsv(sorted, t, lang));
      toast(t('stats.copied', { n: sorted.length }), 'success');
    } catch {
      toast(t('stats.copyFailed'), 'error');
    }
  };

  const scope = [
    clipLowGray ? t('stats.scope.clip', { g: LOW_GRAY_CLIP }) : t('stats.scope.allGray'),
    maxNits !== null ? t('stats.scope.cap', { n: maxNits }) : t('stats.scope.allLevels'),
    t('stats.scope.slice', { g: Math.round(sliceGray) }),
  ].join(' · ');

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'order', label: t('stats.sort.order') },
    { value: 'name', label: t('stats.sort.name') },
    { value: 'safe', label: t('stats.col.safe') },
    { value: 'critical', label: t('stats.col.critical') },
    { value: 'fullWhite', label: t('stats.col.fullWhite') },
    { value: 'peak', label: t('stats.col.peak') },
    { value: 'mean', label: t('stats.col.mean') },
    { value: 'at1', label: 'SVM @10 nits' },
    { value: 'at3', label: 'SVM @100 nits' },
    { value: 'coverage', label: t('stats.col.coverage') },
  ];
  const dirLabel = t(ui.sortDir === 'asc' ? 'stats.sort.asc' : 'stats.sort.desc');
  const footnote =
    rank.low.size > 0 ? (
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlert size={11} className="text-amber-300" aria-hidden />
        {t('stats.caveat.footnote')}
      </span>
    ) : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', black ? 'bg-black' : 'bg-canvas')}>
      {/* header: the title block keeps a minimum width; when title + controls do not fit on one
          line the controls wrap to a second row (never squeezing the title). */}
      <div
        className={cn(
          'group/hdr flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-b border-line px-6 py-3.5',
          black ? 'bg-black' : 'bg-surface-1',
        )}
      >
        <div className="min-w-[min(100%,280px)] flex-[1_1_280px]">
          <div className="flex items-baseline gap-2.5 whitespace-nowrap">
            <h1 className="text-base font-semibold text-ink-1">{t('stats.title')}</h1>
            <span className="text-xs tabular-nums text-ink-3">{t('stats.count', { n: records.length })}</span>
          </div>
          <div className="mt-0.5 text-xs leading-snug text-ink-3">
            <span className="text-ink-2">{t('stats.scope.label')}：</span>
            {scope}
          </div>
        </div>
        {/* In presentation the controls stay out of the picture until the pointer reaches the bar (pure CSS, no timers). */}
        <div
          className={cn(
            'flex max-w-full flex-wrap items-center gap-3',
            presenting && 'opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/hdr:opacity-100',
          )}
        >
          <Switch checked={clipLowGray} onChange={(v) => set('clipLowGray', v)} label={t('stats.clipToggle')} className="items-center" />
          <div className="h-5 w-px bg-line" />
          {ui.mode === 'cards' && (
            <div className="flex items-center gap-1">
              <Select<SortKey>
                aria-label={t('stats.sort.label')}
                value={ui.sortKey}
                onChange={(k) => setUi((u) => ({ ...u, sortKey: k, sortDir: defaultDir(k) }))}
                options={sortOptions}
                className="w-40"
              />
              <IconButton
                size="md"
                variant="ghost"
                label={t('stats.sort.toggle', { dir: dirLabel })}
                icon={ui.sortDir === 'asc' ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
                onClick={() => setUi((u) => ({ ...u, sortDir: u.sortDir === 'asc' ? 'desc' : 'asc' }))}
                aria-pressed={ui.sortDir === 'desc'}
              />
            </div>
          )}
          <Segmented<ViewMode>
            aria-label={t('stats.view.label')}
            value={ui.mode}
            onChange={(mode) => setUi((u) => ({ ...u, mode }))}
            size="md"
            options={[
              { value: 'cards', label: t('stats.view.cards'), icon: <LayoutGrid size={13} /> },
              { value: 'table', label: t('stats.view.table'), icon: <Table2 size={13} /> },
            ]}
          />
          <Button size="md" icon={<ClipboardCopy size={14} />} onClick={onCopy} disabled={records.length === 0}>
            {t('stats.copyTsv')}
          </Button>
        </div>
      </div>

      {/* body */}
      <div className="relative min-h-0 flex-1">
        <div ref={bodyRef} className="h-full overflow-auto" onScroll={measure}>
          {records.length === 0 ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-ink-3 ring-1 ring-inset ring-line">
                <BarChart3 size={22} />
              </div>
              <div className="mt-4 text-sm font-medium text-ink-1">{t('stats.empty.title')}</div>
              <div className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">{t('stats.empty.hint')}</div>
            </div>
          ) : ui.mode === 'cards' ? (
            <div className="p-5">
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 310px), 1fr))' }}>
                {sorted.map((row) => (
                  <StatsCard
                    key={row.rec.id}
                    row={row}
                    style={styles.get(row.rec.id)}
                    lang={lang}
                    rank={rank}
                    clipLowGray={clipLowGray}
                    maxNits={maxNits}
                    colormap={colormap}
                    colorMax={colorMax}
                    extent={extent}
                    onOpen3d={onOpen3d}
                  />
                ))}
              </div>
              {footnote && <div className="mt-3 text-2xs text-ink-3">{footnote}</div>}
            </div>
          ) : (
            <div className="min-w-max p-5">
              <StatsTable
                rows={sorted}
                styles={styles}
                lang={lang}
                rank={rank}
                scrolledX={hScroll.left}
                sortKey={ui.sortKey}
                sortDir={ui.sortDir}
                sliceGray={sliceGray}
                onSort={onSort}
                onOpen3d={onOpen3d}
              />
            </div>
          )}
        </div>
        {/* More columns to the right: edge fade + a "scroll right" button (the sticky record column
            casts a shadow once the table is scrolled). */}
        {ui.mode === 'table' && records.length > 0 && (
          <div
            className={cn(
              'pointer-events-none absolute inset-y-0 flex w-16 items-center justify-end bg-gradient-to-l to-transparent pr-2 transition-opacity duration-200',
              black ? 'from-black via-black/60' : 'from-canvas via-canvas/60',
              hScroll.right ? 'opacity-100' : 'opacity-0',
            )}
            style={{ right: hScroll.gutter }}
          >
            <IconButton
              size="sm"
              variant="secondary"
              label={t('stats.table.moreRight')}
              icon={<ChevronRight size={14} />}
              tabIndex={hScroll.right ? 0 : -1}
              onClick={() => bodyRef.current?.scrollBy({ left: Math.max(160, (bodyRef.current?.clientWidth ?? 0) * 0.6), behavior: 'smooth' })}
              className={cn('rounded-full shadow-panel', hScroll.right && 'pointer-events-auto')}
            />
          </div>
        )}
      </div>
      {/* table legend: outside the scroll area so it never scrolls away sideways */}
      {ui.mode === 'table' && records.length > 0 && (
        <div
          className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-6 py-2 text-2xs text-ink-3', black ? 'bg-black' : 'bg-surface-1')}
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-4 rounded-sm bg-accent/15 ring-1 ring-inset ring-accent/30" />
            {t('stats.bestHint')}
          </span>
          {footnote}
          <span>{t('stats.metric.svmAtHint')}</span>
        </div>
      )}
    </div>
  );
}
