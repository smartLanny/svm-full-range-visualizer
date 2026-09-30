/**
 * Moving axes for the adaptive / free axis modes while a sweep plays (docs/adr/0006, addendum
 * "fix round 3"): the axis range follows the data of the CURRENT frame, calmly.
 *
 * The raw range of a frame is an opacity-weighted extent (weightedExtent), so points fading in
 * or out along a sweep move the range continuously instead of making it jump. A sweep's range is
 * a pure function of the sweep time t (video export renders frames by t, docs/adr/0003/0010):
 * the raw range is sampled over the whole sweep at 60 Hz and smoothed there, once:
 *
 * 1. hold: every bound is widened to the most extreme raw value within ±TRACK_HOLD s
 *    (a running max / min, symmetric in time),
 * 2. speed limit: no bound moves faster than TRACK_SPEED × the current span per second (a zoom /
 *    pan rate; a symmetric forward / backward pass, i.e. the tightest such envelope around it),
 * 3. a zero-phase raised-cosine kernel of ±TRACK_KERNEL s (≤ TRACK_HOLD) rounds the motion.
 *
 * Each step only ever widens the range around the raw data (the kernel is no wider than the
 * hold window), so the drawn points never leave the plot: the range anticipates a change a
 * little and lets go of it slowly, which is what reads as calm. Frames between samples are
 * interpolated linearly.
 *
 * A glide into / out of a sweep (UI only) follows its own frames the same way, sampled along the
 * glide's progress p, and is pinned to the exact ranges of its two ends (glideTrack).
 */
import type { SliceMode, SvmRecord } from '../types';
import { sliceFor, sweepParam, SWEEP_DURATION, type CurvePoint } from './slices';

/** A data range in axis units: x = log10(nits) (gray slice) or gray (brightness slice), y = SVM. */
export interface URange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Sampling step of a sweep's range track (s). */
export const TRACK_DT = 1 / 60;
/** Hold window (s, each side): a bound anticipates / keeps an extreme this long. */
export const TRACK_HOLD = 0.35;
/** Raised-cosine smoothing half-width (s); never wider than TRACK_HOLD (containment). */
export const TRACK_KERNEL = 0.35;
/** Speed limit of a bound: share of the current span per second (a zoom / pan rate). */
export const TRACK_SPEED = 1;

/** Samples of a glide's range track along its progress p (0..1). */
export const GLIDE_SAMPLES = 48;
/** Hold / kernel half-width of a glide track, in samples. */
const GLIDE_HOLD = 2;

const ax = (mode: SliceMode, x: number) => (mode === 'gray' ? Math.log10(x) : x);

/**
 * Opacity-weighted extent of the points of a frame, in axis units. Every point is pulled toward
 * the frame's opacity-weighted centre by (1 − a): an opaque point counts fully, a fading one
 * partly, an invisible one not at all. For an all-opaque frame (every static slice) this is the
 * plain extent. Continuous in every point's position and opacity (min / max of continuous terms
 * around a continuous centre), so a fade never moves the range in one frame. null = no point.
 */
export function weightedRange(mode: SliceMode, slices: CurvePoint[][]): URange | null {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (const s of slices) {
    for (const p of s) {
      const w = Math.min(1, Math.max(0, p.a));
      if (!(w > 0) || !(p.x > 0 || mode !== 'gray') || !Number.isFinite(p.svm)) continue;
      sw += w;
      mx += w * ax(mode, p.x);
      my += w * p.svm;
    }
  }
  if (!(sw > 0)) return null;
  mx /= sw;
  my /= sw;
  const r: URange = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const s of slices) {
    for (const p of s) {
      const w = Math.min(1, Math.max(0, p.a));
      if (!(w > 0) || !(p.x > 0 || mode !== 'gray') || !Number.isFinite(p.svm)) continue;
      const x = mx + w * (ax(mode, p.x) - mx);
      const y = my + w * (p.svm - my);
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
    }
  }
  return r;
}

/** Fill null samples from their nearest non-null neighbour (null if all are null). */
function fillGaps(raw: (URange | null)[]): URange[] | null {
  const first = raw.findIndex((r) => !!r);
  if (first < 0) return null;
  const out: URange[] = new Array(raw.length);
  let last = raw[first]!;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]) last = raw[i]!;
    out[i] = last; // leading nulls take the first value
  }
  return out;
}

/** Running max (upper) / min (lower) over ±hold samples, the ends held. */
function holdBound(v: ArrayLike<number>, upper: boolean, hold: number): Float64Array {
  const n = v.length;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = upper ? -Infinity : Infinity;
    for (let k = -hold; k <= hold; k++) {
      const x = v[Math.min(n - 1, Math.max(0, i + k))];
      m = upper ? Math.max(m, x) : Math.min(m, x);
    }
    d[i] = m;
  }
  return d;
}

/**
 * Speed limit + kernel of one held bound (upper = max bound). `step[i]` = the largest change
 * allowed between samples i − 1 and i (null = no limit): the smallest such function outside the
 * held bound (symmetric forward / backward pass), then a raised cosine of ±kernel samples. With
 * kernel ≤ the hold window the result never gets inside the raw bound (containment).
 */
function limitAndSmooth(held: Float64Array, upper: boolean, step: Float64Array | null, kernel: number): Float64Array {
  const n = held.length;
  const sg = upper ? 1 : -1;
  const d = Float64Array.from(held, (x) => sg * x);
  if (step) {
    for (let i = 1; i < n; i++) d[i] = Math.max(d[i], d[i - 1] - step[i]);
    for (let i = n - 2; i >= 0; i--) d[i] = Math.max(d[i], d[i + 1] - step[i + 1]);
  }
  const w: number[] = [];
  let ws = 0;
  for (let k = -kernel; k <= kernel; k++) {
    const c = 0.5 * (1 + Math.cos((Math.PI * k) / (kernel + 1)));
    w.push(c);
    ws += c;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -kernel; k <= kernel; k++) s += w[k + kernel] * d[Math.min(n - 1, Math.max(0, i + k))];
    out[i] = (sg * s) / ws;
  }
  return out;
}

/** A smoothed range track: bounds sampled every `dt` from 0. */
export interface RangeTrack {
  dt: number;
  x0: Float64Array;
  x1: Float64Array;
  y0: Float64Array;
  y1: Float64Array;
}

/** Range at `t` (linear between samples, held beyond the ends). */
export function trackAt(tr: RangeTrack, t: number): URange {
  const n = tr.x0.length;
  const f = Math.min(n - 1, Math.max(0, t / tr.dt));
  const i = Math.min(n - 2, Math.floor(f));
  if (i < 0) return { x0: tr.x0[0], x1: tr.x1[0], y0: tr.y0[0], y1: tr.y1[0] };
  const u = f - i;
  const l = (a: Float64Array) => a[i] + (a[i + 1] - a[i]) * u;
  return { x0: l(tr.x0), x1: l(tr.x1), y0: l(tr.y0), y1: l(tr.y1) };
}

/**
 * Smooth a series of raw ranges sampled every `dt` (see the module comment). `speed` limits
 * every bound to `speed` × the current (held) span per second, i.e. a zoom / pan rate, the same
 * at any scale (Infinity = no limit).
 */
export function smoothTrack(raw: (URange | null)[], dt: number, holdS: number, kernelS: number, speed: number): RangeTrack | null {
  const filled = fillGaps(raw);
  if (!filled) return null;
  const hold = Math.max(0, Math.round(holdS / dt));
  const kernel = Math.min(hold, Math.max(0, Math.round(kernelS / dt)));
  const held = (k: keyof URange, upper: boolean) => holdBound(Float64Array.from(filled, (r) => r[k]), upper, hold);
  const x0 = held('x0', false);
  const x1 = held('x1', true);
  const y0 = held('y0', false);
  const y1 = held('y1', true);
  const steps = (lo: Float64Array, hi: Float64Array) => {
    if (!Number.isFinite(speed)) return null;
    const out = new Float64Array(lo.length);
    for (let i = 1; i < lo.length; i++) out[i] = speed * dt * Math.max(1e-6, hi[i] - lo[i], hi[i - 1] - lo[i - 1]);
    return out;
  };
  const sx = steps(x0, x1);
  const sy = steps(y0, y1);
  return {
    dt,
    x0: limitAndSmooth(x0, false, sx, kernel),
    x1: limitAndSmooth(x1, true, sx, kernel),
    y0: limitAndSmooth(y0, false, sy, kernel),
    y1: limitAndSmooth(y1, true, sy, kernel),
  };
}

/** Raw (unsmoothed) weighted range of every sweep frame at TRACK_DT. */
export function rawSweepRanges(records: SvmRecord[], mode: SliceMode, clipLowGray: boolean): (URange | null)[] {
  const n = Math.round(SWEEP_DURATION / TRACK_DT);
  const out: (URange | null)[] = [];
  for (let i = 0; i <= n; i++) {
    const prm = sweepParam(mode, i * TRACK_DT);
    out.push(weightedRange(mode, records.map((r) => sliceFor(r, mode, prm, clipLowGray))));
  }
  return out;
}

/** The smoothed range track of a sweep over `records` (null = no data in any frame). */
export function sweepTrack(records: SvmRecord[], mode: SliceMode, clipLowGray: boolean): RangeTrack | null {
  return smoothTrack(rawSweepRanges(records, mode, clipLowGray), TRACK_DT, TRACK_HOLD, TRACK_KERNEL, TRACK_SPEED);
}

/**
 * Range track of a glide: `frameAt(p)` gives the glide's frame at progress p (already eased),
 * `a` / `b` the exact ranges at its ends (a static slice's extent, or a sweep track's value).
 * The glide's own frames are sampled at GLIDE_SAMPLES + 1 progress values, held and smoothed
 * like a sweep (no speed limit: a glide is short and eased), then pinned to the two ends with a
 * linear correction, so a glide starts exactly on the static picture and lands exactly on the
 * sweep's range (and back). Returns the range at p.
 */
export function glideTrack(mode: SliceMode, frameAt: (p: number) => CurvePoint[][], a: URange | null, b: URange | null): ((p: number) => URange | null) | null {
  const raw: (URange | null)[] = [];
  for (let i = 0; i <= GLIDE_SAMPLES; i++) raw.push(weightedRange(mode, frameAt(i / GLIDE_SAMPLES)));
  const tr = smoothTrack(raw, 1 / GLIDE_SAMPLES, GLIDE_HOLD / GLIDE_SAMPLES, GLIDE_HOLD / GLIDE_SAMPLES, Infinity);
  if (!tr) return !a && !b ? null : (p) => (p < 0.5 ? (a ?? b) : (b ?? a));
  const g0 = trackAt(tr, 0);
  const g1 = trackAt(tr, 1);
  const A = a ?? g0;
  const B = b ?? g1;
  return (p: number) => {
    const q = Math.min(1, Math.max(0, p));
    const g = trackAt(tr, q);
    const pin = (k: keyof URange) => g[k] + (1 - q) * (A[k] - g0[k]) + q * (B[k] - g1[k]);
    return { x0: pin('x0'), x1: pin('x1'), y0: pin('y0'), y1: pin('y1') };
  };
}
