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
 * the motion is fluid.
 *
 * Missing cells (never measured, or no data after the denoise, docs/adr/0012) are never interpolated across along the swept
 * axis: a point whose neighbouring row / column is missing stays at its measured value and
 * fades out over that interval (and fades in on the way back), so nothing pops. Along the
 * curve a missing sample is a gap; the renderer marks it (dotted) instead of bridging it.
 * Those fades are for sweeps only: a static slice snaps every point to a reading or nothing
 * (settleSlice), so it never shows faint ghost segments.
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

/** Smooth 0→1 ramp (zero slope at both ends): alpha ramps start and end gently. */
const smooth01 = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/**
 * A slice point as drawn: `a` is its opacity (0..1] and `key` the measured column (gray slice)
 * or row (brightness slice) it comes from, so gaps can be recognised (a key between two
 * drawn points that is not drawn itself = a missing measurement / no data).
 */
export interface CurvePoint extends SlicePoint {
  a: number;
  key: number;
}

/** Opacity in the middle of a short missing span that is interpolated across (see sampleAlong). */
const SHORT_GAP_ALPHA = 0.35;

/** Fade windows along the swept axis, ≈ 8 frames at the sweep's peak speed (never a blink). */
export const GRAY_FADE = 4.5;
export const LEVEL_FADE = 0.045;

/**
 * One measured series (a column of the gray profile, a row of the level profile) at position q
 * of the swept axis, between samples i0 ≤ i1 (xs[i0] ≤ q ≤ xs[i1]).
 *
 * - Both samples valid: monotone cubic, fully opaque.
 * - Otherwise let lo / hi be the nearest valid samples below / above. A short missing span
 *   (shorter than two fade windows) is interpolated across with a dip in opacity (so the point
 *   does not blink out and back in within a few frames, and is still marked as not measured).
 * - A longer span, or a series that ends: the point stays at the last valid sample's value and
 *   fades out across the interval next to it (at least `fade` wide, at most half the span), and
 *   fades in the same way before the next valid sample.
 *
 * So a point never appears or disappears in one frame: records with no-data cells and grids
 * whose rows / columns do not all cover the same range fade instead of popping (docs/adr/0003:
 * the frame is a continuous function of the sweep parameter).
 */
function sampleAlong(
  xs: number[],
  i0: number,
  i1: number,
  q: number,
  fade: number,
  svmA: Float64Array,
  lnA: Float64Array,
  ms: Float64Array,
  ml: Float64Array,
): { svm: number; ln: number; a: number } | null {
  const ok = (i: number) => Number.isFinite(svmA[i]);
  if (ok(i0) && ok(i1)) {
    if (i1 === i0 || q <= xs[i0]) return { svm: svmA[i0], ln: lnA[i0], a: 1 };
    if (q >= xs[i1]) return { svm: svmA[i1], ln: lnA[i1], a: 1 };
    const svm = hermite(xs[i0], xs[i1], svmA[i0], svmA[i1], ms[i0], ms[i1], q);
    const ln = Number.isFinite(lnA[i0]) && Number.isFinite(lnA[i1]) ? hermite(xs[i0], xs[i1], lnA[i0], lnA[i1], ml[i0], ml[i1], q) : NaN;
    return { svm, ln, a: 1 };
  }
  let lo = i0;
  while (lo >= 0 && !ok(lo)) lo--;
  let hi = i1;
  while (hi < xs.length && !ok(hi)) hi++;
  const hasLo = lo >= 0;
  const hasHi = hi < xs.length;
  const span = hasLo && hasHi ? xs[hi] - xs[lo] : Infinity;
  if (span < 2 * fade) {
    // short gap: interpolate across it (linear), opacity dips smoothly toward SHORT_GAP_ALPHA
    const u = Math.min(1, Math.max(0, (q - xs[lo]) / span));
    const bump = Math.sin(Math.PI * u) ** 2;
    const a = 1 - (1 - SHORT_GAP_ALPHA) * Math.min(1, span / (2 * fade)) * bump;
    const lin = (A: Float64Array) => A[lo] + (A[hi] - A[lo]) * u;
    return { svm: lin(svmA), ln: Number.isFinite(lnA[lo]) && Number.isFinite(lnA[hi]) ? lin(lnA) : NaN, a };
  }
  if (hasLo && q >= xs[lo]) {
    const w = Math.min(Math.max(xs[Math.min(lo + 1, xs.length - 1)] - xs[lo], fade), span / 2);
    const a = 1 - smooth01((q - xs[lo]) / w);
    if (a > 0) return { svm: svmA[lo], ln: lnA[lo], a };
  }
  if (hasHi && q <= xs[hi]) {
    const w = Math.min(Math.max(xs[hi] - xs[Math.max(hi - 1, 0)], fade), span / 2);
    const a = 1 - smooth01((xs[hi] - q) / w);
    if (a > 0) return { svm: svmA[hi], ln: lnA[hi], a };
  }
  return null;
}

/**
 * Gray slice at a (fractional) gray level. Same contract as grid.sliceAtGray (gray clamped to
 * the measured range, nits <= 0 dropped, sorted by nits) with C1 interpolation between rows;
 * cells missing on one side of the interval fade (see sampleAlong). Ties in nits are kept
 * (several columns can share a quantised reading; the curve then shows their spread instead
 * of an average) and ordered by column.
 */
export function smoothSliceAtGray(rec: Pick<SvmRecord, 'matrix'>, gray: number): CurvePoint[] {
  const { grays, cols } = grayProfile(rec);
  const R = grays.length;
  if (R === 0) return [];
  const g = Math.min(grays[R - 1], Math.max(grays[0], gray));
  const r = Math.max(0, bracket(grays, g));
  const r1 = Math.min(r + 1, R - 1);
  const out: CurvePoint[] = [];
  cols.forEach((col, c) => {
    const v = sampleAlong(grays, r, r1, g, GRAY_FADE, col.svm, col.ln, col.ms, col.ml);
    if (!v) return;
    const nits = Math.exp(v.ln);
    if (!(nits > 0) || !Number.isFinite(v.svm)) return;
    out.push({ x: nits, svm: v.svm, nits, gray: g, a: v.a, key: c });
  });
  out.sort((a, b) => a.x - b.x || a.key - b.key);
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
 * Outside its measured level range a record's brightness slice is held at the nearest measured
 * column and fades out over this distance (in logNits units, ≈ 15 % in nits). A level sweep
 * that runs past a record's range therefore fades its curve instead of dropping it in one
 * frame; beyond the margin the record has no slice (same as grid.sliceAtLevel).
 */
export const LEVEL_EDGE_FADE = 0.06;

/**
 * Brightness slice at a level luminance (G255 nits). Same contract as grid.sliceAtLevel
 * (honours the low-gray clip; sorted by gray) with C1 interpolation between columns in
 * log1p-nits space; cells missing on one side fade (see sampleAlong) and a level just outside
 * the measured range yields the nearest column, fading (LEVEL_EDGE_FADE).
 */
export function smoothSliceAtLevel(rec: Pick<SvmRecord, 'matrix'>, levelNits: number, opts: { clipLowGray?: boolean } = {}): CurvePoint[] {
  const { grays, x, rows } = levelProfile(rec, !!opts.clipLowGray);
  const C = x.length;
  if (C === 0) return [];
  const xq = logNits(levelNits);
  let edge = 1;
  let q = xq;
  if (xq < x[0] || xq > x[C - 1]) {
    const d = xq < x[0] ? x[0] - xq : xq - x[C - 1];
    edge = 1 - smooth01(d / LEVEL_EDGE_FADE);
    if (!(edge > 0)) return [];
    q = xq < x[0] ? x[0] : x[C - 1];
  }
  const c = Math.max(0, bracket(x, q));
  const c1 = Math.min(c + 1, C - 1);
  const out: CurvePoint[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const v = sampleAlong(x, c, c1, q, LEVEL_FADE, row.svm, row.ln, row.ms, row.ml);
    if (!v || !Number.isFinite(v.svm)) continue;
    out.push({ x: grays[r], svm: v.svm, nits: Number.isFinite(v.ln) ? Math.exp(v.ln) : NaN, gray: grays[r], a: v.a * edge, key: r });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Static slices: readings only.

/**
 * Opacity from which a slice point counts as a reading: the tooltip, the data table and the
 * stats read the curve only where it is at least this opaque (evalCurve, curveXRange).
 */
export const READING_ALPHA = 0.5;

/**
 * A slice as drawn in a frame that is `w` static: 1 = a static slice, 0 = a sweep frame, in
 * between while gliding from one to the other (`ref` = the same record's slice at the static
 * end of the glide; default: `pts` itself, i.e. a static slice).
 *
 * The fades of sampleAlong / LEVEL_EDGE_FADE are there so a SWEEP never pops. A static slice
 * shows readings only: a point is either a reading (opacity ≥ READING_ALPHA, drawn fully opaque)
 * or not drawn, never a faint ghost; the dropped point's column / row becomes a gap, so the curve
 * keeps its measured-backed segments plus the dotted gap bridges (buildCurve).
 *
 * In between, each point's opacity is scaled by a per-key gain that goes from its static value
 * (1 / a_static for a reading, 0 otherwise) to 1: a continuous function of both w and the moving
 * slice, so a glide between a static slice and a sweep never pops either (a point that is not in
 * the moving slice has opacity 0 there, whatever its gain).
 */
export function settleSlice(pts: CurvePoint[], w = 1, ref: CurvePoint[] = pts): CurvePoint[] {
  if (!(w > 0)) return pts;
  const gain = new Map<number, number>();
  for (const p of ref) gain.set(p.key, p.a >= READING_ALPHA ? 1 / p.a : 0);
  const out: CurvePoint[] = [];
  for (const p of pts) {
    const k = w * (gain.get(p.key) ?? 0) + (1 - w);
    const a = p.a * k > 1 - 1e-9 ? 1 : p.a * k; // a reading ends exactly opaque
    if (a > 1e-6) out.push(a === p.a ? p : { ...p, a });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Slice dispatch, sweeps and data extents.

export function sliceFor(rec: SvmRecord, mode: SliceMode, param: number, clipLowGray: boolean): CurvePoint[] {
  return mode === 'gray' ? smoothSliceAtGray(rec, param) : smoothSliceAtLevel(rec, param, { clipLowGray });
}

/** The static slice (readings only, see settleSlice) of a record. */
export function staticSliceFor(rec: SvmRecord, mode: SliceMode, param: number, clipLowGray: boolean): CurvePoint[] {
  return settleSlice(sliceFor(rec, mode, param, clipLowGray));
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
      // measured columns inside the sweep (the held edge values are measured columns too)
      const params = [hi, lo, ...gridView(rec).levelNits.filter((n) => n > lo && n < hi)];
      for (const n of params) e = extendExtent(e, smoothSliceAtLevel(rec, n, { clipLowGray }));
    }
  }
  return e;
}

/** Title / label formatting of a level luminance: 500, 35, 7.5, 2 (at most one decimal, no trailing ".0"). */
export function fmtLevel(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 9.95) return String(Math.round(n));
  return String(Number(n.toFixed(1)));
}
