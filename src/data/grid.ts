/**
 * Numeric core shared by the 3D terrain, the 2D chart, the diff map and the stats.
 *
 * Conventions (see CONTEXT.md / docs/adr/0002):
 * - A dataset matrix is normalised into a GridView sorted ASCENDING in both axes
 *   (gray ascending, level luminance ascending). Callers never deal with the raw
 *   255->1 / 100%->0% ordering.
 * - Horizontal position is x = log10(levelNits + 1) ("log1p nits"), for every representation.
 * - Missing values are null, never 0.
 */
import type { Dataset, DataPoint } from '../types';
import { DEFAULT_MAX_NITS, LOW_GRAY_CLIP } from '../types';

export const logNits = (nits: number) => Math.log10(Math.max(0, nits) + 1);
export const fromLogNits = (x: number) => Math.pow(10, x) - 1;

export interface GridOptions {
  /** Hide rows with gray < lowGrayThreshold. Default false. */
  clipLowGray?: boolean;
  /** Default LOW_GRAY_CLIP (15). */
  lowGrayThreshold?: number;
  /** Hide columns whose level luminance exceeds this. null/undefined = no cap. */
  maxNits?: number | null;
}

export interface GridView {
  /** Gray levels, ascending. */
  grays: number[];
  /** Level luminance (G255 nits) per column, ascending. */
  levelNits: number[];
  /** x = logNits(levelNits[c]). */
  x: number[];
  /** Brightness percent per column (same order as levelNits). */
  percents: number[];
  /** Sorted row -> original matrix row index. */
  rowIndex: number[];
  /** Sorted col -> original matrix col index. */
  colIndex: number[];
  /** points[r][c] in sorted order. */
  points: (DataPoint | null)[][];
}

const viewCache = new WeakMap<Dataset['matrix'], Map<string, GridView>>();

/** Normalised, filtered, ascending view of a dataset matrix. Cached per matrix + options. */
export function gridView(ds: Pick<Dataset, 'matrix'>, opts: GridOptions = {}): GridView {
  const clip = !!opts.clipLowGray;
  const threshold = opts.lowGrayThreshold ?? LOW_GRAY_CLIP;
  const maxNits = opts.maxNits ?? null;
  const key = `${clip ? threshold : -1}|${maxNits ?? 'all'}`;
  let perMatrix = viewCache.get(ds.matrix);
  if (!perMatrix) {
    perMatrix = new Map();
    viewCache.set(ds.matrix, perMatrix);
  }
  const hit = perMatrix.get(key);
  if (hit) return hit;

  const m = ds.matrix;
  const rowIndex = m.rows
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => Number.isFinite(g) && (!clip || g >= threshold))
    .sort((a, b) => a.g - b.g)
    .map(({ i }) => i);
  const colIndex = m.headerNits
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => Number.isFinite(n) && n > 0 && (maxNits === null || n <= maxNits))
    .sort((a, b) => a.n - b.n)
    .map(({ i }) => i);

  // Rows / columns without a single valid cell carry no information and would open holes in
  // interpolation (e.g. a column removed as a duplicate by the anomaly rules): drop them.
  const keepRows = rowIndex.filter((r) => colIndex.some((c) => m.grid[r]?.[c]));
  const keepCols = colIndex.filter((c) => keepRows.some((r) => m.grid[r]?.[c]));
  rowIndex.splice(0, rowIndex.length, ...keepRows);
  colIndex.splice(0, colIndex.length, ...keepCols);

  const view: GridView = {
    grays: rowIndex.map((i) => m.rows[i]),
    levelNits: colIndex.map((i) => m.headerNits[i]),
    x: colIndex.map((i) => logNits(m.headerNits[i])),
    percents: colIndex.map((i) => m.cols[i]),
    rowIndex,
    colIndex,
    points: rowIndex.map((r) => colIndex.map((c) => m.grid[r]?.[c] ?? null)),
  };
  perMatrix.set(key, view);
  return view;
}

/**
 * Cell boundaries for sorted sample coordinates: midpoints between neighbours, the two
 * ends extended by half the neighbouring spacing, then clamped to [min, max].
 * Returns n + 1 edges; cell i spans [edges[i], edges[i + 1]].
 */
export function cellEdges(values: number[], min = -Infinity, max = Infinity): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [Math.max(min, values[0] - 0.5), Math.min(max, values[0] + 0.5)];
  const e = new Array<number>(n + 1);
  for (let i = 1; i < n; i++) e[i] = (values[i - 1] + values[i]) / 2;
  e[0] = values[0] - (values[1] - values[0]) / 2;
  e[n] = values[n - 1] + (values[n - 1] - values[n - 2]) / 2;
  e[0] = Math.max(min, e[0]);
  e[n] = Math.min(max, e[n]);
  return e;
}

/** Index i such that arr[i] <= v <= arr[i + 1] for an ascending array; -1 if out of range. */
export function bracket(arr: number[], v: number): number {
  const n = arr.length;
  if (n === 0 || v < arr[0] || v > arr[n - 1]) return -1;
  if (n === 1) return 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

const EPS = 1e-9;

/**
 * Bilinear sample of a GridView at (x = logNits(levelNits), gray). Corners with zero weight
 * may be missing; any weighted missing corner -> null. Out of range -> null.
 */
export function sampleView(view: GridView, x: number, gray: number): { svm: number; nits: number } | null {
  const c = bracket(view.x, x);
  const r = bracket(view.grays, gray);
  if (c < 0 || r < 0) return null;
  const c1 = Math.min(c + 1, view.x.length - 1);
  const r1 = Math.min(r + 1, view.grays.length - 1);
  const tx = c1 === c ? 0 : (x - view.x[c]) / (view.x[c1] - view.x[c]);
  const tz = r1 === r ? 0 : (gray - view.grays[r]) / (view.grays[r1] - view.grays[r]);
  const corners: [number, number, number][] = [
    [r, c, (1 - tx) * (1 - tz)],
    [r, c1, tx * (1 - tz)],
    [r1, c, (1 - tx) * tz],
    [r1, c1, tx * tz],
  ];
  let svm = 0;
  let nits = 0;
  let wsum = 0;
  for (const [ri, ci, w] of corners) {
    if (w <= EPS) continue;
    const p = view.points[ri][ci];
    if (!p) return null;
    svm += p.svm * w;
    nits += p.nits * w;
    wsum += w;
  }
  if (wsum <= EPS) return null;
  return { svm: svm / wsum, nits: nits / wsum };
}

export interface SlicePoint {
  /** Gray slice: measured nits. Brightness slice: gray level. */
  x: number;
  svm: number;
  /** Measured nits of the (interpolated) cell. */
  nits: number;
  /** Gray level of the (interpolated) cell. */
  gray: number;
}

/** Interpolate nits geometrically when both ends are positive (luminance follows a power law). */
function lerpNits(a: number, b: number, t: number): number {
  if (a > 0 && b > 0) return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
  return a + (b - a) * t;
}

/**
 * Gray slice: SVM vs measured nits at an arbitrary (possibly fractional) gray level.
 * Rows are interpolated continuously, so sweeping `gray` animates smoothly. Gray outside the
 * measured range is clamped. Low-gray clip / nits cap are NOT applied (the chart axis decides).
 * Points with nits <= 0 are dropped (log axis). Sorted by nits ascending.
 */
export function sliceAtGray(ds: Pick<Dataset, 'matrix'>, gray: number): SlicePoint[] {
  const view = gridView(ds);
  const grays = view.grays;
  if (grays.length === 0) return [];
  const g = Math.min(grays[grays.length - 1], Math.max(grays[0], gray));
  const r = Math.max(0, bracket(grays, g));
  const r1 = Math.min(r + 1, grays.length - 1);
  const t = r1 === r ? 0 : (g - grays[r]) / (grays[r1] - grays[r]);
  const out: SlicePoint[] = [];
  for (let c = 0; c < view.x.length; c++) {
    const p0 = view.points[r][c];
    const p1 = view.points[r1][c];
    let nits: number;
    let svm: number;
    if (p0 && p1) {
      nits = lerpNits(p0.nits, p1.nits, t);
      svm = p0.svm + (p1.svm - p0.svm) * t;
    } else if (p0 && t < 1e-6) {
      nits = p0.nits;
      svm = p0.svm;
    } else if (p1 && t > 1 - 1e-6) {
      nits = p1.nits;
      svm = p1.svm;
    } else continue;
    if (!(nits > 0) || !Number.isFinite(svm)) continue;
    out.push({ x: nits, svm, nits, gray: g });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

/**
 * Brightness slice: SVM vs gray at a fixed level luminance (G255 nits), aligned across
 * devices by luminance rather than brightness percent. Columns are interpolated in
 * log1p-nits space. Honors the low-gray clip. Rows whose bracketing cells are missing,
 * or a level outside this record's measured range, yield no point. Sorted by gray ascending.
 */
export function sliceAtLevel(ds: Pick<Dataset, 'matrix'>, levelNits: number, opts: GridOptions = {}): SlicePoint[] {
  const view = gridView(ds, { clipLowGray: opts.clipLowGray, lowGrayThreshold: opts.lowGrayThreshold });
  const xq = logNits(levelNits);
  const c = bracket(view.x, xq);
  if (c < 0) return [];
  const c1 = Math.min(c + 1, view.x.length - 1);
  const t = c1 === c ? 0 : (xq - view.x[c]) / (view.x[c1] - view.x[c]);
  const out: SlicePoint[] = [];
  for (let r = 0; r < view.grays.length; r++) {
    const p0 = view.points[r][c];
    const p1 = view.points[r][c1];
    let svm: number;
    let nits: number;
    if (p0 && p1) {
      svm = p0.svm + (p1.svm - p0.svm) * t;
      nits = lerpNits(p0.nits, p1.nits, t);
    } else if (p0 && t < 1e-6) {
      svm = p0.svm;
      nits = p0.nits;
    } else if (p1 && t > 1 - 1e-6) {
      svm = p1.svm;
      nits = p1.nits;
    } else continue;
    if (!Number.isFinite(svm)) continue;
    out.push({ x: view.grays[r], svm, nits, gray: view.grays[r] });
  }
  return out;
}

/** Measured level-luminance range [min, max] of a record (positive columns only). */
export function levelRange(ds: Pick<Dataset, 'matrix'>): [number, number] | null {
  const v = gridView(ds);
  if (v.levelNits.length === 0) return null;
  return [v.levelNits[0], v.levelNits[v.levelNits.length - 1]];
}

export interface DiffResult {
  /** Grid of A (with the requested clip / cap). */
  view: GridView;
  /** values[r][c] = A - B at A's samples; null where either is missing / B out of range. */
  values: (number | null)[][];
  /** Largest |A - B| over non-null values (0 if none). */
  maxAbs: number;
  /** Number of non-null cells. */
  count: number;
}

/**
 * Difference map ΔSVM = A − B, evaluated on A's grid; B is bilinearly resampled at A's
 * (level luminance, gray) sample coordinates. Negative = A flickers less (better).
 */
export function diffRecords(a: Pick<Dataset, 'matrix'>, b: Pick<Dataset, 'matrix'>, opts: GridOptions = {}): DiffResult {
  const view = gridView(a, opts);
  const bView = gridView(b);
  let maxAbs = 0;
  let count = 0;
  const values = view.points.map((row, r) =>
    row.map((p, c) => {
      if (!p) return null;
      const s = sampleView(bView, view.x[c], view.grays[r]);
      if (!s) return null;
      const d = p.svm - s.svm;
      maxAbs = Math.max(maxAbs, Math.abs(d));
      count++;
      return d;
    }),
  );
  return { view, values, maxAbs, count };
}

/** "Nice" ticks for a log axis within [min, max] (1-2-5 sequence). */
export function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  if (!(min > 0) || !(max > min)) return out;
  const e0 = Math.floor(Math.log10(min));
  const e1 = Math.ceil(Math.log10(max));
  for (let e = e0; e <= e1; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(Number(v.toPrecision(6)));
    }
  }
  return out;
}

/** Ticks for the log1p terrain axis up to maxNits (always includes 0 when it fits). */
export function terrainNitsTicks(maxNits: number = DEFAULT_MAX_NITS): number[] {
  return [0, ...logTicks(1, maxNits)];
}

/** Format an SVM value for labels. */
export function fmtSvm(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

/** Format nits compactly: 0.012, 0.35, 2.1, 35, 512. */
export function fmtNits(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.1) return v.toFixed(2);
  return v.toFixed(3);
}
