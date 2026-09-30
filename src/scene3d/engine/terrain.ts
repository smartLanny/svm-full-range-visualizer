/**
 * Per-panel 3D content: surface (+ side walls), bars, base plate, value table layer and contours.
 * Heights are built at unit scale; the engine sets `heightGroup.scale.y` (flatten / height scale).
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BAR_GAP, BAR_GAP_MAX, plotValue, SY, type PanelModel, type SceneModel } from './model';
import { displayNotes } from '../../data/denoise';
import { boundaryEdges, buildSurfaceGrid, sampleSurface, type SurfaceGrid } from './surfaceGrid';
import {
  cutUnderLabels,
  pieceSegmentCount,
  placeLabels,
  pointAt,
  revealSegments,
  traceContours,
  type ContourLabel,
  type ContourLine,
  type ContourPiece,
  type LabelBox,
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

/** Footprint scale (x / z) of a bar at the very start of its intro fade-in. */
const BAR_FOOTPRINT0 = 0.6;

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
  /** Hatched "no data" floor under the missing cells (null when the panel has none). */
  readonly noData: THREE.Mesh | null;
  /** Dotted outlines of the cells the denoise filled by interpolation (top view; null when none). */
  readonly interp: THREE.Mesh | null;
  lines: ContourLine[];
  readonly contourGroup = new THREE.Group();
  /**
   * Lines cut under their labels, and the same lines cut around the printed cell values (used
   * while the value table replaces the labels): a line never crosses a label or a number.
   */
  readonly contourCut = new ContourLineSet(5);
  readonly contourValues = new ContourLineSet(5);
  labels: ContourLabel[] = [];
  private valueBoxes: LabelBox[] = [];
  readonly labelSprites: THREE.Sprite[] = [];
  valuesMesh: THREE.Mesh | null = null;
  private valuesKey = '';
  /** null once the bars were last written fully grown (skip redundant full updates). */
  private growthKey: Float32Array | null | undefined = undefined;
  private readonly dummy = new THREE.Object3D();
  private readonly labelCache = new TextCache();

  constructor(
    readonly panel: PanelModel,
    readonly model: SceneModel,
    mats: { surface: THREE.Material; walls: THREE.Material; bars: THREE.Material; plate: THREE.Material; noData: THREE.Material; interp: THREE.Material },
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
    // Intro fade-in per bar (1 = fully shown): color from the plate tone to the colormap.
    const aFade = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.barInfo.length)).fill(1), 1);
    aFade.setUsage(THREE.DynamicDrawUsage);
    box.setAttribute('aFade', aFade);
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 1;
    this.heightGroup.add(this.bars);
    this.setGrowth(null, null);

    // --- base plate ---
    const { x0, x1, z0, z1 } = panel.rect;
    const plateGeo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    plateGeo.rotateX(-Math.PI / 2);
    this.plate = new THREE.Mesh(plateGeo, mats.plate);
    this.plate.position.set((x0 + x1) / 2, -0.012, (z0 + z1) / 2);
    this.plate.renderOrder = 0;
    this.group.add(this.plate);

    // --- "no data" floor: exactly the missing cells (same rectangles as the bars / heatmap) ---
    const noDataGeo = buildNoDataGeometry(panel);
    this.noData = noDataGeo ? new THREE.Mesh(noDataGeo, mats.noData) : null;
    if (this.noData) {
      this.noData.renderOrder = 0;
      this.noData.frustumCulled = false;
      this.group.add(this.noData);
    }

    // --- interpolated cells (docs/adr/0012 addendum): dotted outline, shown in the top view ---
    const interpGeo = buildInterpGeometry(panel);
    this.interp = interpGeo ? new THREE.Mesh(interpGeo, mats.interp) : null;
    if (this.interp) {
      this.interp.renderOrder = 6;
      this.interp.frustumCulled = false;
      this.interp.visible = false;
      this.group.add(this.interp);
    }

    // --- contours ---
    this.lines = traceContours(this.grid, model.contourLevels, unitH);
    this.contourGroup.add(this.contourCut.line, this.contourValues.line);
    this.group.add(this.contourGroup);
  }

  /**
   * New height cap (value units) without rebuilding anything: surface / wall / bar heights, capped
   * flags and contour heights are updated in place. Cells, colors and label spots do not change.
   */
  setHeightCap(cap: number, growth: Float32Array | null) {
    const unitH = (v: number) => plotValue(v, cap) * SY;
    const lift = (geo: THREE.BufferGeometry, isTop: (i: number) => boolean) => {
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const val = geo.attributes.aValue as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) if (isTop(i)) pos.setY(i, unitH(val.getX(i)));
      pos.needsUpdate = true;
    };
    lift(this.surface.geometry, () => true);
    this.surface.geometry.computeVertexNormals();
    // Wall quads are [a bottom, b bottom, b top, a top].
    lift(this.walls.geometry, (i) => i % 4 >= 2);
    const aCapped = this.bars.geometry.attributes.aCapped as THREE.InstancedBufferAttribute;
    this.barInfo.forEach((b, i) => {
      const v = this.panel.values[b.r][b.c] as number;
      b.h = unitH(v);
      b.capped = Math.abs(v) > cap;
      aCapped.setX(i, b.capped ? 1 : 0);
    });
    aCapped.needsUpdate = true;
    this.setGrowth(growth, null, true);
    // Contours: same xz (they only depend on values and levels), new heights.
    this.lines = traceContours(this.grid, this.model.contourLevels, unitH);
    for (const lb of this.labels) {
      const line = this.lines[lb.lineIndex];
      if (line) lb.y = pointAt(line, lb.u * line.length).p.y;
    }
    this.contourCut.setPieces(cutUnderLabels(this.lines, this.labels, 1.12));
    this.contourValues.setPieces(cutUnderLabels(this.lines, this.valueBoxes, 1));
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

  /** Unit surface height at world (x, z) (same interpolant as the rendered surface); null outside / over a hole. */
  surfaceHeight(x: number, z: number): number | null {
    const v = sampleSurface(this.panel, x, z);
    return v === null ? null : plotValue(v, this.model.heightCap) * SY;
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

  /**
   * Update bar instance matrices for per-bar growth and fade-in (null = full). A fading-in bar has
   * a smaller footprint (60 % → 100 %) and its color comes up from the plate tone (aFade), so a
   * bar starting to grow never pops in as a full-size colored tile.
   */
  setGrowth(growth: Float32Array | null, fade: Float32Array | null, force = false) {
    if (!force && growth === null && fade === null && this.growthKey === null) return;
    const d = this.dummy;
    const aFade = this.bars.geometry.attributes.aFade as THREE.InstancedBufferAttribute;
    const fadeArr = aFade.array as Float32Array;
    for (let i = 0; i < this.barInfo.length; i++) {
      const b = this.barInfo[i];
      const g = growth ? growth[i] : 1;
      const f = fade ? fade[i] : 1;
      const h = b.h * g;
      const visible = g > 1e-4 || f > 1e-4;
      const foot = visible ? BAR_FOOTPRINT0 + (1 - BAR_FOOTPRINT0) * f : 0;
      d.position.set((b.x0 + b.x1) / 2, Math.min(0, h), (b.z0 + b.z1) / 2);
      d.scale.set((b.x1 - b.x0) * foot, Math.max(1e-4, Math.abs(h)), (b.z1 - b.z0) * foot);
      d.updateMatrix();
      this.bars.setMatrixAt(i, d.matrix);
      fadeArr[i] = f;
    }
    this.bars.instanceMatrix.needsUpdate = true;
    aFade.needsUpdate = true;
    this.growthKey = growth ?? fade;
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
    this.contourValues.setPieces(cutUnderLabels(this.lines, this.valueBoxes, 1));
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
    this.contourValues.setReveal(reveal);
  }

  /** Canvas texture with the cell values (one texture for the whole panel) + the printed boxes. */
  setValuesTexture(key: string, texture: THREE.Texture | null, mat: () => THREE.Material, boxes: LabelBox[] = []) {
    if (key === this.valuesKey) return;
    this.valuesKey = key;
    this.valueBoxes = boxes;
    this.contourValues.setPieces(cutUnderLabels(this.lines, boxes, 1));
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
    this.noData?.geometry.dispose();
    this.interp?.geometry.dispose();
    this.contourCut.dispose();
    this.contourValues.dispose();
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

/**
 * Vertical walls along every border of the drawn surface — the panel border and the rims of the
 * holes left by missing cells — from y = 0 to the surface, so holes read as clean cut-outs instead
 * of paper-thin edges floating in the air.
 */
function buildWallGeometry(grid: SurfaceGrid, unitH: (v: number) => number): THREE.BufferGeometry {
  const { nx, gx, gz, v } = grid;
  const pos: number[] = [];
  const nrm: number[] = [];
  const val: number[] = [];
  const idx: number[] = [];
  for (const { a, b, n } of boundaryEdges(grid)) {
    const va = v[a];
    const vb = v[b];
    if (va === null || vb === null) continue;
    const base = pos.length / 3;
    const ax = gx[a % nx];
    const az = gz[Math.floor(a / nx)];
    const bx = gx[b % nx];
    const bz = gz[Math.floor(b / nx)];
    pos.push(ax, 0, az, bx, 0, bz, bx, unitH(vb), bz, ax, unitH(va), az);
    for (let k = 0; k < 4; k++) nrm.push(...n);
    val.push(va, vb, vb, va);
    // Outward-facing (counter-clockwise seen from outside).
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aValue', new THREE.Float32BufferAttribute(val, 1));
  geo.setIndex(idx);
  return geo;
}

/**
 * One flat quad per cell the denoise filled by interpolation (y = 0, local 0..1 coordinates for the
 * dotted outline), or null when there is none. SVM panels only: a difference map mixes two records.
 */
function buildInterpGeometry(panel: PanelModel): THREE.BufferGeometry | null {
  const notes = panel.kind === 'svm' ? displayNotes(panel.record) : null;
  if (!notes) return null;
  const v = panel.view;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  panel.values.forEach((row, r) =>
    row.forEach((val, c) => {
      if (val === null || notes.noteGrid[v.rowIndex[r]]?.[v.colIndex[c]]?.action !== 'interpolated') return;
      const x0 = panel.xe[c];
      const x1 = panel.xe[c + 1];
      const zf = Math.max(panel.ze[r], panel.ze[r + 1]);
      const zb = Math.min(panel.ze[r], panel.ze[r + 1]);
      const base = pos.length / 3;
      pos.push(x0, 0, zf, x1, 0, zf, x1, 0, zb, x0, 0, zb);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }),
  );
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/** One flat quad per missing cell (y = 0), or null when every cell has a value. */
function buildNoDataGeometry(panel: PanelModel): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const idx: number[] = [];
  panel.values.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v !== null && Number.isFinite(v)) return;
      const x0 = panel.xe[c];
      const x1 = panel.xe[c + 1];
      const zf = Math.max(panel.ze[r], panel.ze[r + 1]); // front
      const zb = Math.min(panel.ze[r], panel.ze[r + 1]); // back
      const base = pos.length / 3;
      pos.push(x0, 0, zf, x1, 0, zf, x1, 0, zb, x0, 0, zb);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }),
  );
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}
