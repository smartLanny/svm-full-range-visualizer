import * as THREE from 'three';
import type { CamPose } from './camera';

/**
 * Everything that varies over time in the 3D view. Both the static view (wall-clock transitions)
 * and the intro (pure function of timeline t) produce one of these per frame; the engine applies
 * it imperatively (uniforms, instance matrices, camera) — never through React.
 */
export interface FrameParams {
  pose: CamPose;
  /** Height factor 0 (flat) .. 1 (full). */
  heightK: number;
  /**
   * Vertical exaggeration of the elevation views (front / side): heights are drawn × elev so the
   * profile fills the frame; 1 in the other views. Value axes keep true values.
   */
  elev: number;
  barsOpacity: number;
  surfaceOpacity: number;
  /** Which representation is drawn on top while both are visible (the incoming one). */
  onTop: 'bars' | 'surface';
  /** Per-bar growth (0..1) for the first panel, in bar instance order; null = fully grown. */
  growth: Float32Array | null;
  /**
   * Per-bar fade-in (0..1) for the first panel, same order: footprint 60 % → 100 % and color
   * plate → colormap, so a bar never pops in. null = fully faded in.
   */
  barFade: Float32Array | null;
  valuesOpacity: number;
  contourOpacity: number;
  /** Draw-on progress per contour level index (null = fully drawn). */
  contourReveal: number[] | null;
  contourLabelOpacity: number;
  axes: { lum: number; gray: number; value: number; captions: number };
  /** Per gray-tick alpha multiplier (null = all 1). */
  grayTickAlpha: ((gray: number) => number) | null;
  hud: { title: number; colorbar: number };
  /** Floor grid / plate shading opacity. */
  ground: number;
}

export function makeFrameParams(): FrameParams {
  return {
    pose: { target: new THREE.Vector3(), theta: 0, phi: 1, h: 10, persp: 0.3 },
    heightK: 1,
    elev: 1,
    barsOpacity: 0,
    surfaceOpacity: 1,
    onTop: 'surface',
    growth: null,
    barFade: null,
    valuesOpacity: 0,
    contourOpacity: 0,
    contourReveal: null,
    contourLabelOpacity: 1,
    axes: { lum: 1, gray: 1, value: 1, captions: 1 },
    grayTickAlpha: null,
    hud: { title: 1, colorbar: 1 },
    ground: 1,
  };
}
