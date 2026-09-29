/**
 * Slices for the 2D chart, with smooth interpolation along the sweep parameter.
 *
 * The data model (src/data/grid.ts) defines the slices: a gray slice is SVM vs measured nits at
 * a (fractional) gray level; a brightness slice is SVM vs gray at a level luminance. grid.ts
 * interpolates between measured rows / columns LINEARLY. That is exact at the measured samples
 * but its derivative jumps at every measured row: during a G255→G50 sweep each curve point
 * moves at constant speed and then abruptly changes speed ~13 times, which reads as visual
 * stutter. Here the same slices are interpolated with a monotone cubic (Fritsch–Carlson)
 * along the swept axis: identical values at every measured row / column (see slices.test.ts),
 * never overshooting the neighbouring measurements, but C1-continuous in the parameter, so
 * the motion is fluid. Missing cells are never bridged (same rule as grid.ts).
 */
import type { SvmRecord, SliceMode } from '../types';
import { bracket, gridView, logNits, type SlicePoint } from '../data/grid';
import { hermite, monotoneSlopes } from './spline';

type Matrix = SvmRecord['matrix'];

// ---------------------------------------------------------------------------------------------
// Gray slice (x = measured nits), interpolated along gray per column.

interface GrayProfile {
  grays: number[];
  /** per column: svm by row (NaN = missing), ln(nits) by row, slopes wrt gray. */
  cols: { svm: Float64Array; ln: Float64Array; ms: Float64Array; ml: Float64Array }[];
}

const grayCache = new WeakMap<Matrix, GrayProfile>();

function grayProfile(rec: Pick<SvmRecord, 'matrix'>): GrayProfile {
  const hit = grayCache.get(rec.matrix);
  if (hit) return hit;
  const view = gridView(rec);
  const R = view.grays.length;
  const cols: GrayProfile['cols'] = [];
  for (let c = 0; c < view.x.length; c++) {
    const svm = new Float64Array(R);
    const ln = new Float64Array(R);
    for (let r = 0; r < R; r++) {
      const p = view.points[r][c];
      const ok = !!p && Number.isFinite(p.svm) && p.nits > 0;
      svm[r] = ok ? p!.svm : NaN;
      ln[r] = ok ? Math.log(p!.nits) : NaN;
    }
    cols.push({ svm, ln, ms: monotoneSlopes(view.grays, svm), ml: monotoneSlopes(view.grays, ln) });
  }
  const prof = { grays: view.grays, cols };
  grayCache.set(rec.matrix, prof);
  return prof;
}

/**
 * Gray slice at a (fractional) gray level. Same contract as grid.sliceAtGray (gray clamped to
 * the measured range, nits <= 0 dropped, sorted by nits) with C1 interpolation between rows.
 */
export function smoothSliceAtGray(rec: Pick<SvmRecord, 'matrix'>, gray: number): SlicePoint[] {
  const { grays, cols } = grayProfile(rec);
  const R = grays.length;
  if (R === 0) return [];
  const g = Math.min(grays[R - 1], Math.max(grays[0], gray));
  const r = Math.max(0, bracket(grays, g));
  const r1 = Math.min(r + 1, R - 1);
  const t = r1 === r ? 0 : (g - grays[r]) / (grays[r1] - grays[r]);
  const out: SlicePoint[] = [];
  for (const col of cols) {
    let svm: number;
    let ln: number;
    const ok0 = Number.isFinite(col.svm[r]);
    const ok1 = Number.isFinite(col.svm[r1]);
    if (ok0 && ok1) {
      svm = hermite(grays[r], grays[r1], col.svm[r], col.svm[r1], col.ms[r], col.ms[r1], g);
      ln = hermite(grays[r], grays[r1], col.ln[r], col.ln[r1], col.ml[r], col.ml[r1], g);
      if (r1 === r) {
        svm = col.svm[r];
        ln = col.ln[r];
      }
    } else if (ok0 && t < 1e-6) {
      svm = col.svm[r];
      ln = col.ln[r];
    } else if (ok1 && t > 1 - 1e-6) {
      svm = col.svm[r1];
      ln = col.ln[r1];
    } else continue;
    const nits = Math.exp(ln);
    if (!(nits > 0) || !Number.isFinite(svm)) continue;
    out.push({ x: nits, svm, nits, gray: g });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Brightness slice (x = gray), interpolated along level luminance (log1p nits) per row.

interface LevelProfile {
  grays: number[];
  x: number[];
  rows: { svm: Float64Array; ln: Float64Array; ms: Float64Array; ml: Float64Array }[];
}

const levelCache = new WeakMap<Matrix, Map<string, LevelProfile>>();

function levelProfile(rec: Pick<SvmRecord, 'matrix'>, clipLowGray: boolean): LevelProfile {
  let per = levelCache.get(rec.matrix);
  if (!per) {
    per = new Map();
    levelCache.set(rec.matrix, per);
  }
  const key = clipLowGray ? 'clip' : 'all';
  const hit = per.get(key);
  if (hit) return hit;
  const view = gridView(rec, { clipLowGray });
  const C = view.x.length;
  const rows: LevelProfile['rows'] = [];
  for (let r = 0; r < view.grays.length; r++) {
    const svm = new Float64Array(C);
    const ln = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      const p = view.points[r][c];
      const ok = !!p && Number.isFinite(p.svm);
      svm[c] = ok ? p!.svm : NaN;
      ln[c] = ok && p!.nits > 0 ? Math.log(p!.nits) : NaN;
    }
    rows.push({ svm, ln, ms: monotoneSlopes(view.x, svm), ml: monotoneSlopes(view.x, ln) });
  }
  const prof = { grays: view.grays, x: view.x, rows };
  per.set(key, prof);
  return prof;
}

/**
 * Brightness slice at a level luminance (G255 nits). Same contract as grid.sliceAtLevel
 * (honours the low-gray clip; a level outside the record's measured range yields no points;
 * sorted by gray) with C1 interpolation between columns in log1p-nits space.
 */
export function smoothSliceAtLevel(rec: Pick<SvmRecord, 'matrix'>, levelNits: number, opts: { clipLowGray?: boolean } = {}): SlicePoint[] {
  const { grays, x, rows } = levelProfile(rec, !!opts.clipLowGray);
  const xq = logNits(levelNits);
  const c = bracket(x, xq);
  if (c < 0) return [];
  const c1 = Math.min(c + 1, x.length - 1);
  const t = c1 === c ? 0 : (xq - x[c]) / (x[c1] - x[c]);
  const out: SlicePoint[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let svm: number;
    let ln: number;
    const ok0 = Number.isFinite(row.svm[c]);
    const ok1 = Number.isFinite(row.svm[c1]);
    if (ok0 && ok1) {
      if (c1 === c) {
        svm = row.svm[c];
        ln = row.ln[c];
      } else {
        svm = hermite(x[c], x[c1], row.svm[c], row.svm[c1], row.ms[c], row.ms[c1], xq);
        ln = Number.isFinite(row.ln[c]) && Number.isFinite(row.ln[c1]) ? hermite(x[c], x[c1], row.ln[c], row.ln[c1], row.ml[c], row.ml[c1], xq) : NaN;
      }
    } else if (ok0 && t < 1e-6) {
      svm = row.svm[c];
      ln = row.ln[c];
    } else if (ok1 && t > 1 - 1e-6) {
      svm = row.svm[c1];
      ln = row.ln[c1];
    } else continue;
    if (!Number.isFinite(svm)) continue;
    out.push({ x: grays[r], svm, nits: Number.isFinite(ln) ? Math.exp(ln) : NaN, gray: grays[r] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Slice dispatch, sweeps and data extents.

export function sliceFor(rec: SvmRecord, mode: SliceMode, param: number, clipLowGray: boolean): SlicePoint[] {
  return mode === 'gray' ? smoothSliceAtGray(rec, param) : smoothSliceAtLevel(rec, param, { clipLowGray });
}

export const SWEEP_DURATION = 10;
/** Gray sweep G255 → G50 (linear in gray, as v1). */
export const GRAY_SWEEP: [number, number] = [255, 50];
/** Brightness sweep 500 → 2 nits (logarithmic in level luminance). */
export const LEVEL_SWEEP: [number, number] = [500, 2];

/** Smooth, gentle ease (C∞, lowest peak speed of the common in-out eases). */
export const easeInOutSine = (p: number) => -(Math.cos(Math.PI * Math.min(1, Math.max(0, p))) - 1) / 2;

/** Sweep parameter (gray level or level nits) at t seconds. Pure function of t. */
export function sweepParam(mode: SliceMode, t: number): number {
  const e = easeInOutSine(t / SWEEP_DURATION);
  if (mode === 'gray') return GRAY_SWEEP[0] + (GRAY_SWEEP[1] - GRAY_SWEEP[0]) * e;
  const a = Math.log(LEVEL_SWEEP[0]);
  const b = Math.log(LEVEL_SWEEP[1]);
  return Math.exp(a + (b - a) * e);
}

export interface Extent {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function extendExtent(e: Extent | null, pts: SlicePoint[]): Extent | null {
  for (const p of pts) {
    if (!e) e = { xMin: p.x, xMax: p.x, yMin: p.svm, yMax: p.svm };
    else {
      if (p.x < e.xMin) e.xMin = p.x;
      if (p.x > e.xMax) e.xMax = p.x;
      if (p.svm < e.yMin) e.yMin = p.svm;
      if (p.svm > e.yMax) e.yMax = p.svm;
    }
  }
  return e;
}

/** Data extent of the given slices. */
export function slicesExtent(slices: SlicePoint[][]): Extent | null {
  let e: Extent | null = null;
  for (const s of slices) e = extendExtent(e, s);
  return e;
}

/**
 * Extent over the WHOLE sweep, so adaptive / free axes stay fixed while it plays. The
 * interpolation is monotone between measured rows / columns, so extremes occur at measured
 * samples: evaluating at every measured row / column inside the sweep range (plus the two
 * ends) bounds every frame.
 */
export function sweepExtent(records: SvmRecord[], mode: SliceMode, clipLowGray: boolean): Extent | null {
  let e: Extent | null = null;
  for (const rec of records) {
    if (mode === 'gray') {
      const [hi, lo] = GRAY_SWEEP;
      const params = [hi, lo, ...gridView(rec).grays.filter((g) => g > lo && g < hi)];
      for (const g of params) e = extendExtent(e, smoothSliceAtGray(rec, g));
    } else {
      const [hi, lo] = LEVEL_SWEEP;
      const params = [hi, lo, ...gridView(rec).levelNits.filter((n) => n > lo && n < hi)];
      for (const n of params) e = extendExtent(e, smoothSliceAtLevel(rec, n, { clipLowGray }));
    }
  }
  return e;
}

/** Title / label formatting of a level luminance: 500, 35, 7.5. */
export function fmtLevel(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(1);
}
