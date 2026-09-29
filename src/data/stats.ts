/**
 * Summary statistics per record (docs/adr/0009-summary-stats.md). Pure and memoized.
 *
 * Scope ("统计范围"): the GridView of the record under the current low-gray clip and
 * level-luminance cap. Shares and the mean are weighted by cell area in the
 * (x = log10(levelNits + 1), gray) plane, using the same cell layout as the 3D bars /
 * heatmap (docs/adr/0002). Missing cells (null / non-finite SVM) are excluded, never 0.
 */
import type { Dataset } from '../types';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges, gridView, sliceAtGray, type GridView } from './grid';

/** Luminances (measured nits) at which the gray-slice SVM is reported. */
export const SVM_AT_NITS = [2, 10, 50, 100] as const;

export interface StatsOptions {
  clipLowGray: boolean;
  /** Level-luminance cap; null = all columns. */
  maxNits: number | null;
  /** Gray level of the gray slice used for svmAt. */
  sliceGray: number;
}

export interface StatsPeak {
  svm: number;
  gray: number;
  /** Level luminance (G255 nits) of the peak's column. */
  levelNits: number;
  /** Measured nits of the peak cell. */
  nits: number;
}

export interface RecordStats {
  /** Number of valid (non-missing) cells in scope. */
  cellCount: number;
  /** Area share with SVM < 0.4 (0..1); null when no cells in scope. */
  safeShare: number | null;
  /** Area share with 0.4 <= SVM < 1.0. */
  midShare: number | null;
  /** Area share with SVM >= 1.0. */
  criticalShare: number | null;
  /** Area-weighted mean SVM. */
  meanSvm: number | null;
  peak: StatsPeak | null;
  /**
   * On the max-gray (G255) row in scope: lowest measured nits from which SVM stays < 0.4 for
   * every higher-luminance sample. null if the brightest sample is not safe (never compliant).
   */
  fullWhiteSafeNits: number | null;
  /** True when every sample of that row is safe (compliant from the lowest measured nits). */
  fullWhiteAllSafe: boolean;
  /** Gray level of the row used for fullWhiteSafeNits (normally 255); null if none. */
  fullWhiteGray: number | null;
  /** Gray-slice SVM at SVM_AT_NITS (log-nits interpolation); null outside the measured range. */
  svmAt: { nits: number; svm: number | null }[];
  /** Gray level actually used for svmAt (sliceGray clamped to the measured rows). */
  sliceGray: number | null;
  /** Extent of the valid cells in scope. */
  coverage: { grayMin: number; grayMax: number; levelMin: number; levelMax: number } | null;
}

/** Areas of the scope's cells: area[r][c] = Δgray × Δx (0..255 gray, x ≥ 0). */
export function cellAreas(view: GridView): number[][] {
  const xe = cellEdges(view.x, 0);
  const ge = cellEdges(view.grays, 0, 255);
  return view.grays.map((_, r) => view.x.map((_, c) => Math.max(0, xe[c + 1] - xe[c]) * Math.max(0, ge[r + 1] - ge[r])));
}

/**
 * Interpolate SVM at `nits` on a slice sorted by nits ascending, linearly in log10(nits).
 * Inclusive at both ends; null outside [first, last] or for an empty slice.
 */
export function interpolateAtNits(slice: { nits: number; svm: number }[], nits: number): number | null {
  const n = slice.length;
  if (n === 0 || !(nits > 0)) return null;
  const tol = 1e-9;
  if (nits < slice[0].nits * (1 - tol) || nits > slice[n - 1].nits * (1 + tol)) return null;
  if (n === 1) return slice[0].svm;
  const lq = Math.log10(nits);
  for (let i = 0; i < n - 1; i++) {
    const a = slice[i];
    const b = slice[i + 1];
    if (nits > b.nits * (1 + tol)) continue;
    const la = Math.log10(a.nits);
    const lb = Math.log10(b.nits);
    if (lb - la < 1e-12) return (a.svm + b.svm) / 2;
    const t = Math.min(1, Math.max(0, (lq - la) / (lb - la)));
    return a.svm + (b.svm - a.svm) * t;
  }
  return slice[n - 1].svm;
}

/**
 * Lowest nits from which every brighter sample is safe (< 0.4). Samples: (nits, svm) of one
 * row; invalid samples ignored. null if the brightest sample is not safe or there are none.
 */
export function safeFromNits(samples: { nits: number; svm: number }[]): number | null {
  const valid = samples.filter((s) => s.nits > 0 && Number.isFinite(s.nits) && Number.isFinite(s.svm)).sort((a, b) => a.nits - b.nits);
  let from: number | null = null;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].svm < SVM_SAFE) from = valid[i].nits;
    else break;
  }
  return from;
}

function compute(ds: Pick<Dataset, 'matrix'>, opts: StatsOptions): RecordStats {
  const view = gridView(ds, { clipLowGray: opts.clipLowGray, maxNits: opts.maxNits });
  const areas = cellAreas(view);

  let total = 0;
  let safe = 0;
  let crit = 0;
  let weighted = 0;
  let cellCount = 0;
  let peak: StatsPeak | null = null;
  let grayMin = Infinity;
  let grayMax = -Infinity;
  let levelMin = Infinity;
  let levelMax = -Infinity;

  for (let r = 0; r < view.grays.length; r++) {
    for (let c = 0; c < view.x.length; c++) {
      const p = view.points[r][c];
      if (!p || !Number.isFinite(p.svm)) continue;
      const a = areas[r][c];
      cellCount++;
      total += a;
      weighted += a * p.svm;
      if (p.svm < SVM_SAFE) safe += a;
      else if (p.svm >= SVM_CRITICAL) crit += a;
      if (!peak || p.svm > peak.svm) peak = { svm: p.svm, gray: view.grays[r], levelNits: view.levelNits[c], nits: p.nits };
      grayMin = Math.min(grayMin, view.grays[r]);
      grayMax = Math.max(grayMax, view.grays[r]);
      levelMin = Math.min(levelMin, view.levelNits[c]);
      levelMax = Math.max(levelMax, view.levelNits[c]);
    }
  }

  const has = cellCount > 0 && total > 0;
  const safeShare = has ? safe / total : null;
  const criticalShare = has ? crit / total : null;
  const midShare = has ? Math.max(0, 1 - safeShare! - criticalShare!) : null;

  // Full-white compliance on the max-gray row in scope.
  let fullWhiteSafeNits: number | null = null;
  let fullWhiteAllSafe = false;
  let fullWhiteGray: number | null = null;
  if (view.grays.length > 0) {
    const r = view.grays.length - 1;
    fullWhiteGray = view.grays[r];
    const samples = view.points[r].filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ nits: p.nits, svm: p.svm }));
    fullWhiteSafeNits = safeFromNits(samples);
    const valid = samples.filter((p) => p.nits > 0 && Number.isFinite(p.svm));
    fullWhiteAllSafe = valid.length > 0 && valid.every((p) => p.svm < SVM_SAFE);
  }

  // Typical-luminance SVM on the gray slice (full slice, like the 2D chart).
  const slice = Number.isFinite(opts.sliceGray) ? sliceAtGray(ds, opts.sliceGray) : [];
  const svmAt = SVM_AT_NITS.map((nits) => ({ nits, svm: interpolateAtNits(slice, nits) }));
  const sliceGray = slice.length > 0 ? slice[0].gray : null;

  return {
    cellCount,
    safeShare,
    midShare,
    criticalShare,
    meanSvm: has ? weighted / total : null,
    peak,
    fullWhiteSafeNits,
    fullWhiteAllSafe,
    fullWhiteGray,
    svmAt,
    sliceGray,
    coverage: cellCount > 0 ? { grayMin, grayMax, levelMin, levelMax } : null,
  };
}

const cache = new WeakMap<Dataset['matrix'], Map<string, RecordStats>>();

/** Summary stats of one record under the given scope. Memoized per matrix + options. */
export function computeRecordStats(ds: Pick<Dataset, 'matrix'>, opts: StatsOptions): RecordStats {
  const key = `${opts.clipLowGray ? 1 : 0}|${opts.maxNits ?? 'all'}|${opts.sliceGray}`;
  let perMatrix = cache.get(ds.matrix);
  if (!perMatrix) {
    perMatrix = new Map();
    cache.set(ds.matrix, perMatrix);
  }
  const hit = perMatrix.get(key);
  if (hit) return hit;
  const s = compute(ds, opts);
  perMatrix.set(key, s);
  return s;
}
