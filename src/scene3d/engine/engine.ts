/**
 * Imperative 3D engine for the terrain view. React only feeds it settings and viewport changes;
 * every frame is computed here from a FrameParams (static transitions or the intro timeline) and
 * applied through uniforms / instance matrices / camera — no React state per frame.
 */
import * as THREE from 'three';
import type { Lang, LightingMode, Representation, SceneLayout, SvmRecord, ViewPreset } from '../../types';
import { ColormapType } from '../../types';
import type { Overlays } from '../../store/appStore';
import { recordLabel } from '../../data/records';
import { translate } from '../../i18n';
import type { Timeline } from '../../timeline/timeline';
import { applyPose, clonePose, copyPose, fitPose, lerpPose, PERSP_TAN, poseBasis, type CamPose, type Insets, type Viewport } from './camera';
import { buildModel, cellAt, SY, type ModelResult, type PanelId, type SceneModel } from './model';
import { makeFloorMaterial, makeTerrainMaterial, setTerrainColormap, type ColorSpec, type TerrainUniforms } from './materials';
import { PanelContent } from './terrain';
import { Axes, type AxisLabelSpec } from './axes';
import { drawColorbarTexture, drawTitleTexture, Hud, type Rect } from './hud';
import { TextCache, type TextTexture } from './text';
import { buildValuesTexture } from './values';
import { easeInOutCubic, smoothstep, Tween } from './easing';
import { makeFrameParams, type FrameParams } from './frame';
import { DEFAULT_PHI, DEFAULT_THETA, ViewControls, defaultUserView } from './controls';
import { IntroPlan, INTRO_DURATION } from './intro';

export interface EngineSettings {
  lang: Lang;
  a: SvmRecord | null;
  b: SvmRecord | null;
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
}

export interface HoverInfo {
  panel: PanelId;
  label: string;
  gray: number;
  percent: number;
  levelNits: number;
  nits: number | null;
  value: number;
  capped: boolean;
  kind: 'svm' | 'diff';
  a?: number | null;
  b?: number | null;
  /** svm: colorMax; diff: symmetric color range. */
  range: number;
  key: string;
}

const CAM_DUR = 0.85;
const FADE_DUR = 0.4;
const SNAP_DUR = 0.45;

const PRESET_ORIENT: Record<Exclude<ViewPreset, 'perspective'>, { theta: number; phi: number }> = {
  top: { theta: 0, phi: 0 },
  front: { theta: 0, phi: Math.PI / 2 },
  side: { theta: Math.PI / 2, phi: Math.PI / 2 },
};

let clockOverride: number | null = null;
const now = () => clockOverride ?? performance.now() / 1000;
/** Visual tests: freeze the wall clock driving static transitions (seconds), or null to release. */
export function setDebugClock(t: number | null) {
  clockOverride = t;
}

export class Engine {
  gl: THREE.WebGLRenderer | null = null;
  readonly scene = new THREE.Scene();
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
  private axes: Axes | null = null;
  private readonly mats: {
    surface: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    walls: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    bars: THREE.ShaderMaterial & { uniforms: TerrainUniforms };
    plate: THREE.MeshBasicMaterial;
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
  private camTransition: { from: CamPose; t0: number; dur: number } | null = null;
  private readonly tw = {
    heightK: new Tween(1),
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

  // snapshot crossfade (any discontinuous static change)
  private snapRT: THREE.WebGLRenderTarget | null = null;
  private snapT0 = -1;
  private readonly snapScene = new THREE.Scene();
  private readonly snapQuad: THREE.Mesh;

  // intro
  private intro: { tl: Timeline; plan: IntroPlan | null; planKey: string } | null = null;
  private introDriving = false;

  // export
  exporting = false;
  private exportSaved: { vp: Viewport; cssW: number; cssH: number; pxScale: number; dpr: number } | null = null;

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
      plate: new THREE.MeshBasicMaterial({ color: '#10151d', transparent: true, depthWrite: true }),
    };
    this.mats.walls.side = THREE.DoubleSide;
    this.floorMat = makeFloorMaterial();
    const floorGeo = new THREE.PlaneGeometry(1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(floorGeo, this.floorMat);
    this.floor.renderOrder = -1;
    this.floor.frustumCulled = false;
    this.scene.add(this.floor);

    const hoverGeo = new THREE.BufferGeometry();
    hoverGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(15), 3));
    this.hover = new THREE.Line(hoverGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false }));
    this.hover.renderOrder = 20;
    this.hover.visible = false;
    this.hover.frustumCulled = false;

    const snapMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.snapQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), snapMat);
    this.snapScene.add(this.snapQuad);

    this.controls = new ViewControls({
      getFrame: () => ({
        theta: this.lastPose.theta,
        phi: this.lastPose.phi,
        h: this.lastPose.h,
        fitH: this.currentFit().h,
        widthCss: this.cssW,
        heightCss: this.cssH,
        ortho: this.preset !== 'perspective',
      }),
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
    this.snapRT?.dispose();
    this.snapRT = null;
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
    this.snapRT?.dispose();
    this.snapRT = null;
    this.snapT0 = -1;
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
    this.titleTex?.tt.texture.dispose();
    this.titleTex = null;
    this.colorbarTex?.tt.texture.dispose();
    this.colorbarTex = null;
    this.contourKey = '';
    this.valuesKey = '';
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
    this.fits.clear();
    this.hud.resize(this.vp.width, this.vp.height);
    if (this.intro) this.intro.planKey = '';
    this.invalidate();
  }

  sync(s: EngineSettings) {
    const prev = this.settings;
    const t = now();
    const layout = this.layoutOverride ?? s.layout;
    const modelKey = [layout, s.a?.id, s.b?.id, s.clipLowGray, s.maxNits, s.heightCap, s.colorMax, s.lang].join('|');
    const recordsChanged = !prev || prev.a !== s.a || prev.b !== s.b;
    const needModel = modelKey !== this.modelKey || recordsChanged;
    const animate = !!prev && this.hasRendered && !this.introDriving && !this.exporting;
    const visualChange =
      !!prev &&
      (needModel || prev.representation !== s.representation || prev.colormap !== s.colormap || prev.lighting !== s.lighting || prev.lang !== s.lang);
    // Freeze the current image with the OLD settings; it cross-fades out over the new one.
    if (visualChange && animate) this.captureSnapshot();
    this.settings = s;

    if (needModel) {
      this.modelKey = modelKey;
      this.rebuildModel();
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
    }
    const ov = s.overlays;
    const fade = (tw: Tween, v: number) => (animate ? tw.set(v, t, FADE_DUR) : tw.jump(v));
    fade(this.tw.values, ov.values && s.view === 'top' ? 1 : 0);
    fade(this.tw.contours, ov.contours ? 1 : 0);
    fade(this.tw.axes, ov.axes ? 1 : 0);
    fade(this.tw.title, ov.title ? 1 : 0);
    fade(this.tw.colorbar, ov.colorbar ? 1 : 0);
    fade(this.tw.captions, s.layout === 'sideBySide' && ov.axes ? 1 : 0);
    if (prev && (prev.heightScale !== s.heightScale || prev.overlays.title !== ov.title || prev.overlays.colorbar !== ov.colorbar)) this.fits.clear();
    if (prev && prev.lang !== s.lang) this.contourKey = '';
    this.invalidate();
  }

  private setPreset(view: ViewPreset, immediate: boolean) {
    const from = clonePose(this.lastPose);
    this.preset = view;
    this.controls.reset(defaultUserView());
    if (immediate) this.camTransition = null;
    else this.camTransition = { from, t0: now(), dur: CAM_DUR };
    this.invalidate();
  }

  /** Reset zoom / pan / orbit of the current preset with a smooth move. */
  fitView() {
    if (!this.model) return;
    this.camTransition = { from: clonePose(this.lastPose), t0: now(), dur: CAM_DUR * 0.8 };
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
    if (this.axes) {
      this.world.remove(this.axes.group);
      this.axes.dispose();
      this.axes = null;
    }
    this.hover.removeFromParent();
  }

  private rebuildModel() {
    const s = this.settings!;
    this.clearContent();
    const res = buildModel({ layout: this.layoutOverride ?? s.layout, a: s.a, b: s.b, clipLowGray: s.clipLowGray, maxNits: s.maxNits, colorMax: s.colorMax, heightCap: s.heightCap });
    this.modelResult = res;
    this.model = res.ok ? res.model : null;
    this.fits.clear();
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
      this.axes = new Axes(m, this.axisTexts());
      this.world.add(this.axes.group);
      this.panels[0]?.heightGroup.add(this.hover);
      const b = m.bounds;
      const R = Math.max(b.x1 - b.x0, b.z1 - b.z0);
      this.floor.scale.set(R * 2.6, 1, R * 2.6);
      this.floor.position.set((b.x0 + b.x1) / 2, -0.03, (b.z0 + b.z1) / 2);
      this.floorMat.uniforms.uRadius.value = R * 1.3;
    }
    this.onModel(res);
  }

  private axisTexts() {
    const s = this.settings!;
    const t = (k: string) => translate(s.lang, k);
    const m = this.model!;
    return {
      lum: t('common.nitsLog'),
      gray: t('common.grayLevel'),
      value: m.kind === 'diff' ? 'ΔSVM' : 'SVM',
      captions:
        m.layout === 'sideBySide'
          ? m.panels.map((p) => `${p.id} · ${recordLabel(p.record, s.lang)}`)
          : [],
    };
  }

  /** Radius around the target that must stay between the near / far planes. */
  private sceneRadius() {
    const m = this.model;
    if (!m) return 20;
    const b = m.bounds;
    const hs = this.settings?.heightScale ?? 1;
    const tall = Math.max(8, (m.plotMax - Math.min(0, m.plotMin)) * SY * hs * 1.2);
    return Math.hypot(b.x1 - b.x0, b.z1 - b.z0, tall) * 0.6 + 4;
  }

  // ------------------------------------------------------------------ framing

  /** Pixel insets reserved for HUD / axis labels (drawing-buffer px). */
  insets(preset: ViewPreset | 'intro-front'): Insets {
    const s = this.settings;
    const S = this.pxScale;
    const portrait = this.vp.width / this.vp.height < 0.85;
    const ov = s?.overlays;
    const title = ov?.title ?? true;
    const cb = ov?.colorbar ?? true;
    const captions = this.model?.layout === 'sideBySide';
    let top = (title ? 84 : 30) + (captions ? 26 : 0);
    let right = cb && !portrait ? 96 : 30;
    let bottom = 62 + (cb && portrait ? 64 : 0);
    let left = 70;
    if (preset === 'perspective') {
      top += 6;
      bottom += 4;
    }
    if (preset === 'side' || preset === 'front') left += 6;
    // DOM controls floating over the canvas (timeline bar / viewport buttons) — not in exports.
    if (!this.exporting) bottom += this.uiInset;
    return { top: top * S, right: right * S, bottom: bottom * S, left: left * S };
  }

  private uiInset = 0;

  /**
   * Reserve room (CSS px) at the bottom for DOM overlays so they never cover the plot or its axis
   * labels. Changes re-frame smoothly.
   */
  setUiInset(bottomCss: number) {
    if (bottomCss === this.uiInset) return;
    this.uiInset = bottomCss;
    this.fits.clear();
    if (this.intro) this.intro.planKey = '';
    if (this.hasRendered && !this.introDriving && !this.exporting && this.model) {
      this.camTransition = { from: clonePose(this.lastPose), t0: now(), dur: CAM_DUR * 0.7 };
    }
    this.invalidate();
  }

  private boxPoints(flat: boolean, heightOnlyRow?: number): THREE.Vector3[] {
    const m = this.model!;
    const s = this.settings!;
    const scale = SY * s.heightScale;
    const b = m.bounds;
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
      if (preset === 'perspective') f = fitPose(this.boxPoints(false), DEFAULT_THETA, DEFAULT_PHI, PERSP_TAN, this.vp, this.insets(preset));
      else {
        const o = PRESET_ORIENT[preset];
        f = fitPose(this.boxPoints(preset === 'top'), o.theta, o.phi, 0, this.vp, this.insets(preset));
      }
      this.fits.set(key, f);
    }
    return f;
  }

  private currentFit() {
    return this.fitFor(this.preset);
  }

  /** Static camera pose for the current preset + user offsets. */
  private staticPose(out: CamPose): CamPose {
    const fit = this.currentFit();
    const v = this.controls.view;
    copyPose(fit, out);
    if (this.preset === 'perspective') {
      out.theta = v.theta;
      out.phi = v.phi;
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
      const fit = fitPose(pts, out.theta, out.phi, out.persp, this.vp, this.insets(this.preset));
      out.target.lerp(fit.target, w);
      out.h = Math.exp(Math.log(out.h) + (Math.log(fit.h) - Math.log(out.h)) * w);
    }
    return out;
  }

  private introFrontPose(): CamPose {
    const m = this.model!;
    const topRow = m.panels[0].values.length - 1;
    return fitPose(this.boxPoints(false, topRow), 0, 1.3, PERSP_TAN, this.vp, this.insets('intro-front'));
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
    const key = `${this.modelKey}|${this.vp.width}x${this.vp.height}|${JSON.stringify(this.settings?.overlays)}|${this.settings?.heightScale}`;
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
      show(pc.contourFull.line);
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
      fitAtPhi: (phi) => fitPose(this.boxPoints(false), 0, phi, PERSP_TAN, this.vp, this.insets('perspective')),
      overlays: this.settings!.overlays,
      levelCount: m.contourLevels.length,
    });
  }

  /** Switch from intro-driven frames to static ones without a visible jump. */
  private leaveIntro() {
    const fp = this.frame;
    if (this.hasRendered && !this.exporting) this.captureSnapshot();
    this.tw.heightK.jump(fp.heightK);
    this.tw.values.jump(fp.valuesOpacity);
    this.tw.contours.jump(fp.contourOpacity);
    const s = this.settings!;
    const T = now();
    this.tw.heightK.set(s.view === 'top' ? 0 : 1, T, CAM_DUR);
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

    const driving = !!this.intro && !!this.model && (this.intro.tl.playing || this.intro.tl.time < this.intro.tl.duration - 1e-6);
    if (this.introDriving && !driving) {
      if (this.intro && this.intro.tl.time >= this.intro.tl.duration - 1e-6) this.onIntroEnd();
      this.leaveIntro();
    }
    this.introDriving = driving;

    let fp: FrameParams;
    if (driving) {
      const plan = this.ensurePlan();
      fp = plan ? plan.evaluate(this.intro!.tl.time, this.frame) : this.staticFrame(t);
      more = this.intro!.tl.playing;
    } else {
      more = this.controls.update(dt) || more;
      fp = this.staticFrame(t);
      more = more || this.staticAnimating(t);
    }
    this.render(fp);
    if (this.snapT0 >= 0) more = true;
    return more;
  }

  private staticAnimating(t: number) {
    return !!this.camTransition || Object.values(this.tw).some((tw) => tw.active(t));
  }

  private staticFrame(t: number): FrameParams {
    const fp = this.frame;
    const s = this.settings;
    if (!s || !this.model) return fp;
    // camera
    const target = this.staticPose(fp.pose);
    fp.heightK = this.tw.heightK.value(t);
    if (this.camTransition) {
      const p = (t - this.camTransition.t0) / this.camTransition.dur;
      if (p >= 1) this.camTransition = null;
      else this.transitionPose(this.camTransition.from, clonePose(target), p, fp.heightK, fp.pose);
    }
    const surface = s.representation === 'surface';
    fp.surfaceOpacity = surface ? 1 : 0;
    fp.barsOpacity = surface ? 0 : 1;
    fp.onTop = s.representation;
    fp.growth = null;
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

  private ensureContourLayout() {
    const s = this.settings!;
    const top = this.fitFor('top');
    const wpc = (top.h / this.vp.height) * this.pxScale; // world per CSS px in the top fit
    const key = `${this.modelKey}|${wpc.toFixed(5)}|${this.pxScale}|${s.lang}`;
    if (key === this.contourKey) return;
    this.contourKey = key;
    const fmt = (v: number) => (this.model!.kind === 'diff' ? (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0') : v.toFixed(1));
    for (const p of this.panels) p.layoutContours(wpc, this.pxScale, fmt);
  }

  private ensureValues() {
    const s = this.settings!;
    const top = this.fitFor('top');
    const wpc = (top.h / this.vp.height) * this.pxScale;
    const key = `${this.modelKey}|${wpc.toFixed(4)}|${this.pxScale}|${s.colormap}|${this.model!.colorMax}`;
    if (key === this.valuesKey) return;
    this.valuesKey = key;
    for (const p of this.panels) {
      const tex = buildValuesTexture(p.panel, { worldPerCssPx: wpc, pxScale: this.pxScale, colormap: s.colormap, colorMax: this.model!.colorMax, inset: 0.12 });
      p.setValuesTexture(key, tex, () => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    }
  }

  private apply(fp: FrameParams) {
    const s = this.settings!;
    const m = this.model!;
    // camera
    this.activeCam = applyPose(fp.pose, this.vp, this.perspCam, this.orthoCam, this.sceneRadius());
    copyPose(fp.pose, this.lastPose);
    const camPos = this.activeCam.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.activeCam.quaternion);

    // terrain heights
    // Flat = heights scaled to ~0 (not exactly: the normal transform needs an invertible scale).
    const k = Math.max(1e-6, fp.heightK);
    const sy = k * s.heightScale;
    const colorScale = m.kind === 'diff' ? 1 / Math.max(1e-6, m.colorMax) : 4 / Math.max(1e-6, m.colorMax);
    for (const mat of [this.mats.surface, this.mats.walls, this.mats.bars]) {
      const u = mat.uniforms;
      u.uColorScale.value = colorScale;
      u.uLighting.value = s.lighting === 'studio' ? 1 : 0;
      u.uSpec.value = smoothstep(0.05, 0.6, fp.heightK);
      u.uInvScaleY.value = 1 / Math.max(1e-6, sy);
      u.uCap.value = m.heightCap;
      u.uHatch.value = smoothstep(0.1, 0.7, fp.heightK);
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

    this.ensureContourLayout();
    if (fp.valuesOpacity > 0.002) this.ensureValues();

    this.panels.forEach((pc, i) => {
      pc.heightGroup.scale.set(1, sy, 1);
      pc.surface.visible = surfaceOn;
      pc.walls.visible = surfaceOn && fp.heightK > 0.004;
      pc.surface.renderOrder = surfTop ? 3 : 1;
      pc.walls.renderOrder = surfTop ? 3 : 1;
      pc.bars.renderOrder = surfTop ? 1 : 3;
      pc.bars.visible = barsOn;
      if (barsOn) pc.setGrowth(i === 0 ? fp.growth : null);
      pc.plate.position.y = plateY;
      // contours
      // Contours follow the surface; over 3D bars they would float inside the bars, so they only
      // show there once the bars are (nearly) flat.
      // Elevation views (front / side) see contours edge-on: fade them out as the camera levels.
      const cOp = fp.contourOpacity * Math.max(fp.surfaceOpacity, smoothstep(0.35, 0.02, fp.heightK)) * smoothstep(1.45, 1.2, fp.pose.phi);
      pc.contourGroup.visible = cOp > 0.002;
      pc.contourGroup.scale.set(1, sy, 1);
      pc.contourGroup.position.y = 0.012 + (1 - fp.heightK) * 0.004;
      // Gapped lines while labels show; continuous lines while the value table hides the labels.
      const labelsShown = 1 - fp.valuesOpacity;
      pc.contourCut.setStyle(cOp * 0.92 * labelsShown, 1.7 * this.pxScale);
      pc.contourFull.setStyle(cOp * 0.92 * (1 - labelsShown), 1.7 * this.pxScale);
      if (pc.contourGroup.visible) pc.setContourReveal(fp.contourReveal);
      // contour labels: world billboards following the surface, pulled toward the camera so the
      // surface they sit on never clips them.
      for (const sp of pc.labelSprites) {
        const lb = sp.userData.label as { x: number; y: number; z: number; u: number; levelIndex: number };
        const rev = fp.contourReveal ? (fp.contourReveal[lb.levelIndex] ?? 1) : 1;
        // Values already print the numbers: contour labels step aside while the table shows.
        const a = cOp * fp.contourLabelOpacity * smoothstep(lb.u, lb.u + 0.12, rev) * (1 - fp.valuesOpacity);
        sp.visible = a > 0.003;
        (sp.material as THREE.SpriteMaterial).opacity = a;
        const anchor = new THREE.Vector3(lb.x, lb.y * sy + 0.012, lb.z);
        sp.userData.baseScale ??= sp.scale.clone();
        const base = sp.userData.baseScale as THREE.Vector3;
        const nominalPx = (sp.userData.nominalPx as number) ?? 16;
        let sc = 1;
        let projPx: number;
        const cam = this.activeCam;
        if (cam instanceof THREE.PerspectiveCamera) {
          const dir = anchor.clone().sub(camPos);
          const dist = dir.length();
          const pull = Math.min(dist * 0.5, 1.2 * fp.heightK + 0.05);
          anchor.addScaledVector(dir.normalize(), -pull);
          sc = (dist - pull) / dist;
          const depth = Math.max(1e-3, anchor.clone().sub(camPos).dot(fwd));
          projPx = ((base.y * sc) / (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)))) * this.vp.height;
        } else {
          const oc = cam as THREE.OrthographicCamera;
          projPx = (base.y / Math.max(1e-6, oc.top - oc.bottom)) * this.vp.height;
        }
        // World-sized labels (they belong to the plot), but kept within a legible size range.
        const clampPx = THREE.MathUtils.clamp(projPx, nominalPx * 0.75, nominalPx * 1.45);
        sp.scale.copy(base).multiplyScalar(sc * (clampPx / Math.max(1e-6, projPx)));
        sp.position.copy(anchor);
      }
      // values
      if (pc.valuesMesh) {
        const vm = pc.valuesMesh.material as THREE.MeshBasicMaterial;
        vm.opacity = fp.valuesOpacity;
        pc.valuesMesh.visible = fp.valuesOpacity > 0.002;
      }
    });

    // floor + plate
    this.floorMat.uniforms.uOpacity.value = fp.ground;
    this.floor.visible = fp.ground > 0.01;
    this.floor.position.y = plateY - 0.02;

    // axes
    if (this.axes) {
      const ax = this.axes;
      ax.chooseEdges(camPos, new THREE.Vector3(0, 0, -1).applyQuaternion(this.activeCam.quaternion));
      const lines = Math.max(fp.axes.lum, fp.axes.gray) * 0.95;
      ax.setStyle(this.pxScale, { lines, grid: fp.ground * Math.max(fp.axes.lum, fp.axes.gray) * 0.9, value: fp.axes.value * smoothstep(0.2, 0.45, fp.pose.phi) });
      ax.valueGroup.scale.set(1, sy, 1);
      const corner = this.valueAxisCorner();
      ax.valueGroup.position.set(corner.x, 0, corner.z);
      const out = corner.clone().sub(ax.center).setY(0).normalize();
      ax.valueGroup.rotation.y = Math.atan2(-out.z, out.x);
    }

    // hover outline
    this.updateHoverOutline();

    // background
    this.scene.background = null;
  }

  private valueAxisCorner(): THREE.Vector3 {
    const ax = this.axes!;
    let best = ax.corners[0];
    let bestX = Infinity;
    let bestDepth = -Infinity;
    const cam = this.activeCam;
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
      gl.render(this.scene, this.activeCam);
      gl.clearDepth();
      gl.render(this.hud.scene, this.hud.camera);
    }
    if (withSnapshot && this.snapRT && this.snapT0 >= 0 && !target) {
      const p = (now() - this.snapT0) / SNAP_DUR;
      if (p >= 1) this.snapT0 = -1;
      else {
        const mat = this.snapQuad.material as THREE.MeshBasicMaterial;
        mat.map = this.snapRT.texture;
        mat.opacity = 1 - easeInOutCubic(p);
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

  /** Freeze the current image; it fades out over the next frames (hides discontinuities). */
  private captureSnapshot() {
    const gl = this.gl;
    if (!gl || !this.settings || !this.model || this.vp.width < 4) return;
    const { width, height } = this.vp;
    if (!this.snapRT || this.snapRT.width !== width || this.snapRT.height !== height) {
      this.snapRT?.dispose();
      this.snapRT = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    }
    // If a snapshot is still fading, keep showing it instead of re-capturing a blend.
    if (this.snapT0 >= 0 && now() - this.snapT0 < SNAP_DUR * 0.5) return;
    this.render(this.frame, this.snapRT, false);
    this.snapT0 = now();
  }

  // ------------------------------------------------------------------ HUD

  private titleSpec() {
    const s = this.settings!;
    const m = this.model!;
    const t = (k: string, v?: Record<string, string | number>) => translate(s.lang, k, v);
    const clip = s.clipLowGray ? ` · ${t('common.lowGrayClipped')}` : '';
    if (m.layout === 'diff') {
      const p = m.panels[0];
      return {
        title: t('scene3d.title.diff'),
        subtitle: `A: ${recordLabel(p.record, s.lang)}  ·  B: ${recordLabel(p.other!, s.lang)}`,
      };
    }
    if (m.layout === 'sideBySide') return { title: t('scene3d.title.sideBySide'), subtitle: `${t('scene3d.subtitle.svm')}${clip}` };
    return { title: recordLabel(m.panels[0].record, s.lang), subtitle: `${t('scene3d.subtitle.svm')}${clip}` };
  }

  private layoutHud(fp: FrameParams) {
    const s = this.settings!;
    const m = this.model!;
    const hud = this.hud;
    const S = this.pxScale;
    const W = this.vp.width;
    const H = this.vp.height;
    const margin = 20 * S;
    const t = (k: string) => translate(s.lang, k);
    hud.begin();
    const occupied: Rect[] = [];

    // title
    if (fp.hud.title > 0.003) {
      const spec = this.titleSpec();
      const maxW = Math.max(160, this.vp.width / S - 200);
      const key = `${spec.title}|${spec.subtitle}|${S}|${maxW}|${s.background}`;
      if (this.titleTex?.key !== key) {
        this.titleTex?.tt.texture.dispose();
        this.titleTex = { key, tt: drawTitleTexture(spec, S, maxW, s.background) };
      }
      const tt = this.titleTex.tt;
      hud.quad(tt.texture, margin - tt.inset, H - margin + tt.inset, tt.w, tt.h, fp.hud.title);
      occupied.push({ x0: margin, y0: H - margin - tt.h + 2 * tt.inset, x1: margin + tt.w - 2 * tt.inset, y1: H - margin });
    }

    // colorbar
    const portrait = W / H < 0.85;
    if (fp.hud.colorbar > 0.003) {
      const len = portrait ? Math.min(420, (W / S) * 0.6) : Math.max(120, Math.min(300, (H / S) * 0.42));
      const diff = m.kind === 'diff';
      const spec = {
        kind: m.kind,
        colormap: s.colormap,
        max: m.colorMax,
        title: diff ? t('scene3d.colorbar.delta') : 'SVM',
        marks: s.overlays.contours ? m.contourLevels.filter((v) => (diff ? v !== 0 || true : true)) : [],
        ends: diff ? ([t('scene3d.colorbar.aBetter'), t('scene3d.colorbar.aWorse')] as [string, string]) : undefined,
        orientation: portrait ? ('horizontal' as const) : ('vertical' as const),
        length: Math.round(len),
      };
      const key = `${JSON.stringify(spec)}|${S}|${s.background}`;
      if (this.colorbarTex?.key !== key) {
        this.colorbarTex?.tt.texture.dispose();
        this.colorbarTex = { key, tt: drawColorbarTexture(spec, S, s.background) };
      }
      const tt = this.colorbarTex.tt;
      const ins = this.insets(this.preset);
      let x: number;
      let yTop: number;
      if (portrait) {
        // Portrait: right under the (top-view) plot and its axis labels, not at the frame edge.
        x = (W - tt.w) / 2;
        const plotBottom = this.fitPlotBottom();
        yTop = Math.max(margin + tt.h, Math.min(ins.bottom + tt.h, plotBottom - 64 * S));
      } else {
        x = W - margin - tt.w;
        const mid = (ins.bottom + (H - ins.top)) / 2;
        yTop = Math.min(H - margin - 4 * S, mid + tt.h / 2);
      }
      hud.quad(tt.texture, x, yTop, tt.w, tt.h, fp.hud.colorbar);
      occupied.push({ x0: x + tt.inset, y0: yTop - tt.h + tt.inset, x1: x + tt.w - tt.inset, y1: yTop - tt.inset });
    }

    // axis labels
    if (this.axes) this.layoutAxisLabels(fp, occupied);
    hud.end();
  }

  private readonly scratchPersp = new THREE.PerspectiveCamera();
  private readonly scratchOrtho = new THREE.OrthographicCamera();

  /** Bottom edge (px, origin bottom-left) of the plate in the static top-view framing. */
  private fitPlotBottom(): number {
    const cam = applyPose(this.fitFor('top'), this.vp, this.scratchPersp, this.scratchOrtho, this.sceneRadius());
    const b = this.model!.bounds;
    let minY = Infinity;
    for (const x of [b.x0, b.x1])
      for (const z of [b.z0, b.z1]) {
        const p = new THREE.Vector3(x, 0, z).project(cam);
        minY = Math.min(minY, ((p.y + 1) / 2) * this.vp.height);
      }
    return minY;
  }

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

  private layoutAxisLabels(fp: FrameParams, occupied: Rect[]) {
    const ax = this.axes!;
    const s = this.settings!;
    const S = this.pxScale;
    const sy = Math.max(1e-4, fp.heightK) * s.heightScale;
    const m = this.model!;
    const hud = this.hud;
    const corner = this.valueAxisCorner();
    const outCorner = corner.clone().sub(ax.center).setY(0).normalize();
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const b = m.bounds;
    const e = ax.edges;

    // Axis visibility from projected axis length (degenerate axes fade out, e.g. gray in front view).
    const axisLen = (a: THREE.Vector3, c: THREE.Vector3) => {
      const p = this.project(a);
      const q = this.project(c);
      return Math.hypot(p.x - q.x, p.y - q.y) / S;
    };
    const lz = e.lumFront ? b.z1 : b.z0;
    const gxE = e.grayLeft ? b.x0 : b.x1;
    const lumVis = smoothstep(50, 140, axisLen(new THREE.Vector3(b.x0, 0, lz), new THREE.Vector3(b.x1, 0, lz)));
    const grayVis = smoothstep(50, 140, axisLen(new THREE.Vector3(gxE, 0, b.z0), new THREE.Vector3(gxE, 0, b.z1)));
    const valueVis = smoothstep(30, 90, axisLen(corner, corner.clone().setY(ax.valueTop * SY * sy)));
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
        d = this.screenDir(mid, [ax.outward(spec.axis), spec.axis === 'caption' ? up : down]);
      }
      dirs.set(key, d);
      return d;
    };

    interface Placed {
      tt: TextTexture;
      rect: Rect;
      alpha: number;
      rot: number;
    }
    const placed: Placed[] = [];
    const tickExtent: Record<string, number> = {};
    const gap = 7 * S;
    const specs = [...ax.labels].sort((p, q) => p.priority - q.priority);

    const alphaOf = (spec: AxisLabelSpec) => {
      if (spec.axis === 'lum') return fp.axes.lum * lumVis * ax.edgeFade.lum;
      if (spec.axis === 'gray') {
        const g = spec.gray !== undefined && fp.grayTickAlpha ? fp.grayTickAlpha(spec.gray) : 1;
        return fp.axes.gray * grayVis * g * ax.edgeFade.gray;
      }
      if (spec.axis === 'value') return fp.axes.value * valueVis * smoothstep(0.2, 0.45, fp.pose.phi);
      return fp.axes.captions;
    };
    const topGray = m.grayTicks.length ? m.grayTicks[m.grayTicks.length - 1] : 255;
    const anchorOf = (spec: AxisLabelSpec) => {
      if (spec.axis === 'value') return corner.clone().setY(spec.coord * SY * sy);
      return ax.anchor(spec, new THREE.Vector3());
    };
    // Soft collision culling: a label fades out continuously as it approaches a higher-priority
    // one (instead of popping), so moving cameras / the intro never flicker labels on and off.
    const separation = (a: Rect, b: Rect) => Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
    const clearance = (rect: Rect) => {
      let c = 1;
      for (const o of occupied) c = Math.min(c, smoothstep(2 * S, 5 * S, separation(rect, o)));
      for (const o of placed) c = Math.min(c, smoothstep(3 * S, 6 * S, separation(rect, o.rect)));
      return c;
    };

    // Tick-label extent per axis (all candidates) so titles sit beyond the tick column.
    for (const spec of specs) {
      if (spec.kind !== 'tick' || alphaOf(spec) <= 0.003) continue;
      const tt = this.text.get(spec.text, spec.style, S);
      const d = dirFor(spec);
      const key = `${spec.axis}${spec.panel}`;
      tickExtent[key] = Math.max(tickExtent[key] ?? 0, Math.abs(d.x) * tt.w + Math.abs(d.y) * tt.h);
    }
    // Titles first (they matter more than any single tick), then ticks around them.
    for (const pass of ['title', 'tick'] as const) {
      for (const spec of specs) {
        if (spec.kind !== pass) continue;
        let alpha = alphaOf(spec);
        if (spec.axis === 'gray' && spec.kind === 'title' && fp.grayTickAlpha) alpha *= fp.grayTickAlpha(topGray);
        if (alpha <= 0.003) continue;
        const tt = this.text.get(spec.text, spec.style, S);
        const d = dirFor(spec);
        const anchorW = anchorOf(spec);
        const a = this.project(anchorW);
        if (!a.ok) continue;
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
          const ext = pass === 'title' && spec.axis !== 'caption' ? (tickExtent[key] ?? 0) + (tickExtent[key] ? 7 * S : 0) : 0;
          const off = gap + ext + Math.abs(d.x) * (w / 2) + Math.abs(d.y) * (h / 2);
          cx = a.x + d.x * off;
          cy = a.y + d.y * off;
        }
        const rect: Rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        if (rect.x0 < 2 || rect.y0 < 2 || rect.x1 > this.vp.width - 2 || rect.y1 > this.vp.height - 2) continue;
        // Labels sit on the plate: terrain in front of them (e.g. perspective bars leaning over an
        // axis) fades them out instead of drawing text over the terrain.
        alpha *= this.labelVisibility(anchorW, rect, fp);
        if (alpha <= 0.003) continue;
        alpha *= clearance(rect);
        if (alpha <= 0.003) continue;
        placed.push({ tt, rect, alpha, rot });
      }
    }
    for (const p of placed) hud.quad(p.tt.texture, p.rect.x0, p.rect.y1, p.tt.w, p.tt.h, p.alpha, p.rot);
  }

  private readonly occRay = new THREE.Raycaster();

  /**
   * Fraction (0..1) of a screen rect not hidden by terrain in front of its world anchor. Rays
   * through 5 points of the rect march the terrain heightfield up to the anchor's depth.
   */
  private labelVisibility(anchor: THREE.Vector3, rect: Rect, fp: FrameParams): number {
    if (fp.heightK < 0.01 || !this.model) return 1;
    const s = this.settings!;
    const sy = fp.heightK * s.heightScale;
    const m = this.model;
    const b = m.bounds;
    const yMax = Math.max(0.01, m.plotMax * SY * sy);
    const cam = this.activeCam;
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
          for (let pi = 0; pi < this.panels.length; pi++) {
            const pc = this.panels[pi];
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

  // ------------------------------------------------------------------ hover / picking

  private raycaster = new THREE.Raycaster();

  pick(ndcX: number, ndcY: number): HoverInfo | null {
    if (!this.model || this.introDriving || this.exporting) return this.setHover(null);
    const s = this.settings!;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCam);
    this.world.updateMatrixWorld(true);
    let best: { dist: number; panel: number; r: number; c: number } | null = null;
    this.panels.forEach((pc, i) => {
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
        } else cell = cellAt(pc.panel, h.point.x, h.point.z);
        if (cell && pc.panel.values[cell.r]?.[cell.c] !== null && pc.panel.values[cell.r]?.[cell.c] !== undefined) {
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
    const value = pm.values[r][c] as number;
    const p = v.points[r][c];
    const info: HoverInfo = {
      panel: pm.id,
      label: recordLabel(pm.record, s.lang),
      gray: v.grays[r],
      percent: v.percents[c],
      levelNits: v.levelNits[c],
      nits: p ? p.nits : null,
      value,
      capped: Math.abs(value) > this.model.heightCap,
      kind: pm.kind,
      range: this.model.colorMax,
      key: `${panel}:${r}:${c}`,
    };
    if (pm.kind === 'diff') {
      info.a = p ? p.svm : null;
      info.b = pm.otherValues?.[r]?.[c] ?? null;
    }
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
    if (!cell || this.introDriving || !this.panels[cell.panel]) {
      hv.visible = false;
      return;
    }
    const pc = this.panels[cell.panel];
    if (hv.parent !== pc.heightGroup) pc.heightGroup.add(hv);
    const bar = pc.barInfo.find((b) => b.r === cell.r && b.c === cell.c);
    if (!bar) {
      hv.visible = false;
      return;
    }
    const pm = pc.panel;
    const x0 = pm.xe[cell.c];
    const x1 = pm.xe[cell.c + 1];
    const z0 = pm.ze[cell.r];
    const z1 = pm.ze[cell.r + 1];
    // Outline the bar top, or the cell on the flat heatmap (a 3D surface has no flat cell to outline).
    if (this.settings!.representation !== 'bars' && this.frame.heightK > 0.05) {
      hv.visible = false;
      return;
    }
    const y = this.settings!.representation === 'bars' ? Math.max(0, bar.h) + 0.002 : 0.002;
    const arr = (hv.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    arr.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y, z0]);
    hv.geometry.attributes.position.needsUpdate = true;
    hv.visible = true;
  }

  // ------------------------------------------------------------------ export

  beginExport(width: number, height: number) {
    const gl = this.gl;
    if (!gl) return;
    this.exportSaved = { vp: { ...this.vp }, cssW: this.cssW, cssH: this.cssH, pxScale: this.pxScale, dpr: gl.getPixelRatio() };
    this.exporting = true;
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
    this.vp = { width, height };
    this.pxScale = Math.max(0.75, Math.min(width, height) / 800);
    this.cssW = width / this.pxScale;
    this.cssH = height / this.pxScale;
    this.onViewportChanged();
    // Finish static transitions instantly.
    this.camTransition = null;
    this.snapT0 = -1;
    const t = now() + 100;
    Object.values(this.tw).forEach((tw) => tw.jump(tw.value(t)));
  }

  /** Render one export frame synchronously; t = intro time or null (static). */
  renderExport(t: number | null): void {
    if (!this.gl || !this.settings) return;
    let fp: FrameParams;
    if (t === null) fp = this.staticFrame(now());
    else {
      if (this.settings.layout !== 'single' && this.layoutOverride !== 'single') {
        this.layoutOverride = 'single';
        this.sync(this.settings);
      }
      if (!this.intro) this.intro = { tl: null as unknown as Timeline, plan: null, planKey: '' };
      const plan = this.ensurePlan();
      fp = plan ? plan.evaluate(Math.min(INTRO_DURATION, Math.max(0, t)), this.frame) : this.staticFrame(now());
    }
    this.render(fp, null, false);
  }

  endExport(restoreIntro: Timeline | null) {
    const gl = this.gl;
    const saved = this.exportSaved;
    this.exporting = false;
    this.exportSaved = null;
    if (this.layoutOverride) {
      this.layoutOverride = null;
      if (this.settings) this.sync(this.settings);
    }
    if (this.intro && !this.intro.tl) this.intro = restoreIntro ? { tl: restoreIntro, plan: null, planKey: '' } : null;
    if (!gl || !saved) return;
    gl.setPixelRatio(saved.dpr);
    gl.setSize(saved.cssW, saved.cssH, true);
    this.vp = saved.vp;
    this.cssW = saved.cssW;
    this.cssH = saved.cssH;
    this.pxScale = saved.pxScale;
    this.onViewportChanged();
  }

  /** Label / info for export file names. */
  exportName(): string {
    const s = this.settings;
    const m = this.model;
    if (!s || !m) return 'svm-3d';
    const base = m.layout === 'diff' ? `diff_${recordLabel(m.panels[0].record, s.lang)}_vs_${recordLabel(m.panels[0].other!, s.lang)}` : m.layout === 'sideBySide' ? `${recordLabel(m.panels[0].record, s.lang)}_vs_${recordLabel(m.panels[1].record, s.lang)}` : recordLabel(m.panels[0].record, s.lang);
    const t = (k: string) => translate(s.lang, k);
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
