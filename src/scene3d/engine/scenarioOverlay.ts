/**
 * Top-view outlines of the scenario-reference rectangles (docs/adr/0009 addendum): per panel the
 * 夜间 / 室内 / 户外 rectangles (level luminance × gray) clipped to the panel's plate, drawn as
 * screen-space lines — a dark halo under a light dashed core, so they read over every colormap tone
 * and never look like the (dark, solid) contour lines — with a small "夜间 30%" label inside the
 * top-left corner. A lightweight line overlay: it only exists in the flat top view (the engine fades
 * it with the flattening, like the interpolation marks) and is off by default (overlays.scenarios).
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { logNits } from '../../data/grid';
import { SCENARIO_IDS, weightShares, type ScenarioConfig, type ScenarioId } from '../../data/scenarios';
import type { PanelModel, SceneModel } from './model';
import { SX } from './model';
import { TextCache, type TextStyle } from './text';

export const SCENARIO_LABEL_STYLE: TextStyle = { size: 11, weight: 600, color: '#f3f5f8', halo: 'rgba(8,10,14,0.9)', haloWidth: 2.2 };

/** A scenario rectangle in world x / z (x0 < x1, z0 < z1: z0 = back = high gray), clipped to the plate. */
export interface ScenarioOutline {
  id: ScenarioId;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * World rectangles of the scenarios inside a panel's plate (same mapping as the cells:
 * x = log10(nits + 1) · SX, z = −gray · sz); scenarios entirely outside the plate are left out.
 */
export function scenarioOutlines(panel: PanelModel, sz: number, config: ScenarioConfig): ScenarioOutline[] {
  const { view, xs, zs, rect } = panel;
  if (!view.x.length || !view.grays.length) return [];
  const wx = (nits: number) => xs[0] + (logNits(nits) - view.x[0]) * SX;
  const wz = (gray: number) => zs[0] - (gray - view.grays[0]) * sz;
  const out: ScenarioOutline[] = [];
  for (const id of SCENARIO_IDS) {
    const s = config[id];
    const x0 = Math.max(rect.x0, wx(s.nitsMin));
    const x1 = Math.min(rect.x1, wx(s.nitsMax));
    const z0 = Math.max(rect.z0, wz(s.grayMax));
    const z1 = Math.min(rect.z1, wz(s.grayMin));
    if (x1 - x0 > 1e-6 && z1 - z0 > 1e-6) out.push({ id, x0, x1, z0, z1 });
  }
  return out;
}

/** The outlines + labels of one panel (world objects, y just above the flat terrain). */
export class ScenarioOverlay {
  readonly group = new THREE.Group();
  private readonly halo: LineSegments2 | null = null;
  private readonly core: LineSegments2 | null = null;
  private readonly haloMat = new LineMaterial({ color: 0x07090d, linewidth: 3.6, transparent: true, depthTest: false, depthWrite: false, worldUnits: false });
  private readonly coreMat: LineMaterial;
  private readonly sprites: THREE.Sprite[] = [];
  private readonly cache = new TextCache();

  /**
   * `worldPerCssPx`: world units per CSS px in the top-view fit (labels / dashes are sized in CSS
   * px there); `pxScale`: device px per CSS px; `label(id)`: the scenario name.
   */
  constructor(panel: PanelModel, model: SceneModel, config: ScenarioConfig, label: (id: ScenarioId) => string, worldPerCssPx: number, pxScale: number) {
    const dash = 5 * worldPerCssPx;
    this.coreMat = new LineMaterial({
      color: 0xf3f5f8,
      linewidth: 1.5,
      dashed: true,
      dashSize: dash,
      gapSize: dash * 0.7,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      worldUnits: false,
    });
    const rects = scenarioOutlines(panel, model.sz, config);
    const pos: number[] = [];
    for (const r of rects) {
      // four edges, each its own segment (dashes restart per edge: corners stay marked)
      pos.push(r.x0, 0, r.z0, r.x1, 0, r.z0, r.x1, 0, r.z0, r.x1, 0, r.z1, r.x1, 0, r.z1, r.x0, 0, r.z1, r.x0, 0, r.z1, r.x0, 0, r.z0);
    }
    if (pos.length) {
      const mk = (mat: LineMaterial, order: number) => {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const line = new LineSegments2(geo, mat);
        line.computeLineDistances();
        line.frustumCulled = false;
        line.renderOrder = order;
        this.group.add(line);
        return line;
      };
      this.halo = mk(this.haloMat, 8);
      this.core = mk(this.coreMat, 9);
    }
    // Labels: "夜间 30%" inside the top-left corner. A rectangle narrower than its label (the
    // outdoor band at the plate's right edge) gets it just under its bottom edge, right-aligned
    // (above its top edge when the rectangle reaches the plate's bottom), so it never runs into
    // the neighbouring rectangle's label.
    const shares = weightShares(config);
    const k = worldPerCssPx / (pxScale * 2);
    const pad = 4 * worldPerCssPx;
    const plate = panel.rect;
    for (const r of rects) {
      const tt = this.cache.get(`${label(r.id)} ${Math.round(shares[r.id] * 100)}%`, SCENARIO_LABEL_STYLE, pxScale * 2);
      const mat = new THREE.SpriteMaterial({ map: tt.texture, transparent: true, depthTest: false, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      const w = tt.w * k;
      const h = tt.h * k;
      sp.scale.set(w, h, 1);
      if (w + 2 * pad <= r.x1 - r.x0) sp.position.set(r.x0 + pad + w / 2, 0, r.z0 + pad + h / 2);
      else {
        const x = Math.max(plate.x0 + w / 2, r.x1 - pad - w / 2);
        const below = r.z1 + pad * 0.5 + h / 2;
        const above = r.z0 - pad * 0.5 - h / 2;
        const z = below + h / 2 <= plate.z1 ? below : above - h / 2 >= plate.z0 ? above : r.z0 + pad + h / 2;
        sp.position.set(x, 0, z);
      }
      sp.renderOrder = 10;
      this.sprites.push(sp);
      this.group.add(sp);
    }
    this.group.visible = false;
  }

  /** Overall opacity (0 hides everything); `pxScale` scales the screen-space line widths. */
  setStyle(opacity: number, pxScale: number) {
    const on = opacity > 0.003;
    this.group.visible = on;
    if (!on) return;
    this.haloMat.opacity = 0.55 * opacity;
    this.haloMat.linewidth = 3.6 * pxScale;
    this.coreMat.opacity = 0.95 * opacity;
    this.coreMat.linewidth = 1.5 * pxScale;
    for (const sp of this.sprites) (sp.material as THREE.SpriteMaterial).opacity = opacity;
  }

  dispose() {
    this.group.removeFromParent();
    this.halo?.geometry.dispose();
    this.core?.geometry.dispose();
    this.haloMat.dispose();
    this.coreMat.dispose();
    for (const sp of this.sprites) (sp.material as THREE.SpriteMaterial).dispose();
    this.cache.clear();
  }
}
