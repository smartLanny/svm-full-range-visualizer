/**
 * Axes: world-space lines (plot borders, tick marks, faint plate grid, vertical value axis) and
 * the label specs that the HUD lays out each frame (screen-constant size, collision culled).
 *
 * In 3D the luminance / gray axes sit on the plate edges nearest to the camera (like most 3D
 * plotting tools) so their labels never sit behind the terrain; top view uses bottom / left.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { logNits } from '../../data/grid';
import { SX, SY, SZ, type SceneModel } from './model';
import type { TextStyle } from './text';

export type AxisId = 'lum' | 'gray' | 'value' | 'caption';

export interface AxisLabelSpec {
  axis: AxisId;
  kind: 'tick' | 'title';
  text: string;
  style: TextStyle;
  /** lum: world x; gray: world z; value: value units. */
  coord: number;
  /** Lower = kept first when labels collide. */
  priority: number;
  panel: number;
  gray?: number;
  /** Rotate when the axis runs vertically on screen (titles only). */
  rotateWhenVertical?: boolean;
}

export const TICK_STYLE: TextStyle = { size: 11, weight: 500, color: '#8e98a8' };
export const TITLE_STYLE: TextStyle = { size: 12, weight: 600, color: '#b9c1cd' };
export const CAPTION_STYLE: TextStyle = { size: 13, weight: 600, color: '#eef1f5' };

const lumPriority = (n: number) => {
  if (n <= 0) return 9;
  const e = Math.floor(Math.log10(n) + 1e-9);
  const m = Math.round(n / Math.pow(10, e));
  return m === 1 ? 0 : m === 5 ? 2 : 3;
};
const grayPriority = (g: number) => (g === 255 || g === 128 ? 0 : g === 64 || g === 192 ? 1 : 2);

export interface AxisTexts {
  lum: string;
  gray: string;
  value: string;
  captions: string[];
}

/** Which plate edges carry the axes this frame. */
export interface AxisEdges {
  /** Luminance axis on the front (low gray, +z) or back edge. */
  lumFront: boolean;
  /** Gray axis on the left (−x) or right edge. */
  grayLeft: boolean;
}

export class Axes {
  readonly group = new THREE.Group();
  /** Scaled like the terrain heights (value axis). */
  readonly valueGroup = new THREE.Group();
  readonly labels: AxisLabelSpec[] = [];
  private readonly lineMat: LineMaterial;
  private readonly gridMat: LineMaterial;
  private readonly valueMat: LineMaterial;
  private readonly objects: LineSegments2[] = [];
  private readonly lumFront: LineSegments2 | null;
  private readonly lumBack: LineSegments2 | null;
  private readonly grayLeft: LineSegments2 | null;
  private readonly grayRight: LineSegments2 | null;
  /** Plate corners (y = 0) for picking the value-axis corner. */
  readonly corners: THREE.Vector3[];
  readonly center: THREE.Vector3;
  valueTop = 1;
  edges: AxisEdges = { lumFront: true, grayLeft: true };

  constructor(readonly model: SceneModel, texts: AxisTexts) {
    this.lineMat = new LineMaterial({ color: 0x4a5464, linewidth: 1.25, transparent: true, depthWrite: false, worldUnits: false });
    this.lineMat.polygonOffset = true;
    this.lineMat.polygonOffsetFactor = -1;
    this.lineMat.polygonOffsetUnits = -2;
    this.gridMat = new LineMaterial({ color: 0x1b222d, linewidth: 1, transparent: true, depthWrite: false, worldUnits: false });
    this.valueMat = new LineMaterial({ color: 0x4a5464, linewidth: 1.25, transparent: true, depthWrite: false, worldUnits: false });
    this.group.add(this.valueGroup);

    const { panels, domain } = model;
    const lxMid = (domain.lx0 + domain.lx1) / 2;
    const gMid = (domain.g0 + domain.g1) / 2;
    const border: number[] = [];
    const lumF: number[] = [];
    const lumB: number[] = [];
    const grayL: number[] = [];
    const grayR: number[] = [];
    const grid: number[] = [];
    const tl = 0.2;
    const y = 0.004;
    const b = model.bounds;
    panels.forEach((p, pi) => {
      const { x0, x1, z0, z1 } = p.rect;
      border.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
      const panelMid = (x0 + x1) / 2;
      for (const n of model.nitsTicks) {
        const x = (logNits(n) - lxMid) * SX + p.offsetX;
        if (x < x0 - 1e-6 || x > x1 + 1e-6) continue;
        lumF.push(x, y, z1, x, y, z1 + tl);
        lumB.push(x, y, z0, x, y, z0 - tl);
        grid.push(x, 0.002, z0, x, 0.002, z1);
        this.labels.push({ axis: 'lum', kind: 'tick', text: String(n), style: TICK_STYLE, coord: x, priority: lumPriority(n), panel: pi });
      }
      for (const g of model.grayTicks) {
        const z = -(g - gMid) * SZ;
        if (z < z0 - 1e-6 || z > z1 + 1e-6) continue;
        grid.push(x0, 0.002, z, x1, 0.002, z);
      }
      this.labels.push({ axis: 'lum', kind: 'title', text: texts.lum, style: TITLE_STYLE, coord: panelMid, priority: 40, panel: pi });
      if (texts.captions[pi]) this.labels.push({ axis: 'caption', kind: 'title', text: texts.captions[pi], style: CAPTION_STYLE, coord: panelMid, priority: 5, panel: pi });
    });
    for (const g of model.grayTicks) {
      const z = -(g - gMid) * SZ;
      if (z < b.z0 - 1e-6 || z > b.z1 + 1e-6) continue;
      grayL.push(b.x0, y, z, b.x0 - tl, y, z);
      grayR.push(b.x1, y, z, b.x1 + tl, y, z);
      this.labels.push({ axis: 'gray', kind: 'tick', text: String(g), style: TICK_STYLE, coord: z, priority: 10 + grayPriority(g), panel: 0, gray: g });
    }
    this.labels.push({ axis: 'gray', kind: 'title', text: texts.gray, style: TITLE_STYLE, coord: (b.z0 + b.z1) / 2, priority: 41, panel: 0, rotateWhenVertical: true });

    // Value axis (unit heights; the group is scaled like the terrain, rotated to point outward).
    const vt = model.valueTicks;
    this.valueTop = vt.length ? vt[vt.length - 1] : 1;
    const vb = vt.length ? Math.min(0, vt[0]) : 0;
    const vLines: number[] = [0, vb * SY, 0, 0, this.valueTop * SY, 0];
    for (const v of vt) {
      vLines.push(0, v * SY, 0, 0.16, v * SY, 0);
      const txt = v === 0 ? '0' : Number.isInteger(v) ? String(v) : v.toFixed(1);
      this.labels.push({ axis: 'value', kind: 'tick', text: v < 0 ? `−${txt.replace('-', '')}` : txt, style: TICK_STYLE, coord: v, priority: 20 + (v === 0 ? 0 : 1), panel: 0 });
    }
    this.labels.push({ axis: 'value', kind: 'title', text: texts.value, style: TITLE_STYLE, coord: this.valueTop, priority: 42, panel: 0 });

    this.addLines(border, this.lineMat, this.group, 3);
    this.lumFront = this.addLines(lumF, this.lineMat, this.group, 3);
    this.lumBack = this.addLines(lumB, this.lineMat, this.group, 3);
    this.grayLeft = this.addLines(grayL, this.lineMat, this.group, 3);
    this.grayRight = this.addLines(grayR, this.lineMat, this.group, 3);
    this.addLines(grid, this.gridMat, this.group, 0);
    this.addLines(vLines, this.valueMat, this.valueGroup, 3);

    this.corners = [new THREE.Vector3(b.x0, 0, b.z0), new THREE.Vector3(b.x1, 0, b.z0), new THREE.Vector3(b.x1, 0, b.z1), new THREE.Vector3(b.x0, 0, b.z1)];
    this.center = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  }

  private addLines(arr: number[], mat: LineMaterial, parent: THREE.Object3D, order: number): LineSegments2 | null {
    if (arr.length < 6) return null;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(arr);
    const obj = new LineSegments2(geo, mat);
    obj.frustumCulled = false;
    obj.renderOrder = order;
    parent.add(obj);
    this.objects.push(obj);
    return obj;
  }

  /**
   * Choose the plate edges nearest to the camera (view depth), with hysteresis; ties (top view)
   * keep the conventional bottom / left placement.
   */
  chooseEdges(camPos: THREE.Vector3, forward: THREE.Vector3) {
    const b = this.model.bounds;
    const depth = (x: number, z: number) => (x - camPos.x) * forward.x + (0 - camPos.y) * forward.y + (z - camPos.z) * forward.z;
    const size = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    const hyst = size * 0.03;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const dFront = depth(cx, b.z1);
    const dBack = depth(cx, b.z0);
    const dLeft = depth(b.x0, cz);
    const dRight = depth(b.x1, cz);
    const e = this.edges;
    if (e.lumFront && dBack < dFront - hyst) e.lumFront = false;
    else if (!e.lumFront && dFront < dBack + hyst) e.lumFront = true;
    if (e.grayLeft && dRight < dLeft - hyst) e.grayLeft = false;
    else if (!e.grayLeft && dLeft < dRight + hyst) e.grayLeft = true;
    if (this.lumFront) this.lumFront.visible = e.lumFront;
    if (this.lumBack) this.lumBack.visible = !e.lumFront;
    if (this.grayLeft) this.grayLeft.visible = e.grayLeft;
    if (this.grayRight) this.grayRight.visible = !e.grayLeft;
  }

  /** World anchor of a label on the current edges (value axis y in value units, unscaled). */
  anchor(spec: AxisLabelSpec, out = new THREE.Vector3()): THREE.Vector3 {
    const m = this.model;
    const b = m.bounds;
    if (spec.axis === 'lum') {
      const r = m.panels[spec.panel].rect;
      return out.set(spec.coord, 0, this.edges.lumFront ? r.z1 : r.z0);
    }
    if (spec.axis === 'gray') return out.set(this.edges.grayLeft ? b.x0 : b.x1, 0, spec.coord);
    if (spec.axis === 'caption') return out.set(spec.coord, 0, m.panels[spec.panel].rect.z0);
    return out.set(0, spec.coord, 0);
  }

  /** Horizontal outward direction of an axis on its current edge. */
  outward(axis: AxisId): THREE.Vector3 {
    if (axis === 'lum') return new THREE.Vector3(0, 0, this.edges.lumFront ? 1 : -1);
    if (axis === 'gray') return new THREE.Vector3(this.edges.grayLeft ? -1 : 1, 0, 0);
    if (axis === 'caption') return new THREE.Vector3(0, 0, -1);
    return new THREE.Vector3(0, 0, 0);
  }

  setStyle(pxScale: number, opacity: { lines: number; grid: number; value: number }) {
    this.lineMat.linewidth = 1.25 * pxScale;
    this.gridMat.linewidth = 1 * pxScale;
    this.valueMat.linewidth = 1.25 * pxScale;
    this.lineMat.opacity = opacity.lines;
    this.gridMat.opacity = opacity.grid;
    this.valueMat.opacity = opacity.value;
    this.lineMat.visible = opacity.lines > 0.003;
    this.gridMat.visible = opacity.grid > 0.003;
    this.valueMat.visible = opacity.value > 0.003;
  }

  dispose() {
    for (const o of this.objects) o.geometry.dispose();
    this.lineMat.dispose();
    this.gridMat.dispose();
    this.valueMat.dispose();
  }
}
