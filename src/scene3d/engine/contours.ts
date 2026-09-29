/**
 * Contour lines (docs/adr/0002): marching triangles over the exact surface triangulation, stitched
 * into polylines, labelled at well-spaced straight spots away from borders, and cut under labels.
 * All in world units on the xz plane; y carries the (unit, un-scaled) surface height.
 */
import type { SurfaceGrid } from './surfaceGrid';

export interface ContourPoint {
  x: number;
  /** Unit height (value · SY, clamped), multiplied by the terrain's height scale at render time. */
  y: number;
  z: number;
}

export interface ContourLine {
  level: number;
  levelIndex: number;
  points: ContourPoint[];
  closed: boolean;
  /** Cumulative xz arc length per point. */
  arc: number[];
  length: number;
}

/**
 * Trace all contour polylines at `levels` over the surface grid. `height(v)` maps a value to the
 * unit height used for the surface vertices.
 */
export function traceContours(grid: SurfaceGrid, levels: number[], height: (v: number) => number): ContourLine[] {
  const out: ContourLine[] = [];
  const { gx, gz, v, nx, tris } = grid;
  levels.forEach((level, levelIndex) => {
    // Segments keyed by the mesh edges they connect (edge key = lo * N + hi).
    const N = v.length + 1;
    const pointOf = new Map<number, ContourPoint>();
    const links = new Map<number, number[]>();
    const above = (i: number) => (v[i] as number) >= level;
    const edgePoint = (p: number, q: number): number => {
      const key = Math.min(p, q) * N + Math.max(p, q);
      if (!pointOf.has(key)) {
        const vp = v[p] as number;
        const vq = v[q] as number;
        const t = vq === vp ? 0.5 : Math.min(1, Math.max(0, (level - vp) / (vq - vp)));
        const xp = gx[p % nx];
        const zp = gz[Math.floor(p / nx)];
        const xq = gx[q % nx];
        const zq = gz[Math.floor(q / nx)];
        const hp = height(vp);
        const hq = height(vq);
        pointOf.set(key, { x: xp + (xq - xp) * t, y: hp + (hq - hp) * t, z: zp + (zq - zp) * t });
      }
      return key;
    };
    const link = (k1: number, k2: number) => {
      if (k1 === k2) return;
      if (!links.has(k1)) links.set(k1, []);
      if (!links.has(k2)) links.set(k2, []);
      links.get(k1)!.push(k2);
      links.get(k2)!.push(k1);
    };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t];
      const b = tris[t + 1];
      const c = tris[t + 2];
      const sa = above(a);
      const sb = above(b);
      const sc = above(c);
      if (sa === sb && sb === sc) continue;
      // The vertex on its own side determines the two crossed edges.
      if (sa !== sb && sa !== sc) link(edgePoint(a, b), edgePoint(a, c));
      else if (sb !== sa && sb !== sc) link(edgePoint(b, a), edgePoint(b, c));
      else link(edgePoint(c, a), edgePoint(c, b));
    }
    // Walk chains (every node has degree <= 2): open ends first, then loops.
    const used = new Set<string>();
    const linkId = (p: number, q: number) => (p < q ? `${p}_${q}` : `${q}_${p}`);
    const walk = (start: number): number[] => {
      const chain = [start];
      let cur = start;
      for (;;) {
        const next = (links.get(cur) ?? []).find((n) => !used.has(linkId(cur, n)));
        if (next === undefined) break;
        used.add(linkId(cur, next));
        chain.push(next);
        cur = next;
        if (cur === start) break;
      }
      return chain;
    };
    const keys = [...links.keys()].sort((p, q) => p - q);
    for (const k of keys) {
      const nbrs = links.get(k)!;
      if (nbrs.length === 1 && !used.has(linkId(k, nbrs[0]))) {
        const chain = walk(k);
        if (chain.length >= 2) out.push(makeLine(level, levelIndex, chain.map((id) => pointOf.get(id)!), false));
      }
    }
    for (const k of keys) {
      if (links.get(k)!.some((n) => !used.has(linkId(k, n)))) {
        const chain = walk(k);
        if (chain.length >= 3) {
          const closed = chain[0] === chain[chain.length - 1];
          out.push(makeLine(level, levelIndex, chain.map((id) => pointOf.get(id)!), closed));
        }
      }
    }
  });
  return out.map(orientLine);
}

function makeLine(level: number, levelIndex: number, points: ContourPoint[], closed: boolean): ContourLine {
  const arc = [0];
  for (let i = 1; i < points.length; i++) arc.push(arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  return { level, levelIndex, points, closed, arc, length: arc[arc.length - 1] };
}

/** Start open lines at their left-most end and loops at their left-most point (draw-on order). */
function orientLine(line: ContourLine): ContourLine {
  const pts = line.points;
  if (!line.closed) {
    if (pts[pts.length - 1].x < pts[0].x) return makeLine(line.level, line.levelIndex, [...pts].reverse(), false);
    return line;
  }
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) if (pts[i].x < pts[best].x) best = i;
  if (best === 0) return line;
  const ring = pts.slice(0, -1);
  const rotated = [...ring.slice(best), ...ring.slice(0, best), ring[best]];
  return makeLine(line.level, line.levelIndex, rotated, true);
}

/** Point + tangent at arc length s along a line. */
export function pointAt(line: ContourLine, s: number): { p: ContourPoint; dx: number; dz: number } {
  const { points, arc } = line;
  const n = points.length;
  if (s <= 0) return { p: points[0], dx: points[1].x - points[0].x, dz: points[1].z - points[0].z };
  if (s >= line.length) return { p: points[n - 1], dx: points[n - 1].x - points[n - 2].x, dz: points[n - 1].z - points[n - 2].z };
  let i = 1;
  while (i < n - 1 && arc[i] < s) i++;
  const a = points[i - 1];
  const b = points[i];
  const t = (s - arc[i - 1]) / Math.max(1e-12, arc[i] - arc[i - 1]);
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, dx: b.x - a.x, dz: b.z - a.z };
}

export interface LabelBox {
  /** Center (world). */
  x: number;
  y: number;
  z: number;
  /** Half extents on the xz plane (world). */
  hw: number;
  hh: number;
}

export interface ContourLabel extends LabelBox {
  level: number;
  levelIndex: number;
  text: string;
  /** Normalised position along its line (0..1), for draw-on reveal. */
  u: number;
  lineIndex: number;
}

export interface PlaceOptions {
  /** Panel rectangle (world): labels keep `margin` away from it. */
  rect: { x0: number; x1: number; z0: number; z1: number };
  /** Label half-height (world) and a text width function (world half-width for a string). */
  halfHeight: number;
  halfWidth: (text: string) => number;
  format: (level: number) => string;
  /** Soft-avoid region (e.g. crowded low-gray rows): z greater than this is penalised. */
  avoidZAbove?: number;
}

/**
 * Choose label spots: one per sufficiently long line (two on long ones), on straight stretches,
 * away from borders, other labels and other lines. Deterministic.
 */
export function placeLabels(lines: ContourLine[], opt: PlaceOptions): ContourLabel[] {
  const labels: ContourLabel[] = [];
  const hh = opt.halfHeight;
  const margin = hh * 1.6;
  // Sample points of every line for clearance tests.
  const samples: { x: number; z: number; line: number }[] = [];
  lines.forEach((l, li) => {
    const step = hh * 0.5;
    for (let s = 0; s <= l.length; s += step) {
      const { p } = pointAt(l, s);
      samples.push({ x: p.x, z: p.z, line: li });
    }
  });
  const order = lines.map((l, i) => i).sort((a, b) => lines[b].length - lines[a].length || a - b);
  for (const li of order) {
    const line = lines[li];
    const text = opt.format(line.level);
    const hw = opt.halfWidth(text);
    // Only lines long enough to read as a line on both sides of the label.
    if (line.length < hw * 9) continue;
    const wanted = line.length > hw * 40 ? 2 : 1;
    for (let k = 0; k < wanted; k++) {
      let best: { score: number; s: number; p: ContourPoint } | null = null;
      const nCand = 48;
      for (let ci = 1; ci < nCand; ci++) {
        const s = (ci / nCand) * line.length;
        if (!line.closed && (s < hw * 3 || s > line.length - hw * 3)) continue;
        const { p } = pointAt(line, s);
        // Inside the panel with margin.
        if (p.x - hw < opt.rect.x0 + margin || p.x + hw > opt.rect.x1 - margin) continue;
        if (p.z - hh < opt.rect.z0 + margin || p.z + hh > opt.rect.z1 - margin) continue;
        // Spacing from other labels: never overlapping; same level well apart; a second label on
        // the same line far along it.
        let ok = true;
        let crowd = 0;
        for (const o of labels) {
          const dx = Math.abs(o.x - p.x);
          const dz = Math.abs(o.z - p.z);
          if (dx < (hw + o.hw) * 1.3 && dz < (hh + o.hh) * 1.6) {
            ok = false;
            break;
          }
          const dist = Math.hypot(dx, dz);
          if (o.level === line.level && dist < hh * 16) {
            ok = false;
            break;
          }
          if (o.lineIndex === li && Math.abs(o.u - s / line.length) < 0.35) {
            ok = false;
            break;
          }
          crowd += 1 / (1 + dist);
        }
        if (!ok) continue;
        // Straightness: tangent change across the label width.
        const a = pointAt(line, s - hw * 1.2);
        const b = pointAt(line, s + hw * 1.2);
        const ang = Math.abs(angleBetween(a.dx, a.dz, b.dx, b.dz));
        if (ang > 1.1) continue;
        // Clearance from other lines inside the (padded) label box.
        let foreign = 0;
        for (const smp of samples) {
          if (smp.line === li) continue;
          if (Math.abs(smp.x - p.x) < hw * 1.25 && Math.abs(smp.z - p.z) < hh * 1.6) foreign++;
        }
        if (foreign > 0) continue;
        // Prefer the middle of the line and open space.
        const u = s / line.length;
        let score = ang * 2 + Math.abs(u - 0.5) * 0.8 + crowd * 0.5;
        if (opt.avoidZAbove !== undefined && p.z > opt.avoidZAbove) score += 2;
        if (!best || score < best.score) best = { score, s, p };
      }
      if (!best) break;
      labels.push({
        x: best.p.x,
        y: best.p.y,
        z: best.p.z,
        hw,
        hh,
        level: line.level,
        levelIndex: line.levelIndex,
        text,
        u: best.s / line.length,
        lineIndex: li,
      });
    }
  }
  return labels;
}

function angleBetween(ax: number, az: number, bx: number, bz: number): number {
  const a = Math.atan2(az, ax);
  const b = Math.atan2(bz, bx);
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** A drawable piece of a contour line (after cutting gaps), with draw-on parameters. */
export interface ContourPiece {
  levelIndex: number;
  points: ContourPoint[];
  /** Normalised arc parameter (0..1 along the original line) per point. */
  u: number[];
}

/**
 * Cut every line where it passes under a label box (padded), returning drawable pieces.
 */
export function cutUnderLabels(lines: ContourLine[], labels: LabelBox[], pad = 1.15): ContourPiece[] {
  const pieces: ContourPiece[] = [];
  for (const line of lines) {
    const state: { cur: ContourPiece | null } = { cur: null };
    const flush = () => {
      if (state.cur && state.cur.points.length >= 2) pieces.push(state.cur);
      state.cur = null;
    };
    const L = Math.max(1e-9, line.length);
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1];
      const b = line.points[i];
      const ua = line.arc[i - 1] / L;
      const ub = line.arc[i] / L;
      // Parameter intervals of [a, b] hidden by labels.
      const hidden: [number, number][] = [];
      for (const lb of labels) {
        const iv = clipSegment(a.x, a.z, b.x, b.z, lb.x - lb.hw * pad, lb.x + lb.hw * pad, lb.z - lb.hh * pad, lb.z + lb.hh * pad);
        if (iv) hidden.push(iv);
      }
      const visible = subtractIntervals([0, 1], hidden);
      const at = (t: number): ContourPoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      if (visible.length === 0) flush();
      for (const [t0, t1] of visible) {
        if (t1 - t0 < 1e-6) continue;
        // A visible part that does not start at the segment start begins a new piece.
        if (!state.cur || t0 > 1e-9) {
          flush();
          state.cur = { levelIndex: line.levelIndex, points: [at(t0)], u: [ua + (ub - ua) * t0] };
        }
        state.cur.points.push(at(t1));
        state.cur.u.push(ua + (ub - ua) * t1);
        if (t1 < 1 - 1e-9) flush();
      }
    }
    flush();
  }
  return pieces;
}

/** Liang–Barsky: parameter interval of segment inside an axis-aligned box, or null. */
function clipSegment(x0: number, z0: number, x1: number, z1: number, bx0: number, bx1: number, bz0: number, bz1: number): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const p = [-dx, dx, -dz, dz];
  const q = [x0 - bx0, bx1 - x0, z0 - bz0, bz1 - z0];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

function subtractIntervals(base: [number, number], cuts: [number, number][]): [number, number][] {
  let parts: [number, number][] = [base];
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) next.push([p0, p1]);
      else {
        if (c0 > p0) next.push([p0, c0]);
        if (c1 < p1) next.push([c1, p1]);
      }
    }
    parts = next;
  }
  return parts;
}

/**
 * Segment list (x,y,z pairs) of the pieces revealed up to `progress` (0..1) of each line's length,
 * with a per-level stagger. Writes into `out` and returns the segment count.
 */
export function revealSegments(
  pieces: ContourPiece[],
  progress: (levelIndex: number) => number,
  out: Float32Array,
  levelOut: Uint8Array,
): number {
  let n = 0;
  const cap = Math.floor(out.length / 6);
  for (const pc of pieces) {
    const p = progress(pc.levelIndex);
    if (p <= 0) continue;
    for (let i = 1; i < pc.points.length && n < cap; i++) {
      const u0 = pc.u[i - 1];
      const u1 = pc.u[i];
      if (u0 >= p) break;
      const a = pc.points[i - 1];
      let b = pc.points[i];
      if (u1 > p) {
        const t = (p - u0) / Math.max(1e-12, u1 - u0);
        b = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      }
      const o = n * 6;
      out[o] = a.x;
      out[o + 1] = a.y;
      out[o + 2] = a.z;
      out[o + 3] = b.x;
      out[o + 4] = b.y;
      out[o + 5] = b.z;
      levelOut[n] = pc.levelIndex;
      n++;
    }
  }
  return n;
}

/** Total segment count of the pieces (buffer capacity). */
export const pieceSegmentCount = (pieces: ContourPiece[]) => pieces.reduce((s, p) => s + p.points.length - 1, 0);
