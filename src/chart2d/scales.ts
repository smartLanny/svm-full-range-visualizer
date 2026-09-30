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
  /** Speed of the lower / upper edge (share of the span per second): widens the edge fades. */
  v0: number;
  v1: number;
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
  /** Speed of each axis's lower / upper edge (share of the span per second); default 0. */
  speed?: { x: [number, number]; y: [number, number] };
  /**
   * Tick density of each axis as a continuous level (see tickLevel; between two integers = a
   * cross-fade of both tick sets). The sweep's levels come from its range track, quantised with
   * hysteresis and smoothed over time (scene.ts), so a steady span never shows a mixed tick set.
   * Default: the level of the current domain.
   */
  level?: { x: number; y: number };
}

/** x range in data units (nits or gray) for a slice + axis mode; `extent` in data units. */
function xRange(slice: SliceMode, mode: AxisMode, extent: Extent | null): [number, number] {
  if (slice === 'gray') {
    let lo = STANDARD_NITS[0];
    let hi = STANDARD_NITS[1];
    if (mode !== 'standard' && extent && extent.xMin > 0) {
      const a = Math.log10(extent.xMin);
      const b = Math.log10(Math.max(extent.xMax, extent.xMin * 1.01));
      const pad = Math.max(0.04 * (b - a), 0.02);
      lo = Math.pow(10, a - pad);
      hi = Math.pow(10, b + pad);
      // Under the level cap (500 nits by default) the pad never pushes the axis past the cap: the
      // points are capped too, so the axis still contains them.
      if (extent.xCap !== undefined) hi = Math.min(hi, Math.max(extent.xCap, extent.xMax));
    }
    return [lo, hi];
  }
  if (mode !== 'standard' && extent) return [extent.xMin, Math.max(extent.xMax, extent.xMin + 1)];
  return [STANDARD_GRAY[0], STANDARD_GRAY[1]];
}

/** x domain (axis units: log10 nits or gray) for a slice + axis mode; `extent` in data units. */
export function xDomain(slice: SliceMode, mode: AxisMode, extent: Extent | null): [number, number] {
  const [lo, hi] = xRange(slice, mode, extent);
  return slice === 'gray' ? [Math.log10(lo), Math.log10(hi)] : [lo, hi];
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
 * Tick density level of a domain of `span` axis units, as the still axes pick it: a linear axis
 * with about `count` intervals → the index j of its 1-2-5 step (niceStep = levelStep(j)); the
 * log axis of the adaptive / free modes → 0 (decades only, > 4.2 decades), 1 (1, 2, 5; > 0.9),
 * 2 (every mantissa). `bias` (±1) nudges the span by the hysteresis margin (a sweep switches
 * level only where both nudged spans agree on the new one).
 */
export function tickLevel(log: boolean, span: number, count: number, bias = 0): number {
  if (log) {
    const dec = span + 0.15 * bias;
    return dec > 4.2 ? 0 : dec > 0.9 ? 1 : 2;
  }
  const raw = (Math.max(1e-12, span) * Math.pow(10, 0.04 * bias)) / Math.max(1, count);
  const e = Math.floor(Math.log10(raw));
  const f = raw / Math.pow(10, e);
  return f < 1.5 ? 3 * e : f < 3 ? 3 * e + 1 : f < 7 ? 3 * e + 2 : 3 * e + 3;
}

/** Tick intervals of the linear axes (x = gray, y = SVM). */
export const X_COUNT = 8;
export const Y_COUNT = 6;

/**
 * Axes for a slice mode + axis mode. `extent` is the data extent (x in data units: nits or
 * gray) used by adaptive / free modes: a static slice's, or the (smoothed) range of the sweep /
 * glide frame (axisTrack.ts). With `motion` (a sweep or glide frame) the adaptive / free axes are
 * built as moving axes: their ticks carry opacities that change continuously (see below);
 * standard axes and adaptive's SVM axis never move.
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
    const [v0, v1] = motion!.speed?.x ?? [0, 0];
    const m = { settle, s0, s1, v0, v1 };
    const lam = motion!.level?.x ?? tickLevel(slice === 'gray', xu1 - xu0, X_COUNT);
    const ticks =
      slice === 'gray'
        ? logMotionTicks(xu0, xu1, m, lam)
        : linearMotionTicks(xu0, xu1, X_COUNT, m, lam, (v) => String(Math.round(v)), (v) => String(Math.round(v)));
    x = { log: slice === 'gray', u0: xu0, u1: xu1, ticks, motion: m };
  } else if (slice === 'gray') {
    const [lo, hi] = xRange(slice, mode, extent);
    x = { log: true, u0: xu0, u1: xu1, ticks: logAxisTicks(lo, hi, mode === 'standard') };
  } else {
    const ticks =
      mode === 'standard'
        ? GRAY_STANDARD_TICKS.map((v) => ({ u: v, label: String(v), major: true }))
        : linearTicks(xu0, xu1, X_COUNT).map((t) => ({ ...t, label: t.label === null ? null : String(Math.round(t.u)) }));
    x = { log: false, u0: xu0, u1: xu1, ticks };
  }

  // ----- y
  const [y0, y1] = yDomain(mode, extent);
  let y: Axis;
  if (moving && mode === 'free') {
    const [s0, s1] = yDomain(mode, from);
    const [v0, v1] = motion!.speed?.y ?? [0, 0];
    const m = { settle, s0, s1, v0, v1 };
    const lam = motion!.level?.y ?? tickLevel(false, y1 - y0, Y_COUNT);
    y = { log: false, u0: y0, u1: y1, ticks: linearMotionTicks(y0, y1, Y_COUNT, m, lam, (v, step) => fmtLinear(v, step), fmtShort), motion: m };
  } else {
    y = { log: false, u0: y0, u1: y1, ticks: mode === 'free' ? linearTicks(y0, y1, Y_COUNT) : SVM_TICKS.map((v) => ({ u: v, label: String(v), major: true })) };
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// Moving axes (docs/adr/0006, fix round 3).
//
// Nothing on a moving axis pops. Ticks fade near the domain's edges, continuously in the domain:
// a gridline fades out just inside an edge, a label fades out just beyond it (where it slides off;
// a label on an edge that does not move, like SVM 0, stays fully visible, and no label shows
// beyond such an edge). The faster an edge moves, the wider its fade reaches inside, so every fade lasts
// at least FADE_TIME whatever the zoom speed. The tick density is a continuous level λ (tickLevel): between two integer levels
// both tick sets cross-fade (a log axis's 2 / 5 labels and minor gridlines, a linear axis's next
// 1-2-5 step); λ changes over a few hundred ms around a level switch and is an integer otherwise.
// Labels are formatted per value (a value's label never changes format while the axis moves).
//
// A static frame keeps the exact static ticks (buildAxes without motion). A glide from / to a
// static slice starts / ends on them: an opacity is its moving value plus settle × (static edge
// rule − moving edge fade) at the glide's static-end domain, and λ there is the static level, so
// at the static end it equals the static tick set exactly and it becomes the moving value as
// settle → 0.

/** Gridlines of a moving edge fade out within this share of the span inside it (at least). */
const GRID_EDGE = 0.02;
/** Labels beyond a moving edge fade out within this share of the span. */
const LABEL_EDGE = 0.03;
/** A moving edge's fades reach speed × FADE_TIME inside (s): no fade is shorter than this. */
const FADE_TIME = 0.15;
/**
 * Edge speed (share of the span per second) from which labels fade over the full LABEL_EDGE
 * beyond it; slower edges over proportionally less, and beyond an edge that does not move at all
 * no label shows (like a still axis). A label on such an edge stays fully visible.
 */
const EDGE_SPEED_FULL = 0.02;

const smooth01 = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Still-axis visibility: inside the domain (strict: not on its edges). */
const hardIn = (u: number, a: number, b: number, strict = false) => (strict ? u > a && u < b : u >= a - 1e-9 && u <= b + 1e-9) ? 1 : 0;
/** Fade of one edge: distance d inside it (< 0 beyond), fading from -out to +inside; a zero-width fade is a cut. */
const edgeFade = (d: number, out: number, inside: number) => (out + inside > 1e-12 ? smooth01((d + out) / (out + inside)) : d >= -1e-9 ? 1 : 0);
const reach = (v: number) => Math.min(1, v / EDGE_SPEED_FULL);
/** Moving gridline visibility: fades out inside the edges (wider at a fast edge). */
const softLine = (u: number, a: number, b: number, m: AxisMotionState) => {
  const span = b - a || 1e-9;
  const w0 = Math.max(GRID_EDGE, m.v0 * FADE_TIME) * span;
  const w1 = Math.max(GRID_EDGE, m.v1 * FADE_TIME) * span;
  return edgeFade(u - a, 0, w0) * edgeFade(b - u, 0, w1);
};
/** Moving label visibility: fades out from speed × FADE_TIME inside to LABEL_EDGE beyond the edges. */
const softLabel = (u: number, a: number, b: number, m: AxisMotionState) => {
  const span = b - a || 1e-9;
  return edgeFade(u - a, LABEL_EDGE * reach(m.v0) * span, m.v0 * FADE_TIME * span) * edgeFade(b - u, LABEL_EDGE * reach(m.v1) * span, m.v1 * FADE_TIME * span);
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
  return clamp01(soft(u, axis.u0, axis.u1, m) + m.settle * (hardIn(u, m.s0, m.s1, strict) - soft(u, m.s0, m.s1, m)));
}

/**
 * A tick's gridline / label opacity: density d (at λ) × edge fade, plus the pin to the static rule
 * (hS = the tick is in the static end's tick set, where its density is exactly hS).
 */
function tickAlphas(u: number, a: number, b: number, d: number, m: AxisMotionState, hS: number) {
  const pin = m.settle * hS;
  const g = pin > 0 ? pin * (hardIn(u, m.s0, m.s1) - softLine(u, m.s0, m.s1, m)) : 0;
  const l = pin > 0 ? pin * (hardIn(u, m.s0, m.s1) - softLabel(u, m.s0, m.s1, m)) : 0;
  return { alpha: clamp01(d * softLine(u, a, b, m) + g), labelAlpha: clamp01(d * softLabel(u, a, b, m) + l) };
}

/** Log-axis ticks of a moving (non-standard) axis over the domain [u0, u1] (log10 nits), density λ ∈ [0, 2]. */
function logMotionTicks(u0: number, u1: number, m: AxisMotionState, lam: number): Tick[] {
  const w25 = clamp01(lam); // 2 / 5 labelled
  const wAll = clamp01(lam - 1); // every mantissa labelled
  const levelS = m.settle > 0 ? tickLevel(true, m.s1 - m.s0, 0) : -1;
  const lo = Math.min(u0, m.s0);
  const hi = Math.max(u1, m.s1);
  const out: Tick[] = [];
  for (let e = Math.floor(lo) - 1; e <= Math.ceil(hi) + 1; e++) {
    for (let k = 1; k <= 9; k++) {
      const v = Number((k * Math.pow(10, e)).toPrecision(6));
      const u = Math.log10(v);
      if (u < lo - LABEL_EDGE * (hi - lo) - 1e-9 || u > hi + LABEL_EDGE * (hi - lo) + 1e-9) continue;
      const cls = k === 1 ? 0 : k === 2 || k === 5 ? 1 : 2;
      // major = labelled gridline, minor = faint gridline; densities at λ and the static set (logAxisTicks)
      const majD = cls === 0 ? 1 : cls === 1 ? w25 : wAll;
      const minD = cls === 0 ? 0 : cls === 1 ? 1 - w25 : w25 - wAll;
      const majH = levelS < 0 ? 0 : cls === 0 ? 1 : cls === 1 ? (levelS >= 1 ? 1 : 0) : levelS >= 2 ? 1 : 0;
      const minH = levelS < 0 ? 0 : cls === 1 ? (levelS === 0 ? 1 : 0) : cls === 2 && levelS === 1 ? 1 : 0;
      if (cls !== 0) {
        const mi = tickAlphas(u, u0, u1, minD, m, minH);
        if (mi.alpha > 0.004) out.push({ u, label: null, major: false, alpha: mi.alpha, labelAlpha: 0 });
      }
      const ma = tickAlphas(u, u0, u1, majD, m, majH);
      if (ma.alpha > 0.004 || ma.labelAlpha > 0.004) out.push({ u, label: fmtTickNits(v), major: true, alpha: ma.alpha, labelAlpha: ma.labelAlpha });
    }
  }
  return out;
}

/** 1-2-5 step of level j (tickLevel): [1, 2, 5][j mod 3] × 10^⌊j / 3⌋. */
export const levelStep = (j: number) => {
  const e = Math.floor(j / 3);
  return Number(([1, 2, 5][j - 3 * e] * Math.pow(10, e)).toPrecision(12));
};
const isMultiple = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

/** Short per-value label of a linear SVM tick (0, 0.5, 1, 1.5): never changes with the step. */
export function fmtShort(v: number): string {
  return Math.abs(v) < 1e-9 ? '0' : String(Number(v.toFixed(4)));
}

/**
 * Linear-axis ticks of a moving axis over [u0, u1] at density level λ (tickLevel with `count`).
 * `fmtStatic(v, step)` = the still axis's label (linearTicks), `fmtMoving(v)` = the per-value
 * label; where they differ, a glide cross-fades the two texts with settle.
 */
function linearMotionTicks(u0: number, u1: number, count: number, m: AxisMotionState, lam: number, fmtStatic: (v: number, step: number) => string, fmtMoving: (v: number) => string): Tick[] {
  const levels = [Math.floor(lam), Math.ceil(lam)].filter((j, i, a) => a.indexOf(j) === i).map((j) => ({ j, w: Math.max(0, 1 - Math.abs(lam - j)), step: levelStep(j) }));
  const stepS = m.settle > 0 ? levelStep(tickLevel(false, m.s1 - m.s0, count)) : 0;
  const lo = Math.min(u0, m.s0);
  const hi = Math.max(u1, m.s1);
  const margin = LABEL_EDGE * (hi - lo);
  const values = new Map<string, number>();
  const steps = levels.filter((l) => l.w > 0).map((l) => l.step);
  if (stepS) steps.push(stepS);
  for (const step of steps) {
    for (let k = Math.ceil((lo - margin) / step - 1e-9); k * step <= hi + margin + step * 1e-9; k++) {
      const v = Number((k * step).toPrecision(12));
      values.set(String(v), Math.abs(v) < step * 1e-9 ? 0 : v);
    }
  }
  const out: Tick[] = [];
  for (const v of [...values.values()].sort((a, b) => a - b)) {
    let d = 0;
    for (const l of levels) if (isMultiple(v, l.step)) d = Math.max(d, l.w);
    const hS = stepS && isMultiple(v, stepS) ? 1 : 0;
    const { alpha, labelAlpha } = tickAlphas(v, u0, u1, d, m, hS);
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
