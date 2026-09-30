/**
 * Plate proportions (docs/adr/0002, addendum "stable heatmap proportions"). Every heatmap of the
 * app has the same width : depth — the 3D plate (top-view heatmap, terrain, bars, value table) in
 * every layout (single, side by side with 2–6 panels, difference map), view, frame, the intro and
 * all exports, and the stats card thumbnails. Neither the frame / cell shape nor the records'
 * luminance or gray range changes it: a frame's spare room becomes margins (the plot is centered),
 * never a stretched gray axis, so a heatmap can never turn into a thin band or a narrow strip.
 * Pure, unit tested.
 */

/**
 * Width : depth of every heatmap (log level-luminance span : gray span on screen). Between the
 * 4 : 3 and 3 : 2 shapes of the former landscape default (about 1.2–1.45 depending on the records
 * and the luminance cap), clearly wider than tall in every layout.
 */
export const PLATE_ASPECT = 1.4;

/** Allowed range of the depth scale (degenerate one-row / one-column records). */
const MIN_DEPTH_SCALE = 0.1;
const MAX_DEPTH_SCALE = 10;

/** Extents of a plate: log1p-nits span [lx0, lx1] and gray span [g0, g1]. */
export interface PlateSpan {
  lx0: number;
  lx1: number;
  g0: number;
  g1: number;
}

/**
 * Stretch of the gray axis (world units per gray level, relative to `sz1`) that gives a plate of
 * `span` the aspect PLATE_ASPECT, where `sx` world units = one log10(nits + 1) and `sz1` world units
 * = one gray level at depth scale 1. Degenerate spans (no width or depth) keep depth scale 1.
 */
export function plateDepthScale(span: PlateSpan, sx: number, sz1: number, aspect = PLATE_ASPECT): number {
  const w = (span.lx1 - span.lx0) * sx;
  const d = (span.g1 - span.g0) * sz1;
  if (!(w > 0 && d > 0 && aspect > 0) || !Number.isFinite(w / d)) return 1;
  return Math.min(MAX_DEPTH_SCALE, Math.max(MIN_DEPTH_SCALE, w / (aspect * d)));
}

/** Height (px) of a heatmap `width` px wide: the plate aspect, rounded to whole px. */
export function plateHeight(width: number, aspect = PLATE_ASPECT): number {
  return width > 0 ? Math.round(width / aspect) : 0;
}
