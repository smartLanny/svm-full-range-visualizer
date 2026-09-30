/**
 * View model of the stats page: one row per visible record, sortable metric columns, the
 * "best" value per column, and TSV export. Pure (no React) so it can be reused / tested.
 */
import type { Lang, SvmRecord } from '../types';
import { deviceLabel, modeLabel, recordLabel } from '../data/records';
import { computeRecordStats, SVM_AT_NITS, type RecordStats, type StatsOptions } from '../data/stats';
import { fmtNits } from '../data/grid';
import type { TFunction } from '../i18n';

export interface StatsRow {
  rec: SvmRecord;
  /** Position in record order (default sort). */
  order: number;
  stats: RecordStats;
}

export type MetricKey = 'safe' | 'mid' | 'critical' | 'fullWhite' | 'peak' | 'mean' | 'at0' | 'at1' | 'at2' | 'at3' | 'coverage';
export type SortKey = 'order' | 'name' | MetricKey;
export type SortDir = 'asc' | 'desc';

export interface MetricColumn {
  key: MetricKey;
  /** 'higher' / 'lower' is better; null = no ranking (neutral). */
  better: 'higher' | 'lower' | null;
  /** Display resolution: values equal at this resolution tie for "best". */
  step: number;
  value: (s: RecordStats) => number | null;
}

export const METRICS: MetricColumn[] = [
  { key: 'safe', better: 'higher', step: 0.001, value: (s) => s.safeShare },
  { key: 'mid', better: null, step: 0.001, value: (s) => s.midShare },
  { key: 'critical', better: 'lower', step: 0.001, value: (s) => s.criticalShare },
  { key: 'fullWhite', better: 'lower', step: 0, value: (s) => s.fullWhiteSafeNits },
  { key: 'peak', better: 'lower', step: 0.01, value: (s) => s.peak?.svm ?? null },
  { key: 'mean', better: 'lower', step: 0.01, value: (s) => s.meanSvm },
  ...SVM_AT_NITS.map((_, i): MetricColumn => ({ key: `at${i}` as MetricKey, better: 'lower', step: 0.01, value: (s) => s.svmAt[i]?.svm ?? null })),
  { key: 'coverage', better: null, step: 0.001, value: (s) => s.coverageShare },
];

export const metricByKey = (k: MetricKey) => METRICS.find((m) => m.key === k)!;

export function buildRows(records: SvmRecord[], opts: StatsOptions): StatsRow[] {
  return records.map((rec, order) => ({ rec, order, stats: computeRecordStats(rec, opts) }));
}

/** Default direction when a column is first clicked: best values first. */
export function defaultDir(key: SortKey): SortDir {
  if (key === 'order' || key === 'name') return 'asc';
  return metricByKey(key).better === 'higher' ? 'desc' : 'asc';
}

/** Sorted copy. Missing values always go last, regardless of direction. Ties keep record order. */
export function sortRows(rows: StatsRow[], key: SortKey, dir: SortDir, lang: Lang): StatsRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const out = rows.slice();
  if (key === 'order') return out.sort((a, b) => sign * (a.order - b.order));
  if (key === 'name') {
    const coll = new Intl.Collator(lang === 'zh' ? 'zh-Hans-CN' : 'en', { numeric: true });
    return out.sort((a, b) => sign * coll.compare(recordLabel(a.rec, lang), recordLabel(b.rec, lang)) || a.order - b.order);
  }
  const get = metricByKey(key).value;
  return out.sort((a, b) => {
    const va = get(a.stats);
    const vb = get(b.stats);
    if (va === null && vb === null) return a.order - b.order;
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || a.order - b.order;
  });
}

/**
 * Best value per ranked column among the rows (only when at least two rows have a value, and
 * not all equal — a "best" among identical values means nothing).
 */
export function bestValues(rows: StatsRow[]): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const m of METRICS) {
    if (!m.better) continue;
    const vals = rows.map((r) => m.value(r.stats)).filter((v): v is number => v !== null);
    if (vals.length < 2) continue;
    const best = m.better === 'higher' ? Math.max(...vals) : Math.min(...vals);
    const worst = m.better === 'higher' ? Math.min(...vals) : Math.max(...vals);
    if (snap(best, m.step) === snap(worst, m.step)) continue;
    out[m.key] = best;
  }
  return out;
}

/**
 * Rows whose coverage (valid area ÷ nominal area of the scope) is below this fraction of the
 * median coverage of the visible rows are not comparable: their shares / mean / peak describe a
 * smaller (usually easier) area, so they never win a "best" highlight (docs/adr/0009, 0012).
 */
export const COVERAGE_MIN_RATIO = 0.9;

export interface Ranking {
  /** Best value per ranked column among the comparable rows. */
  best: Partial<Record<MetricKey, number>>;
  /** Ids of the rows excluded from ranking for low coverage. */
  low: Set<string>;
  /** Median coverage of the rows (null when no row has one). */
  medianCoverage: number | null;
}

export function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const v = vals.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Best values over the comparable rows, plus which rows are left out for low coverage. */
export function rankRows(rows: StatsRow[]): Ranking {
  const medianCoverage = median(rows.map((r) => r.stats.coverageShare).filter((v): v is number => v !== null));
  const low = new Set<string>();
  if (medianCoverage !== null) {
    for (const r of rows) {
      const c = r.stats.coverageShare;
      if (c !== null && c < COVERAGE_MIN_RATIO * medianCoverage - 1e-12) low.add(r.rec.id);
    }
  }
  return { best: bestValues(rows.filter((r) => !low.has(r.rec.id))), low, medianCoverage };
}

/** 'higher' / 'lower' comparison at display resolution: v is at least as good as b. */
function atLeastAsGood(key: MetricKey, v: number, b: number): boolean {
  const m = metricByKey(key);
  const sv = snap(v, m.step);
  const sb = snap(b, m.step);
  return m.better === 'higher' ? sv >= sb : m.better === 'lower' ? sv <= sb : false;
}

/**
 * Mark of one value: 'best' (highlight) for a comparable row holding the column's best value;
 * 'caveat' for a low-coverage row whose value would otherwise match or beat that best (shown
 * with a warning marker instead of the highlight); null otherwise.
 */
export function markOf(rank: Ranking, key: MetricKey, row: StatsRow, v: number | null): 'best' | 'caveat' | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (!rank.low.has(row.rec.id)) return isBest(rank.best, key, v) ? 'best' : null;
  const b = rank.best[key];
  return b !== undefined && atLeastAsGood(key, v, b) ? 'caveat' : null;
}

/** Snap to a column's display resolution (so values that LOOK equal rank equal). */
const snap = (v: number, step: number) => (step > 0 ? Math.round(v / step) : v);

/** True when v equals the column's best value at display resolution (ties all highlight). */
export function isBest(best: Partial<Record<MetricKey, number>>, key: MetricKey, v: number | null): boolean {
  const b = best[key];
  if (v === null || b === undefined) return false;
  const step = metricByKey(key).step;
  return snap(v, step) === snap(b, step);
}

// ---- formatting ------------------------------------------------------------------------

export const fmtPct = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
export const fmtSvmOrDash = (v: number | null, digits = 2) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
export const fmtNitsOrDash = (v: number | null) => (v === null ? '—' : fmtNits(v));

/** Status band of an SVM value (reference thresholds 0.4 / 1.0). */
export function band(v: number): 'safe' | 'mid' | 'critical' {
  return v < 0.4 ? 'safe' : v >= 1.0 ? 'critical' : 'mid';
}

export const BAND_COLORS = { safe: '#22c55e', mid: '#f59e0b', critical: '#ef4444' } as const;

// ---- TSV -------------------------------------------------------------------------------

const num = (v: number | null | undefined, digits: number) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits));

/** Tab-separated table of the rows (header in the current language, empty cell = missing). */
export function toTsv(rows: StatsRow[], t: TFunction, lang: Lang): string {
  const header = [
    t('stats.col.device'),
    t('stats.col.mode'),
    `${t('stats.col.safe')} (%)`,
    `${t('stats.col.mid')} (%)`,
    `${t('stats.col.critical')} (%)`,
    `${t('stats.col.fullWhite')} (nits)`,
    t('stats.col.peak'),
    t('stats.col.peakGray'),
    `${t('stats.col.peakLevel')} (nits)`,
    t('stats.col.mean'),
    ...SVM_AT_NITS.map((n) => t('stats.col.at', { n: `${n}nits` })),
    t('stats.col.cells'),
    t('stats.col.nominalCells'),
    `${t('stats.col.coverage')} (%)`,
    t('stats.col.interpolated'),
    t('stats.col.noData'),
    t('stats.col.lumEstimated'),
  ];
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const lines = rows.map(({ rec, stats: s }) =>
    [
      clean(deviceLabel(rec, lang)),
      clean(modeLabel(rec, lang)),
      num(s.safeShare === null ? null : s.safeShare * 100, 1),
      num(s.midShare === null ? null : s.midShare * 100, 1),
      num(s.criticalShare === null ? null : s.criticalShare * 100, 1),
      num(s.fullWhiteSafeNits, 2),
      num(s.peak?.svm, 3),
      num(s.peak?.gray, 0),
      num(s.peak?.levelNits, 2),
      num(s.meanSvm, 3),
      ...s.svmAt.map((a) => num(a.svm, 3)),
      String(s.cellCount),
      String(s.nominalCount),
      num(s.coverageShare === null ? null : s.coverageShare * 100, 1),
      String(s.denoise.interpolated),
      String(s.denoise.noData),
      String(s.denoise.lumEstimated),
    ].join('\t'),
  );
  return [header.join('\t'), ...lines].join('\n');
}

/** Copy text to the clipboard (async API with a textarea fallback for file:// / older browsers). */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('COPY_FAILED');
}
