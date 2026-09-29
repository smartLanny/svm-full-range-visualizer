import { ANOMALY_KINDS, detectAnomalies, excludeAnomalies, type Anomaly, type AnomalyKind } from '../data/anomalies';
import type { Dataset } from '../types';
import type { TFunction } from '../i18n';

/**
 * Import screening (docs/adr/0012, contract C7): pasted / dropped tables and JSON without an
 * `excluded` field are checked for obvious anomalies; the importer offers to exclude them
 * (default on). Excluded raw values are kept in `record.excluded`.
 */
export interface Screening {
  anomalies: Anomaly[];
  byReason: Partial<Record<AnomalyKind, number>>;
}

/** Screen a parsed dataset. null = not screened (it already carries an `excluded` field). */
export function screenDataset(ds: Pick<Dataset, 'matrix' | 'excluded'>): Screening | null {
  if (ds.excluded !== undefined) return null;
  let anomalies: Anomaly[];
  try {
    anomalies = detectAnomalies(ds);
  } catch (e) {
    console.warn('Anomaly screening failed:', e);
    anomalies = [];
  }
  return { anomalies, byReason: countByReason(anomalies.map((a) => a.kind)) };
}

export function countByReason(kinds: string[]): Partial<Record<AnomalyKind, number>> {
  const out: Partial<Record<AnomalyKind, number>> = {};
  for (const k of kinds) out[k as AnomalyKind] = (out[k as AnomalyKind] ?? 0) + 1;
  return out;
}

/** Apply a screening: flagged cells become missing, raw values go to `excluded`. */
export function applyScreening<T extends Dataset>(ds: T, s: Screening | null | undefined, exclude: boolean): T {
  if (!exclude || !s || !s.anomalies.length) return ds;
  return excludeAnomalies(ds, s.anomalies);
}

export function mergeByReason(list: (Partial<Record<AnomalyKind, number>> | null | undefined)[]): { total: number; byReason: Partial<Record<AnomalyKind, number>> } {
  const byReason: Partial<Record<AnomalyKind, number>> = {};
  let total = 0;
  for (const m of list) {
    if (!m) continue;
    for (const [k, n] of Object.entries(m) as [AnomalyKind, number][]) {
      byReason[k] = (byReason[k] ?? 0) + n;
      total += n;
    }
  }
  return { total, byReason };
}

/** "低于噪声底 165 · 陈旧读数 8" in ANOMALY_KINDS order (unknown reasons last, untranslated). */
export function reasonsText(t: TFunction, byReason: Partial<Record<string, number>>, sep = ' · '): string {
  const known = ANOMALY_KINDS.filter((k) => byReason[k]).map((k) => `${t(`common.exclusion.reasons.${k}`)} ${byReason[k]}`);
  const other = Object.keys(byReason)
    .filter((k) => !(ANOMALY_KINDS as string[]).includes(k) && byReason[k])
    .map((k) => `${k} ${byReason[k]}`);
  return [...known, ...other].join(sep);
}
