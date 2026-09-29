/**
 * Intro storyboard (docs/adr/0003), as a pure function of timeline time t:
 *
 *   a) the G255 row of bars grows (left → right stagger) seen from a low front camera that slowly
 *      pushes in
 *   b/c) one continuous camera move front → top-down while the other rows grow in a diagonal wave
 *      from high gray to low gray; gray ticks fade in as their rows appear
 *   d) the lens narrows to orthographic while the bars flatten (the two overlap but are offset);
 *      axis labels step aside while the terrain leans over them and return in the final layout;
 *      values fade in
 *   e) hold the value table
 *   f) the heatmap surface fades in over the identical cells; values fade out
 *   g) contour lines draw on; their labels fade in as the lines reach them
 *
 * Smoothness rules (the user's "视觉观感卡顿" report): every bar starts with zero velocity
 * (smootherstep), its footprint and color fade in over its first `fadeDur` seconds instead of
 * popping in, and bar start times are spread evenly over the wave (row by row with a diagonal
 * skew across the columns), so the amount of motion on screen changes smoothly — no row appears
 * as a block. The camera is C2 in t: smootherstep easings of a smooth curve through the sampled crane
 * framings, overlapping (never stopping between phases), ending exactly on the top-view pose.
 *
 * The last frame equals the static view with representation 'surface', view 'top', contours on.
 */
import type { Overlays } from '../../store/appStore';
import { clonePose, copyPose, lerpPose, PERSP_TAN, type CamPose } from './camera';
import { easeInOutSine, lerp, smootherstep, smoothstep, window01 } from './easing';
import type { FrameParams } from './frame';
import { PolyCurve } from './polyfit';

export const INTRO = {
  // a) G255 row
  colStart: 0.3,
  colSpread: 0.8,
  colDur: 1.4,
  // slow push-in of the opening shot (h × (1 + pushIn) → h), overlapping the crane start
  pushIn: 0.1,
  pushEnd: 2.9,
  // b/c) camera crane + row wave
  camStart: 1.9,
  camEnd: 7.5,
  rowsStart: 2.4,
  rowsSpread: 3.5,
  rowDur: 1.4,
  /** Diagonal skew of the wave across the columns, in row spacings (1 = evenly spread starts). */
  rowSkew: 1,
  /** Footprint (60 % → 100 %) and color (plate → colormap) fade-in at the start of each bar. */
  fadeDur: 0.2,
  // axis ticks / titles step aside while the steep perspective leans the terrain over them
  axHide0: 6.3,
  axHide1: 6.9,
  axShow0: 8.5,
  axShow1: 9.0,
  // d) orthographic narrowing + flatten (offset so their peaks do not coincide)
  nar0: 7.0,
  nar1: 9.0,
  flat0: 7.3,
  flat1: 8.9,
  val0: 8.5,
  val1: 9.3,
  // f) crossfade
  xf0: 9.9,
  xf1: 11.3,
  valOut1: 10.6,
  // g) contours
  ct0: 11.3,
  ctLevelDur: 1.0,
  ctStagger: 0.22,
  lab0: 11.8,
  duration: 13.2,
} as const;

export const INTRO_DURATION = INTRO.duration;

/** Chapter marks for the timeline (label keys under scene3d.intro.chapters). */
export const INTRO_CHAPTERS: { t: number; key: string }[] = [
  { t: 0, key: 'grow' },
  { t: INTRO.camStart, key: 'rise' },
  { t: INTRO.nar0, key: 'table' },
  { t: INTRO.xf0, key: 'heatmap' },
  { t: INTRO.ct0, key: 'contours' },
];

/** Crane framings sampled along the polar angle, and the degree of the smooth curve through them. */
const CRANE_SAMPLES = 49;
const CRANE_DEGREE = 5;

export interface IntroContext {
  /** Gray levels of the panel rows, ascending. */
  grays: number[];
  nCols: number;
  /** Cell of each bar instance, in instance order. */
  barCells: { r: number; c: number }[];
  /** Low front camera (framing the plate + G255 row) and the static orthographic top view. */
  front: CamPose;
  top: CamPose;
  /** Perspective fit (theta 0) of the full-height terrain box at a polar angle. */
  fitAtPhi: (phi: number) => CamPose;
  overlays: Overlays;
  levelCount: number;
}

export class IntroPlan {
  /** Start time and duration of each bar's growth window, in instance order. */
  private readonly barStart: Float32Array;
  private readonly barDur: Float32Array;
  /** Start time of each row (its first bar). */
  private readonly rowStart: number[];
  private readonly growth: Float32Array;
  private readonly fade: Float32Array;
  private readonly reveal: number[];
  /** Crane framing as smooth curves of the polar angle: target x / y / z and log h. */
  private readonly crane: PolyCurve[];
  /** Constant log-h lift so the smooth framing always contains the terrain (see constructor). */
  private readonly hLift: number;
  private readonly tmpPose: CamPose;
  private readonly basePose: CamPose;

  constructor(private readonly ctx: IntroContext) {
    const I = INTRO;
    const R = ctx.grays.length;
    const C = Math.max(1, ctx.nCols);
    const top = R - 1;
    // Wave slots: rows below the top one, from high gray (slot 0) to low gray, skewed diagonally
    // across the columns so that bar start times are spread evenly over the whole wave.
    const nSlots = Math.max(1, R - 2 + I.rowSkew);
    const slot = (r: number, c: number) => (top - 1 - r + (C > 1 ? (I.rowSkew * c) / (C - 1) : 0)) / nSlots;
    this.rowStart = ctx.grays.map((_, r) => (r === top ? I.colStart : I.rowsStart + slot(r, 0) * I.rowsSpread));
    const n = ctx.barCells.length;
    this.barStart = new Float32Array(n);
    this.barDur = new Float32Array(n);
    ctx.barCells.forEach(({ r, c }, i) => {
      if (r === top) {
        this.barStart[i] = I.colStart + (C > 1 ? (c / (C - 1)) * I.colSpread : 0);
        this.barDur[i] = I.colDur;
      } else {
        this.barStart[i] = I.rowsStart + slot(r, c) * I.rowsSpread;
        this.barDur[i] = I.rowDur;
      }
    });
    this.growth = new Float32Array(n);
    this.fade = new Float32Array(n);
    this.reveal = new Array(ctx.levelCount).fill(0);
    // Crane: sample the exact framing at polar angles 0..front.phi and follow a least-squares
    // polynomial through it. The exact fit is only C0 in phi (the limiting corner of the box
    // changes along the way, e.g. the target briefly reverses direction); the curve is C∞ and stays
    // within a fraction of a percent of it (see intro.test.ts).
    const phiMax = Math.max(1e-6, ctx.front.phi);
    const phis = Array.from({ length: CRANE_SAMPLES }, (_, i) => (phiMax * i) / (CRANE_SAMPLES - 1));
    const samples = phis.map((p) => ctx.fitAtPhi(p));
    const channel = (f: (p: CamPose) => number) => new PolyCurve(0, phiMax, phis, samples.map(f), CRANE_DEGREE);
    this.crane = [channel((p) => p.target.x), channel((p) => p.target.y), channel((p) => p.target.z), channel((p) => Math.log(p.h))];
    // Never frame tighter than the exact fit: lift the (smooth) visible height by the largest
    // shortfall, counting a target offset as needing twice its size in extra height.
    const [cx, cy, cz, clh] = this.crane;
    this.hLift = samples.reduce((m, p, i) => {
      const f = phis[i];
      const off = Math.hypot(cx.at(f) - p.target.x, cy.at(f) - p.target.y, cz.at(f) - p.target.z);
      return Math.max(m, Math.log(p.h) - clh.at(f) + (2 * off) / p.h);
    }, 0);
    this.tmpPose = clonePose(ctx.top);
    this.basePose = clonePose(ctx.top);
  }

  /** Crane framing at polar angle phi (smooth in phi). */
  craneAt(phi: number, out: CamPose): CamPose {
    const [x, y, z, lh] = this.crane;
    out.target.set(x.at(phi), y.at(phi), z.at(phi));
    out.h = Math.exp(lh.at(phi) + this.hLift);
    out.theta = 0;
    out.phi = phi;
    out.persp = PERSP_TAN;
    return out;
  }

  /** Time at which the wave reaches a gray level (for tick fade-in). */
  grayAppearTime(gray: number): number {
    const { grays } = this.ctx;
    const R = grays.length;
    if (R === 0) return 0;
    if (gray >= grays[R - 1] - 1e-6) return INTRO.colStart;
    // Rows between; interpolate the start times of the bracketing rows.
    for (let r = R - 2; r >= 0; r--) {
      if (gray >= grays[r]) {
        const t0 = this.rowStart[r];
        const t1 = r + 1 === R - 1 ? INTRO.rowsStart : this.rowStart[r + 1];
        const f = (gray - grays[r]) / Math.max(1e-6, grays[r + 1] - grays[r]);
        return lerp(t0, t1, f);
      }
    }
    return this.rowStart[0];
  }

  /**
   * Camera pose at time t, C2 in t: a slow push-in that overlaps the crane (no stop between the
   * two), the crane along the smoothed framing curve, and the narrowing to the orthographic top view overlapping
   * the end of the crane. Exactly `top` from INTRO.nar1 on.
   */
  cameraAt(t: number, out: CamPose): CamPose {
    const { ctx } = this;
    const I = INTRO;
    const front = ctx.front;
    const u = smootherstep(window01(t, I.camStart, I.camEnd));
    const phi = front.phi * (1 - u);
    const path = this.craneAt(phi, this.tmpPose);
    // Leave the opening framing (the G255 row) for the whole-terrain framing early in the move.
    const blend = smootherstep(window01(u, 0, 0.55));
    const push = 1 + I.pushIn * (1 - smootherstep(window01(t, 0, I.pushEnd)));
    const base = this.basePose;
    base.target.lerpVectors(front.target, path.target, blend);
    base.h = Math.exp(lerp(Math.log(front.h), Math.log(path.h), blend)) * push;
    base.theta = 0;
    base.phi = phi;
    base.persp = PERSP_TAN;
    const narrow = smootherstep(window01(t, I.nar0, I.nar1));
    if (narrow >= 1) return copyPose(ctx.top, out);
    if (narrow > 0) return lerpPose(base, ctx.top, narrow, out);
    return copyPose(base, out);
  }

  evaluate(t: number, out: FrameParams): FrameParams {
    const { ctx } = this;
    const I = INTRO;
    const ov = ctx.overlays;

    // --- bars: zero-velocity growth, footprint + color fade-in at the start ---
    for (let i = 0; i < this.barStart.length; i++) {
      const s = this.barStart[i];
      this.growth[i] = smootherstep(window01(t, s, s + this.barDur[i]));
      this.fade[i] = smootherstep(window01(t, s, s + I.fadeDur));
    }
    out.growth = this.growth;
    out.barFade = this.fade;

    // --- heights / representations ---
    out.heightK = 1 - smootherstep(window01(t, I.flat0, I.flat1));
    out.elev = 1;
    const xf = easeInOutSine(window01(t, I.xf0, I.xf1));
    out.surfaceOpacity = xf;
    out.barsOpacity = t < I.xf1 ? 1 : 0;
    out.onTop = 'surface';

    // --- values ---
    const vin = easeInOutSine(window01(t, I.val0, I.val1));
    const vout = ov.values ? 0 : easeInOutSine(window01(t, I.xf0, I.valOut1));
    out.valuesOpacity = vin * (1 - vout);

    // --- contours ---
    for (let l = 0; l < this.reveal.length; l++) {
      const s = I.ct0 + l * I.ctStagger;
      this.reveal[l] = easeInOutSine(window01(t, s, s + I.ctLevelDur));
    }
    out.contourReveal = this.reveal;
    out.contourOpacity = t >= I.ct0 ? 1 : 0;
    out.contourLabelOpacity = smoothstep(I.lab0, I.lab0 + 0.4, t);

    // --- axes / HUD ---
    const intro = smoothstep(0.1, 0.9, t);
    // Plate-edge labels step aside while the steep perspective leans the terrain over them, and
    // return once the table is flat (placed in the final top-view layout).
    const aside = 1 - smoothstep(I.axHide0, I.axHide1, t) + smoothstep(I.axShow0, I.axShow1, t);
    out.axes.lum = ov.axes ? intro * aside : 0;
    out.axes.gray = ov.axes ? aside : 0;
    // The vertical SVM axis belongs to the low front shot; it leaves as the crane rises.
    out.axes.value = ov.axes ? intro * out.heightK * (1 - smoothstep(I.camStart, I.camStart + 1.6, t)) : 0;
    out.axes.captions = 0;
    out.grayTickAlpha = (gray: number) => {
      const s = this.grayAppearTime(gray);
      return smoothstep(s, s + 0.5, t);
    };
    out.hud.title = ov.title ? smoothstep(0, 0.7, t) : 0;
    out.hud.colorbar = ov.colorbar ? smoothstep(0.2, 1.0, t) : 0;
    out.ground = out.heightK;

    // --- camera ---
    this.cameraAt(t, out.pose);
    return out;
  }
}
