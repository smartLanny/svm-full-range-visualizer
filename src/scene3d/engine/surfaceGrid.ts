/**
 * Vertex grid shared by the terrain surface mesh and the contour tracer, so contour lines lie
 * exactly on the rendered triangles.
 *
 * Base vertices sit at cell centers plus one extra ring on the outer cell edges carrying the
 * nearest cell's value, so the surface tiles exactly the same rectangle as the bars / cells.
 * Each base quad is then subdivided (bilinear values) so the surface, its colors and the contour
 * lines follow the bilinear interpolant smoothly instead of showing triangle "star" artifacts.
 * The value at every cell center is the measured value, unchanged.
 *
 * Missing cells (docs/adr/0012): the subdivision is even, so every sub-quad lies inside exactly
 * one cell (cell edges are the midpoints between centers). A sub-quad is drawn iff its cell has a
 * value: a valid cell always fills its whole rectangle, a missing cell is exactly empty — the same
 * footprint as the bars (docs/adr/0002). Vertex values renormalise the bilinear weights over the
 * corners that have a value, so the surface next to a hole extends the valid neighbours instead of
 * shrinking away from it.
 */
import type { PanelModel } from './model';

export interface SurfaceGrid {
  /** Vertex counts along x and z. */
  nx: number;
  nz: number;
  /** World x per vertex column, world z per vertex row (row 0 = lowest gray = front). */
  gx: number[];
  gz: number[];
  /** Values per vertex (index j * nx + i); null = not part of any drawn sub-quad. */
  v: (number | null)[];
  /** Triangles (vertex indices), counter-clockwise seen from +y. */
  tris: number[];
  /** Per sub-quad (index j * (nx − 1) + i): 1 = drawn (its cell has a value). */
  quadOn: Uint8Array;
  /** Per sub-quad: cell index r * nCols + c. */
  quadCell: Int32Array;
}

export const SUBDIV = 4;

const EPS = 1e-9;

const baseCache = new WeakMap<PanelModel, ReturnType<typeof makeBaseGrid>>();

/** Base grid of a panel: [edge, centers..., edge] per axis, values clamped to the nearest cell. */
function baseGrid(panel: PanelModel) {
  let g = baseCache.get(panel);
  if (!g) {
    g = makeBaseGrid(panel);
    baseCache.set(panel, g);
  }
  return g;
}

function makeBaseGrid(panel: PanelModel) {
  const nC = panel.xs.length;
  const nR = panel.zs.length;
  const bx = [panel.xe[0], ...panel.xs, panel.xe[nC]];
  const bz = [panel.ze[0], ...panel.zs, panel.ze[nR]];
  const cellOf = (i: number, n: number) => Math.min(n - 1, Math.max(0, i - 1));
  const bv = (i: number, j: number): number | null => {
    const val = panel.values[cellOf(j, nR)][cellOf(i, nC)];
    return val === null || !Number.isFinite(val) ? null : val;
  };
  return { nC, nR, bx, bz, bv, cellOf };
}

/** Bilinear value in base quad (i, j) at (tu, tv), weights renormalised over non-null corners. */
function interp(bv: (i: number, j: number) => number | null, i: number, j: number, tu: number, tv: number): number | null {
  let sum = 0;
  let wsum = 0;
  const add = (ci: number, cj: number, w: number) => {
    if (w <= EPS) return;
    const cv = bv(ci, cj);
    if (cv === null) return;
    sum += cv * w;
    wsum += w;
  };
  add(i, j, (1 - tu) * (1 - tv));
  add(i + 1, j, tu * (1 - tv));
  add(i, j + 1, (1 - tu) * tv);
  add(i + 1, j + 1, tu * tv);
  return wsum > EPS ? sum / wsum : null;
}

/**
 * Value of the (un-subdivided) surface at world (x, z): null outside the panel or over a missing
 * cell. Same interpolant as the mesh vertices.
 */
export function sampleSurface(panel: PanelModel, x: number, z: number): number | null {
  const { nC, nR, bx, bz, bv } = baseGrid(panel);
  const { x0, x1, z0, z1 } = panel.rect;
  if (x < x0 || x > x1 || z < z0 || z > z1) return null;
  // Cell containing the point (edges: xe ascending, ze descending).
  let c = 0;
  while (c < nC - 1 && x > panel.xe[c + 1]) c++;
  let r = 0;
  while (r < nR - 1 && z < panel.ze[r + 1]) r++;
  const cell = panel.values[r][c];
  if (cell === null || !Number.isFinite(cell)) return null;
  let i = 0;
  while (i < nC && x > bx[i + 1]) i++;
  let j = 0;
  while (j < nR && z < bz[j + 1]) j++;
  const tu = (x - bx[i]) / Math.max(EPS, bx[i + 1] - bx[i]);
  const tv = (z - bz[j]) / Math.min(-EPS, bz[j + 1] - bz[j]);
  return interp(bv, i, j, Math.min(1, Math.max(0, tu)), Math.min(1, Math.max(0, tv)));
}

export function buildSurfaceGrid(panel: PanelModel, subdiv = SUBDIV): SurfaceGrid {
  const { nC, nR, bx, bz, bv, cellOf } = baseGrid(panel);
  const bnx = nC + 2;
  const bnz = nR + 2;
  // Even, so the cell edge (base-interval midpoint) is always a grid line.
  const S = Math.max(2, 2 * Math.round(subdiv / 2));
  const nx = (bnx - 1) * S + 1;
  const nz = (bnz - 1) * S + 1;
  const split = (k: number, n: number) => {
    const i = Math.min(n - 2, Math.floor(k / S));
    return { i, u: (k - i * S) / S };
  };
  const gx: number[] = new Array(nx);
  const gz: number[] = new Array(nz);
  for (let k = 0; k < nx; k++) {
    const { i, u } = split(k, bnx);
    gx[k] = bx[i] + (bx[i + 1] - bx[i]) * u;
  }
  for (let k = 0; k < nz; k++) {
    const { i, u } = split(k, bnz);
    gz[k] = bz[i] + (bz[i + 1] - bz[i]) * u;
  }
  // Cell column / row of each sub-quad column / row: the base corner on its side of the midpoint.
  const quadAxisCell = (K: number, n: number, nCells: number) => {
    const { i, u } = split(K, n);
    return u + 0.5 / S < 0.5 ? cellOf(i, nCells) : cellOf(i + 1, nCells);
  };
  const qx = Array.from({ length: nx - 1 }, (_, I) => quadAxisCell(I, bnx, nC));
  const qz = Array.from({ length: nz - 1 }, (_, J) => quadAxisCell(J, bnz, nR));
  const quadOn = new Uint8Array((nx - 1) * (nz - 1));
  const quadCell = new Int32Array((nx - 1) * (nz - 1));
  for (let J = 0; J < nz - 1; J++)
    for (let I = 0; I < nx - 1; I++) {
      const q = J * (nx - 1) + I;
      const r = qz[J];
      const c = qx[I];
      quadCell[q] = r * nC + c;
      const val = panel.values[r][c];
      quadOn[q] = val !== null && Number.isFinite(val) ? 1 : 0;
    }

  // Vertex values, only where a drawn sub-quad needs them.
  const needed = new Uint8Array(nx * nz);
  for (let J = 0; J < nz - 1; J++)
    for (let I = 0; I < nx - 1; I++) {
      if (!quadOn[J * (nx - 1) + I]) continue;
      const a = J * nx + I;
      needed[a] = needed[a + 1] = needed[a + nx] = needed[a + nx + 1] = 1;
    }
  const v: (number | null)[] = new Array(nx * nz).fill(null);
  for (let J = 0; J < nz; J++) {
    const { i: j, u: tv } = split(J, bnz);
    for (let I = 0; I < nx; I++) {
      if (!needed[J * nx + I]) continue;
      const { i, u: tu } = split(I, bnx);
      v[J * nx + I] = interp(bv, i, j, tu, tv);
    }
  }

  const tris: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (!quadOn[j * (nx - 1) + i]) continue;
      const a = j * nx + i; // front-left
      const b = a + 1; // front-right
      const d = a + nx; // back-left
      const e = d + 1; // back-right
      const va = v[a];
      const vb = v[b];
      const vd = v[d];
      const ve = v[e];
      // Cannot happen for a drawn quad (its own cell weighs at least 1/4), but stay safe.
      if (va === null || vb === null || vd === null || ve === null) continue;
      if (Math.abs(va - ve) <= Math.abs(vb - vd)) tris.push(a, b, e, a, e, d);
      else tris.push(a, b, d, b, e, d);
    }
  }
  return { nx, nz, gx, gz, v, tris, quadOn, quadCell };
}

/** A border edge of the drawn surface: vertices a → b; the wall on it faces `n` (outward). */
export interface BoundaryEdge {
  a: number;
  b: number;
  n: [number, number, number];
}

/**
 * Every edge between a drawn sub-quad and the outside (panel border or a missing cell), oriented
 * so that (b − a) × ŷ = n, i.e. counter-clockwise seen from outside. Zero-length edges (the
 * degenerate ring where a cell edge is clamped onto its center) are skipped.
 */
export function boundaryEdges(grid: SurfaceGrid): BoundaryEdge[] {
  const { nx, nz, gx, gz, quadOn } = grid;
  const qn = nx - 1;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < nx - 1 && j < nz - 1 && quadOn[j * qn + i] === 1;
  const out: BoundaryEdge[] = [];
  const push = (a: number, b: number, n: [number, number, number]) => {
    const len = Math.hypot(gx[a % nx] - gx[b % nx], gz[Math.floor(a / nx)] - gz[Math.floor(b / nx)]);
    if (len > 1e-7) out.push({ a, b, n });
  };
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      if (!on(i, j)) continue;
      const a = j * nx + i; // front-left
      const b = a + 1; // front-right
      const d = a + nx; // back-left
      const e = d + 1; // back-right
      if (!on(i, j - 1)) push(a, b, [0, 0, 1]); // front (+z): left → right
      if (!on(i + 1, j)) push(b, e, [1, 0, 0]); // right (+x): front → back
      if (!on(i, j + 1)) push(e, d, [0, 0, -1]); // back (−z): right → left
      if (!on(i - 1, j)) push(d, a, [-1, 0, 0]); // left (−x): back → front
    }
  return out;
}
