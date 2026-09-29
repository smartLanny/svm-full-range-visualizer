/**
 * SVM colormaps. One data-driven definition per map (piecewise-linear stops) generates both the
 * GLSL used by the 3D terrain and the JS sampler used by canvases / DOM, so they always agree.
 *
 * Conventions (kept from v1 so every map keeps its look):
 * - Stops are defined over the reference SVM domain [0, 4] and clamp outside it. A different
 *   "color max" is applied by rescaling the input: s = svm * 4 / colorMax.
 * - Stop values are LINEAR-light RGB. They are displayed through the sRGB transfer function
 *   (three.js output encoding; `colormapCss` for canvases), exactly like v1 rendered them.
 * - The diverging ΔSVM map takes t in [-1, 1] (negative = blue, 0 = near-white neutral, positive = red).
 */
import * as THREE from 'three';
import { ColormapType } from './types';

/** [svm, r, g, b] with r/g/b in linear light. */
export type ColormapStop = readonly [number, number, number, number];

/** Reference domain upper bound of the stop definitions. */
export const COLORMAP_REF_MAX = 4;

type RGB = readonly [number, number, number];

// v1 color constants.
const RDYLBU: Record<'deepBlue' | 'lightBlue' | 'paleYellow' | 'orange' | 'deepRed', RGB> = {
  deepBlue: [0.192, 0.212, 0.584],
  lightBlue: [0.455, 0.678, 0.82],
  paleYellow: [1.0, 1.0, 0.749],
  orange: [0.992, 0.682, 0.38],
  deepRed: [0.847, 0.05, 0.149],
};

const s = (v: number, c: RGB): ColormapStop => [v, c[0], c[1], c[2]];

/** Inverted 5-stop maps of v1: t = 1 - svm/4, stops at t = 0, .25, .5, .75, 1. */
const inverted5 = (c0: RGB, c1: RGB, c2: RGB, c3: RGB, c4: RGB): ColormapStop[] => [s(0, c4), s(1, c3), s(2, c2), s(3, c1), s(4, c0)];

export const COLORMAP_STOPS: Record<ColormapType, readonly ColormapStop[]> = {
  [ColormapType.TURBO]: [
    s(0, [0.188, 0.07, 0.231]),
    s(0.8, [0.274, 0.525, 0.984]),
    s(1.6, [0.094, 0.843, 0.796]),
    s(2.4, [0.643, 0.988, 0.235]),
    s(3.2, [0.949, 0.619, 0.18]),
    s(4, [0.478, 0.015, 0.011]),
  ],
  // v1: clamp(1.5 - |4t - k|) per channel — piecewise linear with exactly these breakpoints.
  [ColormapType.JET]: [s(0, [0, 0, 0.5]), s(0.5, [0, 0, 1]), s(1.5, [0, 1, 1]), s(2.5, [1, 1, 0]), s(3.5, [1, 0, 0]), s(4, [0.5, 0, 0])],
  [ColormapType.RD_YL_BU]: [s(0, RDYLBU.deepBlue), s(0.4, RDYLBU.lightBlue), s(1, RDYLBU.paleYellow), s(2.5, RDYLBU.orange), s(4, RDYLBU.deepRed)],
  [ColormapType.RD_YL_BU_R]: [s(0, RDYLBU.deepRed), s(1.5, RDYLBU.orange), s(3, RDYLBU.paleYellow), s(3.6, RDYLBU.lightBlue), s(4, RDYLBU.deepBlue)],
  [ColormapType.VIRIDIS]: inverted5([0.267, 0.004, 0.329], [0.229, 0.322, 0.545], [0.128, 0.567, 0.551], [0.369, 0.787, 0.383], [0.993, 0.906, 0.144]),
  [ColormapType.PLASMA]: inverted5([0.051, 0.031, 0.529], [0.494, 0.012, 0.659], [0.796, 0.278, 0.471], [0.972, 0.58, 0.255], [0.941, 0.976, 0.129]),
  [ColormapType.INFERNO]: inverted5([0, 0, 0.016], [0.259, 0.039, 0.408], [0.576, 0.153, 0.404], [0.867, 0.373, 0.176], [0.988, 0.992, 0.647]),
  [ColormapType.MAGMA]: inverted5([0.001, 0, 0.005], [0.145, 0.063, 0.333], [0.459, 0.102, 0.427], [0.882, 0.329, 0.31], [0.988, 0.992, 0.749]),
  [ColormapType.TRAFFIC_LIGHT]: [s(0, [0, 0.8, 0.2]), s(1, [1, 0.9, 0.1]), s(2.5, [0.9, 0.1, 0.1])],
  [ColormapType.COOL_WARM]: [s(0, [0.1, 0.4, 0.8]), s(1, [0.95, 0.95, 0.95]), s(2.5, [0.8, 0, 0.2])],
  [ColormapType.RD_YL_BU_ENHANCED]: [
    s(0, [0.106, 0.235, 0.584]),
    s(0.5, [0.455, 0.678, 0.82]),
    s(1, [1, 1, 0.8]),
    s(2, [1, 0.6, 0.1]),
    s(3, [0.85, 0.1, 0.1]),
    s(4, [0.25, 0, 0.05]),
  ],
};

/** Order used by pickers (recommended first). */
export const COLORMAP_ORDER: ColormapType[] = [
  ColormapType.RD_YL_BU_ENHANCED,
  ColormapType.TRAFFIC_LIGHT,
  ColormapType.COOL_WARM,
  ColormapType.TURBO,
  ColormapType.VIRIDIS,
  ColormapType.PLASMA,
  ColormapType.INFERNO,
  ColormapType.MAGMA,
  ColormapType.RD_YL_BU,
  ColormapType.RD_YL_BU_R,
  ColormapType.JET,
];

/** i18n key of a colormap's display name (strings live in the scene3d namespace). */
export const colormapLabelKey = (type: ColormapType) => `scene3d.colormaps.${type}`;

// --- Diverging ΔSVM map ------------------------------------------------------------------

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hexLinear = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
};

/**
 * ΔSVM diverging map over t in [-1, 1], designed in sRGB for a dark background: blue – white – red.
 * A light (near-white) neutral at 0 so "no difference" reads as blank and even small differences
 * show their sign; increasingly saturated and darker blue (A lower = better) / red (A higher =
 * worse) toward the extremes, which stay distinct from the dark page.
 */
export const DIVERGING_STOPS: readonly ColormapStop[] = [
  s(-1, hexLinear('#2156a8')),
  s(-0.5, hexLinear('#4b8bd4')),
  s(-0.15, hexLinear('#b3c6de')),
  s(0, hexLinear('#dfe1e5')),
  s(0.15, hexLinear('#e5c5b8')),
  s(0.5, hexLinear('#e0714f')),
  s(1, hexLinear('#b01c2e')),
];

// --- Sampling -----------------------------------------------------------------------------

function sampleStops(stops: readonly ColormapStop[], v: number, out: [number, number, number]): [number, number, number] {
  const n = stops.length;
  if (!(v > stops[0][0])) {
    out[0] = stops[0][1];
    out[1] = stops[0][2];
    out[2] = stops[0][3];
    return out;
  }
  for (let i = 1; i < n; i++) {
    const b = stops[i];
    if (v < b[0]) {
      const a = stops[i - 1];
      const t = (v - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * t;
      out[1] = a[2] + (b[2] - a[2]) * t;
      out[2] = a[3] + (b[3] - a[3]) * t;
      return out;
    }
  }
  const z = stops[n - 1];
  out[0] = z[1];
  out[1] = z[2];
  out[2] = z[3];
  return out;
}

/**
 * Linear-light RGB of a colormap at an SVM value. `colorMax` = SVM mapped to the top of the map
 * (default 4 = the v1 scale).
 */
export function sampleColormap(type: ColormapType, svm: number, colorMax = COLORMAP_REF_MAX, out: [number, number, number] = [0, 0, 0]) {
  const stops = COLORMAP_STOPS[type] ?? COLORMAP_STOPS[ColormapType.TURBO];
  return sampleStops(stops, (svm * COLORMAP_REF_MAX) / Math.max(1e-6, colorMax), out);
}

/** Linear-light RGB of the diverging map; t in [-1, 1]. */
export function sampleDiverging(t: number, out: [number, number, number] = [0, 0, 0]) {
  return sampleStops(DIVERGING_STOPS, t, out);
}

/** Linear-light RGB → displayed sRGB hex. */
export function linearToCss(lin: readonly number[]): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const c = Math.min(1, Math.max(0, lin[i]));
    out += Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

/** Displayed (sRGB) CSS color of a colormap at an SVM value — matches the 3D rendering. */
export function colormapCss(type: ColormapType, svm: number, colorMax = COLORMAP_REF_MAX): string {
  return linearToCss(sampleColormap(type, svm, colorMax));
}

/** Displayed (sRGB) CSS color of the diverging ΔSVM map; t in [-1, 1]. */
export function divergingCss(t: number): string {
  return linearToCss(sampleDiverging(t));
}

/** Relative luminance (0..1) of a linear-light color — for choosing black/white text on top. */
export function relativeLuminance(lin: readonly number[]): number {
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** CSS linear-gradient (0 → colorMax along `direction`) for pickers / legends. */
export function colormapGradientCss(type: ColormapType, steps = 24, direction = 'to right'): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    parts.push(`${colormapCss(type, (i / steps) * COLORMAP_REF_MAX)} ${((i / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

// --- GLSL ---------------------------------------------------------------------------------

const glf = (n: number) => {
  const str = Number(n.toFixed(6)).toString();
  return /[.e]/.test(str) ? str : `${str}.0`;
};

/** GLSL `vec3 <fnName>(float v)` for a stop list (v in the stops' own domain, clamped). */
export function stopsToGlsl(stops: readonly ColormapStop[], fnName: string): string {
  const c = (st: ColormapStop) => `vec3(${glf(st[1])}, ${glf(st[2])}, ${glf(st[3])})`;
  const lines: string[] = [`vec3 ${fnName}(float v) {`, `  if (v <= ${glf(stops[0][0])}) return ${c(stops[0])};`];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    lines.push(`  if (v < ${glf(b[0])}) return mix(${c(a)}, ${c(b)}, (v - ${glf(a[0])}) / ${glf(b[0] - a[0])});`);
  }
  lines.push(`  return ${c(stops[stops.length - 1])};`, '}');
  return lines.join('\n');
}

/** GLSL for a colormap over the reference SVM domain [0, 4]. */
export function colormapGlsl(type: ColormapType, fnName = 'svmColormap'): string {
  return stopsToGlsl(COLORMAP_STOPS[type] ?? COLORMAP_STOPS[ColormapType.TURBO], fnName);
}

/** GLSL for the diverging map over [-1, 1]. */
export function divergingGlsl(fnName = 'divergingColormap'): string {
  return stopsToGlsl(DIVERGING_STOPS, fnName);
}

// --- v1-compatible API ----------------------------------------------------------------------

/** v1 API: GLSL defining `vec3 getHeatmapColor(float svm)` (SVM domain 0..4, linear output). */
export const getGlslColorFunction = (type: ColormapType) => colormapGlsl(type, 'getHeatmapColor');

const tmp: [number, number, number] = [0, 0, 0];
/** v1 API: write the (linear) colormap color for an SVM value into a THREE.Color. */
export const getJsColor = (svm: number, type: ColormapType, target: THREE.Color) => {
  sampleColormap(type, svm, COLORMAP_REF_MAX, tmp);
  target.setRGB(tmp[0], tmp[1], tmp[2]);
};
