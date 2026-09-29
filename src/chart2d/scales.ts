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
}

export interface Axis {
  log: boolean;
  /** Domain in axis units. */
  u0: number;
  u1: number;
  ticks: Tick[];
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

/**
 * Axes for a slice mode + axis mode. `extent` is the data extent (x in data units: nits or
 * gray) used by adaptive / free modes; for a sweep it is the extent over the whole sweep.
 */
export function buildAxes(slice: SliceMode, mode: AxisMode, extent: Extent | null): Axes {
  // ----- x
  let x: Axis;
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
    x = { log: true, u0: Math.log10(lo), u1: Math.log10(hi), ticks: logAxisTicks(lo, hi, mode === 'standard') };
  } else {
    let lo = STANDARD_GRAY[0];
    let hi = STANDARD_GRAY[1];
    if (mode !== 'standard' && extent) {
      lo = extent.xMin;
      hi = Math.max(extent.xMax, extent.xMin + 1);
    }
    const ticks =
      mode === 'standard'
        ? [0, 32, 64, 96, 128, 160, 192, 224, 255].map((v) => ({ u: v, label: String(v), major: true }))
        : linearTicks(lo, hi, 8).map((t) => ({ ...t, label: t.label === null ? null : String(Math.round(t.u)) }));
    x = { log: false, u0: lo, u1: hi, ticks };
  }

  // ----- y
  let y0 = STANDARD_SVM[0];
  let y1 = STANDARD_SVM[1];
  if (mode === 'free' && extent) {
    const span = Math.max(extent.yMax - extent.yMin, 0.1);
    y0 = extent.yMin - span * 0.1;
    y1 = extent.yMax + span * 0.1;
    if (extent.yMin >= 0) y0 = Math.max(0, y0);
  }
  const y: Axis = { log: false, u0: y0, u1: y1, ticks: mode === 'free' ? linearTicks(y0, y1, 6) : [0, 1, 2, 3, 4, 5, 6].map((v) => ({ u: v, label: String(v), major: true })) };
  return { x, y };
}
