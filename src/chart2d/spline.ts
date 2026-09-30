/**
 * Monotone cubic (Fritsch–Carlson) interpolation.
 *
 * Used twice in the 2D chart:
 * - to draw each curve through its slice points (in axis space: log10 nits or gray; see
 *   buildCurve: a parametric form with per-point opacity), and
 * - to interpolate the measurement grid ALONG the sweep parameter (gray rows / level columns),
 *   so that the curves move with C1-continuous velocity during a sweep instead of the
 *   piecewise-linear "kinks" of bilinear interpolation (which read as visual stutter).
 *
 * Fritsch–Carlson is affine-invariant in each axis (its limiter works on ratios m/Δ), so a
 * curve built in axis space maps exactly onto screen space by transforming the Bézier
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

// ---------------------------------------------------------------------------------------------
// Curves with per-point opacity (sweeps over records with missing cells, docs/adr/0003).

export interface CurveNode {
  x: number;
  y: number;
  /** Opacity 0..1 (points entering / leaving the slice fade). */
  a: number;
  /**
   * Measured column / row of the point. The curve runs through the nodes in key order (the
   * order of the measurement sequence), and a key missing between two nodes is a gap.
   */
  key: number;
}

/** Dotted connection across a gap (missing / excluded samples) between two opaque nodes. */
export interface Bridge {
  i0: number;
  i1: number;
  /** Tangents (d/ds) at both ends, already limited for this span. */
  mx0: number;
  my0: number;
  mx1: number;
  my1: number;
  alpha: number;
}

/**
 * Parametric monotone curve: x(s) and y(s) are each Fritsch–Carlson cubics over a chord-length
 * parameter s. When x increases along the nodes (the normal case) this is, up to a tiny
 * second-order term, the monotone spline y(x) of buildSpline; when two readings share an x
 * (quantised nits) or swap order (a stale reading), the curve stays continuous instead of
 * reordering its nodes, so a sweep never flips the curve between two shapes.
 */
export interface Curve {
  xs: Float64Array;
  ys: Float64Array;
  /** Chord-length parameter per node (strictly increasing). */
  ss: Float64Array;
  /** Tangents dx/ds, dy/ds per node. */
  mx: Float64Array;
  my: Float64Array;
  /** Node opacity. */
  a: Float64Array;
  /** Opacity of the solid segment i → i+1 (0 = not drawn: a gap). Length n-1. */
  seg: Float64Array;
  /** Opacity of the dot drawn for a node without any drawn segment. */
  dot: Float64Array;
  bridges: Bridge[];
  /** Key (measured column / row) of each node. */
  keys: Int32Array;
}

/** Weight of |Δy| in the chord parameter: s ≈ x for ordinary curves, > 0 for equal x. */
const CHORD_Y = 0.05;

/** Fritsch–Carlson limiter for one segment, blended in with weight w (keeps continuity). */
function limitSegment(m0: number, m1: number, d: number, w: number): [number, number] {
  if (w <= 0) return [m0, m1];
  let a0 = 0;
  let a1 = 0;
  if (d !== 0) {
    a0 = Math.max(0, m0 / d);
    a1 = Math.max(0, m1 / d);
    const s = a0 * a0 + a1 * a1;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      a0 *= tau;
      a1 *= tau;
    }
  }
  return [m0 + w * (a0 * d - m0), m1 + w * (a1 * d - m1)];
}

/**
 * One-coordinate tangents over s. Each node blends the two-sided Fritsch–Carlson slope with the
 * one-sided end slopes by the opacity of its two segments, so the shape changes continuously
 * while a neighbour fades out (and does not jump when it is finally gone).
 */
function blendedSlopes(ss: Float64Array, vs: Float64Array, seg: Float64Array): Float64Array {
  const n = vs.length;
  const d = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) d[i] = (vs[i + 1] - vs[i]) / (ss[i + 1] - ss[i]);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wl = i > 0 ? seg[i - 1] : 0;
    const wr = i < n - 1 ? seg[i] : 0;
    const dl = i > 0 ? d[i - 1] : 0;
    const dr = i < n - 1 ? d[i] : 0;
    const both = dl * dr <= 0 ? 0 : (dl + dr) / 2;
    m[i] = wl * wr * both + wl * (1 - wr) * dl + (1 - wl) * wr * dr;
  }
  for (let k = 0; k < n - 1; k++) [m[k], m[k + 1]] = limitSegment(m[k], m[k + 1], d[k], seg[k]);
  return m;
}

/**
 * Curve through nodes (any order; sorted by key here), each with an opacity. The drawing is a
 * CONTINUOUS function of the node positions and opacities, so a sweep never pops:
 * - segment opacity = min of its two nodes, or 0 across a gap (a key missing in between);
 * - tangents blend with the neighbouring segments' opacity (blendedSlopes);
 * - between two opaque nodes with a gap (or fading nodes) in between, a dotted bridge fades in
 *   as the nodes in between fade out. It is never solid: an excluded sample is not bridged
 *   silently.
 * With every node opaque and no gap this is the ordinary monotone spline.
 */
export function buildCurve(nodes: CurveNode[]): Curve | null {
  const pts = nodes.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.a > 0).sort((p, q) => p.key - q.key);
  const n = pts.length;
  if (n === 0) return null;
  const xs = Float64Array.from(pts, (p) => p.x);
  const ys = Float64Array.from(pts, (p) => p.y);
  const a = Float64Array.from(pts, (p) => Math.min(1, p.a));
  const ss = new Float64Array(n);
  for (let i = 1; i < n; i++) ss[i] = ss[i - 1] + Math.max(1e-9, Math.hypot(xs[i] - xs[i - 1], CHORD_Y * (ys[i] - ys[i - 1])));
  const seg = new Float64Array(Math.max(0, n - 1));
  const gap = new Uint8Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    gap[i] = pts[i + 1].key - pts[i].key > 1 ? 1 : 0;
    seg[i] = gap[i] ? 0 : Math.min(a[i], a[i + 1]);
  }
  const mx = blendedSlopes(ss, xs, seg);
  const my = blendedSlopes(ss, ys, seg);
  const dot = new Float64Array(n);
  for (let i = 0; i < n; i++) dot[i] = a[i] * (1 - Math.max(i > 0 ? seg[i - 1] : 0, i < n - 1 ? seg[i] : 0));

  // Bridges over gaps. Bridge i → j (i < j) spans the nodes strictly between them and any
  // missing keys; opacity = min(a_i, a_j) × (1 − max opacity of the nodes in between), so a
  // bridge grows exactly as the nodes it replaces fade out (and fades with its end points).
  const bridges: Bridge[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n && j <= i + 4; j++) {
      let maxA = 0;
      for (let k = i + 1; k < j; k++) maxA = Math.max(maxA, a[k]);
      if (j === i + 1 && !gap[i]) continue;
      const alpha = Math.min(a[i], a[j]) * (1 - maxA);
      if (alpha <= 1e-4) continue;
      const h = ss[j] - ss[i];
      const [mx0, mx1] = limitSegment(mx[i], mx[j], (xs[j] - xs[i]) / h, 1);
      const [my0, my1] = limitSegment(my[i], my[j], (ys[j] - ys[i]) / h, 1);
      bridges.push({ i0: i, i1: j, mx0, my0, mx1, my1, alpha });
    }
  }
  return { xs, ys, ss, mx, my, a, seg, dot, bridges, keys: Int32Array.from(pts, (p) => p.key) };
}

export type Bezier = [number, number, number, number, number, number, number, number];

/** Cubic Bézier (x0, y0, c1x, c1y, c2x, c2y, x1, y1) of segment i → i+1, in axis units. */
export function segmentBezier(c: Curve, i: number): Bezier {
  const h = (c.ss[i + 1] - c.ss[i]) / 3;
  return [c.xs[i], c.ys[i], c.xs[i] + c.mx[i] * h, c.ys[i] + c.my[i] * h, c.xs[i + 1] - c.mx[i + 1] * h, c.ys[i + 1] - c.my[i + 1] * h, c.xs[i + 1], c.ys[i + 1]];
}

/** Cubic Bézier of a bridge, in axis units. */
export function bridgeBezier(c: Curve, b: Bridge): Bezier {
  const h = (c.ss[b.i1] - c.ss[b.i0]) / 3;
  return [c.xs[b.i0], c.ys[b.i0], c.xs[b.i0] + b.mx0 * h, c.ys[b.i0] + b.my0 * h, c.xs[b.i1] - b.mx1 * h, c.ys[b.i1] - b.my1 * h, c.xs[b.i1], c.ys[b.i1]];
}

/** Point on a Bézier at parameter u ∈ [0, 1]. */
export function bezierAt(b: Bezier, u: number): [number, number] {
  const v = 1 - u;
  const k0 = v * v * v;
  const k1 = 3 * v * v * u;
  const k2 = 3 * v * u * u;
  const k3 = u * u * u;
  return [k0 * b[0] + k1 * b[2] + k2 * b[4] + k3 * b[6], k0 * b[1] + k1 * b[3] + k2 * b[5] + k3 * b[7]];
}

/**
 * Curve value at x, or null outside the curve, inside a gap, or where the curve is mostly
 * faded (< 50 % opacity: a point entering / leaving the slice is not a reading). Where the curve
 * passes x more than once (equal or swapped readings) the segment latest in the measurement
 * order (the brightest column) wins.
 */
export function evalCurve(c: Curve, x: number): number | null {
  const n = c.xs.length;
  if (n === 1) return c.a[0] >= 0.5 && Math.abs(x - c.xs[0]) < 1e-9 ? c.ys[0] : null;
  for (let i = n - 2; i >= 0; i--) {
    if (c.seg[i] < 0.5) continue;
    const x0 = c.xs[i];
    const x1 = c.xs[i + 1];
    if (x < Math.min(x0, x1) - 1e-12 || x > Math.max(x0, x1) + 1e-12) continue;
    const b = segmentBezier(c, i);
    if (x1 === x0) return Math.max(c.ys[i], c.ys[i + 1]);
    // x(u) is monotone on a segment (Fritsch–Carlson in x): bisection.
    const up = x1 > x0;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const xm = bezierAt(b, mid)[0];
      if (xm < x === up) lo = mid;
      else hi = mid;
    }
    return bezierAt(b, (lo + hi) / 2)[1];
  }
  return null;
}

/**
 * Where x falls on a curve: the drawn segment (nodes i, i + 1; the one evalCurve reads), the
 * single node of a one-point curve, or a gap between two drawn nodes (the keys missing there are
 * the samples without data); null outside the curve.
 */
export function curveSpanAt(c: Curve, x: number): { nodes: number[]; gap: boolean } | null {
  const n = c.xs.length;
  const inside = (i: number, j: number) => x >= Math.min(c.xs[i], c.xs[j]) - 1e-12 && x <= Math.max(c.xs[i], c.xs[j]) + 1e-12;
  if (n === 1) return c.a[0] >= 0.5 && Math.abs(x - c.xs[0]) < 1e-9 ? { nodes: [0], gap: false } : null;
  for (let i = n - 2; i >= 0; i--) if (c.seg[i] >= 0.5 && inside(i, i + 1)) return { nodes: [i, i + 1], gap: false };
  for (let i = 0; i < n - 1; i++) {
    if (c.a[i] < 0.5) continue;
    let j = i + 1;
    while (j < n && c.a[j] < 0.5) j++;
    if (j < n && c.keys[j] - c.keys[i] > 1 && inside(i, j)) return { nodes: [i, j], gap: true };
  }
  return null;
}

/** x range covered by drawn (≥ 50 % opaque) segments, or null. */
export function curveXRange(c: Curve): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = c.xs.length;
  if (n === 1 && c.a[0] >= 0.5) return [c.xs[0], c.xs[0]];
  for (let i = 0; i < n - 1; i++) {
    if (c.seg[i] < 0.5) continue;
    lo = Math.min(lo, c.xs[i], c.xs[i + 1]);
    hi = Math.max(hi, c.xs[i], c.xs[i + 1]);
  }
  return hi >= lo ? [lo, hi] : null;
}
