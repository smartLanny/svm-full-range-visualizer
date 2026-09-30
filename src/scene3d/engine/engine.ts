/**
 * Imperative 3D engine for the terrain view. React only feeds it settings and viewport changes;
 * every frame is computed here from a FrameParams (static transitions or the intro timeline) and
 * applied through uniforms / instance matrices / camera — no React state per frame.
 */
import * as THREE from 'three';
import type { Lang, LightingMode, Representation, SceneLayout, SvmRecord, ViewPreset } from '../../types';
import { ColormapType, MAX_COMPARE_PANELS, PANEL_LETTERS } from '../../types';
import type { Overlays } from '../../store/appStore';
import { deviceLabel, modeLabel, recordLabel } from '../../data/records';
import { translate } from '../../i18n';
import type { Timeline } from '../../timeline/timeline';
import { applyPose, clonePose, copyPose, fitPose, lerpPose, PERSP_TAN, poseBasis, type CamPose, type Insets, type Viewport } from './camera';
import { gridView, bracket } from '../../data/grid';
import type { AnomalyKind } from '../../data/anomalies';
import { buildModel, cellAt, setModelHeightCap, SY, type ModelResult, type PanelId, type PanelModel, type SceneModel } from './model';
import { makeFloorMaterial, makeNoDataMaterial, makeTerrainMaterial, PLATE_COLOR, setTerrainColormap, type ColorSpec, type NoDataMaterial, type TerrainUniforms } from './materials';
import { PanelContent } from './terrain';
import { Axes, CAPTION_STYLE, type AxisLabelSpec } from './axes';
import { captionLineHeight, drawCaptionTexture, drawColorbarTexture, drawTitleTexture, HUD_SUBTITLE_STYLE, HUD_TITLE_STYLE, Hud, SUBTITLE_LINE, TITLE_LINE, type ColorbarSpec, type Rect } from './hud';
import { measureText, TextCache, type TextTexture } from './text';
import { chooseValueFont, drawValuesTexture, measureValueCells } from './values';
import {
  approxCellAspect,
  depthScaleFor,
  fillDepthScale,
  gridFor,
  gridPlotSize,
  presetFit,
  regionAt,
  SINGLE_GRID,
  splitCells,
  viewOffsetFor,
  type Cell,
  type CellLayout,
  type GridMetrics,
  type GridShape,
} from './cells';
import { captionLines, commonPrefixLength, titleLines, wrapParts } from './fitText';
import { easeInOutCubic, smoothstep, Tween } from './easing';
import { makeFrameParams, type FrameParams } from './frame';
import { DEFAULT_PHI, DEFAULT_THETA, ViewControls, defaultUserView, type UserView } from './controls';
import { IntroPlan, INTRO_DURATION } from './intro';

export interface EngineSettings {
  lang: Lang;
  a: SvmRecord | null;
  b: SvmRecord | null;
  /** Side-by-side panels C–F after A and B (docs/adr/0002); the other layouts ignore them. */
  extras?: SvmRecord[];
  clipLowGray: boolean;
  maxNits: number | null;
  representation: Representation;
  view: ViewPreset;
  layout: SceneLayout;
  colormap: ColormapType;
  lighting: LightingMode;
  heightScale: number;
  heightCap: number;
  colorMax: number;
  overlays: Overlays;
  background: string;
  /**
   * Presentation: CSS px from the left edge the in-canvas title must keep clear (the exit button
   * sits there, see appStore.presentSafeLeft); 0 otherwise. Ignored in exports.
   */
  safeLeft?: number;
}

/**
 * What an export renders instead of the scene on screen (docs/adr/0010, addendum "export
 * contents"): applied in beginExport(), removed in endExport(). The store and the on-screen state
 * are never changed; a view preset is rendered at its default pose (the user's zoom / pan / orbit
 * belong to the screen).
 */
export interface ExportScene {
  layout?: SceneLayout;
  view?: ViewPreset;
}

/** The export scene applied to the on-screen settings. */
export function exportSettings(s: EngineSettings, scene: ExportScene | null): EngineSettings {
  if (!scene) return s;
  return { ...s, layout: scene.layout ?? s.layout, view: scene.view ?? s.view };
}

export interface HoverInfo {
  panel: PanelId;
  label: string;
  gray: number;
  percent: number;
  levelNits: number;
  nits: number | null;
  /** SVM / ΔSVM; null for a cell without valid data (see `missing`). */
  value: number | null;
  capped: boolean;
  kind: 'svm' | 'diff';
  a?: number | null;
  b?: number | null;
  /** svm: colorMax; diff: symmetric color range. */
  range: number;
  /**
   * Cell without valid data (docs/adr/0012): the exclusion rule when the raw point was excluded
   * (looked up in record.excluded by gray + brightness %), else null = never measured / out of
   * range. `who` names the record for a difference map.
   */
  missing?: { reason: AnomalyKind | null; who?: 'A' | 'B'; raw?: { nits: number; svm: number } };
  key: string;
}

/** Background colors that make the 3D view "pure black" (presentation, docs C3). */
const isPureBlack = (css: string) => /^#0{3}(0{3})?$/i.test(css.trim());

const CAM_DUR = 0.85;
/** HUD margin to the frame edge (CSS px). */
const HUD_MARGIN = 20;
const FADE_DUR = 0.4;
const SNAP_DUR = 0.45;
/**
 * Live start / replay of the intro: dissolve from the frame on screen into the intro (the empty
 * plate at t = 0) instead of cutting to it. Longer and gentler (smoothstep) than the other
 * crossfades: it replaces the whole picture, and the change per frame stays even.
 */
const INTRO_SNAP_DUR = 0.8;
/** An intro time jump back by more than this while playing (restart, loop) dissolves too (s). */
const INTRO_REPLAY_JUMP = 0.5;
const smoothstep01 = (p: number) => p * p * (3 - 2 * p);

const PRESET_ORIENT: Record<Exclude<ViewPreset, 'perspective'>, { theta: number; phi: number }> = {
  top: { theta: 0, phi: 0 },
  front: { theta: 0, phi: Math.PI / 2 },
  side: { theta: Math.PI / 2, phi: Math.PI / 2 },
};

/** Side-by-side cells: room right of a panel's plot (the next column's left gutter follows), CSS px. */
const CELL_PAD = 24;
/** Several rows of cells: band under each plot for its luminance axis labels, CSS px. */
const LUM_BAND = 62;
/**
 * Grids of 3–6 panels (small multiples): axis titles only on the outer panels (luminance title on
 * the last row, gray title on the first panel of each row), so the band under an inner row holds
 * just its tick labels, CSS px.
 */
const LUM_BAND_GRID = 34;
/** Several rows of cells: extra room between a plot's axis labels and the next row's captions, CSS px. */
const STACK_PAD = 12;

/** Same records in the same order (side-by-side extras). */
const sameRecords = (p: readonly SvmRecord[] = [], q: readonly SvmRecord[] = []) => p.length === q.length && p.every((r, i) => r === q[i]);

/**
 * One rendered view: a cell of the frame with its own camera and axes. Single / difference: one
 * view over the whole frame; side-by-side: one per panel (docs/adr/0002), congruent cameras.
 */
interface ViewSlot {
  /** Indices into panels / model.panels. */
  panels: number[];
  axes: Axes;
  /** World translation of this view's camera relative to view 0 (its panel's offset). */
  shift: THREE.Vector3;
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  cam: THREE.Camera;
  /** Plate bounds (world) of the view's panels (floor glow, occlusion tests). */
  bounds: { x0: number; x1: number; z0: number; z1: number };
}

let clockOverride: number | null = null;
const now = () => clockOverride ?? performance.now() / 1000;
/** Visual tests: freeze the wall clock driving static transitions (seconds), or null to release. */
export function setDebugClock(t: number | null) {
  clockOverride = t;
}

export class Engine {
  gl: THREE.WebGLRenderer | null = null;
  readonly scene = new THREE.Scene();
  private readonly floorScene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly perspCam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  private activeCam: THREE.Camera = this.perspCam;
  readonly hud = new Hud();
  private readonly text = new TextCache();
  readonly controls: ViewControls;

  settings: EngineSettings | null = null;
  model: SceneModel | null = null;
  modelResult: ModelResult | null = null;
  private modelKey = '';
  private panels: PanelContent[] = [];
  /** Views of the current model (see ViewSlot); view 0 owns the main camera pose. */
  private views: ViewSlot[] = [];
  private readonly mats: {
    surface: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    walls: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    bars: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    plate: THREE.MeshBasicMaterial;
    noData: NoDataMaterial;
  };
  private colorKey = '';
  private readonly floor: THREE.Mesh;
  private readonly floorMat: THREE.ShaderMaterial;
  private readonly hover: THREE.Line;

  // viewport (drawing-buffer px) and CSS px scale
  vp: Viewport = { width: 2, height: 2 };
  cssW = 2;
  cssH = 2;
  pxScale = 1;
  private fits = new Map<string, CamPose>();
  private contourKey = '';
  private valuesKey = '';
  private titleTex: { key: string; tt: TextTexture & { inset: number } } | null = null;
  private colorbarTex: { key: string; tt: TextTexture & { inset: number } } | null = null;

  // static state
  preset: ViewPreset = 'perspective';
  /** Static camera move; `clip` = it started while the plot was clipped (zoomed / panned). */
  private camTransition: { from: CamPose; t0: number; dur: number; clip?: boolean } | null = null;
  private readonly tw = {
    heightK: new Tween(1),
    /** Vertical exaggeration of the elevation views (front / side). */
    elev: new Tween(1),
    values: new Tween(0),
    contours: new Tween(1),
    axes: new Tween(1),
    captions: new Tween(0),
    title: new Tween(1),
    colorbar: new Tween(1),
  };
  private readonly frame: FrameParams = makeFrameParams();
  private lastPose: CamPose = makeFrameParams().pose;
  private hasRendered = false;
  private lastTime = now();

  // snapshot crossfade (any discontinuous static change, live intro start)
  /**
   * Pixels of the last presented frame, copied from the canvas itself (same multisampling,
   * blending and color encoding as the screen), so the first crossfade frame equals it exactly.
   */
  private snapTex: THREE.FramebufferTexture | null = null;
  private snapT0 = -1;
  private snapDur = SNAP_DUR;
  private snapEase: (p: number) => number = easeInOutCubic;
  private readonly snapScene = new THREE.Scene();
  private readonly snapQuad: THREE.Mesh;
  private readonly snapMat: THREE.ShaderMaterial;
  private readonly snapBuf = new THREE.Vector2();
  /** On-screen frames presented so far; `snapOf` = the one the snapshot holds. */
  private presented = 0;
  private snapOf = -1;
  /** The last frame drawn on the canvas was an on-screen frame (not an export frame). */
  private lastFrameOnScreen = false;
  /** Intro time of the last presented intro frame (replay detection). */
  private lastIntroT = 0;

  // intro
  private intro: { tl: Timeline; plan: IntroPlan | null; planKey: string } | null = null;
  private introDriving = false;
  /** The frame being rendered is an intro frame (on screen or exported). */
  private introFrame = false;

  // export
  exporting = false;
  private exportSaved: { vp: Viewport; cssW: number; cssH: number; pxScale: number; dpr: number } | null = null;
  /** Export scene in effect (see ExportScene); `settings` then holds exportSettings(screenSettings). */
  private exportScene: ExportScene | null = null;
  /** The on-screen settings while an export scene is applied (store updates keep arriving here). */
  private screenSettings: EngineSettings | null = null;
  /** On-screen camera state to put back after an export scene (preset + the user's view). */
  private exportRestore: { preset: ViewPreset; view: UserView } | null = null;
  /** The model was rebuilt while exporting (React is told once, after the export). */
  private exportRebuilt = false;
  /**
   * endExport() is putting the screen state back: layout / metrics are the screen's again (not the
   * export frame's), but nothing animates or cross-fades — the view returns exactly as it was.
   */
  private restoring = false;
  /** No cross-fades, camera moves or React notifications (export frames and their restore). */
  private get quiet() {
    return this.exporting || this.restoring;
  }

  hoverCell: { panel: number; r: number; c: number } | null = null;
  /** Export of the intro while another layout is shown renders a single-layout model. */
  private layoutOverride: SceneLayout | null = null;
  private frameCount = 0;

  /** Request a render (R3F invalidate). */
  invalidate: () => void = () => {};
  /** Model / empty-state changes (React overlay). */
  onModel: (res: ModelResult) => void = () => {};
  /** The intro reached its end: apply the end state to the store (called while still driving). */
  onIntroEnd: () => void = () => {};

  constructor() {
    this.scene.add(this.world);
    const spec: ColorSpec = { kind: 'svm', colormap: ColormapType.RD_YL_BU_ENHANCED };
    this.mats = {
      surface: makeTerrainMaterial(spec),
      walls: makeTerrainMaterial(spec, 0.82),
      bars: makeTerrainMaterial(spec),
      plate: new THREE.MeshBasicMaterial({ color: PLATE_COLOR, transparent: true, depthWrite: true }),
      noData: makeNoDataMaterial(),
    };
    this.mats.walls.side = THREE.DoubleSide;
    // The "no data" floor lies on the plate: pulled forward in depth so it never z-fights it.
    this.mats.noData.polygonOffset = true;
    this.mats.noData.polygonOffsetFactor = -1;
    this.mats.noData.polygonOffsetUnits = -4;
    this.floorMat = makeFloorMaterial();
    const floorGeo = new THREE.PlaneGeometry(1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(floorGeo, this.floorMat);
    this.floor.renderOrder = -1;
    this.floor.frustumCulled = false;
    // Own pass, drawn first and never clipped to the plot (its soft glow has no edge to cut).
    this.floorScene.add(this.floor);

    const hoverGeo = new THREE.BufferGeometry();
    hoverGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(15), 3));
    this.hover = new THREE.Line(hoverGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false }));
    this.hover.renderOrder = 20;
    this.hover.visible = false;
    this.hover.frustumCulled = false;

    // The copied canvas pixels are already display-encoded: written back unchanged (no color-space
    // conversion, nearest texels over the whole viewport), so at full opacity the quad reproduces
    // the presented frame exactly.
    this.snapMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, opacity: { value: 1 } },
      vertexShader: 'varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
      fragmentShader: 'uniform sampler2D map;\nuniform float opacity;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = vec4(texture2D(map, vUv).rgb, opacity);\n}',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.snapQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.snapMat);
    this.snapQuad.frustumCulled = false;
    this.snapScene.add(this.snapQuad);

    this.controls = new ViewControls({
      getFrame: () => ({
        theta: this.lastPose.theta,
        phi: this.lastPose.phi,
        h: this.lastPose.h,
        fitH: this.currentFit().h,
        // Poses are fitted in a view's cell (the whole frame unless side-by-side).
        widthCss: this.model ? this.cellVp().width / this.pxScale : this.cssW,
        heightCss: this.model ? this.cellVp().height / this.pxScale : this.cssH,
        ortho: this.preset !== 'perspective',
      }),
      localNdc: (ndc) => {
        if (!this.model) return ndc;
        const lay = this.cellLayout();
        const px = ((ndc.x + 1) / 2) * this.vp.width;
        const py = ((ndc.y + 1) / 2) * this.vp.height;
        const c = lay.cells[regionAt(lay.regions, px, py)] ?? lay.cells[0];
        return { x: ((px - c.x) / c.w) * 2 - 1, y: ((py - c.y) / c.h) * 2 - 1 };
      },
      canInteract: () => !this.introDriving && !this.exporting && !this.camTransition && !!this.model,
      onChange: () => this.invalidate(),
      onDoubleClick: () => this.fitView(),
      onUserStart: () => this.invalidate(),
    });
  }

  // ------------------------------------------------------------------ lifecycle

  attach(gl: THREE.WebGLRenderer) {
    this.gl = gl;
    this.controls.attach(gl.domElement);
  }

  detach() {
    this.controls.detach();
    this.disposeSnapshot();
    this.gl = null;
  }

  /**
   * Free GPU resources and forget the model. The engine stays usable (React StrictMode re-runs
   * effects): the next sync() rebuilds everything. The canvas attachment is managed by attach/detach.
   */
  dispose() {
    this.clearContent();
    this.settings = null;
    this.modelKey = '';
    this.colorKey = '';
    this.model = null;
    this.hasRendered = false;
    this.disposeSnapshot();
    Object.values(this.mats).forEach((m) => m.dispose());
    this.floorMat.dispose();
    this.floor.geometry.dispose();
    this.hud.dispose();
    this.text.clear();
    this.titleTex?.tt.texture.dispose();
    this.colorbarTex?.tt.texture.dispose();
  }

  /** Fonts finished loading: redraw all text textures. */
  refreshText() {
    this.text.clear();
    this.gridCache.clear();
    for (const t of this.captionTex.values()) t.texture.dispose();
    this.captionTex.clear();
    this.captionCache = null;
    this.titleLinesCache = null;
    this.clearFits();
    this.titleTex?.tt.texture.dispose();
    this.titleTex = null;
    this.colorbarTex?.tt.texture.dispose();
    this.colorbarTex = null;
    this.contourKey = '';
    this.valuesKey = '';
    // Caption widths (and so the side-by-side grid) were measured with the fallback font.
    this.refreshModelForViewport();
    this.invalidate();
  }

  // ------------------------------------------------------------------ settings

  setViewport(cssW: number, cssH: number, dpr: number) {
    if (this.exporting) {
      this.exportSaved = this.exportSaved ? { ...this.exportSaved, cssW, cssH, dpr, vp: { width: Math.round(cssW * dpr), height: Math.round(cssH * dpr) }, pxScale: dpr } : null;
      return;
    }
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    if (w === this.vp.width && h === this.vp.height && dpr === this.pxScale) return;
    this.vp = { width: w, height: h };
    this.cssW = Math.max(2, cssW);
    this.cssH = Math.max(2, cssH);
    this.pxScale = dpr;
    this.onViewportChanged();
  }

  private onViewportChanged() {
    this.clearFits();
    this.hud.resize(this.vp.width, this.vp.height);
    if (this.intro) this.intro.planKey = '';
    this.refreshModelForViewport();
    this.invalidate();
  }

  /**
   * Depth stretch of the gray axis for the cell shape of a layout (the frame, or one panel's cell
   * side by side): 1 for landscape / square, deeper for narrow cells (9:16 → 1.5) so the plate, the
   * terrain and the heatmap fill a tall cell instead of a thin band. Quantised, so resizing only
   * rebuilds the scene at a few thresholds.
   */
  private depthScale(s: EngineSettings | null, layout: SceneLayout): number {
    const n = this.panelsFor(s, layout);
    const g = this.gridOf(n, s);
    // Grids of 3–6 panels: deepen the plate to fill the (nominal) plot area of a cell.
    if (n >= 3) {
      const m = this.gridMetrics(n, g, s);
      return fillDepthScale(gridPlotSize(this.vp, m.ins, g, m.opt));
    }
    return depthScaleFor(approxCellAspect(g, this.vp.width / Math.max(1, this.vp.height)));
  }

  /** Panels a layout shows side by side (A, B + extras, ≤ 6); 1 = a single view. */
  private panelsFor(s: EngineSettings | null, layout: SceneLayout): number {
    if (layout !== 'sideBySide' || !s) return 1;
    return Math.min(MAX_COMPARE_PANELS, 2 + (s.extras?.length ?? 0));
  }

  /** Panels of the current model's views (side by side: one view each). */
  private viewPanels(): number {
    const m = this.model;
    if (m) return m.layout === 'sideBySide' ? m.panels.length : 1;
    return this.panelsFor(this.settings, this.layoutOverride ?? this.settings?.layout ?? 'single');
  }

  /**
   * Grid of n side-by-side views in the current frame (cells.ts gridFor), chosen from nominal
   * insets (the exact ones depend on the captions, which depend on the grid).
   */
  private gridOf(n: number, s: EngineSettings | null = this.settings): GridShape {
    if (n <= 1) return SINGLE_GRID;
    const key = this.gridMetricsKey(n, s);
    const hit = this.gridCache.get(key);
    if (hit) return hit;
    const g = gridFor(n, this.vp, (c) => this.gridMetrics(n, c, s));
    if (this.gridCache.size > 32) this.gridCache.clear();
    this.gridCache.set(key, g);
    return g;
  }
  private readonly gridCache = new Map<string, GridShape>();

  private gridMetricsKey(n: number, s: EngineSettings | null): string {
    const ov = s?.overlays;
    const ids = [s?.a?.id, s?.b?.id, ...(s?.extras ?? []).map((r) => r.id)].slice(0, n).join(',');
    return `${n}|${this.vp.width}x${this.vp.height}|${this.pxScale}|${ov?.title}|${ov?.colorbar}|${this.exporting ? 0 : this.uiInset}|${s?.lang}|${ids}`;
  }

  /**
   * Nominal frame insets and cell bands (px) of a candidate grid, for choosing the grid and the
   * plate depth before the model exists: a typical title / colorbar / axis band, the floating
   * controls, and the caption band the panels' captions would need in cells of that width (one
   * line, or two when a caption does not fit).
   */
  private gridMetrics(n: number, g: GridShape, s: EngineSettings | null): GridMetrics {
    const S = this.pxScale;
    const ov = s?.overlays;
    const cb = ov?.colorbar ?? true;
    const portrait = this.portrait;
    const right = (cb && !portrait ? 110 : 30) * S;
    const pad = CELL_PAD * S;
    const recs = s ? [s.a, s.b, ...(s.extras ?? [])].slice(0, n) : [];
    const capW = (g.cols > 1 ? (this.vp.width - right + pad) / g.cols : this.vp.width) - 8 * S;
    const twoLines = recs.some((r, i) => {
      if (!r || !s) return false;
      const mode = modeLabel(r, s.lang);
      const one = `${PANEL_LETTERS[i]} · ${deviceLabel(r, s.lang)}${mode ? ` · ${mode}` : ''}`;
      return measureText(one, CAPTION_STYLE, S) > capW;
    });
    const cap = 26 + (twoLines ? captionLineHeight(CAPTION_STYLE.size) : 0) + (g.rows > 1 ? STACK_PAD : 0);
    return {
      ins: {
        top: (((ov?.title ?? true) ? 84 : 30) + cap) * S,
        right,
        bottom: (62 + (cb && portrait ? this.portraitColorbarRoom(n) : 0) + (this.exporting ? 0 : this.uiInset)) * S,
        left: 70 * S,
      },
      opt: { pad, capBand: cap * S, lumBand: (n >= 3 ? LUM_BAND_GRID : LUM_BAND) * S },
    };
  }

  /**
   * Portrait frames: room under the plot's axis band for the horizontal colorbar (CSS px). Grids of
   * 3–6 panels fill their cells (no centering slack below the plot), so they reserve the colorbar's
   * full height; single / two-panel frames keep their layout.
   */
  private portraitColorbarRoom(n: number): number {
    return n >= 3 ? 80 : 64;
  }

  /** Grid of the current model's views. */
  private grid(): GridShape {
    return this.gridOf(this.viewPanels());
  }

  /** Approximate aspect of one view's cell (before HUD insets): drives plate depth / orientation. */
  private cellAspect(): number {
    return approxCellAspect(this.grid(), this.vp.width / Math.max(1, this.vp.height));
  }

  /**
   * Model identity. Height cap and color max are not part of it: they only change heights /
   * uniforms / textures and are applied in place (a slider drag never rebuilds or cross-fades).
   */
  private modelKeyFor(s: EngineSettings): string {
    const layout = this.layoutOverride ?? s.layout;
    const extras = layout === 'sideBySide' ? (s.extras ?? []).map((r) => r.id).join(',') : '';
    const g = this.gridOf(this.panelsFor(s, layout), s);
    return [layout, s.a?.id, s.b?.id, extras, s.clipLowGray, s.maxNits, s.lang, this.depthScale(s, layout), `${g.cols}x${g.rows}`].join('|');
  }

  /** The frame shape changed the model (portrait depth): rebuild, cross-fading on screen. */
  private refreshModelForViewport() {
    const s = this.settings;
    if (!s) return;
    const key = this.modelKeyFor(s);
    if (key === this.modelKey) return;
    if (this.hasRendered && !this.introDriving && !this.quiet) this.captureSnapshot();
    this.modelKey = key;
    this.rebuildModel();
  }

  sync(input: EngineSettings) {
    // An export scene is in effect: the screen's settings are kept for endExport(), the export
    // renders them with the scene's layout / view.
    if (this.exportScene) this.screenSettings = input;
    const s = exportSettings(input, this.exportScene);
    const prev = this.settings;
    const t = now();
    const modelKey = this.modelKeyFor(s);
    const recordsChanged =
      !prev || prev.a !== s.a || prev.b !== s.b || ((this.layoutOverride ?? s.layout) === 'sideBySide' && !sameRecords(prev.extras, s.extras));
    const needModel = modelKey !== this.modelKey || recordsChanged;
    const animate = !!prev && this.hasRendered && !this.introDriving && !this.quiet;
    const visualChange =
      !!prev &&
      (needModel || prev.representation !== s.representation || prev.colormap !== s.colormap || prev.lighting !== s.lighting || prev.lang !== s.lang);
    // Freeze the current image with the OLD settings; it cross-fades out over the new one.
    if (visualChange && animate) this.captureSnapshot();
    this.settings = s;

    if (needModel) {
      this.modelKey = modelKey;
      this.rebuildModel();
    } else if (this.model) {
      if (this.model.kind === 'svm') this.model.colorMax = Math.max(0.1, s.colorMax);
      if (prev && prev.heightCap !== s.heightCap) this.applyHeightCap(animate);
    }
    const colorKey = `${this.model?.kind ?? 'svm'}|${s.colormap}`;
    if (colorKey !== this.colorKey) {
      this.colorKey = colorKey;
      const spec: ColorSpec = this.model?.kind === 'diff' ? { kind: 'diff' } : { kind: 'svm', colormap: s.colormap };
      setTerrainColormap(this.mats.surface, spec);
      setTerrainColormap(this.mats.walls, spec);
      setTerrainColormap(this.mats.bars, spec);
      this.valuesKey = '';
    }
    if (!prev || prev.colorMax !== s.colorMax) this.valuesKey = '';

    // View preset change -> continuous camera move + height flatten.
    if (!prev || prev.view !== s.view) this.setPreset(s.view, !animate);
    const flatTarget = s.view === 'top' ? 0 : 1;
    if (!prev || prev.view !== s.view) {
      if (!animate) this.tw.heightK.jump(flatTarget);
      else this.tw.heightK.set(flatTarget, t, CAM_DUR);
      // The vertical exaggeration of front / side eases in with the same camera move.
      const elev = this.elevFor(s.view);
      if (!animate) this.tw.elev.jump(elev);
      else this.tw.elev.set(elev, t, CAM_DUR);
    }
    const ov = s.overlays;
    const fade = (tw: Tween, v: number) => (animate ? tw.set(v, t, FADE_DUR) : tw.jump(v));
    fade(this.tw.values, ov.values && s.view === 'top' ? 1 : 0);
    fade(this.tw.contours, ov.contours ? 1 : 0);
    fade(this.tw.axes, ov.axes ? 1 : 0);
    fade(this.tw.title, ov.title ? 1 : 0);
    fade(this.tw.colorbar, ov.colorbar ? 1 : 0);
    fade(this.tw.captions, s.layout === 'sideBySide' && ov.axes ? 1 : 0);
    if (prev && (prev.heightScale !== s.heightScale || prev.overlays.title !== ov.title || prev.overlays.colorbar !== ov.colorbar)) this.clearFits();
    // The title moved clear of the presentation exit button: its width budget (and so its line
    // count, i.e. the title band) may change — re-frame smoothly.
    if (prev && (prev.safeLeft ?? 0) !== (s.safeLeft ?? 0)) {
      this.clearFits();
      if (animate && this.model) this.camTransition = { from: clonePose(this.lastPose), t0: t, dur: CAM_DUR * 0.6, clip: !!this.clip };
    }
    if (prev && prev.lang !== s.lang) this.contourKey = '';
    this.invalidate();
  }

  private setPreset(view: ViewPreset, immediate: boolean) {
    const from = clonePose(this.lastPose);
    this.preset = view;
    this.controls.reset(defaultUserView());
    if (immediate) this.camTransition = null;
    else this.camTransition = { from, t0: now(), dur: CAM_DUR, clip: !!this.clip };
    this.invalidate();
  }

  /** Reset zoom / pan / orbit of the current preset with a smooth move. */
  fitView() {
    if (!this.model) return;
    this.camTransition = { from: clonePose(this.lastPose), t0: now(), dur: CAM_DUR * 0.8, clip: !!this.clip };
    this.controls.reset(defaultUserView());
    this.invalidate();
  }

  zoomBy(steps: number) {
    if (this.introDriving || this.camTransition) return;
    this.controls.zoomBy(steps);
    this.invalidate();
  }

  // ------------------------------------------------------------------ model / content

  private clearContent() {
    for (const p of this.panels) {
      this.world.remove(p.group);
      p.dispose();
    }
    this.panels = [];
    this.disposeAxes();
    this.views = [];
    this.hover.removeFromParent();
  }

  private disposeAxes() {
    for (const v of this.views) {
      this.world.remove(v.axes.group);
      v.axes.dispose();
    }
  }

  /**
   * Views of a model: one over the frame, or (side-by-side) one per panel, each with axes built
   * for its own panel. Existing cameras are reused (height-cap rebuilds of the axes).
   */
  private buildViews(m: SceneModel) {
    const old = this.views;
    const groups = m.layout === 'sideBySide' ? m.panels.map((_, i) => [i]) : [m.panels.map((_, i) => i)];
    this.views = groups.map((panels, vi) => {
      const sub: SceneModel = groups.length === 1 ? m : { ...m, panels: panels.map((i) => m.panels[i]), bounds: { ...m.panels[panels[0]].rect } };
      const axes = new Axes(sub, this.axisTexts());
      this.world.add(axes.group);
      const persp = old[vi]?.persp ?? (vi === 0 ? this.perspCam : new THREE.PerspectiveCamera(30, 1, 0.1, 1000));
      const ortho = old[vi]?.ortho ?? (vi === 0 ? this.orthoCam : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000));
      return {
        panels,
        axes,
        shift: new THREE.Vector3(m.panels[panels[0]].offsetX - m.panels[groups[0][0]].offsetX, 0, 0),
        persp,
        ortho,
        cam: old[vi]?.cam ?? persp,
        bounds: { ...sub.bounds },
      };
    });
  }

  private rebuildModel() {
    const s = this.settings!;
    this.clearContent();
    const layout = this.layoutOverride ?? s.layout;
    const res = buildModel({
      layout,
      a: s.a,
      b: s.b,
      extras: s.extras,
      clipLowGray: s.clipLowGray,
      maxNits: s.maxNits,
      colorMax: s.colorMax,
      heightCap: s.heightCap,
      depthScale: this.depthScale(s, layout),
    });
    this.modelResult = res;
    this.model = res.ok ? res.model : null;
    this.clearFits();
    this.contourKey = '';
    this.valuesKey = '';
    this.hoverCell = null;
    if (this.intro) this.intro.planKey = '';
    if (res.ok) {
      const m = res.model;
      for (const p of m.panels) {
        const pc = new PanelContent(p, m, this.mats);
        this.panels.push(pc);
        this.world.add(pc.group);
      }
      this.buildViews(m);
      this.panels[0]?.heightGroup.add(this.hover);
    }
    // Exports rebuild offscreen (layout overrides, export-size depth): the React overlay (empty
    // state, tooltip) must not follow them — it is told once, after the export (endExport).
    if (this.quiet) this.exportRebuilt = true;
    else this.onModel(res);
  }

  /** Height cap changed: update heights in place, re-frame smoothly (no rebuild, no crossfade). */
  private applyHeightCap(animate: boolean) {
    const m = this.model!;
    setModelHeightCap(m, this.settings!.heightCap);
    for (const pc of this.panels) pc.setHeightCap(m.heightCap, null);
    // The value axis ticks follow the plotted range.
    this.disposeAxes();
    this.buildViews(m);
    this.clearFits();
    if (this.intro) this.intro.planKey = '';
    if (animate) this.camTransition = { from: clonePose(this.lastPose), t0: now(), dur: CAM_DUR * 0.6, clip: !!this.clip };
  }

  private axisTexts() {
    const s = this.settings!;
    const t = (k: string) => translate(s.lang, k);
    const m = this.model!;
    return {
      lum: t('common.nitsLog'),
      gray: t('common.grayLevel'),
      value: m.kind === 'diff' ? 'ΔSVM' : 'SVM',
    };
  }

  /** Radius around the target that must stay between the near / far planes. */
  private sceneRadius() {
    const m = this.model;
    if (!m) return 20;
    const b = this.fitBounds();
    const hs = (this.settings?.heightScale ?? 1) * Math.max(1, this.frame.elev, this.tw.elev.target);
    const tall = Math.max(8, (m.plotMax - Math.min(0, m.plotMin)) * SY * hs * 1.2);
    return Math.hypot(b.x1 - b.x0, b.z1 - b.z0, tall) * 0.6 + 4;
  }

  // ------------------------------------------------------------------ framing

  private get portrait() {
    return this.vp.width / this.vp.height < 0.85;
  }

  /**
   * Insets (drawing-buffer px) of the plot's safe rect inside view 0's cell, used to fit the
   * camera: the frame insets (title band, colorbar, axis labels) for a single view; side-by-side
   * cells have their own (see cells.ts). Portrait frames center the group [title, plot(s),
   * colorbar] vertically: the slack a (width-limited) plot leaves is split above and below it, and
   * the title / colorbar follow the plot instead of the frame edges.
   */
  insets(preset: ViewPreset | 'intro-front'): Insets {
    return presetFit(this.cellLayout(), this.frameInsets('top'), this.frameInsets(preset));
  }

  /** Single-panel safe-rect insets of the whole frame, with the portrait centering shift. */
  private frameInsets(preset: ViewPreset | 'intro-front'): Insets {
    const ins = this.baseInsets(preset);
    if (!this.portrait) return ins;
    const shift = this.portraitShift();
    return { ...ins, top: ins.top + shift, bottom: ins.bottom + shift };
  }

  /**
   * The cells of the current frame, one per view. Laid out from the top-view insets so they do not
   * move between presets (a preset's few extra px go into its fit insets).
   */
  cellLayout(): CellLayout {
    const g = this.grid();
    const key = `${this.vp.width}x${this.vp.height}|${this.pxScale}|${this.uiInset}|${this.exporting}|${this.viewPanels()}|${g.cols}x${g.rows}`;
    if (this.cellCache?.key === key) return this.cellCache.layout;
    const layout = this.cellsFor(this.frameInsets('top'));
    this.cellCache = { key, layout };
    return layout;
  }
  private cellCache: { key: string; layout: CellLayout } | null = null;

  private cellsFor(ins: Insets): CellLayout {
    const S = this.pxScale;
    // Several rows: the caption band of a lower row also keeps the luminance axis title of the
    // row above clear of its captions.
    const grid = this.grid();
    const capBand = this.captionBand() + (grid.rows > 1 ? STACK_PAD : 0);
    const n = this.viewPanels();
    return splitCells(this.vp, ins, n, grid, { pad: CELL_PAD * S, capBand: capBand * S, lumBand: (n >= 3 ? LUM_BAND_GRID : LUM_BAND) * S });
  }

  /** Size of a view's cell: the viewport every camera pose is fitted in (all cells are congruent). */
  private cellVp(): Viewport {
    const c = this.cellLayout().cells[0];
    return { width: c.w, height: c.h };
  }

  /** Portrait: half the vertical slack the top-view plot(s) leave in the safe rect (px, ≥ 0). */
  private portraitShift(): number {
    if (!this.portrait || !this.model || !this.settings) return 0;
    if (this.shiftCache !== null) return this.shiftCache;
    const lay = this.cellsFor(this.baseInsets('top'));
    const cell = lay.cells[0];
    const fit = fitPose(this.boxPoints(true), 0, 0, 0, { width: cell.w, height: cell.h }, lay.fit);
    const b = this.fitBounds();
    const plotH = (b.z1 - b.z0) / (fit.h / cell.h);
    const contentH = cell.h - lay.fit.top - lay.fit.bottom;
    const rows = lay.rows;
    this.shiftCache = Math.max(0, (rows * (contentH - plotH)) / 2);
    return this.shiftCache;
  }
  private shiftCache: number | null = null;

  private clearFits() {
    this.fits.clear();
    this.shiftCache = null;
    this.cellCache = null;
    this.elevCache.clear();
  }

  private baseInsets(preset: ViewPreset | 'intro-front'): Insets {
    const s = this.settings;
    const S = this.pxScale;
    const portrait = this.portrait;
    const ov = s?.overlays;
    const title = ov?.title ?? true;
    const cb = ov?.colorbar ?? true;
    // Landscape: the plot keeps clear of the colorbar's visible width (wider for ΔSVM / the
    // "no data" chip), so the colorbar never overlaps the heatmap.
    const right = cb && !portrait ? this.rightInsetCss() : 30;
    const captions = this.model?.layout === 'sideBySide' ? this.captionBand() + (this.grid().rows > 1 ? STACK_PAD : 0) : 0;
    // A title wrapped to two lines (device / mode) pushes the plot down by one line.
    const tt = title ? this.titleText() : null;
    const titleExtra = tt ? (tt.lines.length - 1) * Math.ceil(TITLE_LINE) + Math.max(0, tt.subLines.length - 1) * Math.ceil(SUBTITLE_LINE) : 0;
    let top = (title ? 84 + titleExtra : 30) + captions;
    let bottom = 62 + (cb && portrait ? this.portraitColorbarRoom(this.viewPanels()) : 0);
    let left = 70;
    if (preset === 'perspective') {
      top += 6;
      bottom += 4;
    }
    if (preset === 'side' || preset === 'front') left += 6;
    // DOM controls floating over the canvas (timeline bar / viewport controls) — not in exports.
    if (!this.exporting) bottom += this.uiInset;
    return { top: top * S, right: right * S, bottom: bottom * S, left: left * S };
  }

  private uiInset = 0;
  private plateY = -0.012;
  /**
   * Plot clip rect of view 0 (px, origin bottom-left) while the terrain would run past the plot's
   * safe area (zoomed / panned): the terrain is cut there so it never runs under the title /
   * colorbar, and the axes are pinned to its edges. null = nothing to clip. Other views use the
   * same rect moved to their cell (their images are congruent).
   */
  private clip: Rect | null = null;

  /**
   * Reserve room (CSS px) at the bottom for DOM overlays so they never cover the plot or its axis
   * labels. Changes re-frame smoothly.
   */
  setUiInset(bottomCss: number) {
    if (bottomCss === this.uiInset) return;
    this.uiInset = bottomCss;
    this.clearFits();
    if (this.intro) this.intro.planKey = '';
    // The room left for the plots can change the side-by-side grid (and so the plate depth).
    this.refreshModelForViewport();
    if (this.hasRendered && !this.introDriving && !this.quiet && this.model) {
      this.camTransition = { from: clonePose(this.lastPose), t0: now(), dur: CAM_DUR * 0.7, clip: !!this.clip };
    }
    this.invalidate();
  }

  /**
   * Plate bounds the cameras frame: all panels of a single view; side-by-side: the union of the
   * panels moved into view 0's place (every view's camera is view 0's, moved by its panel offset).
   */
  private fitBounds(): { x0: number; x1: number; z0: number; z1: number } {
    const m = this.model!;
    if (m.layout !== 'sideBySide') return m.bounds;
    const ref = m.panels[0].offsetX;
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of m.panels) {
      const dx = p.offsetX - ref;
      b.x0 = Math.min(b.x0, p.rect.x0 - dx);
      b.x1 = Math.max(b.x1, p.rect.x1 - dx);
      b.z0 = Math.min(b.z0, p.rect.z0);
      b.z1 = Math.max(b.z1, p.rect.z1);
    }
    return b;
  }

  private boxPoints(flat: boolean, heightOnlyRow?: number, elev = 1): THREE.Vector3[] {
    const m = this.model!;
    const s = this.settings!;
    const scale = SY * s.heightScale * elev;
    const b = this.fitBounds();
    let yMax = flat ? 0 : Math.max(0.5, m.plotMax) * scale;
    const yMin = flat ? 0 : Math.min(0, m.plotMin) * scale;
    if (heightOnlyRow !== undefined) {
      const row = m.panels[0].values[heightOnlyRow] ?? [];
      yMax = Math.max(0.5, ...row.map((v) => (v === null ? 0 : Math.min(m.heightCap, v)))) * scale;
    }
    const pts: THREE.Vector3[] = [];
    for (const x of [b.x0, b.x1]) for (const z of [b.z0, b.z1]) for (const y of [yMin, yMax]) pts.push(new THREE.Vector3(x, y, z));
    return pts;
  }

  fitFor(preset: ViewPreset): CamPose {
    const key = `${preset}`;
    let f = this.fits.get(key);
    if (!f) {
      if (!this.model) return clonePose(this.lastPose);
      if (preset === 'perspective') {
        const o = this.perspOrientation(DEFAULT_THETA, DEFAULT_PHI);
        f = fitPose(this.boxPoints(false), o.theta, o.phi, PERSP_TAN, this.cellVp(), this.insets(preset));
      } else {
        const o = PRESET_ORIENT[preset];
        f = fitPose(this.boxPoints(preset === 'top', undefined, this.elevFor(preset)), o.theta, o.phi, 0, this.cellVp(), this.insets(preset));
      }
      this.fits.set(key, f);
    }
    return f;
  }

  /**
   * Perspective orientation for the user's (theta, phi) and the cell shape: portrait cells turn
   * the default view more frontal and steeper so the terrain uses the tall cell (the user's orbit
   * is kept as an offset from the landscape default).
   */
  private perspOrientation(theta: number, phi: number): { theta: number; phi: number } {
    const k = smoothstep(0.85, 0.56, this.cellAspect());
    return { theta: theta - 0.4 * k, phi: Math.min(1.5, Math.max(0.12, phi - 0.26 * k)) };
  }

  /**
   * Vertical exaggeration of an elevation view (front / side), so the profile fills ~50–60 % of
   * the plot height instead of a thin strip (the plate is much wider than the terrain is tall).
   * 1 for the other views; halves only (the subtitle states it); value axes keep true values.
   */
  elevFor(preset: ViewPreset): number {
    if ((preset !== 'front' && preset !== 'side') || !this.model || !this.settings) return 1;
    const hit = this.elevCache.get(preset);
    if (hit !== undefined) return hit;
    const m = this.model;
    const b = this.fitBounds();
    const ins = this.insets(preset);
    const cvp = this.cellVp();
    const sw = Math.max(20, cvp.width - ins.left - ins.right);
    const sh = Math.max(20, cvp.height - ins.top - ins.bottom);
    const span = preset === 'front' ? b.x1 - b.x0 : b.z1 - b.z0;
    const tall = Math.max(1e-3, (Math.max(0.5, m.plotMax) - Math.min(0, m.plotMin)) * SY * this.settings.heightScale);
    const raw = (0.62 * sh * span) / (sw * tall);
    const e = raw < 1.25 ? 1 : Math.min(8, Math.floor(raw * 2) / 2);
    this.elevCache.set(preset, e);
    return e;
  }
  private readonly elevCache = new Map<ViewPreset, number>();

  private currentFit() {
    return this.fitFor(this.preset);
  }

  /** Static camera pose for the current preset + user offsets. */
  private staticPose(out: CamPose): CamPose {
    const fit = this.currentFit();
    const v = this.controls.view;
    copyPose(fit, out);
    if (this.preset === 'perspective') {
      const o = this.perspOrientation(v.theta, v.phi);
      out.theta = o.theta;
      out.phi = o.phi;
    }
    out.target.addScaledVector(v.pan, fit.h);
    out.h = fit.h * Math.exp(-v.zoom);
    return out;
  }

  /**
   * Camera between two poses: orientation eased (azimuth settles a little earlier so the last part
   * of a move to the top view is a pure tilt, not a twist), framing assisted in the middle of the
   * move by a live fit of the terrain at the current orientation / heights, so nothing swings out
   * of frame or over the title. Endpoints are exact.
   */
  private transitionPose(from: CamPose, to: CamPose, p: number, heightK: number, out: CamPose): CamPose {
    // heightK here is the full vertical factor (flatten × elevation exaggeration).
    const u = easeInOutCubic(p);
    lerpPose(from, to, u, out);
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    // Toward a more top-down view: finish the azimuth early (then a pure tilt); away from it: tilt
    // first, turn later — so an orthographic top view never appears to spin in place.
    const pt = to.phi <= from.phi ? Math.min(1, p * 1.35) : Math.max(0, (p - 0.26) / 0.74);
    out.theta = from.theta + dTheta * easeInOutCubic(pt);
    const w = Math.pow(Math.sin(Math.PI * u), 2);
    if (w > 1e-3 && this.model) {
      const pts = this.boxPoints(false).map((v) => v.clone().setY(v.y * heightK));
      const fit = fitPose(pts, out.theta, out.phi, out.persp, this.cellVp(), this.insets(this.preset));
      out.target.lerp(fit.target, w);
      out.h = Math.exp(Math.log(out.h) + (Math.log(fit.h) - Math.log(out.h)) * w);
    }
    return out;
  }

  private introFrontPose(): CamPose {
    const m = this.model!;
    const topRow = m.panels[0].values.length - 1;
    return fitPose(this.boxPoints(false, topRow), 0, 1.3, PERSP_TAN, this.cellVp(), this.insets('intro-front'));
  }

  // ------------------------------------------------------------------ intro

  startIntro(tl: Timeline) {
    this.intro = { tl, plan: null, planKey: '' };
    this.invalidate();
  }

  stopIntro() {
    if (!this.intro) return;
    if (this.introDriving) this.leaveIntro();
    this.intro = null;
    this.introDriving = false;
    this.invalidate();
  }

  get introActive() {
    return this.introDriving;
  }

  private ensurePlan(): IntroPlan | null {
    if (!this.intro || !this.model) return null;
    const key = `${this.modelKey}|${this.model.heightCap}|${this.vp.width}x${this.vp.height}|${JSON.stringify(this.settings?.overlays)}|${this.settings?.heightScale}`;
    if (this.intro.plan && this.intro.planKey === key) return this.intro.plan;
    this.intro.plan = this.makePlan();
    this.intro.planKey = key;
    this.prewarm();
    return this.intro.plan;
  }

  /**
   * Build and upload everything the intro will show later (value table texture, label textures)
   * and compile every material now, so no shader compile / texture upload lands mid-animation.
   */
  private prewarm() {
    const gl = this.gl;
    if (!gl || !this.model) return;
    this.ensureContourLayout();
    this.ensureValues();
    const toggled: THREE.Object3D[] = [];
    const show = (o: THREE.Object3D | null | undefined) => {
      if (o && !o.visible) {
        o.visible = true;
        toggled.push(o);
      }
    };
    for (const pc of this.panels) {
      show(pc.surface);
      show(pc.walls);
      show(pc.bars);
      show(pc.valuesMesh);
      show(pc.contourGroup);
      show(pc.contourCut.line);
      show(pc.contourValues.line);
      show(pc.noData);
      pc.labelSprites.forEach(show);
      const vm = pc.valuesMesh?.material as THREE.MeshBasicMaterial | undefined;
      if (vm?.map) gl.initTexture(vm.map);
      for (const sp of pc.labelSprites) {
        const map = (sp.material as THREE.SpriteMaterial).map;
        if (map) gl.initTexture(map);
      }
    }
    try {
      gl.compile(this.scene, this.activeCam);
      gl.compile(this.hud.scene, this.hud.camera);
    } catch {
      // Compilation is only an optimisation.
    }
    for (const o of toggled) o.visible = false;
  }

  private makePlan(): IntroPlan {
    const m = this.model!;
    const p = this.panels[0];
    return new IntroPlan({
      grays: m.panels[0].view.grays,
      nCols: m.panels[0].xs.length,
      barCells: p.barInfo.map((b) => ({ r: b.r, c: b.c })),
      front: this.introFrontPose(),
      top: this.fitFor('top'),
      fitAtPhi: (phi) => fitPose(this.boxPoints(false), 0, phi, PERSP_TAN, this.cellVp(), this.insets('perspective')),
      overlays: this.settings!.overlays,
      levelCount: m.contourLevels.length,
    });
  }

  /** Switch from intro-driven frames to static ones without a visible jump. */
  private leaveIntro() {
    const fp = this.frame;
    if (this.hasRendered && !this.quiet) this.captureSnapshot();
    this.tw.heightK.jump(fp.heightK);
    this.tw.elev.jump(fp.elev);
    this.tw.values.jump(fp.valuesOpacity);
    this.tw.contours.jump(fp.contourOpacity);
    const s = this.settings!;
    const T = now();
    this.tw.heightK.set(s.view === 'top' ? 0 : 1, T, CAM_DUR);
    this.tw.elev.set(this.elevFor(s.view), T, CAM_DUR);
    this.tw.values.set(s.overlays.values && s.view === 'top' ? 1 : 0, T, FADE_DUR);
    this.tw.contours.set(s.overlays.contours ? 1 : 0, T, FADE_DUR);
    this.controls.reset(defaultUserView());
    const target = this.staticPose(clonePose(this.lastPose));
    const same =
      target.target.distanceTo(this.lastPose.target) < 1e-4 &&
      Math.abs(target.h - this.lastPose.h) < 1e-4 &&
      Math.abs(target.phi - this.lastPose.phi) < 1e-5 &&
      Math.abs(target.theta - this.lastPose.theta) < 1e-5 &&
      Math.abs(target.persp - this.lastPose.persp) < 1e-6;
    this.camTransition = same ? null : { from: clonePose(this.lastPose), t0: T, dur: CAM_DUR };
    if (same) this.snapT0 = -1; // identical frame: no crossfade needed
  }

  // ------------------------------------------------------------------ frame

  /** Compute + render one interactive frame. Returns true if another frame is needed. */
  frameTick(): boolean {
    if (!this.gl || this.exporting) return false;
    const t = now();
    const dt = Math.min(0.1, Math.max(0, t - this.lastTime));
    this.lastTime = t;
    let more = false;

    const driving = this.introShowing();
    if (this.introDriving && !driving) {
      if (this.intro && this.intro.tl.time >= this.intro.tl.duration - 1e-6) this.onIntroEnd();
      this.leaveIntro();
    } else if (driving && this.intro!.tl.playing && (!this.introDriving || this.intro!.tl.time < this.lastIntroT - INTRO_REPLAY_JUMP)) {
      // The intro starts playing on screen (start, replay after the end, restart mid-way, loop):
      // dissolve from the frame on screen instead of cutting to the empty plate. Scrubbing (paused)
      // stays direct; exports never see this (the video starts at t = 0).
      this.captureSnapshot(INTRO_SNAP_DUR, smoothstep01);
    }
    this.introDriving = driving;

    let fp: FrameParams;
    this.introFrame = false;
    if (driving) {
      const plan = this.ensurePlan();
      const it = this.intro!.tl.time;
      fp = plan ? this.liveHud(plan.evaluate(it, this.frame)) : this.staticFrame(t);
      this.introFrame = !!plan;
      this.lastIntroT = it;
      more = this.intro!.tl.playing;
    } else {
      more = this.controls.update(dt) || more;
      fp = this.staticFrame(t);
      more = more || this.staticAnimating(t);
    }
    this.render(fp);
    this.presented++;
    this.lastFrameOnScreen = true;
    if (this.snapT0 >= 0) more = true;
    return more;
  }

  /**
   * Intro frames in the live view (screen, current-view PNG): the title and colorbar stay up —
   * they were on screen before the intro started. Only the exported video fades them in from
   * black at its start.
   */
  private liveHud(fp: FrameParams): FrameParams {
    const ov = this.settings!.overlays;
    if (ov.title) fp.hud.title = 1;
    if (ov.colorbar) fp.hud.colorbar = 1;
    return fp;
  }

  private staticAnimating(t: number) {
    return !!this.camTransition || Object.values(this.tw).some((tw) => tw.active(t));
  }

  private staticFrame(t: number): FrameParams {
    const fp = this.frame;
    const s = this.settings;
    if (!s || !this.model) return fp;
    // camera
    // The elevation exaggeration follows the frame (resize / export / height scale) at once; view
    // changes animate it (sync).
    const elev = this.elevFor(this.preset);
    if (Math.abs(elev - this.tw.elev.target) > 1e-9) this.tw.elev.jump(elev);
    fp.elev = this.tw.elev.value(t);
    const target = this.staticPose(fp.pose);
    fp.heightK = this.tw.heightK.value(t);
    if (this.camTransition) {
      const p = (t - this.camTransition.t0) / this.camTransition.dur;
      if (p >= 1) this.camTransition = null;
      else this.transitionPose(this.camTransition.from, clonePose(target), p, fp.heightK * fp.elev, fp.pose);
    }
    const surface = s.representation === 'surface';
    fp.surfaceOpacity = surface ? 1 : 0;
    fp.barsOpacity = surface ? 0 : 1;
    fp.onTop = s.representation;
    fp.growth = null;
    fp.barFade = null;
    fp.valuesOpacity = this.tw.values.value(t);
    fp.contourOpacity = this.tw.contours.value(t);
    fp.contourReveal = null;
    fp.contourLabelOpacity = 1;
    const axes = this.tw.axes.value(t);
    fp.axes.lum = axes;
    fp.axes.gray = axes;
    fp.axes.value = axes * fp.heightK;
    fp.axes.captions = this.tw.captions.value(t);
    fp.grayTickAlpha = null;
    fp.hud.title = this.tw.title.value(t);
    fp.hud.colorbar = this.tw.colorbar.value(t);
    fp.ground = fp.heightK;
    return fp;
  }

  // ------------------------------------------------------------------ apply + render

  /** World units per CSS px in the top-view fit (cell px: every view has the same scale). */
  private topWorldPerCss(): number {
    return (this.fitFor('top').h / this.cellVp().height) * this.pxScale;
  }

  private ensureContourLayout() {
    const s = this.settings!;
    const wpc = this.topWorldPerCss();
    const key = `${this.modelKey}|${wpc.toFixed(5)}|${this.pxScale}|${s.lang}`;
    if (key === this.contourKey) return;
    this.contourKey = key;
    const fmt = (v: number) => (this.model!.kind === 'diff' ? (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0') : v.toFixed(1));
    for (const p of this.panels) p.layoutContours(wpc, this.pxScale, fmt);
  }

  /**
   * Value table: one decision for the whole layout (docs/adr/0002) — a uniform font in every
   * panel, or no values anywhere (then the view shows a hint instead of a few stray numbers).
   */
  private ensureValues() {
    const s = this.settings!;
    const wpc = this.topWorldPerCss();
    const key = `${this.modelKey}|${wpc.toFixed(4)}|${this.pxScale}|${s.colormap}|${this.model!.colorMax}`;
    if (key === this.valuesKey) return;
    this.valuesKey = key;
    const opt = { worldPerCssPx: wpc, pxScale: this.pxScale, colormap: s.colormap, colorMax: this.model!.colorMax, inset: 0.12 };
    const cells = this.panels.map((p) => measureValueCells(p.panel, opt));
    const choice = chooseValueFont(cells.map((c) => c.map((x) => x.fit)));
    this.valuesNone = choice.size === null;
    this.panels.forEach((p, i) => {
      const layer = choice.size === null ? null : drawValuesTexture(p.panel, cells[i], choice.size, opt);
      p.setValuesTexture(
        key,
        layer?.texture ?? null,
        () => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
        layer?.boxes ?? [],
      );
    });
  }
  /** The last value-table decision printed nothing (cells too small at this frame size). */
  private valuesNone = false;
  private valuesHintShown = false;
  /** Values overlay on in the top view, but the cells are too small to print them (React hint). */
  onValuesHint: (hidden: boolean) => void = () => {};

  private updateValuesHint() {
    // Export frames (other size / view) must not toggle the on-screen hint.
    if (this.exporting) return;
    const s = this.settings;
    const show = !!s && !!this.model && s.overlays.values && s.view === 'top' && !this.introDriving && this.valuesNone;
    if (show !== this.valuesHintShown) {
      this.valuesHintShown = show;
      this.onValuesHint(show);
    }
  }

  /** The view showing panel i. */
  private viewOf(panel: number): ViewSlot {
    return this.views.find((v) => v.panels.includes(panel)) ?? this.views[0];
  }

  private readonly scratchPose: CamPose = makeFrameParams().pose;

  /**
   * Camera of view i for a pose of view 0: moved by the view's panel offset and placed in the
   * view's cell of the full frame (view offset), so projecting / raycasting with it works in
   * full-frame coordinates. A single view is the plain full-frame camera.
   */
  private viewCamera(pose: CamPose, i: number, persp: THREE.PerspectiveCamera, ortho: THREE.OrthographicCamera): THREE.Camera {
    const lay = this.cellLayout();
    const cell = lay.cells[i] ?? lay.cells[0];
    const shift = this.views[i]?.shift;
    let p = pose;
    if (shift && shift.lengthSq() > 0) {
      p = copyPose(pose, this.scratchPose);
      p.target.add(shift);
    }
    const cam = applyPose(p, { width: cell.w, height: cell.h }, persp, ortho, this.sceneRadius()) as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (lay.cells.length <= 1) {
      if (cam.view?.enabled) cam.clearViewOffset();
    } else {
      const o = viewOffsetFor(cell, this.vp);
      cam.setViewOffset(o.fullWidth, o.fullHeight, o.x, o.y, o.width, o.height);
    }
    return cam;
  }

  private apply(fp: FrameParams) {
    const s = this.settings!;
    const m = this.model!;
    // cameras: view 0 follows the pose; the others are the same camera moved to their panel / cell
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      v.cam = this.viewCamera(fp.pose, i, v.persp, v.ortho);
    }
    this.activeCam = this.views[0]?.cam ?? applyPose(fp.pose, this.vp, this.perspCam, this.orthoCam, this.sceneRadius());
    copyPose(fp.pose, this.lastPose);
    const camPos = this.activeCam.position;
    const cellH = this.cellVp().height;

    // terrain heights
    // Flat = heights scaled to ~0 (not exactly: the normal transform needs an invertible scale).
    const k = Math.max(1e-6, fp.heightK);
    const sy = k * s.heightScale * fp.elev;
    const colorScale = m.kind === 'diff' ? 1 / Math.max(1e-6, m.colorMax) : 4 / Math.max(1e-6, m.colorMax);
    for (const mat of [this.mats.surface, this.mats.walls, this.mats.bars]) {
      const u = mat.uniforms;
      u.uColorScale.value = colorScale;
      u.uLighting.value = s.lighting === 'studio' ? 1 : 0;
      u.uSpec.value = smoothstep(0.05, 0.6, fp.heightK);
      u.uInvScaleY.value = 1 / Math.max(1e-6, sy);
      u.uCap.value = m.heightCap;
      u.uHatch.value = smoothstep(0.1, 0.7, fp.heightK);
      // Specular follows the camera of view 0 (all views share the orientation; the offset is a pan).
      u.uCamPos.value.copy(camPos);
    }
    const surfaceOn = fp.surfaceOpacity > 0.002;
    const barsOn = fp.barsOpacity > 0.002;
    this.mats.surface.uniforms.uOpacity.value = fp.surfaceOpacity;
    this.mats.walls.uniforms.uOpacity.value = fp.surfaceOpacity;
    this.mats.bars.uniforms.uOpacity.value = fp.barsOpacity;
    const surfTop = fp.onTop === 'surface';
    for (const mat of [this.mats.surface, this.mats.walls]) {
      mat.polygonOffset = surfTop && barsOn;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -2;
    }
    this.mats.bars.polygonOffset = !surfTop && surfaceOn;
    this.mats.bars.polygonOffsetFactor = -1;
    this.mats.bars.polygonOffsetUnits = -2;
    // Flat crossfade (intro heatmap reveal): the incoming layer lies in the same plane as the
    // outgoing one — draw it without depth test so it cleanly covers it (no z-fighting).
    const flatBoth = fp.heightK < 1e-3 && surfaceOn && barsOn;
    this.mats.surface.depthTest = !(flatBoth && surfTop);
    this.mats.walls.depthTest = true;
    this.mats.bars.depthTest = !(flatBoth && !surfTop);
    // Plate sits below the lowest (possibly negative) height.
    const plateY = Math.min(0, m.plotMin) * SY * sy - 0.012;
    this.plateY = plateY;
    // "No data" hatch: ~6 CSS px line spacing in the top-view fit (world space, so it moves with
    // the plot), 1 CSS px lines.
    this.mats.noData.uniforms.uSpacing.value = 6 * this.topWorldPerCss();
    this.mats.noData.uniforms.uPx.value = this.pxScale;

    this.ensureContourLayout();
    if (fp.valuesOpacity > 0.002) this.ensureValues();
    // Values printed only when the layout-wide decision found room for them (see ensureValues).
    const valuesOp = this.valuesNone ? 0 : fp.valuesOpacity;
    this.updateValuesHint();

    const labelRects: { sp: THREE.Sprite; view: ViewSlot; order: number; rect: Rect }[] = [];
    this.panels.forEach((pc, i) => {
      const view = this.viewOf(i);
      const cam = view.cam;
      const vPos = cam.position;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      pc.heightGroup.scale.set(1, sy, 1);
      pc.surface.visible = surfaceOn;
      pc.walls.visible = surfaceOn && fp.heightK > 0.004;
      pc.surface.renderOrder = surfTop ? 3 : 1;
      pc.walls.renderOrder = surfTop ? 3 : 1;
      pc.bars.renderOrder = surfTop ? 1 : 3;
      pc.bars.visible = barsOn;
      if (barsOn) pc.setGrowth(i === 0 ? fp.growth : null, i === 0 ? fp.barFade : null);
      pc.plate.position.y = plateY;
      if (pc.noData) pc.noData.position.y = plateY + 0.002;
      // contours
      // Contours follow the surface; over 3D bars they would float inside the bars, so they only
      // show there once the bars are (nearly) flat.
      // Elevation views (front / side) see contours edge-on: fade them out as the camera levels.
      const cOp = fp.contourOpacity * Math.max(fp.surfaceOpacity, smoothstep(0.35, 0.02, fp.heightK)) * smoothstep(1.45, 1.2, fp.pose.phi);
      pc.contourGroup.visible = cOp > 0.002;
      pc.contourGroup.scale.set(1, sy, 1);
      pc.contourGroup.position.y = 0.012 + (1 - fp.heightK) * 0.004;
      // Lines gapped under their labels; while the value table shows (labels hidden), lines gapped
      // around every printed value instead — a line never runs through a number.
      const labelsShown = 1 - valuesOp;
      pc.contourCut.setStyle(cOp * 0.92 * labelsShown, 1.7 * this.pxScale);
      pc.contourValues.setStyle(cOp * 0.92 * (1 - labelsShown), 1.7 * this.pxScale);
      if (pc.contourGroup.visible) pc.setContourReveal(fp.contourReveal);
      // contour labels: world billboards following the surface, pulled toward the camera so the
      // surface they sit on never clips them.
      pc.labelSprites.forEach((sp, order) => {
        const lb = sp.userData.label as { x: number; y: number; z: number; u: number; levelIndex: number };
        const rev = fp.contourReveal ? (fp.contourReveal[lb.levelIndex] ?? 1) : 1;
        // Values already print the numbers: contour labels step aside while the table shows.
        const a = cOp * fp.contourLabelOpacity * smoothstep(lb.u, lb.u + 0.12, rev) * (1 - valuesOp);
        sp.visible = a > 0.003;
        (sp.material as THREE.SpriteMaterial).opacity = a;
        const anchor = new THREE.Vector3(lb.x, lb.y * sy + 0.012, lb.z);
        sp.userData.baseScale ??= sp.scale.clone();
        const base = sp.userData.baseScale as THREE.Vector3;
        const nominalPx = (sp.userData.nominalPx as number) ?? 16;
        let sc = 1;
        let projPx: number;
        let pxPerWorld: number;
        if (cam instanceof THREE.PerspectiveCamera) {
          const dir = anchor.clone().sub(vPos);
          const dist = dir.length();
          const pull = Math.min(dist * 0.5, 1.2 * fp.heightK + 0.05);
          anchor.addScaledVector(dir.normalize(), -pull);
          sc = (dist - pull) / dist;
          const depth = Math.max(1e-3, anchor.clone().sub(vPos).dot(fwd));
          // The camera's fov spans its cell's height (the view offset only moves the image).
          pxPerWorld = cellH / (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
          projPx = base.y * sc * pxPerWorld;
        } else {
          const oc = cam as THREE.OrthographicCamera;
          pxPerWorld = cellH / Math.max(1e-6, oc.top - oc.bottom);
          projPx = base.y * pxPerWorld;
        }
        // World-sized labels (they belong to the plot), but kept within a legible size range.
        const clampPx = THREE.MathUtils.clamp(projPx, nominalPx * 0.75, nominalPx * 1.45);
        sp.scale.copy(base).multiplyScalar(sc * (clampPx / Math.max(1e-6, projPx)));
        sp.position.copy(anchor);
        // The pull toward the camera must not show a label through terrain standing in front of
        // its line (e.g. behind a ridge): fade by how much of it the terrain hides — a label the
        // terrain cuts into is dropped rather than shown half hidden.
        if (sp.visible && fp.heightK > 0.01) {
          const vis = this.spriteSightline(new THREE.Vector3(lb.x, lb.y * sy + 0.012, lb.z), sp.scale.x * 0.5, fp, view);
          const a2 = a * smoothstep(0.8, 1, vis);
          sp.visible = a2 > 0.003;
          (sp.material as THREE.SpriteMaterial).opacity = a2;
        }
        if (sp.visible) {
          const q = anchor.clone().project(cam);
          const cx = ((q.x + 1) / 2) * this.vp.width;
          const cy = ((q.y + 1) / 2) * this.vp.height;
          // Visible text box (the texture has a halo margin): ~80 % of the sprite.
          const hw = sp.scale.x * pxPerWorld * 0.4;
          const hh = sp.scale.y * pxPerWorld * 0.36;
          labelRects.push({ sp, view, order, rect: { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh } });
        }
      });
      // values
      if (pc.valuesMesh) {
        const vm = pc.valuesMesh.material as THREE.MeshBasicMaterial;
        vm.opacity = valuesOp;
        pc.valuesMesh.visible = valuesOp > 0.002;
      }
    });
    this.separateContourLabels(labelRects);

    // floor + plate (no floor glow on a pure black presentation background: keyable / black-level exact)
    this.floorMat.uniforms.uOpacity.value = fp.ground;
    this.floor.visible = fp.ground > 0.01 && !isPureBlack(s.background);

    // axes (per view, each on the plate edges nearest to its camera)
    for (const v of this.views) {
      const ax = v.axes;
      ax.chooseEdges(v.cam.position, new THREE.Vector3(0, 0, -1).applyQuaternion(v.cam.quaternion));
      const lines = Math.max(fp.axes.lum, fp.axes.gray) * 0.95;
      ax.setStyle(this.pxScale, { lines, grid: fp.ground * Math.max(fp.axes.lum, fp.axes.gray) * 0.9, value: fp.axes.value * smoothstep(0.2, 0.45, fp.pose.phi) });
      ax.valueGroup.scale.set(1, sy, 1);
      const corner = this.valueAxisCorner(v);
      ax.valueGroup.position.set(corner.x, 0, corner.z);
      const out = corner.clone().sub(ax.center).setY(0).normalize();
      ax.valueGroup.rotation.y = Math.atan2(-out.z, out.x);
    }

    // hover outline
    this.updateHoverOutline();

    // background
    this.scene.background = null;
  }

  /**
   * Contour labels are placed apart on the plate, but in 3D labels at different heights can
   * project onto each other (a label high on a wall over one on the slope below): per view, a
   * label fades out as it approaches one placed earlier (longer lines first), continuously, so a
   * moving camera never makes labels pop.
   */
  private separateContourLabels(items: { sp: THREE.Sprite; view: ViewSlot; order: number; rect: Rect }[]) {
    const S = this.pxScale;
    const byView = new Map<ViewSlot, typeof items>();
    for (const it of items) {
      const list = byView.get(it.view) ?? [];
      list.push(it);
      byView.set(it.view, list);
    }
    for (const list of byView.values()) {
      list.sort((p, q) => p.order - q.order);
      const kept: Rect[] = [];
      for (const it of list) {
        let c = 1;
        for (const r of kept) c = Math.min(c, smoothstep(0, 4 * S, Math.max(r.x0 - it.rect.x1, it.rect.x0 - r.x1, r.y0 - it.rect.y1, it.rect.y0 - r.y1)));
        const mat = it.sp.material as THREE.SpriteMaterial;
        mat.opacity *= c;
        it.sp.visible = mat.opacity > 0.003;
        if (c > 0.5) kept.push(it.rect);
      }
    }
  }

  /**
   * Clip rects per view (see `clip`), null = not clipped. Active when the terrain box leaves the
   * current preset's safe rect. Orthographic views clip to that rect (its gutters carry the pinned
   * axes, like a chart's plot area); perspective only keeps the terrain off the HUD blocks (title
   * band, colorbar), a camera crop — within the view's own region.
   */
  private plotClips(fp: FrameParams, hudBlocks: { title: Rect | null; colorbar: Rect | null }): (Rect | null)[] {
    const lay = this.cellLayout();
    const none = lay.cells.map(() => null);
    if (!this.model || !this.settings || this.introFrame) return none;
    // Only the user's zoom / pan (or a camera move leaving it) clips: preset changes and other
    // transitions may overshoot the safe rect for a moment and must not show a hard cut.
    const v = this.controls.view;
    const userFramed = v.zoom > 1e-3 || v.pan.lengthSq() > 1e-10 || !!this.camTransition?.clip;
    if (!userFramed) return none;
    const W = this.vp.width;
    const H = this.vp.height;
    const ins = this.insets(this.preset);
    const c0 = lay.cells[0];
    const safe: Rect = { x0: c0.x + ins.left, y0: c0.y + ins.bottom, x1: c0.x + c0.w - ins.right, y1: c0.y + c0.h - ins.top };
    if (safe.x1 - safe.x0 < 20 || safe.y1 - safe.y0 < 20) return none;
    const tol = 2 * this.pxScale;
    const pts = this.boxPoints(false, undefined, fp.elev);
    let out = false;
    const cam = this.views[0]?.cam ?? this.activeCam;
    for (const p of pts) {
      p.y *= fp.heightK;
      const q = p.project(cam);
      const x = ((q.x + 1) / 2) * W;
      const y = ((q.y + 1) / 2) * H;
      if (!(q.z > -1 && q.z < 1) || x < safe.x0 - tol || x > safe.x1 + tol || y < safe.y0 - tol || y > safe.y1 + tol) out = true;
    }
    if (!out) return none;
    const moved = (r: Rect, c: Cell): Rect => ({ x0: r.x0 + c.x - c0.x, y0: r.y0 + c.y - c0.y, x1: r.x1 + c.x - c0.x, y1: r.y1 + c.y - c0.y });
    if (fp.pose.persp <= 0) return lay.cells.map((c) => moved(safe, c));
    const gap = 10 * this.pxScale;
    const r: Rect = { x0: 0, y0: 0, x1: W, y1: H };
    if (hudBlocks.title) r.y1 = Math.min(r.y1, hudBlocks.title.y0 - gap);
    const cb = hudBlocks.colorbar;
    if (cb) {
      if (this.portrait) r.y0 = Math.max(r.y0, cb.y1 + gap);
      else r.x1 = Math.min(r.x1, cb.x0 - gap);
    }
    return lay.regions.map((g, i) => {
      const q: Rect = { x0: Math.max(r.x0, g.x), y0: Math.max(r.y0, g.y), x1: Math.min(r.x1, g.x + g.w), y1: Math.min(r.y1, g.y + g.h) };
      return q.x1 - q.x0 > 20 && q.y1 - q.y0 > 20 ? q : moved(safe, lay.cells[i]);
    });
  }
  /** Clip rects of the views this frame (see plotClips). */
  private clips: (Rect | null)[] = [];

  private valueAxisCorner(v: ViewSlot): THREE.Vector3 {
    const ax = v.axes;
    let best = ax.corners[0];
    let bestX = Infinity;
    let bestDepth = -Infinity;
    const cam = v.cam;
    for (const c of ax.corners) {
      const p = c.clone().project(cam);
      const depth = c.distanceTo(cam.position);
      if (p.x < bestX - 1e-3 || (Math.abs(p.x - bestX) <= 1e-3 && depth > bestDepth)) {
        best = c;
        bestX = p.x;
        bestDepth = depth;
      }
    }
    return best;
  }

  /** Show only view i's panels and axes (-1 = everything). */
  private showOnly(i: number) {
    this.views.forEach((v, j) => {
      const on = i < 0 || j === i;
      v.axes.group.visible = on;
      for (const p of v.panels) if (this.panels[p]) this.panels[p].group.visible = on;
    });
  }

  private render(fp: FrameParams, target: THREE.WebGLRenderTarget | null = null, withSnapshot = true) {
    const gl = this.gl;
    if (!gl) return;
    const s = this.settings;
    gl.setRenderTarget(target);
    gl.autoClear = false;
    gl.setClearColor(new THREE.Color(s?.background ?? '#07090d'), 1);
    gl.clear(true, true, true);
    if (s && this.model) {
      this.apply(fp);
      this.layoutHud(fp);
      const lay = this.cellLayout();
      const multi = this.views.length > 1;
      this.views.forEach((v, i) => {
        this.showOnly(multi ? i : -1);
        // Floor glow under this view's plate: its own pass, never clipped (a soft glow has no edge
        // to cut; neighbouring glows blend smoothly).
        const b = v.bounds;
        const R = Math.max(b.x1 - b.x0, b.z1 - b.z0);
        const cx = (b.x0 + b.x1) / 2;
        const cz = (b.z0 + b.z1) / 2;
        this.floor.scale.set(R * 2.6, 1, R * 2.6);
        this.floor.position.set(cx, this.plateY - 0.02, cz);
        this.floorMat.uniforms.uRadius.value = R * 1.3;
        (this.floorMat.uniforms.uCenter.value as THREE.Vector2).set(cx, cz);
        gl.render(this.floorScene, v.cam);
        // Side-by-side: every view stays inside its own region; zoomed / panned: the plot clip.
        const g = lay.regions[i];
        const clip = this.clips[i] ?? (multi && g ? { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h } : null);
        if (clip) this.setScissor(target, clip);
        gl.render(this.scene, v.cam);
        if (clip) this.setScissor(target, null);
      });
      if (multi) this.showOnly(-1);
      gl.clearDepth();
      gl.render(this.hud.scene, this.hud.camera);
    }
    if (withSnapshot && this.snapTex && this.snapT0 >= 0 && !target) {
      const p = (now() - this.snapT0) / this.snapDur;
      if (p >= 1) this.snapT0 = -1;
      else {
        const u = this.snapMat.uniforms;
        u.map.value = this.snapTex;
        u.opacity.value = 1 - this.snapEase(Math.max(0, p));
        // Over the whole viewport (= the whole drawing buffer the pixels were copied from).
        this.snapQuad.position.set(this.vp.width / 2, this.vp.height / 2, 0);
        this.snapQuad.scale.set(this.vp.width, this.vp.height, 1);
        gl.clearDepth();
        gl.render(this.snapScene, this.hud.camera);
      }
    }
    gl.setRenderTarget(null);
    this.hasRendered = true;
    if (++this.frameCount % 240 === 0) this.text.sweep();
  }

  /** Scissor (px, origin bottom-left) for the canvas or a render target; null = off. */
  private setScissor(target: THREE.WebGLRenderTarget | null, r: Rect | null) {
    const gl = this.gl!;
    if (target) {
      target.scissorTest = !!r;
      if (r) target.scissor.set(Math.floor(r.x0), Math.floor(r.y0), Math.ceil(r.x1 - r.x0), Math.ceil(r.y1 - r.y0));
      gl.setRenderTarget(target);
      return;
    }
    gl.setScissorTest(!!r);
    if (r) {
      // The canvas scissor is given in CSS px (the renderer multiplies by its pixel ratio).
      const k = 1 / gl.getPixelRatio();
      gl.setScissor(Math.floor(r.x0) * k, Math.floor(r.y0) * k, Math.ceil(r.x1 - r.x0) * k, Math.ceil(r.y1 - r.y0) * k);
    }
  }

  /**
   * Freeze the image on screen; it fades out over the next frames (hides discontinuities). The
   * last presented frame is drawn again on the canvas — same frame parameters, same pipeline, a
   * still-fading older snapshot included — and its pixels copied, so the snapshot equals what was
   * on screen (an offscreen render target would differ in multisampling and blending space).
   */
  private captureSnapshot(dur = SNAP_DUR, ease: (p: number) => number = easeInOutCubic) {
    const gl = this.gl;
    if (!gl || !this.settings || !this.model || this.quiet || !this.lastFrameOnScreen) return;
    // Several changes before the next frame: the snapshot already holds the last presented frame
    // (the longer fade wins; nothing has faded yet).
    if (this.snapT0 >= 0 && this.snapOf === this.presented) {
      if (dur > this.snapDur) {
        this.snapDur = dur;
        this.snapEase = ease;
      }
      return;
    }
    // The canvas must already have the frame's size (drawing buffer = viewport, ±1 px rounding).
    const buf = gl.getDrawingBufferSize(this.snapBuf);
    if (buf.x < 4 || buf.y < 4 || Math.abs(buf.x - this.vp.width) > 1 || Math.abs(buf.y - this.vp.height) > 1) return;
    if (this.snapTex && (this.snapTex.image.width !== buf.x || this.snapTex.image.height !== buf.y)) this.disposeSnapshot();
    this.snapTex ??= new THREE.FramebufferTexture(buf.x, buf.y);
    this.render(this.frame, null, true);
    gl.copyFramebufferToTexture(this.snapTex);
    this.snapT0 = now();
    this.snapDur = dur;
    this.snapEase = ease;
    this.snapOf = this.presented;
  }

  // ------------------------------------------------------------------ HUD

  /** Left edge of the title (CSS px): the margin, or clear of the presentation exit button. */
  private titleLeftCss(): number {
    const safe = this.exporting ? 0 : (this.settings?.safeLeft ?? 0);
    return Math.max(HUD_MARGIN, safe);
  }

  /**
   * Title width budget (CSS px). Portrait frames put the colorbar under the plot, so the title
   * gets the full width; landscape keeps clear of the colorbar column on the right.
   */
  private titleMaxW(): number {
    const W = this.vp.width / this.pxScale;
    const left = this.titleLeftCss();
    return this.portrait ? Math.max(120, W - left - HUD_MARGIN) : Math.max(160, W - 200 - (left - HUD_MARGIN));
  }

  /**
   * Title text and its fitted lines (a record title wraps to device / mode before shortening), and
   * the subtitle's base (without the view-dependent elevation note) wrapped at a " · " separator.
   * Line counts size the title band (baseInsets), so they never depend on the camera fit.
   */
  private titleText(): { title: string; lines: string[]; sub: string; subLines: string[]; sep: string } {
    const s = this.settings;
    const m = this.model;
    if (!s || !m) return { title: '', lines: [''], sub: '', subLines: [], sep: ' · ' };
    const t = (k: string) => translate(s.lang, k);
    let title: string;
    let parts: [string, string] | null = null;
    let sub: string;
    let sep = ' · ';
    if (m.layout === 'diff') {
      title = t('scene3d.title.diff');
      const p = m.panels[0];
      sep = '  ·  ';
      sub = `A: ${recordLabel(p.record, s.lang)}${sep}B: ${recordLabel(p.other!, s.lang)}`;
    } else {
      title = m.layout === 'sideBySide' ? t('scene3d.title.sideBySide') : recordLabel(m.panels[0].record, s.lang);
      if (m.layout === 'single') parts = [deviceLabel(m.panels[0].record, s.lang), modeLabel(m.panels[0].record, s.lang)];
      sub = `${t('scene3d.subtitle.svm')}${s.clipLowGray ? ` · ${t('common.lowGrayClipped')}` : ''}`;
    }
    const S = this.pxScale;
    const maxW = this.titleMaxW() * S;
    const key = `${title}|${sub}|${maxW}|${S}`;
    if (this.titleLinesCache?.key !== key) {
      this.titleLinesCache = {
        key,
        lines: titleLines(title, parts, maxW, (x) => measureText(x, HUD_TITLE_STYLE, S)),
        subLines: sub ? wrapParts(sub, sep, maxW, (x) => measureText(x, HUD_SUBTITLE_STYLE, S)) : [],
      };
    }
    return { title, lines: this.titleLinesCache.lines, sub, subLines: this.titleLinesCache.subLines, sep };
  }
  private titleLinesCache: { key: string; lines: string[]; subLines: string[] } | null = null;

  private titleSpec() {
    const s = this.settings!;
    const t = (k: string, v?: Record<string, string | number>) => translate(s.lang, k, v);
    const { title, lines, sub, subLines, sep } = this.titleText();
    // Front / side views are drawn with a vertical exaggeration: say so (value axis stays true).
    const e = this.introFrame ? 1 : this.elevFor(s.view);
    const elev = e > 1 ? `${sep}${t('scene3d.subtitle.elev', { k: Number(e.toFixed(1)) })}` : '';
    const out = subLines.length ? [...subLines] : [];
    if (elev && out.length) out[out.length - 1] += elev;
    return { title, lines, subtitle: `${sub}${elev}`, subLines: out };
  }

  private layoutHud(fp: FrameParams) {
    const s = this.settings!;
    const hud = this.hud;
    const S = this.pxScale;
    const W = this.vp.width;
    const H = this.vp.height;
    const margin = HUD_MARGIN * S;
    hud.snap = !this.introFrame;
    hud.begin();
    const occupied: Rect[] = [];
    let titleRect: Rect | null = null;
    let colorbarRect: Rect | null = null;

    // title (clear of the presentation exit button, see EngineSettings.safeLeft)
    if (fp.hud.title > 0.003) {
      const spec = this.titleSpec();
      const maxW = this.titleMaxW();
      const key = `${spec.lines.join('\n')}|${spec.subLines.join('\n')}|${S}|${maxW}|${s.background}`;
      if (this.titleTex?.key !== key) {
        this.titleTex?.tt.texture.dispose();
        this.titleTex = { key, tt: drawTitleTexture(spec, S, maxW, s.background) };
      }
      const tt = this.titleTex.tt;
      const x0 = this.titleLeftCss() * S;
      // Portrait: the title sits right above the (vertically centered) plot, not at the frame top.
      const top = H - margin - this.portraitShift();
      hud.quad(tt.texture, x0 - tt.inset, top + tt.inset, tt.w, tt.h, fp.hud.title);
      titleRect = { x0, y0: top - tt.h + 2 * tt.inset, x1: x0 + tt.w - 2 * tt.inset, y1: top };
      occupied.push(titleRect);
    }

    // colorbar
    const portrait = W / H < 0.85;
    const cbTex = fp.hud.colorbar > 0.003 ? this.colorbarTexture() : null;
    if (cbTex) {
      const tt = cbTex;
      let x: number;
      let yTop: number;
      if (portrait) {
        // Portrait: right under the (top-view) plot and its luminance axis labels, not at the
        // frame edge — the same spot in every view, so it does not move with the camera.
        x = (W - tt.w) / 2;
        const plotBottom = this.fitPlotBottom();
        yTop = Math.max(margin + tt.h, plotBottom - 64 * S + tt.inset);
      } else {
        x = W - margin - tt.w;
        const ins = this.frameInsets(this.preset);
        const mid = (ins.bottom + (H - ins.top)) / 2;
        yTop = Math.min(H - margin - 4 * S, mid + tt.h / 2);
      }
      hud.quad(tt.texture, x, yTop, tt.w, tt.h, fp.hud.colorbar);
      colorbarRect = { x0: x + tt.inset, y0: yTop - tt.h + tt.inset, x1: x + tt.w - tt.inset, y1: yTop - tt.inset };
      occupied.push(colorbarRect);
    }

    // plot clip (zoomed / panned), then the labels that depend on it
    this.clips = this.plotClips(fp, { title: titleRect, colorbar: colorbarRect });
    this.clip = this.clips[0] ?? null;
    if (this.views.length > 1 && fp.axes.captions > 0.003) this.layoutCaptions(fp, titleRect, occupied);
    if (this.views.length) this.layoutAxisLabels(fp, occupied);
    this.activeCam = this.views[0]?.cam ?? this.activeCam;
    hud.end();
  }

  /** Right frame inset (CSS px): the colorbar column in landscape frames. */
  private rightInsetCss(): number {
    const S = this.pxScale;
    const cb = this.settings?.overlays.colorbar ?? true;
    if (!cb || this.portrait) return 30;
    const tt = this.colorbarTexture();
    return Math.max(96, tt ? (HUD_MARGIN * S + tt.w - tt.inset) / S + 14 : 96);
  }

  /** Horizontal room (px) of view i's caption: its cell, never over the colorbar column. */
  private captionRegion(i: number, lay: CellLayout, rightPx: number): { x0: number; x1: number } {
    const S = this.pxScale;
    const c = lay.cells[i] ?? lay.cells[0];
    const cbRight = (this.settings?.overlays.colorbar ?? true) && !this.portrait;
    const xMax = cbRight ? this.vp.width - rightPx + 4 * S : this.vp.width - 4 * S;
    return { x0: c.x + 4 * S, x1: Math.max(c.x + 40 * S, Math.min(xMax, c.x + c.w - 4 * S)) };
  }

  /**
   * Caption lines per side-by-side panel ("A · device · mode"), fitted to the panel's cell: one
   * line, or device / mode on two lines; the device is shortened before the mode, and a mode too
   * long for the cell keeps the part that tells it apart from the most similar other panel's mode.
   */
  private captionTexts(): string[][] {
    const m = this.model;
    const s = this.settings;
    if (!m || !s || m.layout !== 'sideBySide') return [];
    const S = this.pxScale;
    const rightPx = this.rightInsetCss() * S;
    const grid = this.grid();
    const key = `${this.modelKey}|${this.vp.width}|${S}|${rightPx}|${grid.cols}x${grid.rows}|${this.portrait}|${s.overlays.colorbar}`;
    if (this.captionCache?.key === key) return this.captionCache.lines;
    const lay = splitCells(this.vp, { left: 70 * S, right: rightPx, top: 0, bottom: 0 }, m.panels.length, grid, { pad: CELL_PAD * S, capBand: 0, lumBand: 0 });
    const measure = (t: string) => measureText(t, CAPTION_STYLE, S);
    const modes = m.panels.map((p) => modeLabel(p.record, s.lang));
    // The other panel whose mode shares the longest beginning with this one ("…Pro off" / "…Pro on").
    const nearest = (i: number): string | null => {
      let best: string | null = null;
      let k = -1;
      modes.forEach((md, j) => {
        const c = j === i ? -1 : commonPrefixLength(modes[i], md);
        if (c > k) {
          k = c;
          best = md;
        }
      });
      return best;
    };
    const fitAll = (two: boolean) =>
      m.panels.map((p, i) => {
        const r = this.captionRegion(i, lay, rightPx);
        return captionLines(p.id, deviceLabel(p.record, s.lang), modes[i], nearest(i), r.x1 - r.x0, measure, two);
      });
    let lines = fitAll(false);
    // Same shape for every panel: if one caption needs two lines, all use two (aligned rows).
    if (lines.some((l) => l.length > 1)) lines = fitAll(true);
    this.captionCache = { key, lines };
    return lines;
  }
  private captionCache: { key: string; lines: string[][] } | null = null;
  private readonly captionTex = new Map<string, TextTexture & { inset: number }>();

  /** Caption band above each side-by-side plot (CSS px): one or two lines. */
  private captionBand(): number {
    const lines = Math.max(1, ...this.captionTexts().map((l) => l.length));
    return 26 + (lines - 1) * captionLineHeight(CAPTION_STYLE.size);
  }

  /**
   * Side-by-side captions: centered over each panel's (projected) terrain box, in the caption band
   * of its cell, clamped to the cell and clear of the title. Never culled: a collision moves the
   * caption, and two lines / shortening keep the mode visible.
   */
  private layoutCaptions(fp: FrameParams, titleRect: Rect | null, occupied: Rect[]) {
    const s = this.settings!;
    const S = this.pxScale;
    const W = this.vp.width;
    const H = this.vp.height;
    const lay = this.cellLayout();
    const rightPx = this.rightInsetCss() * S;
    const texts = this.captionTexts();
    if (this.captionTex.size > 16) {
      for (const t of this.captionTex.values()) t.texture.dispose();
      this.captionTex.clear();
    }
    const rows: { tt: TextTexture & { inset: number }; rect: Rect; row: number }[] = [];
    this.views.forEach((v, i) => {
      const lines = texts[v.panels[0]];
      if (!lines) return;
      const key = `${lines.join('\n')}|${S}|${s.background}`;
      let tt = this.captionTex.get(key);
      if (!tt) {
        tt = drawCaptionTexture(lines, CAPTION_STYLE, S, s.background);
        this.captionTex.set(key, tt);
      }
      // Projected box of the view's terrain at the current heights.
      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of this.boxPoints(false, undefined, fp.elev)) {
        p.y *= fp.heightK;
        p.add(v.shift);
        const q = p.project(v.cam);
        if (!(q.z > -1 && q.z < 1)) continue;
        const x = ((q.x + 1) / 2) * W;
        const y = ((q.y + 1) / 2) * H;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      const cell = lay.cells[i] ?? lay.cells[0];
      if (!Number.isFinite(maxY)) {
        minX = cell.x;
        maxX = cell.x + cell.w;
        maxY = cell.y + cell.h - 30 * S;
      }
      // Zoomed / panned: the caption stays over the visible (clipped) part of the plot.
      const clip = this.clips[i];
      if (clip) {
        maxY = Math.min(maxY, clip.y1);
        const x0 = Math.max(minX, clip.x0);
        const x1 = Math.min(maxX, clip.x1);
        if (x1 > x0) {
          minX = x0;
          maxX = x1;
        }
      }
      const w = tt.w - 2 * tt.inset;
      const h = tt.h - 2 * tt.inset;
      const reg = this.captionRegion(i, lay, rightPx);
      let cx = (minX + maxX) / 2;
      cx = reg.x1 - reg.x0 <= w ? (reg.x0 + reg.x1) / 2 : Math.min(reg.x1 - w / 2, Math.max(reg.x0 + w / 2, cx));
      // Clear of the plot's top tick labels (e.g. gray 255 at the top-left corner in top view).
      let y0 = maxY + 15 * S;
      // Below the title (when it spans the caption's column) and inside the frame; in a grid of
      // 3–6 panels a lower row's caption never climbs past the axis band of the row above (a tall
      // perspective terrain would otherwise push it there).
      const g = lay.regions[i] ?? cell;
      let yMax = H - 4 * S;
      if (this.views.length >= 3) yMax = Math.min(yMax, g.y + g.h + (STACK_PAD - 2) * S);
      if (titleRect && titleRect.x1 > cx - w / 2 && titleRect.x0 < cx + w / 2) yMax = Math.min(yMax, titleRect.y0 - 6 * S);
      y0 = Math.max(cell.y + 4 * S, Math.min(y0, yMax - h));
      rows.push({ tt, rect: { x0: cx - w / 2, y0, x1: cx + w / 2, y1: y0 + h }, row: lay.slots[i]?.row ?? 0 });
    });
    // One caption line per grid row (the cells are congruent; only the title clamp differs).
    for (const row of new Set(rows.map((r) => r.row))) {
      const inRow = rows.filter((r) => r.row === row);
      if (inRow.length < 2) continue;
      const y0 = Math.min(...inRow.map((r) => r.rect.y0));
      for (const r of inRow) {
        r.rect.y1 += y0 - r.rect.y0;
        r.rect.y0 = y0;
      }
    }
    for (const { tt, rect } of rows) {
      this.hud.quad(tt.texture, rect.x0 - tt.inset, rect.y1 + tt.inset, tt.w, tt.h, fp.axes.captions);
      occupied.push(rect);
    }
  }

  /** Colorbar spec for the current model / settings (null without a model). */
  private colorbarSpec(): ColorbarSpec | null {
    const s = this.settings;
    const m = this.model;
    if (!s || !m) return null;
    const t = (k: string) => translate(s.lang, k);
    const portrait = this.vp.width / this.vp.height < 0.85;
    const S = this.pxScale;
    const len = portrait ? Math.min(420, (this.vp.width / S) * 0.6) : Math.max(120, Math.min(300, (this.vp.height / S) * 0.42));
    const diff = m.kind === 'diff';
    const hasNull = m.panels.some((p) => p.count < p.values.length * (p.values[0]?.length ?? 0));
    return {
      kind: m.kind,
      colormap: s.colormap,
      max: m.colorMax,
      title: diff ? t('scene3d.colorbar.delta') : 'SVM',
      marks: s.overlays.contours ? m.contourLevels : [],
      ends: diff ? ([t('scene3d.colorbar.aBetter'), t('scene3d.colorbar.aWorse')] as [string, string]) : undefined,
      // Diff: the scale saturates; ends that clip real values read "≤ −R" / "≥ +R".
      over: diff ? [m.panels.some((p) => p.minValue < -m.colorMax - 1e-9), m.panels.some((p) => p.maxValue > m.colorMax + 1e-9)] : undefined,
      noData: hasNull ? t('common.noValidData') : undefined,
      orientation: portrait ? 'horizontal' : 'vertical',
      length: Math.round(len),
    };
  }

  /** Cached colorbar texture (also sizes the right inset of the fit). */
  private colorbarTexture(): (TextTexture & { inset: number }) | null {
    const spec = this.colorbarSpec();
    if (!spec) return null;
    const bg = this.settings!.background;
    const key = `${JSON.stringify(spec)}|${this.pxScale}|${bg}`;
    if (this.colorbarTex?.key !== key) {
      this.colorbarTex?.tt.texture.dispose();
      this.colorbarTex = { key, tt: drawColorbarTexture(spec, this.pxScale, bg) };
    }
    return this.colorbarTex.tt;
  }

  private readonly scratchPersp = new THREE.PerspectiveCamera();
  private readonly scratchOrtho = new THREE.OrthographicCamera();

  /** Bottom edge (px, origin bottom-left) of the lowest view's plate in the static top-view framing. */
  private fitPlotBottom(): number {
    const i = Math.max(0, this.views.length - 1);
    const cam = this.viewCamera(this.fitFor('top'), i, this.scratchPersp, this.scratchOrtho);
    const b = this.fitBounds();
    const shift = this.views[i]?.shift ?? new THREE.Vector3();
    let minY = Infinity;
    for (const x of [b.x0, b.x1])
      for (const z of [b.z0, b.z1]) {
        const p = new THREE.Vector3(x, 0, z).add(shift).project(cam);
        minY = Math.min(minY, ((p.y + 1) / 2) * this.vp.height);
      }
    return minY;
  }

  /** Project with the active camera (the view being laid out) to frame px (origin bottom-left). */
  private project(v: THREE.Vector3): { x: number; y: number; ok: boolean } {
    const p = v.clone().project(this.activeCam);
    return { x: ((p.x + 1) / 2) * this.vp.width, y: ((p.y + 1) / 2) * this.vp.height, ok: p.z > -1 && p.z < 1 };
  }

  private screenDir(anchor: THREE.Vector3, dirs: THREE.Vector3[]): { x: number; y: number } {
    const p0 = this.project(anchor);
    let x = 0;
    let y = 0;
    for (const d of dirs) {
      const p1 = this.project(anchor.clone().add(d));
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.5 * this.pxScale) {
        x += dx / len;
        y += dy / len;
      }
    }
    const len = Math.hypot(x, y);
    return len > 1e-3 ? { x: x / len, y: y / len } : { x: 0, y: -1 };
  }

  /**
   * Axis tick / title labels of every view: projected from world anchors with the view's camera,
   * collision-culled softly against the HUD blocks, the captions and each other (across views).
   */
  private layoutAxisLabels(fp: FrameParams, occupied: Rect[]) {
    const s = this.settings!;
    const S = this.pxScale;
    const sy = Math.max(1e-4, fp.heightK) * s.heightScale * fp.elev;
    const hud = this.hud;
    const down = new THREE.Vector3(0, -1, 0);
    const gap = 7 * S;

    interface Placed {
      tt: TextTexture;
      rect: Rect;
      alpha: number;
      rot: number;
    }
    const placed: Placed[] = [];
    // Soft collision culling: a label fades out continuously as it approaches a higher-priority
    // one (instead of popping), so moving cameras / the intro never flicker labels on and off.
    const separation = (a: Rect, b: Rect) => Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
    const clearance = (rect: Rect) => {
      let c = 1;
      for (const o of occupied) c = Math.min(c, smoothstep(2 * S, 5 * S, separation(rect, o)));
      for (const o of placed) c = Math.min(c, smoothstep(3 * S, 6 * S, separation(rect, o.rect)));
      return c;
    };

    // Per-view context (camera, axes, clip, axis visibility, label directions, tick extents).
    const lay = this.cellLayout();
    const ctxs = this.views.map((view, vi) => {
      this.activeCam = view.cam;
      const ax = view.axes;
      const m = ax.model;
      const b = m.bounds;
      const e = ax.edges;
      const corner = this.valueAxisCorner(view);
      const outCorner = corner.clone().sub(ax.center).setY(0).normalize();
      // Axis visibility from projected axis length (degenerate axes fade out, e.g. gray in front view).
      const axisLen = (a: THREE.Vector3, c: THREE.Vector3) => {
        const p = this.project(a);
        const q = this.project(c);
        return Math.hypot(p.x - q.x, p.y - q.y) / S;
      };
      const lz = e.lumFront ? b.z1 : b.z0;
      const gxE = e.grayLeft ? b.x0 : b.x1;
      // Small multiples (3–6 panels) have small plates, not degenerate axes: the length thresholds
      // scale with the cell (a cell under 400 CSS px scales them down).
      const cell = lay.cells[vi] ?? lay.cells[0];
      const k = this.views.length >= 3 ? Math.min(1, Math.min(cell.w, cell.h) / S / 400) : 1;
      const lumVis = smoothstep(50 * k, 140 * k, axisLen(new THREE.Vector3(b.x0, 0, lz), new THREE.Vector3(b.x1, 0, lz)));
      const grayVis = smoothstep(50 * k, 140 * k, axisLen(new THREE.Vector3(gxE, 0, b.z0), new THREE.Vector3(gxE, 0, b.z1)));
      // The value axis fades only when it collapses; seen end-on is the polar-angle factor (alphaOf).
      // Never by its length: a low height cap or a small side-by-side cell makes it short, not
      // degenerate — its title stays and the tick collision pass thins crowded ticks.
      const valueVis = smoothstep(4, 12, axisLen(corner, corner.clone().setY(ax.valueTop * SY * sy)));
      const dirs = new Map<string, { x: number; y: number }>();
      const tmp = new THREE.Vector3();
      const dirFor = (spec: AxisLabelSpec) => {
        const key = `${spec.axis}${spec.panel}`;
        const hit = dirs.get(key);
        if (hit) return hit;
        let d: { x: number; y: number };
        if (spec.axis === 'value') d = this.screenDir(corner.clone().setY(0.5), [outCorner]);
        else {
          const mid = ax.anchor({ ...spec, coord: spec.axis === 'gray' ? (b.z0 + b.z1) / 2 : (m.panels[spec.panel].rect.x0 + m.panels[spec.panel].rect.x1) / 2 }, tmp).clone();
          d = this.screenDir(mid, [ax.outward(spec.axis), down]);
        }
        dirs.set(key, d);
        return d;
      };
      const alphaOf = (spec: AxisLabelSpec) => {
        if (spec.axis === 'lum') return fp.axes.lum * lumVis * ax.edgeFade.lum;
        if (spec.axis === 'gray') {
          const g = spec.gray !== undefined && fp.grayTickAlpha ? fp.grayTickAlpha(spec.gray) : 1;
          return fp.axes.gray * grayVis * g * ax.edgeFade.gray;
        }
        return fp.axes.value * valueVis * smoothstep(0.2, 0.45, fp.pose.phi);
      };
      const anchorOf = (spec: AxisLabelSpec) => (spec.axis === 'value' ? corner.clone().setY(spec.coord * SY * sy) : ax.anchor(spec, new THREE.Vector3()));
      const tickExtent: Record<string, number> = {};
      const specs = [...ax.labels].sort((p, q) => p.priority - q.priority);
      // Tick-label extent per axis (all candidates) so titles sit beyond the tick column.
      for (const spec of specs) {
        if (spec.kind !== 'tick' || alphaOf(spec) <= 0.003) continue;
        const tt = this.text.get(spec.text, spec.style, S);
        const d = dirFor(spec);
        const key = `${spec.axis}${spec.panel}`;
        tickExtent[key] = Math.max(tickExtent[key] ?? 0, Math.abs(d.x) * tt.w + Math.abs(d.y) * tt.h);
      }
      const topGray = m.grayTicks.length ? m.grayTicks[m.grayTicks.length - 1] : 255;
      // Small multiples (3–6 panels): an axis title only on the outer panels of the grid. A title
      // below / above its axis (a horizontal axis on screen) shows on the last / first row; one
      // left / right of it (a vertical axis) on the first / last panel of each row.
      const slot = lay.slots[vi];
      const showsTitle = (_spec: AxisLabelSpec, d: { x: number; y: number }) => {
        if (this.views.length < 3 || !slot) return true;
        if (Math.abs(d.y) >= Math.abs(d.x)) return d.y <= 0 ? slot.row === lay.rows - 1 : slot.row === 0;
        return d.x <= 0 ? slot.first : slot.last;
      };
      return {
        view,
        showsTitle,
        region: this.views.length > 1 ? lay.regions[vi] : null,
        clip: this.clips[vi] ?? null,
        specs,
        dirFor,
        alphaOf,
        anchorOf,
        tickExtent,
        topGray,
        rulers: new Map<string, { d: { x: number; y: number }; alpha: number; ticks: { x: number; y: number; alpha: number }[] }>(),
      };
    });

    // Titles first (they matter more than any single tick), then ticks around them — every view.
    for (const pass of ['title', 'tick'] as const) {
      for (const c of ctxs) {
        this.activeCam = c.view.cam;
        const clip = c.clip;
        for (const spec of c.specs) {
          if (spec.kind !== pass) continue;
          let alpha = c.alphaOf(spec);
          if (spec.axis === 'gray' && spec.kind === 'title' && fp.grayTickAlpha) alpha *= fp.grayTickAlpha(c.topGray);
          if (alpha <= 0.003) continue;
          const anchorW = c.anchorOf(spec);
          const tt = this.text.get(spec.text, spec.style, S);
          const d = c.dirFor(spec);
          if (pass === 'title' && !c.showsTitle(spec, d)) continue;
          const a = this.project(anchorW);
          if (!a.ok) continue;
          // Plot clipped (zoomed / panned): in orthographic views the axes are pinned to the clip
          // edges (screen rulers) and ticks outside the visible range fade out; elsewhere a label
          // whose anchor left the plot area hides (it would sit over the title / colorbar).
          if (clip) {
            const cx = Math.min(clip.x1, Math.max(clip.x0, a.x));
            const cy = Math.min(clip.y1, Math.max(clip.y0, a.y));
            const dx = cx - a.x;
            const dy = cy - a.y;
            if (Math.abs(dx) + Math.abs(dy) > 0.5) {
              if (!(fp.pose.persp <= 0 && spec.axis !== 'value' && (Math.abs(d.x) > 0.95 || Math.abs(d.y) > 0.95))) continue;
              const across = Math.abs(dx * d.y - dy * d.x);
              if (spec.kind === 'tick') alpha *= 1 - smoothstep(0, 8 * S, across);
              if (alpha <= 0.003) continue;
              a.x = cx;
              a.y = cy;
              const key = `${spec.axis}${spec.panel}`;
              const r = c.rulers.get(key) ?? { d, alpha: 0, ticks: [] as { x: number; y: number; alpha: number }[] };
              r.alpha = Math.max(r.alpha, pass === 'title' ? alpha : c.alphaOf(spec));
              if (spec.kind === 'tick') r.ticks.push({ x: cx, y: cy, alpha });
              c.rulers.set(key, r);
            }
          }
          const key = `${spec.axis}${spec.panel}`;
          let rot = 0;
          let w = tt.w;
          let h = tt.h;
          let cx: number;
          let cy: number;
          if (pass === 'title' && spec.axis === 'value') {
            // Above the top tick of the vertical axis.
            cx = a.x + d.x * (gap + tt.w / 2);
            cy = a.y + tt.h * 1.25 + 6 * S;
          } else {
            if (pass === 'title' && spec.rotateWhenVertical && Math.abs(d.x) > 0.8) {
              rot = d.x < 0 ? Math.PI / 2 : -Math.PI / 2;
              w = tt.h;
              h = tt.w;
            }
            const ext = pass === 'title' ? (c.tickExtent[key] ?? 0) + (c.tickExtent[key] ? 7 * S : 0) : 0;
            const off = gap + ext + Math.abs(d.x) * (w / 2) + Math.abs(d.y) * (h / 2);
            cx = a.x + d.x * off;
            cy = a.y + d.y * off;
          }
          const rect: Rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
          if (rect.x0 < 2 || rect.y0 < 2 || rect.x1 > this.vp.width - 2 || rect.y1 > this.vp.height - 2) continue;
          // Zoomed / panned side by side: a label never crosses into the other panel's cell.
          const g = c.region;
          if (clip && g && (cx < g.x || cx > g.x + g.w || cy < g.y || cy > g.y + g.h)) continue;
          // Labels sit on the plate: terrain in front of them (e.g. perspective bars leaning over an
          // axis) fades them out instead of drawing text over the terrain.
          alpha *= this.labelVisibility(anchorW, rect, fp, c.view);
          if (alpha <= 0.003) continue;
          alpha *= clearance(rect);
          if (alpha <= 0.003) continue;
          placed.push({ tt, rect, alpha, rot });
        }
      }
    }
    // Screen rulers along the clip edges carrying pinned axes (+ their tick marks).
    for (const c of ctxs) {
      const clip = c.clip;
      if (!clip) continue;
      const lw = Math.max(1, Math.round(1.25 * S));
      const tl = Math.round(5 * S);
      for (const r of c.rulers.values()) {
        const a = r.alpha * 0.95;
        if (Math.abs(r.d.x) > 0.95) {
          const x = r.d.x < 0 ? clip.x0 - lw : clip.x1;
          hud.rule(x, clip.y1, lw, clip.y1 - clip.y0, a);
          for (const t of r.ticks) hud.rule(r.d.x < 0 ? x - tl : x + lw, t.y + lw / 2, tl, lw, t.alpha * 0.95);
        } else {
          const y = r.d.y < 0 ? clip.y0 : clip.y1 + lw;
          hud.rule(clip.x0, y, clip.x1 - clip.x0, lw, a);
          for (const t of r.ticks) hud.rule(t.x - lw / 2, r.d.y < 0 ? y - lw : y + tl, lw, tl, t.alpha * 0.95);
        }
      }
    }
    for (const p of placed) hud.quad(p.tt.texture, p.rect.x0, p.rect.y1, p.tt.w, p.tt.h, p.alpha, p.rot);
  }

  private readonly occRay = new THREE.Raycaster();

  /**
   * Fraction (0..1) of a screen rect not hidden by terrain in front of its world anchor. Rays
   * through 5 points of the rect (view's camera) march the view's terrain heightfield up to the
   * anchor's depth.
   */
  private labelVisibility(anchor: THREE.Vector3, rect: Rect, fp: FrameParams, view: ViewSlot): number {
    if (fp.heightK < 0.01 || !this.model) return 1;
    const s = this.settings!;
    const sy = fp.heightK * s.heightScale * fp.elev;
    const m = this.model;
    const b = view.bounds;
    const yMax = Math.max(0.01, m.plotMax * SY * sy);
    const cam = view.cam;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const W = this.vp.width;
    const H = this.vp.height;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const pts = [
      [rect.x0 + w * 0.5, rect.y0 + h * 0.5],
      [rect.x0 + w * 0.2, rect.y0 + h * 0.3],
      [rect.x1 - w * 0.2, rect.y0 + h * 0.3],
      [rect.x0 + w * 0.2, rect.y1 - h * 0.3],
      [rect.x1 - w * 0.2, rect.y1 - h * 0.3],
    ];
    const useBars = fp.barsOpacity > 0.5 || fp.surfaceOpacity < 0.5;
    const ndc = new THREE.Vector2();
    const pos = new THREE.Vector3();
    let visible = 0;
    for (const [px, py] of pts) {
      ndc.set((px / W) * 2 - 1, (py / H) * 2 - 1);
      this.occRay.setFromCamera(ndc, cam);
      const { origin, direction } = this.occRay.ray;
      const denom = direction.dot(fwd);
      const tMax = anchor.clone().sub(origin).dot(fwd) / Math.max(1e-6, denom) - 0.05;
      // Clip the march to the terrain's bounding box.
      let t0 = 0;
      let t1 = tMax;
      const clipAxis = (o: number, d: number, lo: number, hi: number) => {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) t1 = -1;
          return;
        }
        let a = (lo - o) / d;
        let c = (hi - o) / d;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
      };
      clipAxis(origin.x, direction.x, b.x0, b.x1);
      clipAxis(origin.y, direction.y, 0, yMax);
      clipAxis(origin.z, direction.z, b.z0, b.z1);
      let hit = false;
      if (t1 > t0) {
        const steps = Math.min(160, Math.max(8, Math.ceil((t1 - t0) / 0.08)));
        for (let k = 0; k <= steps && !hit; k++) {
          const t = t0 + ((t1 - t0) * k) / steps;
          pos.copy(origin).addScaledVector(direction, t);
          for (const pi of view.panels) {
            const pc = this.panels[pi];
            if (!pc) continue;
            const unit = useBars ? pc.barHeight(pos.x, pos.z, pi === 0 ? fp.growth : null) : (pc.surfaceHeight(pos.x, pos.z) ?? 0);
            if (unit > 0 && pos.y < unit * sy - 1e-3) {
              hit = true;
              break;
            }
          }
        }
      }
      if (!hit) visible++;
    }
    return visible / pts.length;
  }

  /**
   * Fraction (0..1) of a contour label's sight lines not blocked by terrain: rays from the view's
   * camera to nine points across the label (at its anchor on the surface), ignoring the last
   * stretch right in front of the anchor (the surface the label sits on).
   */
  private spriteSightline(anchor: THREE.Vector3, halfWidth: number, fp: FrameParams, view: ViewSlot): number {
    const m = this.model;
    if (!m) return 1;
    const s = this.settings!;
    const sy = fp.heightK * s.heightScale * fp.elev;
    const b = view.bounds;
    const yMax = Math.max(0.01, m.plotMax * SY * sy);
    const cam = view.cam;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const ortho = !(cam instanceof THREE.PerspectiveCamera);
    const useBars = fp.barsOpacity > 0.5 || fp.surfaceOpacity < 0.5;
    const clearance = 0.3 + 0.25 * fp.heightK;
    const target = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const pos = new THREE.Vector3();
    let clear = 0;
    const offs = [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -0.95, 0.95];
    for (const o of offs) {
      target.copy(anchor).addScaledVector(right, o * halfWidth);
      if (ortho) origin.copy(target).addScaledVector(fwd, -1000);
      else origin.copy(cam.position);
      dir.copy(target).sub(origin);
      const len = dir.length();
      dir.divideScalar(Math.max(1e-9, len));
      let t0 = 0;
      let t1 = len - clearance;
      const clipAxis = (oo: number, d: number, lo: number, hi: number) => {
        if (Math.abs(d) < 1e-9) {
          if (oo < lo || oo > hi) t1 = -1;
          return;
        }
        let a = (lo - oo) / d;
        let c = (hi - oo) / d;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
      };
      clipAxis(origin.x, dir.x, b.x0, b.x1);
      clipAxis(origin.y, dir.y, Math.min(0, m.plotMin * SY * sy), yMax);
      clipAxis(origin.z, dir.z, b.z0, b.z1);
      let hit = false;
      if (t1 > t0) {
        const steps = Math.min(96, Math.max(8, Math.ceil((t1 - t0) / 0.06)));
        for (let k = 0; k <= steps && !hit; k++) {
          pos.copy(origin).addScaledVector(dir, t0 + ((t1 - t0) * k) / steps);
          for (const pi of view.panels) {
            const pc = this.panels[pi];
            if (!pc || hit) continue;
            const unit = useBars ? pc.barHeight(pos.x, pos.z, pi === 0 ? fp.growth : null) : pc.surfaceHeight(pos.x, pos.z);
            if (unit === null) continue;
            const h = unit * sy;
            // Inside the terrain body (between the zero plane and the surface).
            if ((h > 0 && pos.y < h - 1e-3 && pos.y > -1e-3) || (h < 0 && pos.y > h + 1e-3 && pos.y < 1e-3)) hit = true;
          }
        }
      }
      if (!hit) clear++;
    }
    return clear / offs.length;
  }

  // ------------------------------------------------------------------ hover / picking

  private raycaster = new THREE.Raycaster();

  pick(ndcX: number, ndcY: number): HoverInfo | null {
    if (!this.model || this.introDriving || this.exporting) return this.setHover(null);
    // The view under the pointer (side-by-side: the panel's cell) and its camera.
    const px = ((ndcX + 1) / 2) * this.vp.width;
    const py = ((ndcY + 1) / 2) * this.vp.height;
    const vi = regionAt(this.cellLayout().regions, px, py);
    const view = this.views[vi];
    if (!view) return this.setHover(null);
    // Terrain cut away by the plot clip is not shown: nothing to pick there.
    const clip = this.clips[vi];
    if (clip && (px < clip.x0 || px > clip.x1 || py < clip.y0 || py > clip.y1)) return this.setHover(null);
    const s = this.settings!;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), view.cam);
    this.world.updateMatrixWorld(true);
    let best: { dist: number; panel: number; r: number; c: number } | null = null;
    this.panels.forEach((pc, i) => {
      if (!view.panels.includes(i)) return;
      const targets: THREE.Object3D[] = [];
      if (pc.bars.visible) targets.push(pc.bars);
      if (pc.surface.visible) targets.push(pc.surface, pc.walls);
      targets.push(pc.plate);
      const hits = this.raycaster.intersectObjects(targets, false);
      for (const h of hits) {
        let cell: { r: number; c: number } | null = null;
        if (h.object === pc.bars && h.instanceId !== undefined) {
          const b = pc.barInfo[h.instanceId];
          cell = { r: b.r, c: b.c };
        } else if (h.object === pc.walls && h.face) {
          // A wall lies on a cell edge and faces away from its cell: step back into that cell.
          cell = cellAt(pc.panel, h.point.x - h.face.normal.x * 1e-4, h.point.z - h.face.normal.z * 1e-4);
        } else cell = cellAt(pc.panel, h.point.x, h.point.z);
        if (!cell || pc.panel.values[cell.r]?.[cell.c] === undefined) continue;
        // A valid cell, or the (hatched) floor of a cell without valid data.
        if (pc.panel.values[cell.r][cell.c] !== null || h.object === pc.plate) {
          if (!best || h.distance < best.dist) best = { dist: h.distance, panel: i, r: cell.r, c: cell.c };
          break;
        }
      }
    });
    if (!best) return this.setHover(null);
    const { panel, r, c } = best as { dist: number; panel: number; r: number; c: number };
    this.setHover({ panel, r, c });
    const pm = this.model.panels[panel];
    const v = pm.view;
    const value = pm.values[r][c];
    const p = v.points[r][c];
    const info: HoverInfo = {
      panel: pm.id,
      label: recordLabel(pm.record, s.lang),
      gray: v.grays[r],
      percent: v.percents[c],
      levelNits: v.levelNits[c],
      nits: p ? p.nits : null,
      value,
      capped: value !== null && Math.abs(value) > this.model.heightCap,
      kind: pm.kind,
      range: this.model.colorMax,
      key: `${panel}:${r}:${c}`,
    };
    if (pm.kind === 'diff') {
      info.a = p ? p.svm : null;
      info.b = pm.otherValues?.[r]?.[c] ?? null;
    }
    if (value === null) info.missing = missingReason(pm, r, c);
    return info;
  }

  private setHover(cell: { panel: number; r: number; c: number } | null): null {
    const prev = this.hoverCell;
    const same = prev && cell && prev.panel === cell.panel && prev.r === cell.r && prev.c === cell.c;
    if (!same && (prev || cell)) {
      this.hoverCell = cell;
      this.invalidate();
    }
    return null;
  }

  private updateHoverOutline() {
    const cell = this.hoverCell;
    const hv = this.hover;
    // Never in intro frames or exports (the outline follows the pointer, it is not content).
    if (!cell || this.introFrame || this.exporting || !this.panels[cell.panel]) {
      hv.visible = false;
      return;
    }
    const pc = this.panels[cell.panel];
    if (hv.parent !== pc.heightGroup) pc.heightGroup.add(hv);
    const bar = pc.barInfo.find((b) => b.r === cell.r && b.c === cell.c);
    const pm = pc.panel;
    const x0 = pm.xe[cell.c];
    const x1 = pm.xe[cell.c + 1];
    const z0 = pm.ze[cell.r];
    const z1 = pm.ze[cell.r + 1];
    let y: number;
    if (!bar) {
      // A cell without valid data: outline its hatched floor (flat in every view).
      if (pm.values[cell.r]?.[cell.c] !== null) {
        hv.visible = false;
        return;
      }
      y = (this.plateY + 0.004) / Math.max(1e-6, pc.heightGroup.scale.y);
    } else {
      // Outline the bar top, or the cell on the flat heatmap (a 3D surface has no flat cell to outline).
      if (this.settings!.representation !== 'bars' && this.frame.heightK > 0.05) {
        hv.visible = false;
        return;
      }
      y = this.settings!.representation === 'bars' ? Math.max(0, bar.h) + 0.002 : 0.002;
    }
    const arr = (hv.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    arr.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y, z0]);
    hv.geometry.attributes.position.needsUpdate = true;
    hv.visible = true;
  }

  // ------------------------------------------------------------------ export

  /**
   * Resize rendering to exactly width×height px for an export. `scene` renders another layout /
   * view preset than the one on screen (offscreen: nothing changes on screen, endExport() restores
   * everything, the store is never touched).
   */
  beginExport(width: number, height: number, scene: ExportScene | null = null) {
    const gl = this.gl;
    if (!gl) return;
    this.exportSaved = { vp: { ...this.vp }, cssW: this.cssW, cssH: this.cssH, pxScale: this.pxScale, dpr: gl.getPixelRatio() };
    this.exporting = true;
    this.exportRebuilt = false;
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
    this.vp = { width, height };
    this.pxScale = Math.max(0.75, Math.min(width, height) / 800);
    this.cssW = width / this.pxScale;
    this.cssH = height / this.pxScale;
    if (scene && this.settings) {
      // The user's camera belongs to the screen: saved here, put back in endExport().
      const v = this.controls.view;
      this.exportRestore = { preset: this.preset, view: { theta: v.theta, phi: v.phi, zoom: v.zoom, pan: v.pan.clone() } };
      const screen = this.settings;
      this.exportScene = scene;
      this.sync(screen);
      // A view preset is exported at its default pose (also when it is the preset on screen).
      if (scene.view) this.controls.reset(defaultUserView());
    }
    this.onViewportChanged();
    // Finish static transitions instantly.
    this.camTransition = null;
    this.snapT0 = -1;
    const t = now() + 100;
    Object.values(this.tw).forEach((tw) => tw.jump(tw.value(t)));
    this.disposeSnapshot();
  }

  /** The intro is on screen (playing, paused or scrubbed before its end). */
  private introShowing(): boolean {
    const tl = this.intro?.tl;
    return !!tl && !!this.model && (tl.playing || tl.time < tl.duration - 1e-6);
  }

  /**
   * Render one export frame synchronously; t = intro time (video) or null = exactly what is on
   * screen: the static view, or the intro frame at the current timeline time while the intro is
   * open (paused / scrubbed) — never the static view behind it. `still` = the static view of the
   * export scene, also while the intro is open (export contents other than the screen / intro).
   */
  renderExport(t: number | null, still = false): void {
    if (!this.gl || !this.settings) return;
    let fp: FrameParams;
    this.introFrame = false;
    this.lastFrameOnScreen = false;
    if (still) {
      fp = this.staticFrame(now());
    } else if (t === null) {
      const plan = this.introShowing() ? this.ensurePlan() : null;
      fp = plan ? this.liveHud(plan.evaluate(Math.min(INTRO_DURATION, Math.max(0, this.intro!.tl.time)), this.frame)) : this.staticFrame(now());
      this.introFrame = !!plan;
    } else {
      if (this.settings.layout !== 'single' && this.layoutOverride !== 'single') {
        this.layoutOverride = 'single';
        this.sync(this.settings);
      }
      if (!this.intro) this.intro = { tl: null as unknown as Timeline, plan: null, planKey: '' };
      const plan = this.ensurePlan();
      fp = plan ? plan.evaluate(Math.min(INTRO_DURATION, Math.max(0, t)), this.frame) : this.staticFrame(now());
      this.introFrame = !!plan;
    }
    this.render(fp, null, false);
    this.introFrame = false;
  }

  endExport(restoreIntro: Timeline | null) {
    const gl = this.gl;
    const saved = this.exportSaved;
    this.exportSaved = null;
    // Restore the on-screen size FIRST: the model rebuilds below (layout override of an intro video,
    // export scene, portrait depth of the export frame) then happen at the screen viewport, and
    // (`restoring`) never capture a cross-fade snapshot of an export-sized frame (it would be
    // stretched over the view) nor start a camera move.
    if (gl && saved) {
      gl.setPixelRatio(saved.dpr);
      gl.setSize(saved.cssW, saved.cssH, true);
      this.vp = saved.vp;
      this.cssW = saved.cssW;
      this.cssH = saved.cssH;
      this.pxScale = saved.pxScale;
    }
    // From here on the metrics are the screen's (the room kept for the floating controls decides
    // the side-by-side grid and plate depth): rebuilding with export metrics would leave a model
    // that differs from the one on screen before the export. `restoring` keeps it all instant.
    this.exporting = false;
    this.restoring = true;
    try {
      this.layoutOverride = null;
      if (this.intro && !this.intro.tl) this.intro = restoreIntro ? { tl: restoreIntro, plan: null, planKey: '' } : null;
      // Remove the export scene: back to the screen's settings, then the user's own camera.
      const screen = this.exportScene ? this.screenSettings : this.settings;
      this.exportScene = null;
      this.screenSettings = null;
      if (screen) this.sync(screen);
      const restore = this.exportRestore;
      this.exportRestore = null;
      if (restore) {
        this.preset = restore.preset;
        this.controls.reset(restore.view);
      }
      this.onViewportChanged();
      this.camTransition = null;
    } finally {
      this.restoring = false;
    }
    // Free the export-sized render targets; the next frame is drawn fresh at screen size.
    this.disposeSnapshot();
    // The model was rebuilt offscreen (and back): the React overlay learns the screen's result.
    if (this.exportRebuilt && this.modelResult) this.onModel(this.modelResult);
    this.exportRebuilt = false;
    this.invalidate();
  }

  /** The user has zoomed, panned or orbited away from the preset's default pose. */
  viewAdjusted(): boolean {
    const v = this.exportRestore?.view ?? this.controls.view;
    const d = defaultUserView();
    const orbit = this.preset === 'perspective' && (Math.abs(v.theta - d.theta) > 1e-3 || Math.abs(v.phi - d.phi) > 1e-3);
    return orbit || Math.abs(v.zoom) > 1e-3 || v.pan.lengthSq() > 1e-8;
  }

  /** Current intro time (s) while the intro is on screen, else null. */
  introTime(): number | null {
    const tl = this.intro?.tl;
    return tl && this.introShowing() ? Math.min(INTRO_DURATION, Math.max(0, tl.time)) : null;
  }

  /**
   * Whether `layout` can be rendered with the current records / settings (side-by-side and the
   * difference map need B; the difference map needs overlapping data). Pure data, no GPU work.
   */
  canRenderLayout(layout: SceneLayout): boolean {
    const s = this.screenSettings ?? this.settings;
    if (!s) return false;
    return buildModel({ layout, a: s.a, b: s.b, extras: s.extras, clipLowGray: s.clipLowGray, maxNits: s.maxNits, colorMax: s.colorMax, heightCap: s.heightCap }).ok;
  }

  /** Drop the cross-fade snapshot and its texture. */
  private disposeSnapshot() {
    this.snapTex?.dispose();
    this.snapTex = null;
    this.snapMat.uniforms.map.value = null;
    this.snapT0 = -1;
  }

  /** On-screen drawing-buffer size (device px), also while an export has resized the canvas. */
  screenSize(): Viewport {
    const vp = this.exportSaved?.vp ?? this.vp;
    return { width: vp.width, height: vp.height };
  }

  /**
   * File name of the intro video: the intro always shows record A alone (single layout, also when
   * side-by-side / difference is on screen), so the name is A's, never "A_vs_B".
   */
  introExportName(): string {
    const s = this.settings;
    if (!s?.a) return 'svm-3d';
    return `${recordLabel(s.a, s.lang)}_${translate(s.lang, 'scene3d.export.intro')}`;
  }

  /**
   * File name of a still image (PNG): the intro frame when the intro is on screen (paused /
   * scrubbed; the image shows that frame, see renderExport), e.g. "<A>_开场动画_5.0s"; else the
   * static view's name.
   */
  imageExportName(): string {
    const tl = this.intro?.tl;
    if (tl && this.introShowing()) return `${this.introExportName()}_${Math.min(INTRO_DURATION, Math.max(0, tl.time)).toFixed(1)}s`;
    return this.exportName();
  }

  /**
   * Label / info for export file names (static view): "<A>_vs_<B>" side by side, "<A>_vs_<B>_+N"
   * with N extra panels — or "并排对比_6条" / "side-by-side_6" when the record names would make
   * the name too long for safeFileName (80 characters, the view part must survive).
   */
  exportName(scene: ExportScene | null = null): string {
    // Named from the screen's settings with the scene applied (callable before beginExport()).
    const screen = this.screenSettings ?? this.settings;
    if (!screen || !this.model || !screen.a) return 'svm-3d';
    const s = exportSettings(screen, scene);
    const a = screen.a;
    const t = (k: string, v?: Record<string, string | number>) => translate(s.lang, k, v);
    const label = (r: SvmRecord) => recordLabel(r, s.lang);
    let base: string;
    if (s.layout === 'diff' && s.b) base = `diff_${label(a)}_vs_${label(s.b)}`;
    else if (s.layout === 'sideBySide' && s.b) {
      // The panels buildModel lays out: A, B and the extras C–F (at most MAX_COMPARE_PANELS).
      const n = Math.min(MAX_COMPARE_PANELS, 2 + (s.extras?.length ?? 0));
      base = `${label(a)}_vs_${label(s.b)}${n > 2 ? `_+${n - 2}` : ''}`;
      if (n > 2 && base.length > 56) base = t('scene3d.export.sideBySideN', { n });
    } else base = label(a);
    return `${base}_${t(`scene3d.representation.${s.representation}`)}_${t(`scene3d.views.${s.view}`)}`;
  }

  /** Camera orientation (for a view gizmo). */
  get pose(): CamPose {
    return this.lastPose;
  }

  get basis() {
    return poseBasis(this.lastPose.theta, this.lastPose.phi);
  }
}

/**
 * Why a cell has no valid data (docs/adr/0012): the rule that excluded its raw point, looked up in
 * the record's `excluded` list by gray + brightness %. For a difference map, A's own cell first,
 * then the B cells the resampling needs at that spot.
 */
export function missingReason(pm: PanelModel, r: number, c: number): NonNullable<HoverInfo['missing']> {
  const find = (rec: SvmRecord | undefined, gray: number, percent: number) =>
    rec?.excluded?.find((x) => x.gray === gray && Math.abs(x.brightnessPercent - percent) < 1e-9) ?? null;
  const v = pm.view;
  const diff = pm.kind === 'diff';
  if (!v.points[r][c]) {
    const x = find(pm.record, v.grays[r], v.percents[c]);
    return { reason: (x?.reason as AnomalyKind) ?? null, who: diff ? 'A' : undefined, raw: x ? { nits: x.nits, svm: x.svm } : undefined };
  }
  if (!diff || !pm.other) return { reason: null };
  // B is bilinearly resampled at A's (level luminance, gray): report an excluded bracketing cell.
  const bv = gridView(pm.other);
  const ci = bracket(bv.x, v.x[c]);
  const ri = bracket(bv.grays, v.grays[r]);
  if (ci >= 0 && ri >= 0) {
    for (const rr of [ri, Math.min(ri + 1, bv.grays.length - 1)])
      for (const cc of [ci, Math.min(ci + 1, bv.x.length - 1)]) {
        if (bv.points[rr][cc]) continue;
        const x = find(pm.other, bv.grays[rr], bv.percents[cc]);
        if (x) return { reason: x.reason as AnomalyKind, who: 'B' };
      }
  }
  return { reason: null, who: 'B' };
}
