/**
 * Vertex grid shared by the terrain surface mesh and the contour tracer, so contour lines lie
 * exactly on the rendered triangles.
 *
 * Base vertices sit at cell centers plus one extra ring on the outer cell edges carrying the
 * nearest cell's value, so the surface tiles exactly the same rectangle as the bars / cells.
 * Each base quad is then subdivided (bilinear values) so the surface, its colors and the contour
 * lines follow the bilinear interpolant smoothly instead of showing triangle "star" artifacts.
 * The value at every cell center is the measured value, unchanged.
 */
import type { PanelModel } from './model';

export interface SurfaceGrid {
  /** Vertex counts along x and z. */
  nx: number;
  nz: number;
  /** World x per vertex column, world z per vertex row (row 0 = lowest gray = front). */
  gx: number[];
  gz: number[];
  /** Values per vertex (index j * nx + i); null = missing. */
  v: (number | null)[];
  /** Triangles (vertex indices), counter-clockwise seen from +y. */
  tris: number[];
}

export const SUBDIV = 4;

export function buildSurfaceGrid(panel: PanelModel, subdiv = SUBDIV): SurfaceGrid {
  const nC = panel.xs.length;
  const nR = panel.zs.length;
  const bx = [panel.xe[0], ...panel.xs, panel.xe[nC]];
  const bz = [panel.ze[0], ...panel.zs, panel.ze[nR]];
  const bnx = nC + 2;
  const bnz = nR + 2;
  const bv = (i: number, j: number): number | null => {
    const r = Math.min(nR - 1, Math.max(0, j - 1));
    const c = Math.min(nC - 1, Math.max(0, i - 1));
    const val = panel.values[r][c];
    return val === null || !Number.isFinite(val) ? null : val;
  };
  const S = Math.max(1, Math.round(subdiv));
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
  const v: (number | null)[] = new Array(nx * nz);
  const EPS = 1e-9;
  for (let J = 0; J < nz; J++) {
    const { i: j, u: tv } = split(J, bnz);
    for (let I = 0; I < nx; I++) {
      const { i, u: tu } = split(I, bnx);
      const corners: [number, number, number][] = [
        [i, j, (1 - tu) * (1 - tv)],
        [i + 1, j, tu * (1 - tv)],
        [i, j + 1, (1 - tu) * tv],
        [i + 1, j + 1, tu * tv],
      ];
      let sum = 0;
      let wsum = 0;
      let ok = true;
      for (const [ci, cj, w] of corners) {
        if (w <= EPS) continue;
        const cv = bv(ci, cj);
        if (cv === null) {
          ok = false;
          break;
        }
        sum += cv * w;
        wsum += w;
      }
      v[J * nx + I] = ok && wsum > EPS ? sum / wsum : null;
    }
  }
  const tris: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i; // front-left
      const b = a + 1; // front-right
      const d = a + nx; // back-left
      const e = d + 1; // back-right
      const va = v[a];
      const vb = v[b];
      const vd = v[d];
      const ve = v[e];
      const diagAE = va !== null && ve !== null ? Math.abs(va - ve) : Infinity;
      const diagBD = vb !== null && vd !== null ? Math.abs(vb - vd) : Infinity;
      if (diagAE <= diagBD) {
        if (va !== null && vb !== null && ve !== null) tris.push(a, b, e);
        if (va !== null && ve !== null && vd !== null) tris.push(a, e, d);
      } else {
        if (va !== null && vb !== null && vd !== null) tris.push(a, b, d);
        if (vb !== null && ve !== null && vd !== null) tris.push(b, e, d);
      }
    }
  }
  return { nx, nz, gx, gz, v, tris };
}
