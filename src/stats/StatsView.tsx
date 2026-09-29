import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ClipboardCopy, LayoutGrid, Table2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRecordStyles, useVisibleRecords } from '../store/hooks';
import { LOW_GRAY_CLIP } from '../types';
import { useT } from '../i18n';
import { Button, Segmented, Select, Switch, toast } from '../ui';
import { bestValues, buildRows, copyText, defaultDir, METRICS, sortRows, toTsv, type SortDir, type SortKey } from './model';
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
  const best = useMemo(() => bestValues(rows), [rows]);
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
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-surface-1 px-6 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-base font-semibold text-ink-1">{t('stats.title')}</h1>
            <span className="text-xs tabular-nums text-ink-3">{t('stats.count', { n: records.length })}</span>
          </div>
          <div className="mt-0.5 text-xs leading-snug text-ink-3">
            <span className="text-ink-2">{t('stats.scope.label')}：</span>
            {scope}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch checked={clipLowGray} onChange={(v) => set('clipLowGray', v)} label={t('stats.clipToggle')} className="items-center" />
          <div className="h-5 w-px bg-line" />
          {ui.mode === 'cards' && (
            <Select<SortKey>
              aria-label={t('stats.sort.label')}
              value={ui.sortKey}
              onChange={(k) => setUi((u) => ({ ...u, sortKey: k, sortDir: defaultDir(k) }))}
              options={sortOptions}
              className="w-40"
            />
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
      <div className="min-h-0 flex-1 overflow-auto">
        {records.length === 0 ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-ink-3 ring-1 ring-inset ring-line">
              <BarChart3 size={22} />
            </div>
            <div className="mt-4 text-sm font-medium text-ink-1">{t('stats.empty.title')}</div>
            <div className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">{t('stats.empty.hint')}</div>
          </div>
        ) : ui.mode === 'cards' ? (
          <div className="grid gap-4 p-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' }}>
            {sorted.map((row) => (
              <StatsCard
                key={row.rec.id}
                row={row}
                style={styles.get(row.rec.id)}
                lang={lang}
                best={best}
                clipLowGray={clipLowGray}
                maxNits={maxNits}
                colormap={colormap}
                colorMax={colorMax}
                extent={extent}
                onOpen3d={onOpen3d}
              />
            ))}
          </div>
        ) : (
          <div className="min-w-max p-6">
            <StatsTable rows={sorted} styles={styles} lang={lang} best={best} sortKey={ui.sortKey} sortDir={ui.sortDir} sliceGray={sliceGray} onSort={onSort} onOpen3d={onOpen3d} />
            <div className="mt-2.5 flex items-center gap-4 text-2xs text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-4 rounded-sm bg-accent/15 ring-1 ring-inset ring-accent/30" />
                {t('stats.bestHint')}
              </span>
              <span>{t('stats.metric.svmAtHint')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
