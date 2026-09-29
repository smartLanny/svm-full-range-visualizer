/**
 * Intro storyboard (docs/adr/0003), as a pure function of timeline time t:
 *
 *   a) the G255 row of bars grows (easeOutCubic, gentle left→right stagger) seen from a low front camera
 *   b) short hold (slow push-in)
 *   c) one continuous camera move front → top-down while the other rows grow in an overlapping wave
 *      from high gray to low gray; gray ticks fade in as their rows appear
 *   d) bars flatten (ease-in-out) while the lens narrows to orthographic; values fade in
 *   e) hold the value table
 *   f) the heatmap surface fades in over the identical cells; values fade out
 *   g) contour lines draw on; their labels fade in as the lines reach them
 *
 * The last frame equals the static view with representation 'surface', view 'top', contours on.
 */
import type { Overlays } from '../../store/appStore';
import { clonePose, copyPose, lerpPose, PERSP_MIN, PERSP_TAN, type CamPose } from './camera';
import { easeInOutCubic, easeInOutSine, easeOutCubic, easeOutSine, lerp, smootherstep, smoothstep, window01 } from './easing';
import type { FrameParams } from './frame';

export const INTRO = {
  // a) G255 row
  colStart: 0.3,
  colSpread: 0.55,
  colDur: 1.15,
  // b/c) camera + rows
  camStart: 2.3,
  camEnd: 7.3,
  rowsStart: 2.8,
  rowsSpread: 3.3,
  rowDur: 1.15,
  // d) flatten + orthographic
  flat0: 7.2,
  flat1: 8.6,
  val0: 8.0,
  val1: 8.8,
  // f) crossfade
  xf0: 9.6,
  xf1: 11.0,
  valOut1: 10.3,
  // g) contours
  ct0: 11.0,
  ctLevelDur: 1.0,
  ctStagger: 0.22,
  lab0: 11.5,
  duration: 12.9,
} as const;

export const INTRO_DURATION = INTRO.duration;

/** Chapter marks for the timeline (label keys under scene3d.intro.chapters). */
export const INTRO_CHAPTERS: { t: number; key: string }[] = [
  { t: 0, key: 'grow' },
  { t: INTRO.camStart, key: 'rise' },
  { t: INTRO.flat0, key: 'table' },
  { t: INTRO.xf0, key: 'heatmap' },
  { t: INTRO.ct0, key: 'contours' },
];

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
  private readonly rowStart: number[];
  private readonly growth: Float32Array;
  private readonly reveal: number[];
  private readonly frontWide: CamPose;
  /** Crane path samples: perspective fits of the whole terrain at polar angles 0..front.phi. */
  private readonly path: CamPose[];
  private readonly tmpPose: CamPose;
  private readonly basePose: CamPose;

  constructor(private readonly ctx: IntroContext) {
    const R = ctx.grays.length;
    // Row start times: top row (highest gray) is chapter a; the rest form a wave toward low gray.
    this.rowStart = ctx.grays.map((_, r) => {
      if (r === R - 1) return 0;
      const k = R - 2 - r; // 0 for the row just below the top
      return INTRO.rowsStart + (R > 2 ? (k / (R - 2)) * INTRO.rowsSpread : 0);
    });
    this.growth = new Float32Array(ctx.barCells.length);
    this.reveal = new Array(ctx.levelCount).fill(0);
    this.frontWide = clonePose(ctx.front);
    this.frontWide.h *= 1.07;
    const N = 14;
    this.path = Array.from({ length: N + 1 }, (_, i) => ctx.fitAtPhi((ctx.front.phi * i) / N));
    this.tmpPose = clonePose(ctx.top);
    this.basePose = clonePose(ctx.top);
  }

  /** Crane framing at polar angle phi (linear between samples). */
  private pathAt(phi: number, out: CamPose): CamPose {
    const N = this.path.length - 1;
    const f = Math.min(N, Math.max(0, (phi / Math.max(1e-6, this.ctx.front.phi)) * N));
    const i = Math.min(N - 1, Math.floor(f));
    const u = f - i;
    const a = this.path[i];
    const b = this.path[i + 1];
    out.target.lerpVectors(a.target, b.target, u);
    out.h = Math.exp(lerp(Math.log(a.h), Math.log(b.h), u));
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

  evaluate(t: number, out: FrameParams): FrameParams {
    const { ctx } = this;
    const I = INTRO;
    const R = ctx.grays.length;
    const C = Math.max(1, ctx.nCols);
    const ov = ctx.overlays;

    // --- bars growth ---
    for (let i = 0; i < ctx.barCells.length; i++) {
      const { r, c } = ctx.barCells[i];
      let g: number;
      if (r === R - 1) {
        const s = I.colStart + (C > 1 ? (c / (C - 1)) * I.colSpread : 0);
        g = easeOutCubic(window01(t, s, s + I.colDur));
      } else {
        const s = this.rowStart[r];
        g = easeOutCubic(window01(t, s, s + I.rowDur));
      }
      this.growth[i] = g;
    }
    out.growth = this.growth;

    // --- heights / representations ---
    out.heightK = 1 - easeInOutCubic(window01(t, I.flat0, I.flat1));
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
    out.axes.lum = ov.axes ? intro : 0;
    out.axes.gray = ov.axes ? 1 : 0;
    out.axes.value = ov.axes ? intro * out.heightK : 0;
    out.axes.captions = 0;
    out.grayTickAlpha = (gray: number) => {
      const s = this.grayAppearTime(gray);
      return smoothstep(s, s + 0.5, t);
    };
    out.hud.title = ov.title ? smoothstep(0, 0.7, t) : 0;
    out.hud.colorbar = ov.colorbar ? smoothstep(0.2, 1.0, t) : 0;
    out.ground = out.heightK;

    // --- camera: slow push-in, one crane move over the terrain (always framing all of it), then
    // the lens narrows to orthographic while the bars flatten ---
    const base = this.basePose;
    if (t < I.camStart) {
      lerpPose(this.frontWide, ctx.front, easeOutSine(window01(t, 0, I.camStart)), base);
    } else {
      const u = easeInOutCubic(window01(t, I.camStart, I.camEnd));
      const phi = ctx.front.phi * (1 - u);
      const path = this.pathAt(phi, this.tmpPose);
      const blend = smootherstep(window01(u, 0, 0.55));
      base.target.lerpVectors(ctx.front.target, path.target, blend);
      base.h = Math.exp(lerp(Math.log(ctx.front.h), Math.log(path.h), blend));
      base.theta = 0;
      base.phi = phi;
      base.persp = PERSP_TAN;
    }
    const narrow = easeInOutCubic(window01(t, I.flat0, I.flat1));
    if (narrow >= 1) copyPose(ctx.top, out.pose);
    else if (narrow > 0) lerpPose(base, ctx.top, narrow, out.pose);
    else copyPose(base, out.pose);
    void PERSP_MIN;
    return out;
  }
}
