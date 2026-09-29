/**
 * Per-panel 3D content: surface (+ side walls), bars, base plate, value table layer and contours.
 * Heights are built at unit scale; the engine sets `heightGroup.scale.y` (flatten / height scale).
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BAR_GAP, BAR_GAP_MAX, plotValue, SY, type PanelModel, type SceneModel } from './model';
import { buildSurfaceGrid, type SurfaceGrid } from './surfaceGrid';
import {
  cutUnderLabels,
  pieceSegmentCount,
  placeLabels,
  revealSegments,
  traceContours,
  type ContourLabel,
  type ContourLine,
  type ContourPiece,
} from './contours';
import { measureText, TextCache, type TextStyle } from './text';

export interface BarInfo {
  r: number;
  c: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Unit height (clamped value · SY). */
  h: number;
  capped: boolean;
}

export const CONTOUR_LABEL_STYLE: TextStyle = { size: 12, weight: 600, color: '#f6f7f9', halo: 'rgba(8,10,14,0.88)', haloWidth: 2.2 };

/** Contour line colors (display sRGB): dark core readable on light and mid colormap tones. */
const CONTOUR_COLORS = ['#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14', '#0b0e14'];

/** One drawable contour line set (LineSegments2) with draw-on reveal. */
export class ContourLineSet {
  readonly line: LineSegments2;
  readonly mat: LineMaterial;
  private pieces: ContourPiece[] = [];
  private segBuf = new Float32Array(0);
  private lvlBuf = new Uint8Array(0);
  private revealKey = '';

  constructor(order: number) {
    this.mat = new LineMaterial({ color: 0xffffff, linewidth: 1.6, vertexColors: true, transparent: true, depthWrite: false, worldUnits: false });
    this.mat.polygonOffset = true;
    this.mat.polygonOffsetFactor = -2;
    this.mat.polygonOffsetUnits = -4;
    this.line = new LineSegments2(new LineSegmentsGeometry(), this.mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = order;
  }

  setPieces(pieces: ContourPiece[]) {
    this.pieces = pieces;
    const cap = Math.max(1, pieceSegmentCount(pieces));
    if (this.segBuf.length < cap * 6) {
      this.segBuf = new Float32Array(cap * 6);
      this.lvlBuf = new Uint8Array(cap);
      const geo = this.line.geometry as LineSegmentsGeometry;
      geo.setPositions(new Float32Array(cap * 6));
      geo.setColors(new Float32Array(cap * 6));
    }
    this.revealKey = '';
  }

  /** Write revealed segments (null = all) into the geometry. */
  setReveal(reveal: number[] | null) {
    const key = reveal ? reveal.map((r) => r.toFixed(4)).join(',') : 'all';
    if (key === this.revealKey) return;
    this.revealKey = key;
    const n = revealSegments(this.pieces, (l) => (reveal ? (reveal[l] ?? 1) : 1), this.segBuf, this.lvlBuf);
    const geo = this.line.geometry as LineSegmentsGeometry;
    const start = geo.attributes.instanceStart as THREE.InterleavedBufferAttribute | undefined;
    const colors = geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute | undefined;
    if (!start || !colors) return;
    (start.data.array as Float32Array).set(this.segBuf.subarray(0, n * 6));
    start.data.needsUpdate = true;
    const col = colors.data.array as Float32Array;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      c.set(CONTOUR_COLORS[this.lvlBuf[i] % CONTOUR_COLORS.length]);
      col[i * 6] = col[i * 6 + 3] = c.r;
      col[i * 6 + 1] = col[i * 6 + 4] = c.g;
      col[i * 6 + 2] = col[i * 6 + 5] = c.b;
    }
    colors.data.needsUpdate = true;
    geo.instanceCount = n;
  }

  setStyle(opacity: number, linewidth: number) {
    this.mat.opacity = opacity;
    this.mat.linewidth = linewidth;
    this.line.visible = opacity > 0.003;
  }

  dispose() {
    this.line.geometry.dispose();
    this.mat.dispose();
  }
}

export class PanelContent {
  readonly group = new THREE.Group();
  /** y-scaled by heightK · heightScale. */
  readonly heightGroup = new THREE.Group();
  readonly grid: SurfaceGrid;
  readonly surface: THREE.Mesh;
  readonly walls: THREE.Mesh;
  readonly bars: THREE.InstancedMesh;
  readonly barInfo: BarInfo[];
  readonly plate: THREE.Mesh;
  readonly lines: ContourLine[];
  readonly contourGroup = new THREE.Group();
  /** Lines cut under their labels, and the same lines uncut (used while labels are hidden). */
  readonly contourCut = new ContourLineSet(5);
  readonly contourFull = new ContourLineSet(5);
  labels: ContourLabel[] = [];
  readonly labelSprites: THREE.Sprite[] = [];
  valuesMesh: THREE.Mesh | null = null;
  private valuesKey = '';
  private growthKey: Float32Array | null | undefined = undefined;
  private readonly dummy = new THREE.Object3D();
  private readonly labelCache = new TextCache();

  constructor(
    readonly panel: PanelModel,
    readonly model: SceneModel,
    mats: { surface: THREE.Material; walls: THREE.Material; bars: THREE.Material; plate: THREE.Material },
  ) {
    const cap = model.heightCap;
    const unitH = (v: number) => plotValue(v, cap) * SY;
    this.grid = buildSurfaceGrid(panel);
    this.group.add(this.heightGroup);

    // --- surface ---
    this.surface = new THREE.Mesh(buildSurfaceGeometry(this.grid, unitH), mats.surface);
    this.surface.renderOrder = 2;
    this.surface.frustumCulled = false;
    this.walls = new THREE.Mesh(buildWallGeometry(this.grid, unitH), mats.walls);
    this.walls.renderOrder = 2;
    this.walls.frustumCulled = false;
    this.heightGroup.add(this.surface, this.walls);

    // --- bars ---
    this.barInfo = [];
    panel.values.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === null) return;
        const gx = Math.min(BAR_GAP_MAX, ((panel.xe[c + 1] - panel.xe[c]) * BAR_GAP) / 2);
        const zA = panel.ze[r];
        const zB = panel.ze[r + 1];
        const gz = Math.min(BAR_GAP_MAX, (Math.abs(zB - zA) * BAR_GAP) / 2);
        this.barInfo.push({
          r,
          c,
          x0: panel.xe[c] + gx,
          x1: panel.xe[c + 1] - gx,
          z0: Math.min(zA, zB) + gz,
          z1: Math.max(zA, zB) - gz,
          h: unitH(v),
          capped: Math.abs(v) > cap,
        });
      }),
    );
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.bars = new THREE.InstancedMesh(box, mats.bars, Math.max(1, this.barInfo.length));
    this.bars.count = this.barInfo.length;
    const aValue = new Float32Array(Math.max(1, this.barInfo.length));
    const aCapped = new Float32Array(Math.max(1, this.barInfo.length));
    this.barInfo.forEach((b, i) => {
      aValue[i] = panel.values[b.r][b.c] as number;
      aCapped[i] = b.capped ? 1 : 0;
    });
    box.setAttribute('aValue', new THREE.InstancedBufferAttribute(aValue, 1));
    box.setAttribute('aCapped', new THREE.InstancedBufferAttribute(aCapped, 1));
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 1;
    this.heightGroup.add(this.bars);
    this.setGrowth(null);

    // --- base plate ---
    const { x0, x1, z0, z1 } = panel.rect;
    const plateGeo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    plateGeo.rotateX(-Math.PI / 2);
    this.plate = new THREE.Mesh(plateGeo, mats.plate);
    this.plate.position.set((x0 + x1) / 2, -0.012, (z0 + z1) / 2);
    this.plate.renderOrder = 0;
    this.group.add(this.plate);

    // --- contours ---
    this.lines = traceContours(this.grid, model.contourLevels, unitH);
    this.contourGroup.add(this.contourCut.line, this.contourFull.line);
    this.group.add(this.contourGroup);
  }

  /** Instance index per cell (r * nCols + c), -1 = no bar. */
  get barIndex(): Int32Array {
    if (!this._barIndex) {
      const nC = this.panel.xs.length;
      this._barIndex = new Int32Array(this.panel.zs.length * nC).fill(-1);
      this.barInfo.forEach((b, i) => (this._barIndex![b.r * nC + b.c] = i));
    }
    return this._barIndex;
  }
  private _barIndex: Int32Array | null = null;

  /** Unit surface height at world (x, z) (bilinear, same function as the rendered surface); null outside. */
  surfaceHeight(x: number, z: number): number | null {
    const p = this.panel;
    const { x0, x1, z0, z1 } = p.rect;
    if (x < x0 || x > x1 || z < z0 || z > z1) return null;
    const nC = p.xs.length;
    const nR = p.zs.length;
    // Base grid: [edge, centers..., edge]; z descending with row index.
    const gx = (i: number) => (i === 0 ? p.xe[0] : i === nC + 1 ? p.xe[nC] : p.xs[i - 1]);
    const gz = (j: number) => (j === 0 ? p.ze[0] : j === nR + 1 ? p.ze[nR] : p.zs[j - 1]);
    let i = 0;
    while (i < nC && x > gx(i + 1)) i++;
    let j = 0;
    while (j < nR && z < gz(j + 1)) j++;
    const u = (x - gx(i)) / Math.max(1e-9, gx(i + 1) - gx(i));
    const v = (z - gz(j)) / Math.min(-1e-9, gz(j + 1) - gz(j));
    const val = (ii: number, jj: number) => p.values[Math.min(nR - 1, Math.max(0, jj - 1))][Math.min(nC - 1, Math.max(0, ii - 1))];
    const c00 = val(i, j);
    const c10 = val(i + 1, j);
    const c01 = val(i, j + 1);
    const c11 = val(i + 1, j + 1);
    if (c00 === null || c10 === null || c01 === null || c11 === null) return null;
    const vv = c00 * (1 - u) * (1 - v) + c10 * u * (1 - v) + c01 * (1 - u) * v + c11 * u * v;
    return plotValue(vv, this.model.heightCap) * SY;
  }

  /** Unit bar height at world (x, z) including growth (0 in gaps / outside). */
  barHeight(x: number, z: number, growth: Float32Array | null): number {
    const p = this.panel;
    const { x0, x1, z0, z1 } = p.rect;
    if (x < x0 || x > x1 || z < z0 || z > z1) return 0;
    let c = 0;
    while (c < p.xs.length - 1 && x > p.xe[c + 1]) c++;
    let r = 0;
    while (r < p.zs.length - 1 && z < p.ze[r + 1]) r++;
    const idx = this.barIndex[r * p.xs.length + c];
    if (idx < 0) return 0;
    const b = this.barInfo[idx];
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return 0;
    return b.h * (growth ? growth[idx] : 1);
  }

  /** Update bar instance matrices for per-bar growth (null = full). */
  setGrowth(growth: Float32Array | null) {
    if (growth === this.growthKey && growth === null) return;
    const d = this.dummy;
    for (let i = 0; i < this.barInfo.length; i++) {
      const b = this.barInfo[i];
      const g = growth ? growth[i] : 1;
      const h = b.h * g;
      const visible = g > 1e-4;
      d.position.set((b.x0 + b.x1) / 2, Math.min(0, h), (b.z0 + b.z1) / 2);
      d.scale.set(visible ? b.x1 - b.x0 : 0, Math.max(1e-4, Math.abs(h)), visible ? b.z1 - b.z0 : 0);
      d.updateMatrix();
      this.bars.setMatrixAt(i, d.matrix);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.growthKey = growth;
  }

  /**
   * Place contour labels for a given top-view scale (world units per CSS px) and rebuild the
   * cut line pieces. Called when the viewport / fit changes.
   */
  layoutContours(worldPerCssPx: number, pxScale: number, format: (v: number) => string) {
    const cache = this.labelCache;
    cache.clear();
    const style = CONTOUR_LABEL_STYLE;
    const hh = style.size * 0.62 * worldPerCssPx;
    const { rect } = this.panel;
    const lowGrayZ = this.panel.zs.length > 3 ? (this.panel.ze[0] + this.panel.ze[Math.min(3, this.panel.ze.length - 1)]) / 2 : undefined;
    this.labels = placeLabels(this.lines, {
      rect,
      halfHeight: hh,
      halfWidth: (txt) => ((measureText(txt, style, 1) + 4) / 2) * worldPerCssPx,
      format,
      avoidZAbove: lowGrayZ,
    });
    this.contourCut.setPieces(cutUnderLabels(this.lines, this.labels, 1.12));
    this.contourFull.setPieces(cutUnderLabels(this.lines, [], 1));
    // Label sprites (world-sized billboards, depth-tested so hills hide them in 3D).
    for (const s of this.labelSprites) {
      this.contourGroup.parent?.remove(s);
      (s.material as THREE.SpriteMaterial).dispose();
    }
    this.labelSprites.length = 0;
    for (const lb of this.labels) {
      const tt = cache.get(lb.text, style, pxScale * 2);
      const mat = new THREE.SpriteMaterial({ map: tt.texture, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true });
      const sp = new THREE.Sprite(mat);
      // Texture px -> world: tt.w device px at (pxScale*2) px per CSS px.
      const k = worldPerCssPx / (pxScale * 2);
      sp.scale.set(tt.w * k, tt.h * k, 1);
      sp.renderOrder = 6;
      sp.userData.label = lb;
      sp.userData.nominalPx = tt.h / 2;
      this.labelSprites.push(sp);
      this.group.add(sp);
    }
  }

  /** Draw-on progress per level (null = all) for both line sets. */
  setContourReveal(reveal: number[] | null) {
    this.contourCut.setReveal(reveal);
    this.contourFull.setReveal(reveal);
  }

  /** Canvas texture with the cell values (one texture for the whole panel). */
  setValuesTexture(key: string, texture: THREE.Texture | null, mat: () => THREE.Material) {
    if (key === this.valuesKey) return;
    this.valuesKey = key;
    if (this.valuesMesh) {
      this.group.remove(this.valuesMesh);
      this.valuesMesh.geometry.dispose();
      const m = this.valuesMesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
      this.valuesMesh = null;
    }
    if (!texture) return;
    const { x0, x1, z0, z1 } = this.panel.rect;
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    geo.rotateX(-Math.PI / 2);
    const m = mat() as THREE.MeshBasicMaterial;
    m.map = texture;
    this.valuesMesh = new THREE.Mesh(geo, m);
    this.valuesMesh.position.set((x0 + x1) / 2, 0.01, (z0 + z1) / 2);
    // Above the contour lines: the digits' halo (cell color) masks lines passing under them.
    this.valuesMesh.renderOrder = 7;
    this.valuesMesh.frustumCulled = false;
    this.group.add(this.valuesMesh);
  }

  dispose() {
    this.surface.geometry.dispose();
    this.walls.geometry.dispose();
    this.bars.geometry.dispose();
    this.bars.dispose();
    this.plate.geometry.dispose();
    this.contourCut.dispose();
    this.contourFull.dispose();
    for (const s of this.labelSprites) (s.material as THREE.SpriteMaterial).dispose();
    this.labelCache.clear();
    this.setValuesTexture('', null, () => new THREE.MeshBasicMaterial());
  }
}

function buildSurfaceGeometry(grid: SurfaceGrid, unitH: (v: number) => number): THREE.BufferGeometry {
  const { nx, nz, gx, gz, v, tris } = grid;
  const pos = new Float32Array(nx * nz * 3);
  const val = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const value = v[k];
      pos[k * 3] = gx[i];
      pos[k * 3 + 1] = value === null ? 0 : unitH(value);
      pos[k * 3 + 2] = gz[j];
      val[k] = value ?? 0;
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aValue', new THREE.BufferAttribute(val, 1));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  return geo;
}

/** Vertical walls around the surface border, from y = 0 to the surface. */
function buildWallGeometry(grid: SurfaceGrid, unitH: (v: number) => number): THREE.BufferGeometry {
  const { nx, nz, gx, gz, v } = grid;
  const pos: number[] = [];
  const nrm: number[] = [];
  const val: number[] = [];
  const idx: number[] = [];
  // Border walk as (vertexIndex, outward normal) runs: front (j=0), right (i=nx-1), back (j=nz-1), left (i=0).
  const runs: { ids: number[]; n: [number, number, number] }[] = [
    { ids: Array.from({ length: nx }, (_, i) => i), n: [0, 0, 1] },
    { ids: Array.from({ length: nz }, (_, j) => j * nx + nx - 1), n: [1, 0, 0] },
    { ids: Array.from({ length: nx }, (_, i) => (nz - 1) * nx + (nx - 1 - i)), n: [0, 0, -1] },
    { ids: Array.from({ length: nz }, (_, j) => (nz - 1 - j) * nx), n: [-1, 0, 0] },
  ];
  for (const run of runs) {
    for (let s = 0; s < run.ids.length - 1; s++) {
      const a = run.ids[s];
      const b = run.ids[s + 1];
      const va = v[a];
      const vb = v[b];
      if (va === null || vb === null) continue;
      const base = pos.length / 3;
      const ax = gx[a % nx];
      const az = gz[Math.floor(a / nx)];
      const bx = gx[b % nx];
      const bz = gz[Math.floor(b / nx)];
      pos.push(ax, 0, az, bx, 0, bz, bx, unitH(vb), bz, ax, unitH(va), az);
      for (let k = 0; k < 4; k++) nrm.push(...run.n);
      val.push(va, vb, vb, va);
      // Outward-facing (counter-clockwise seen from outside).
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aValue', new THREE.Float32BufferAttribute(val, 1));
  geo.setIndex(idx);
  return geo;
}
