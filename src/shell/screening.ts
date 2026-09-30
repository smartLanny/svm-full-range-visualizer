import { denoiseSummary, DENOISE_KINDS, type DenoiseKind, type DenoiseSummary } from '../data/denoise';
import type { Dataset } from '../types';

/**
 * Import preview of the denoise (docs/adr/0012 addendum, contract C7). Records are imported RAW:
 * nothing is removed or rewritten. The importer shows what the view-time denoise will do with a
 * table (the same processing every record gets), so the user knows before importing.
 */
export interface Screening {
  summary: DenoiseSummary;
}

/** What the denoise will do with a parsed dataset (null if the check fails). */
export function screenDataset(ds: Dataset): Screening | null {
  try {
    return { summary: denoiseSummary(ds) };
  } catch (e) {
    console.warn('Denoise preview failed:', e);
    return null;
  }
}

export type SummaryTotals = Pick<DenoiseSummary, 'touched' | 'interpolated' | 'noData' | 'lumEstimated' | 'levelsEstimated' | 'byKind'>;

/** Totals over several previews (several tables / files). */
export function mergeSummaries(list: (Screening | null | undefined)[]): SummaryTotals {
  const out: SummaryTotals = { touched: 0, interpolated: 0, noData: 0, lumEstimated: 0, levelsEstimated: 0, byKind: {} };
  for (const s of list) {
    if (!s) continue;
    const m = s.summary;
    out.touched += m.touched;
    out.interpolated += m.interpolated;
    out.noData += m.noData;
    out.lumEstimated += m.lumEstimated;
    out.levelsEstimated += m.levelsEstimated;
    for (const k of DENOISE_KINDS) if (m.byKind[k]) out.byKind[k as DenoiseKind] = (out.byKind[k] ?? 0) + m.byKind[k]!;
  }
  return out;
}

export interface DatasetRanges {
  /** Gray levels of the rows that keep at least one valid cell. */
  gray: [number, number] | null;
  /** Level luminance (column header nits) of the columns that keep at least one valid cell. */
  level: [number, number] | null;
  svm: [number, number] | null;
  /** Valid cells. */
  points: number;
}

const span = (vs: number[]): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vs) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
};

/**
 * Importer preview ranges of what will be shown (finding N13): computed from the valid grid
 * cells, so with the denoise on they describe the denoised dataset, not the raw table (a
 * −0.05 nits cell with a raw SVM of 62.8 does not widen the SVM range once the denoise hides it).
 */
export function datasetRanges(ds: Pick<Dataset, 'matrix'>): DatasetRanges {
  const { rows, headerNits, grid } = ds.matrix;
  const grays: number[] = [];
  const levels: number[] = [];
  const svms: number[] = [];
  const colUsed = new Set<number>();
  grid.forEach((row, r) => {
    let any = false;
    row.forEach((p, c) => {
      if (!p || !Number.isFinite(p.svm)) return;
      any = true;
      colUsed.add(c);
      svms.push(p.svm);
    });
    if (any) grays.push(rows[r]);
  });
  for (const c of colUsed) levels.push(headerNits[c]);
  return { gray: span(grays), level: span(levels), svm: span(svms), points: svms.length };
}
