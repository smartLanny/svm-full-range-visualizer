/**
 * Summary statistics per record (docs/adr/0009-summary-stats.md). Pure and memoized.
 *
 * Scope ("统计范围"): the GridView of the record under the current low-gray clip and
 * level-luminance cap. Shares and the mean are weighted by cell area in the
 * (x = log10(levelNits + 1), gray) plane, using the same cell layout as the 3D bars /
 * heatmap (docs/adr/0002). Missing cells (null / non-finite SVM) are excluded, never 0.
 *
 * Coverage: valid area ÷ nominal area of the scope, both measured on the NOMINAL layout (every
 * row / column of the matrix inside the scope, whether or not it still holds a valid cell), so
 * records with cells the denoise shows as no data (docs/adr/0012) are visibly "smaller" than the
 * others. Given a denoised record, valid cells are the measured plus the interpolated ones
 * (denoiseInScope counts what the denoise did inside the scope).
 *
 * The typical-luminance read-outs (svmAt) use exactly the curve the 2D chart draws and its data
 * table prints (smooth gray slice + monotone spline in log10 nits), so the two never disagree.
 */
import type { Dataset } from '../types';
import { LOW_GRAY_CLIP, SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges, gridView, logNits, type GridView } from './grid';
import { settleSlice, smoothSliceAtGray } from '../chart2d/slices';
import { buildCurve, evalCurve } from '../chart2d/spline';
import { displayNotes, type ProcessedRecord } from './denoise';

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
  /** Number of cells of the nominal grid in scope (valid + missing / no data). */
  nominalCount: number;
  /**
   * Valid area ÷ nominal area of the scope, on the nominal cell layout (0..1); null if the scope is
   * empty. Valid = measured + interpolated by the denoise (docs/adr/0012 addendum).
   */
  coverageShare: number | null;
  /** What the denoise did inside the scope (all zero for a raw record / denoise off). */
  denoise: DenoiseInScope;
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
  /**
   * Gray-slice SVM at SVM_AT_NITS, read off the 2D chart's curve (smoothSliceAtGray + monotone
   * spline in log10 nits); null outside the slice's measured range.
   */
  svmAt: { nits: number; svm: number | null }[];
  /** Gray level actually used for svmAt (sliceGray clamped to the measured rows). */
  sliceGray: number | null;
  /** Extent of the valid cells in scope. */
  validExtent: { grayMin: number; grayMax: number; levelMin: number; levelMax: number } | null;
}

/** Areas of the scope's cells: area[r][c] = Δgray × Δx (0..255 gray, x ≥ 0). */
export function cellAreas(view: GridView): number[][] {
  const xe = cellEdges(view.x, 0);
  const ge = cellEdges(view.grays, 0, 255);
  return view.grays.map((_, r) => view.x.map((_, c) => Math.max(0, xe[c + 1] - xe[c]) * Math.max(0, ge[r + 1] - ge[r])));
}

/**
 * Interpolate SVM at `nits` on a slice sorted by nits ascending, linearly in log10(nits).
 * (Reference rule; the stats read-outs use sliceSvmAt, the 2D chart's curve.)
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

/**
 * Nominal grid of the scope: every matrix row (gray) and column (level luminance) that the
 * clip / cap keep, INCLUDING rows / columns without a single valid cell (which gridView drops).
 * Returns the cell areas on that layout and, per cell, whether it holds a valid measurement.
 */
export function nominalScope(
  ds: Pick<Dataset, 'matrix'>,
  opts: Pick<StatsOptions, 'clipLowGray' | 'maxNits'>,
): { rows: number[]; cols: number[]; areas: number[][]; valid: boolean[][] } {
  const m = ds.matrix;
  const rows = m.rows
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => Number.isFinite(g) && (!opts.clipLowGray || g >= LOW_GRAY_CLIP))
    .sort((a, b) => a.g - b.g);
  const cols = m.headerNits
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => Number.isFinite(n) && n > 0 && (opts.maxNits === null || n <= opts.maxNits))
    .sort((a, b) => a.n - b.n);
  const xe = cellEdges(
    cols.map(({ n }) => logNits(n)),
    0,
  );
  const ge = cellEdges(
    rows.map(({ g }) => g),
    0,
    255,
  );
  const areas = rows.map((_, r) => cols.map((_, c) => Math.max(0, xe[c + 1] - xe[c]) * Math.max(0, ge[r + 1] - ge[r])));
  const valid = rows.map(({ i: ri }) =>
    cols.map(({ i: ci }) => {
      const p = m.grid[ri]?.[ci];
      return !!p && Number.isFinite(p.svm);
    }),
  );
  return { rows: rows.map(({ i }) => i), cols: cols.map(({ i }) => i), areas, valid };
}

/**
 * SVM of the gray slice at `nits`, exactly as the 2D chart draws it and its data table prints
 * it: the smooth gray slice (C1 along gray, identical to the measurements on measured rows)
 * through a monotone cubic in log10(nits). null outside the slice's measured nits range.
 */
export function sliceSvmAt(ds: Pick<Dataset, 'matrix'>, gray: number, nits: readonly number[]): { gray: number | null; svm: (number | null)[] } {
  // Same path as the 2D chart's static curve (chart2d/scene.ts curveOf + graySliceSvmAt).
  const slice = Number.isFinite(gray) ? smoothSliceAtGray(ds, gray) : [];
  const curve = buildCurve(settleSlice(slice).map((p) => ({ x: Math.log10(p.x), y: p.svm, a: p.a, key: p.key })));
  return {
    gray: slice.length > 0 ? slice[0].gray : null,
    svm: nits.map((n) => (curve && n > 0 ? evalCurve(curve, Math.log10(n)) : null)),
  };
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

  // Typical-luminance SVM on the gray slice (full slice, the 2D chart's curve).
  const at = sliceSvmAt(ds, opts.sliceGray, SVM_AT_NITS);
  const svmAt = SVM_AT_NITS.map((nits, i) => ({ nits, svm: at.svm[i] }));
  const sliceGray = at.gray;

  // Coverage on the nominal layout, and what the denoise did inside the scope.
  const nom = nominalScope(ds, opts);
  let nominalArea = 0;
  let validArea = 0;
  let nominalCount = 0;
  nom.areas.forEach((row, r) =>
    row.forEach((a, c) => {
      nominalCount++;
      nominalArea += a;
      if (nom.valid[r][c]) validArea += a;
    }),
  );
  const dn = displayNotes(ds);
  const denoise = dn ? denoiseInScope({ notes: dn.notes, record: ds }, opts) : { interpolated: 0, noData: 0, lumEstimated: 0 };

  return {
    cellCount,
    nominalCount,
    coverageShare: nominalArea > 0 ? validArea / nominalArea : null,
    denoise,
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
    validExtent: cellCount > 0 ? { grayMin, grayMax, levelMin, levelMax } : null,
  };
}

const cache = new WeakMap<Dataset['matrix'], Map<string, RecordStats>>();

/**
 * Summary stats of one record under the given scope. Memoized per matrix + options. Pass the
 * record as displayed (processed by the denoise): its notes are found by its matrix.
 */
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

/** What the denoise did inside a stats scope (docs/adr/0012 addendum). */
export interface DenoiseInScope {
  /** Cells filled by interpolation (they count towards coverage). */
  interpolated: number;
  /** Cells shown as no data. */
  noData: number;
  /** Cells whose SVM is measured but whose luminance is an estimate. */
  lumEstimated: number;
}

/**
 * Counts of processed cells inside the scope (low-gray clip / level cap, the same nominal rows and
 * columns as the coverage) — for "降噪：插值 N 格，无有效数据 M 格". All zero with denoise off.
 */
export function denoiseInScope(pr: { notes: ProcessedRecord['notes']; record: Pick<Dataset, 'matrix'> }, opts: Pick<StatsOptions, 'clipLowGray' | 'maxNits'>): DenoiseInScope {
  const out: DenoiseInScope = { interpolated: 0, noData: 0, lumEstimated: 0 };
  if (!pr.notes.length) return out;
  const nom = nominalScope(pr.record, opts);
  const rows = new Set(nom.rows);
  const cols = new Set(nom.cols);
  for (const n of pr.notes) if (rows.has(n.r) && cols.has(n.c)) out[n.action]++;
  return out;
}
