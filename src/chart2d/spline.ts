/**
 * Monotone cubic (Fritsch–Carlson) interpolation.
 *
 * Used twice in the 2D chart:
 * - to draw each curve through its slice points (in axis space: log10 nits or gray), and
 * - to interpolate the measurement grid ALONG the sweep parameter (gray rows / level columns),
 *   so that the curves move with C1-continuous velocity during a sweep instead of the
 *   piecewise-linear "kinks" of bilinear interpolation (which read as visual stutter).
 *
 * Fritsch–Carlson is affine-invariant in each axis (its limiter works on ratios m/Δ), so a
 * spline built in axis space maps exactly onto screen space by transforming the Bézier
 * control points, and evaluating it for the hover read-out matches the drawn line.
 */

/**
 * Tangents for points (xs, ys), xs strictly ascending. NaN in ys splits the data into
 * independent runs (a missing sample is never bridged); NaN entries get NaN slopes.
 */
export function monotoneSlopes(xs: ArrayLike<number>, ys: ArrayLike<number>): Float64Array {
  const n = xs.length;
  const m = new Float64Array(n).fill(NaN);
  let i = 0;
  while (i < n) {
    if (!Number.isFinite(ys[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && Number.isFinite(ys[j + 1])) j++;
    runSlopes(xs, ys, i, j, m);
    i = j + 1;
  }
  return m;
}

function runSlopes(xs: ArrayLike<number>, ys: ArrayLike<number>, a: number, b: number, m: Float64Array) {
  const len = b - a + 1;
  if (len === 1) {
    m[a] = 0;
    return;
  }
  const d = new Float64Array(len - 1);
  for (let k = 0; k < len - 1; k++) {
    const h = xs[a + k + 1] - xs[a + k];
    d[k] = h > 0 ? (ys[a + k + 1] - ys[a + k]) / h : 0;
  }
  m[a] = d[0];
  m[b] = d[len - 2];
  for (let k = 1; k < len - 1; k++) {
    const d0 = d[k - 1];
    const d1 = d[k];
    m[a + k] = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
  }
  // Fritsch–Carlson limiter: keep every segment monotone (no overshoot).
  for (let k = 0; k < len - 1; k++) {
    const dk = d[k];
    if (dk === 0) {
      m[a + k] = 0;
      m[a + k + 1] = 0;
      continue;
    }
    const al = m[a + k] / dk;
    const be = m[a + k + 1] / dk;
    const s = al * al + be * be;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[a + k] = tau * al * dk;
      m[a + k + 1] = tau * be * dk;
    }
  }
}

/** Cubic Hermite value on [x0, x1] with values y0, y1 and slopes m0, m1. */
export function hermite(x0: number, x1: number, y0: number, y1: number, m0: number, m1: number, x: number): number {
  const h = x1 - x0;
  if (!(h > 0)) return y0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}

export interface Spline {
  xs: Float64Array;
  ys: Float64Array;
  ms: Float64Array;
}

/**
 * Build a monotone spline through points sorted by x (ascending). Points closer than
 * `mergeEps` in x are merged (averaged), so xs is strictly increasing. Non-finite points are
 * dropped. Returns null for an empty input.
 */
export function buildSpline(pts: { x: number; y: number }[], mergeEps = 1e-9): Spline | null {
  const xs: number[] = [];
  const ys: number[] = [];
  let cnt = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = xs.length - 1;
    if (last >= 0 && p.x - xs[last] <= mergeEps) {
      // running average of the merged cluster
      cnt++;
      xs[last] += (p.x - xs[last]) / cnt;
      ys[last] += (p.y - ys[last]) / cnt;
      continue;
    }
    xs.push(p.x);
    ys.push(p.y);
    cnt = 1;
  }
  if (xs.length === 0) return null;
  const X = Float64Array.from(xs);
  const Y = Float64Array.from(ys);
  return { xs: X, ys: Y, ms: monotoneSlopes(X, Y) };
}

/** Spline value at x, or null outside [xs[0], xs[n-1]]. */
export function evalSpline(s: Spline, x: number): number | null {
  const n = s.xs.length;
  if (n === 0 || x < s.xs[0] || x > s.xs[n - 1]) return null;
  if (n === 1) return s.ys[0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return hermite(s.xs[lo], s.xs[hi], s.ys[lo], s.ys[hi], s.ms[lo], s.ms[hi], x);
}

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
}

/**
 * Trace the spline as cubic Béziers after an affine map (px = ax*x + bx, py = ay*y + by).
 * A single point is traced as a zero-length segment (round caps render it as a dot).
 */
export function traceSpline(s: Spline, sink: PathSink, ax: number, bx: number, ay: number, by: number) {
  const n = s.xs.length;
  if (n === 0) return;
  sink.moveTo(ax * s.xs[0] + bx, ay * s.ys[0] + by);
  if (n === 1) {
    sink.lineTo(ax * s.xs[0] + bx + 0.01, ay * s.ys[0] + by);
    return;
  }
  for (let i = 0; i < n - 1; i++) {
    const x0 = s.xs[i];
    const x1 = s.xs[i + 1];
    const h = (x1 - x0) / 3;
    const c1x = x0 + h;
    const c1y = s.ys[i] + s.ms[i] * h;
    const c2x = x1 - h;
    const c2y = s.ys[i + 1] - s.ms[i + 1] * h;
    sink.bezierCurveTo(ax * c1x + bx, ay * c1y + by, ax * c2x + bx, ay * c2y + by, ax * x1 + bx, ay * s.ys[i + 1] + by);
  }
}
