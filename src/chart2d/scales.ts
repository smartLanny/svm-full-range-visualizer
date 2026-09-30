/**
 * Axis domains and ticks for the 2D chart (docs/adr/0006: standard / adaptive / free).
 *
 * Every axis works in "axis units" u: log10(nits) for the log luminance axis, the value itself
 * for linear axes. Curves are splined in axis units and mapped affinely to pixels.
 */
import type { AxisMode, SliceMode } from '../types';
import type { Extent } from './slices';

export interface Tick {
  /** Axis units. */
  u: number;
  label: string | null;
  /** Major ticks get a gridline + label; minor ones a faint gridline only. */
  major: boolean;
  /**
   * Moving axis only (docs/adr/0006, fix round 3): gridline opacity. A still axis leaves it
   * undefined and draws every tick inside its domain fully.
   */
  alpha?: number;
  /** Moving axis only: label opacity (the label may sit just outside the domain as it fades). */
  labelAlpha?: number;
}

/** Motion state of a moving axis (see edgeAlpha). */
export interface AxisMotionState {
  /** How static the frame is: 1 = a static slice, 0 = a sweep frame, in between in a glide. */
  settle: number;
  /** Domain at the static end of a glide (= the domain itself when there is none). */
  s0: number;
  s1: number;
}

export interface Axis {
  log: boolean;
  /** Domain in axis units. */
  u0: number;
  u1: number;
  ticks: Tick[];
  /** Set while the axis follows the data of a sweep / glide frame; absent on a still axis. */
  motion?: AxisMotionState;
}

export const toU = (axis: Pick<Axis, 'log'>, v: number) => (axis.log ? Math.log10(v) : v);
export const fromU = (axis: Pick<Axis, 'log'>, u: number) => (axis.log ? Math.pow(10, u) : u);

export const STANDARD_NITS: [number, number] = [0.01, 500];
export const STANDARD_SVM: [number, number] = [0, 6];
export const STANDARD_GRAY: [number, number] = [0, 255];

/** Compact nits label: 0.01, 0.2, 1, 50, 500, 1k. */
export function fmtTickNits(v: number): string {
  if (v >= 1000) return `${Number((v / 1000).toPrecision(3))}k`;
  return String(Number(v.toPrecision(3)));
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const m = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return m * p;
}

function fmtLinear(v: number, step: number): string {
  const digits = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(digits);
}

/** "Nice" linear ticks inside [a, b]. */
export function linearTicks(a: number, b: number, count = 6): Tick[] {
  if (!(b > a)) return [{ u: a, label: fmtLinear(a, 1), major: true }];
  const step = niceStep(b - a, count);
  const out: Tick[] = [];
  const start = Math.ceil(a / step - 1e-9) * step;
  for (let v = start; v <= b + step * 1e-9; v += step) {
    const val = Math.abs(v) < step * 1e-9 ? 0 : v;
    out.push({ u: val, label: fmtLinear(val, step), major: true });
  }
  return out;
}

/** Ticks for a log axis [lo, hi] (values in nits). */
export function logAxisTicks(lo: number, hi: number, standard: boolean): Tick[] {
  const out: Tick[] = [];
  const e0 = Math.floor(Math.log10(lo)) - 1;
  const e1 = Math.ceil(Math.log10(hi)) + 1;
  const decades = Math.log10(hi / lo);
  const inRange = (v: number) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9);
  for (let e = e0; e <= e1; e++) {
    for (let m = 1; m <= 9; m++) {
      const v = Number((m * Math.pow(10, e)).toPrecision(6));
      if (!inRange(v)) continue;
      const isDecade = m === 1;
      const is25 = m === 2 || m === 5;
      if (standard) {
        // 0.01, 0.1, 1, 10, 100 (+ 500 below); faint 2 / 5 minors.
        if (isDecade) out.push({ u: Math.log10(v), label: fmtTickNits(v), major: true });
        else if (is25) out.push({ u: Math.log10(v), label: null, major: false });
      } else if (decades > 4.2) {
        if (isDecade) out.push({ u: Math.log10(v), label: fmtTickNits(v), major: true });
        else if (is25) out.push({ u: Math.log10(v), label: null, major: false });
      } else if (decades > 0.9) {
        if (isDecade || is25) out.push({ u: Math.log10(v), label: fmtTickNits(v), major: true });
        else out.push({ u: Math.log10(v), label: null, major: false });
      } else {
        out.push({ u: Math.log10(v), label: fmtTickNits(v), major: true });
      }
    }
  }
  if (standard) {
    // 500 is the standard right edge: label it (replacing the minor 5 × 100 gridline).
    const u500 = Math.log10(500);
    const i = out.findIndex((t) => Math.abs(t.u - u500) < 1e-9);
    if (i >= 0) out[i] = { u: u500, label: '500', major: true };
  }
  return out;
}

export interface Axes {
  x: Axis;
  y: Axis;
}

/** Motion input of buildAxes: how static the frame is, and the data extent at a glide's static end. */
export interface AxisMotion {
  settle: number;
  /** Extent at the static end of a glide (settle > 0), else null. */
  from: Extent | null;
}

/** x domain (axis units) for a slice + axis mode; `extent` in data units (nits or gray). */
export function xDomain(slice: SliceMode, mode: AxisMode, extent: Extent | null): [number, number] {
  if (slice === 'gray') {
    let lo = STANDARD_NITS[0];
    let hi = STANDARD_NITS[1];
    if (mode !== 'standard' && extent && extent.xMin > 0) {
      const a = Math.log10(extent.xMin);
      const b = Math.log10(Math.max(extent.xMax, extent.xMin * 1.01));
      const pad = Math.max(0.04 * (b - a), 0.02);
      lo = Math.pow(10, a - pad);
      hi = Math.pow(10, b + pad);
    }
    return [Math.log10(lo), Math.log10(hi)];
  }
  if (mode !== 'standard' && extent) return [extent.xMin, Math.max(extent.xMax, extent.xMin + 1)];
  return [STANDARD_GRAY[0], STANDARD_GRAY[1]];
}

/** y (SVM) domain: 0–6 unless the axes are free (data extent, padded by 10 %, not below 0). */
export function yDomain(mode: AxisMode, extent: Extent | null): [number, number] {
  let y0 = STANDARD_SVM[0];
  let y1 = STANDARD_SVM[1];
  if (mode === 'free' && extent) {
    const span = Math.max(extent.yMax - extent.yMin, 0.1);
    y0 = extent.yMin - span * 0.1;
    y1 = extent.yMax + span * 0.1;
    if (extent.yMin >= 0) y0 = Math.max(0, y0);
  }
  return [y0, y1];
}

const GRAY_STANDARD_TICKS = [0, 32, 64, 96, 128, 160, 192, 224, 255];
const SVM_TICKS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Axes for a slice mode + axis mode. `extent` is the data extent (x in data units: nits or
 * gray) used by adaptive / free modes: a static slice's, or the (smoothed) range of the sweep /
 * glide frame (axisTrack.ts). With `motion` (a sweep or glide frame) the adaptive / free axes are
 * built as moving axes: their ticks carry opacities that change continuously with the domain
 * (motionTicks); standard axes and adaptive's SVM axis never move.
 */
export function buildAxes(slice: SliceMode, mode: AxisMode, extent: Extent | null, motion?: AxisMotion): Axes {
  const moving = !!motion && mode !== 'standard' && !!extent;
  const settle = moving ? Math.min(1, Math.max(0, motion!.settle)) : 1;
  const from = moving && settle > 0 ? (motion!.from ?? extent) : extent;

  // ----- x
  const [xu0, xu1] = xDomain(slice, mode, extent);
  let x: Axis;
  if (moving) {
    const [s0, s1] = xDomain(slice, mode, from);
    const m = { settle, s0, s1 };
    const ticks =
      slice === 'gray'
        ? logMotionTicks(xu0, xu1, m)
        : linearMotionTicks(xu0, xu1, 8, m, (v) => String(Math.round(v)), (v) => String(Math.round(v)));
    x = { log: slice === 'gray', u0: xu0, u1: xu1, ticks, motion: m };
  } else if (slice === 'gray') {
    x = { log: true, u0: xu0, u1: xu1, ticks: logAxisTicks(Math.pow(10, xu0), Math.pow(10, xu1), mode === 'standard') };
  } else {
    const ticks =
      mode === 'standard'
        ? GRAY_STANDARD_TICKS.map((v) => ({ u: v, label: String(v), major: true }))
        : linearTicks(xu0, xu1, 8).map((t) => ({ ...t, label: t.label === null ? null : String(Math.round(t.u)) }));
    x = { log: false, u0: xu0, u1: xu1, ticks };
  }

  // ----- y
  const [y0, y1] = yDomain(mode, extent);
  let y: Axis;
  if (moving && mode === 'free') {
    const [s0, s1] = yDomain(mode, from);
    const m = { settle, s0, s1 };
    y = { log: false, u0: y0, u1: y1, ticks: linearMotionTicks(y0, y1, 6, m, (v, step) => fmtLinear(v, step), fmtShort), motion: m };
  } else {
    y = { log: false, u0: y0, u1: y1, ticks: mode === 'free' ? linearTicks(y0, y1, 6) : SVM_TICKS.map((v) => ({ u: v, label: String(v), major: true })) };
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// Moving axes (docs/adr/0006, fix round 3).
//
// A tick's opacity on a moving axis is a continuous function of the domain, so nothing pops while
// the domain follows the data: ticks fade near the domain's edges (gridlines just inside,
// labels just outside, where they slide off), and a denser tick level (the 2 / 5 labels of a log
// axis, the next 1-2-5 step of a linear axis) cross-fades in as the span shrinks instead of
// switching at a threshold. Labels are formatted per value (a value's label never changes format).
//
// A static frame keeps the exact static ticks (buildAxes without motion). A glide from / to a
// static slice starts / ends on them: every opacity is its "soft" moving value plus
// settle × (static value − soft value), both taken at the glide's static-end domain, so at the
// static end it equals the static tick set exactly and it becomes the moving value as settle → 0.

/** Gridlines fade out within this share of the span inside the domain's edges. */
const GRID_EDGE = 0.02;
/** Labels fade out within this share of the span outside the domain's edges. */
const LABEL_EDGE = 0.03;

const smooth01 = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Still-axis visibility: inside the domain (strict: not on its edges). */
const hardIn = (u: number, a: number, b: number, strict = false) => (strict ? u > a && u < b : u >= a - 1e-9 && u <= b + 1e-9) ? 1 : 0;
/** Moving gridline visibility: fades out just inside the edges. */
const softLine = (u: number, a: number, b: number) => {
  const f = GRID_EDGE * (b - a) || 1e-9;
  return smooth01((u - a) / f) * smooth01((b - u) / f);
};
/** Moving label visibility: fades out just outside the edges. */
const softLabel = (u: number, a: number, b: number) => {
  const f = LABEL_EDGE * (b - a) || 1e-9;
  return smooth01((u - a) / f + 1) * smooth01((b - u) / f + 1);
};

/**
 * Opacity of an element at u on an axis: a gridline / reference line ('line', drawn inside the
 * domain) or its label ('label'). Still axis: 1 inside the domain (strict: not on the edge), else 0.
 * Moving axis: the continuous edge fade, pinned to the still rule at a glide's static end.
 */
export function edgeAlpha(axis: Axis, u: number, kind: 'line' | 'label', strict = false): number {
  const m = axis.motion;
  if (!m) return hardIn(u, axis.u0, axis.u1, strict);
  const soft = kind === 'line' ? softLine : softLabel;
  return clamp01(soft(u, axis.u0, axis.u1) + m.settle * (hardIn(u, m.s0, m.s1, strict) - soft(u, m.s0, m.s1)));
}

/** Combine a tick's moving density with its edge fade, pinned to the static rule (see above). */
function tickAlphas(u: number, a: number, b: number, dR: number, m: AxisMotionState, dS: number, hS: number) {
  const g = m.settle > 0 ? m.settle * (hS * hardIn(u, m.s0, m.s1) - dS * softLine(u, m.s0, m.s1)) : 0;
  const l = m.settle > 0 ? m.settle * (hS * hardIn(u, m.s0, m.s1) - dS * softLabel(u, m.s0, m.s1)) : 0;
  return { alpha: clamp01(dR * softLine(u, a, b) + g), labelAlpha: clamp01(dR * softLabel(u, a, b) + l) };
}

/** Log axis: the 2 / 5 labels show below ~4.2 decades, every mantissa below ~0.9 (as logAxisTicks). */
const w25 = (dec: number) => 1 - smooth01((dec - 3.9) / 0.6);
const wAll = (dec: number) => 1 - smooth01((dec - 0.8) / 0.2);

/** Log-axis ticks of a moving (non-standard) axis over the domain [u0, u1] (log10 nits). */
function logMotionTicks(u0: number, u1: number, m: AxisMotionState): Tick[] {
  const dec = u1 - u0;
  const decS = m.s1 - m.s0;
  const lo = Math.min(u0, m.s0);
  const hi = Math.max(u1, m.s1);
  const out: Tick[] = [];
  for (let e = Math.floor(lo) - 1; e <= Math.ceil(hi) + 1; e++) {
    for (let k = 1; k <= 9; k++) {
      const v = Number((k * Math.pow(10, e)).toPrecision(6));
      const u = Math.log10(v);
      if (u < lo - LABEL_EDGE * (hi - lo) - 1e-9 || u > hi + LABEL_EDGE * (hi - lo) + 1e-9) continue;
      const cls = k === 1 ? 0 : k === 2 || k === 5 ? 1 : 2;
      // moving densities (major = labelled gridline, minor = faint gridline) and the static rule
      const majR = cls === 0 ? 1 : cls === 1 ? w25(dec) : wAll(dec);
      const majS = cls === 0 ? 1 : cls === 1 ? w25(decS) : wAll(decS);
      const majH = cls === 0 ? 1 : cls === 1 ? (decS > 4.2 ? 0 : 1) : decS > 0.9 ? 0 : 1;
      const minR = cls === 0 ? 0 : cls === 1 ? 1 : w25(dec);
      const minS = cls === 0 ? 0 : cls === 1 ? 1 : w25(decS);
      const minH = cls === 0 ? 0 : cls === 1 ? (decS > 4.2 ? 1 : 0) : decS > 0.9 && decS <= 4.2 ? 1 : 0;
      if (cls !== 0) {
        const mi = tickAlphas(u, u0, u1, minR, m, minS, minH);
        if (mi.alpha > 0.004) out.push({ u, label: null, major: false, alpha: mi.alpha, labelAlpha: 0 });
      }
      const ma = tickAlphas(u, u0, u1, majR, m, majS, majH);
      if (ma.alpha > 0.004 || ma.labelAlpha > 0.004) out.push({ u, label: fmtTickNits(v), major: true, alpha: ma.alpha, labelAlpha: ma.labelAlpha });
    }
  }
  return out;
}

/**
 * 1-2-5 step levels of a linear axis: level j = step [1, 2, 5][j mod 3] × 10^⌊j / 3⌋. niceStep
 * picks level j when L = log10(span / count) lies in [lo(j), hi(j)); a moving axis cross-fades
 * two neighbouring levels over ±STEP_FADE around each boundary instead.
 */
const LOG15 = Math.log10(1.5);
const LOG3 = Math.log10(3);
const LOG7 = Math.log10(7);
const STEP_FADE = 0.06;
const levelStep = (j: number) => {
  const e = Math.floor(j / 3);
  return Number(([1, 2, 5][j - 3 * e] * Math.pow(10, e)).toPrecision(12));
};
const levelBounds = (j: number): [number, number] => {
  const e = Math.floor(j / 3);
  const k = j - 3 * e;
  return k === 0 ? [e - 1 + LOG7, e + LOG15] : k === 1 ? [e + LOG15, e + LOG3] : [e + LOG3, e + LOG7];
};
const levelOf = (L: number) => {
  const e = Math.floor(L);
  const f = L - e;
  return f < LOG15 ? 3 * e : f < LOG3 ? 3 * e + 1 : f < LOG7 ? 3 * e + 2 : 3 * e + 3;
};
const ramp = (x: number) => smooth01((x + STEP_FADE) / (2 * STEP_FADE));
/** Weight of level j at L (neighbouring levels' weights sum to 1). */
const levelWeight = (j: number, L: number) => {
  const [a, b] = levelBounds(j);
  return ramp(L - a) * (1 - ramp(L - b));
};
const isMultiple = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

/** Short per-value label of a linear SVM tick (0, 0.5, 1, 1.5): never changes with the step. */
export function fmtShort(v: number): string {
  return Math.abs(v) < 1e-9 ? '0' : String(Number(v.toFixed(4)));
}

/**
 * Linear-axis ticks of a moving axis over [u0, u1] (about `count` intervals). `fmtStatic(v,
 * step)` = the still axis's label (linearTicks), `fmtMoving(v)` = the per-value label; where they
 * differ, a glide cross-fades the two texts with settle.
 */
function linearMotionTicks(u0: number, u1: number, count: number, m: AxisMotionState, fmtStatic: (v: number, step: number) => string, fmtMoving: (v: number) => string): Tick[] {
  const L = Math.log10(Math.max(1e-9, u1 - u0) / count);
  const LS = Math.log10(Math.max(1e-9, m.s1 - m.s0) / count);
  const stepS = niceStep(m.s1 - m.s0, count);
  const levels = new Set<number>();
  for (const j0 of [levelOf(L), levelOf(LS)]) for (const j of [j0 - 1, j0, j0 + 1]) if (levelWeight(j, L) > 0 || levelWeight(j, LS) > 0) levels.add(j);
  const lo = Math.min(u0, m.s0);
  const hi = Math.max(u1, m.s1);
  const margin = LABEL_EDGE * (hi - lo);
  const values = new Map<string, number>();
  const steps = [...levels].map(levelStep);
  if (m.settle > 0) steps.push(stepS);
  for (const step of steps) {
    for (let k = Math.ceil((lo - margin) / step - 1e-9); k * step <= hi + margin + step * 1e-9; k++) {
      const v = Number((k * step).toPrecision(12));
      values.set(String(v), Math.abs(v) < step * 1e-9 ? 0 : v);
    }
  }
  const density = (v: number, at: number) => {
    let d = 0;
    for (const j of levels) if (isMultiple(v, levelStep(j))) d = Math.max(d, levelWeight(j, at));
    return d;
  };
  const out: Tick[] = [];
  for (const v of [...values.values()].sort((a, b) => a - b)) {
    const hS = m.settle > 0 && isMultiple(v, stepS) ? 1 : 0;
    const { alpha, labelAlpha } = tickAlphas(v, u0, u1, density(v, L), m, density(v, LS), hS);
    if (!(alpha > 0.004 || labelAlpha > 0.004)) continue;
    const moving = fmtMoving(v);
    const still = hS ? fmtStatic(v, stepS) : moving;
    if (m.settle > 0 && still !== moving) {
      // glide between the still labels (e.g. "2.0") and the per-value ones ("2"): cross-fade
      out.push({ u: v, label: moving, major: true, alpha, labelAlpha: labelAlpha * (1 - m.settle) });
      out.push({ u: v, label: still, major: true, alpha: 0, labelAlpha: labelAlpha * m.settle });
    } else out.push({ u: v, label: moving, major: true, alpha, labelAlpha });
  }
  return out;
}
