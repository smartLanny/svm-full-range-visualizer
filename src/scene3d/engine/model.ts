/**
 * Scene model: turns records + settings into world-space cells (docs/adr/0002).
 *
 * World axes: x = log10(level nits + 1) · SX (luminance to the right), z = −gray · SZ (gray
 * increases away from the viewer / upward in top view), y = value · SY · heightScale.
 * Pure data — no three.js objects — so it can be unit tested.
 */
import type { SceneLayout, SvmRecord } from '../../types';
import { CONTOUR_LEVELS } from '../../types';
import { cellEdges, diffRecords, gridView, sampleView, terrainNitsTicks, type GridView } from '../../data/grid';

/** World units per log10(nits + 1). */
export const SX = 6;
/** World units per gray level. */
export const SZ = 12 / 255;
/** World units per SVM unit (before the user's height scale). */
export const SY = 1.1;
/** World gap between side-by-side panels. */
export const PANEL_GAP = 2.4;
/** Fraction of a cell left as gap around a bar (split over both sides). */
export const BAR_GAP = 0.12;
/** Maximum absolute bar gap per side (world units), so big cells don't look sparse. */
export const BAR_GAP_MAX = 0.05;

export type PanelId = 'A' | 'B' | 'D';
export type ValueKind = 'svm' | 'diff';

export interface PanelModel {
  id: PanelId;
  /** Record shown (A for the diff panel). */
  record: SvmRecord;
  /** Diff: the subtracted record (B). */
  other?: SvmRecord;
  view: GridView;
  kind: ValueKind;
  /** values[r][c] (ascending gray r, ascending luminance c): SVM or ΔSVM; null = missing. */
  values: (number | null)[][];
  /** Diff: B resampled at A's samples (tooltips). */
  otherValues?: (number | null)[][];
  /** World x offset of this panel relative to the single-panel mapping. */
  offsetX: number;
  /** Cell centers, world. */
  xs: number[];
  zs: number[];
  /** Cell edges, world (n + 1). xe ascending; ze follows gray ascending, i.e. DEScending z. */
  xe: number[];
  ze: number[];
  /** World rectangle of the panel: x0 < x1, z0 (back, high gray) < z1 (front, low gray). */
  rect: { x0: number; x1: number; z0: number; z1: number };
  /** Largest |value| (0 if none). */
  maxAbs: number;
  minValue: number;
  maxValue: number;
  /** Non-null cell count. */
  count: number;
}

export interface Domain {
  /** log10(nits + 1) extents. */
  lx0: number;
  lx1: number;
  /** Gray extents. */
  g0: number;
  g1: number;
}

export interface SceneModel {
  layout: SceneLayout;
  kind: ValueKind;
  panels: PanelModel[];
  domain: Domain;
  /** World bounds of all panels. */
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** Value mapped to the top of the colormap (svm) / symmetric range (diff). */
  colorMax: number;
  /** Heights clamp at ±heightCap (value units). */
  heightCap: number;
  /** Contour levels (value units). */
  contourLevels: number[];
  /** Luminance ticks (nits) inside the domain. */
  nitsTicks: number[];
  /** Gray ticks inside the domain. */
  grayTicks: number[];
  /** Height axis ticks (value units). */
  valueTicks: number[];
  /** Max/min plotted (capped) value over all panels, for bounds. */
  plotMax: number;
  plotMin: number;
}

export interface ModelInput {
  layout: SceneLayout;
  a: SvmRecord | null;
  b: SvmRecord | null;
  clipLowGray: boolean;
  maxNits: number | null;
  colorMax: number;
  heightCap: number;
}

export type ModelResult = { ok: true; model: SceneModel } | { ok: false; reason: 'noRecord' | 'needB' | 'empty' | 'noOverlap' };

const GRAY_TICKS = [0, 32, 64, 96, 128, 160, 192, 224, 255];

/** Symmetric ΔSVM color range: ±max(0.5, ceil(maxAbs·2)/2). */
export const diffRange = (maxAbs: number) => Math.max(0.5, Math.ceil(maxAbs * 2 - 1e-9) / 2);

function extents(view: GridView) {
  const xe = cellEdges(view.x, 0);
  const ge = cellEdges(view.grays, 0, 255);
  return { lx0: xe[0], lx1: xe[xe.length - 1], g0: ge[0], g1: ge[ge.length - 1], xe, ge };
}

function stats(values: (number | null)[][]) {
  let maxAbs = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const row of values)
    for (const v of row) {
      if (v === null || !Number.isFinite(v)) continue;
      maxAbs = Math.max(maxAbs, Math.abs(v));
      min = Math.min(min, v);
      max = Math.max(max, v);
      count++;
    }
  return { maxAbs, min: count ? min : 0, max: count ? max : 0, count };
}

function makePanel(
  id: PanelId,
  record: SvmRecord,
  view: GridView,
  kind: ValueKind,
  values: (number | null)[][],
  mapX: (lx: number) => number,
  mapZ: (g: number) => number,
  offsetX: number,
): PanelModel {
  const ex = extents(view);
  const xe = ex.xe.map(mapX);
  const ze = ex.ge.map(mapZ);
  const st = stats(values);
  return {
    id,
    record,
    view,
    kind,
    values,
    offsetX,
    xs: view.x.map(mapX),
    zs: view.grays.map(mapZ),
    xe,
    ze,
    rect: { x0: xe[0], x1: xe[xe.length - 1], z0: Math.min(ze[0], ze[ze.length - 1]), z1: Math.max(ze[0], ze[ze.length - 1]) },
    maxAbs: st.maxAbs,
    minValue: st.min,
    maxValue: st.max,
    count: st.count,
  };
}

/** Build the scene model; returns a reason when nothing can be shown. */
export function buildModel(input: ModelInput): ModelResult {
  const { layout, a, b } = input;
  if (!a) return { ok: false, reason: 'noRecord' };
  if (layout !== 'single' && !b) return { ok: false, reason: 'needB' };
  const opts = { clipLowGray: input.clipLowGray, maxNits: input.maxNits };

  if (layout === 'diff') {
    const diff = diffRecords(a, b!, opts);
    if (diff.view.grays.length === 0 || diff.view.x.length === 0) return { ok: false, reason: 'empty' };
    if (diff.count === 0) return { ok: false, reason: 'noOverlap' };
    const bView = gridView(b!);
    const ex = extents(diff.view);
    const domain: Domain = { lx0: ex.lx0, lx1: ex.lx1, g0: ex.g0, g1: ex.g1 };
    const { mapX, mapZ } = mappers(domain, 0);
    const panel = makePanel('D', a, diff.view, 'diff', diff.values, mapX, mapZ, 0);
    panel.other = b!;
    panel.otherValues = diff.view.points.map((row, r) =>
      row.map((_, c) => {
        const smp = sampleView(bView, diff.view.x[c], diff.view.grays[r]);
        return smp ? smp.svm : null;
      }),
    );
    const range = diffRange(diff.maxAbs);
    return { ok: true, model: finish(input, 'diff', [panel], domain, range) };
  }

  const recs = layout === 'sideBySide' ? [a, b!] : [a];
  const views = recs.map((r) => gridView(r, opts));
  if (views.some((v) => v.grays.length === 0 || v.x.length === 0)) return { ok: false, reason: 'empty' };
  const exs = views.map(extents);
  const domain: Domain = {
    lx0: Math.min(...exs.map((e) => e.lx0)),
    lx1: Math.max(...exs.map((e) => e.lx1)),
    g0: Math.min(...exs.map((e) => e.g0)),
    g1: Math.max(...exs.map((e) => e.g1)),
  };
  const width = (domain.lx1 - domain.lx0) * SX;
  const panels = recs.map((rec, i) => {
    const offset = recs.length === 1 ? 0 : (i === 0 ? -1 : 1) * (width + PANEL_GAP) * 0.5;
    const { mapX, mapZ } = mappers(domain, offset);
    const values = views[i].points.map((row) => row.map((p) => (p && Number.isFinite(p.svm) ? p.svm : null)));
    return makePanel(recs.length === 1 ? 'A' : i === 0 ? 'A' : 'B', rec, views[i], 'svm', values, mapX, mapZ, offset);
  });
  return { ok: true, model: finish(input, 'svm', panels, domain, input.colorMax) };
}

function mappers(domain: Domain, offsetX: number) {
  const lxMid = (domain.lx0 + domain.lx1) / 2;
  const gMid = (domain.g0 + domain.g1) / 2;
  return {
    mapX: (lx: number) => (lx - lxMid) * SX + offsetX,
    mapZ: (g: number) => -(g - gMid) * SZ,
  };
}

function finish(input: ModelInput, kind: ValueKind, panels: PanelModel[], domain: Domain, colorMax: number): SceneModel {
  const cap = Math.max(0.1, input.heightCap);
  const bounds = {
    x0: Math.min(...panels.map((p) => p.rect.x0)),
    x1: Math.max(...panels.map((p) => p.rect.x1)),
    z0: Math.min(...panels.map((p) => p.rect.z0)),
    z1: Math.max(...panels.map((p) => p.rect.z1)),
  };
  const plotMax = Math.min(cap, Math.max(0, ...panels.map((p) => p.maxValue)));
  const plotMin = Math.max(-cap, Math.min(0, ...panels.map((p) => p.minValue)));
  const eps = 1e-6;
  const lx = (n: number) => Math.log10(n + 1);
  const nitsTicks = terrainNitsTicks(input.maxNits ?? 1e5).filter((n) => lx(n) >= domain.lx0 - eps && lx(n) <= domain.lx1 + eps);
  const grayTicks = GRAY_TICKS.filter((g) => g >= domain.g0 - eps && g <= domain.g1 + eps);
  return {
    layout: input.layout,
    kind,
    panels,
    domain,
    bounds,
    colorMax: kind === 'diff' ? colorMax : Math.max(0.1, colorMax),
    heightCap: cap,
    contourLevels: kind === 'diff' ? diffContourLevels(colorMax) : [...CONTOUR_LEVELS],
    nitsTicks,
    grayTicks,
    valueTicks: kind === 'diff' ? diffTicks(colorMax, plotMin, plotMax) : svmTicks(plotMax),
    plotMax,
    plotMin,
  };
}

function svmTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max - 1e-6));
  const step = top > 6 ? 2 : 1;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v);
  return out;
}

function diffTicks(range: number, min: number, max: number): number[] {
  const step = range <= 1 ? 0.5 : range <= 3 ? 1 : 2;
  const out: number[] = [];
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(3)));
  if (!out.includes(0)) out.push(0);
  return out.sort((x, y) => x - y);
}

/**
 * Diff contours: symmetric ± levels inside the color range (0.5 steps; 0.25 for a ±0.5 range).
 * The zero line is left out on purpose: measurement noise turns it into many tiny loops, and the
 * blue / red colors already show the sign.
 */
export function diffContourLevels(range: number): number[] {
  const step = range <= 0.5 + 1e-9 ? 0.25 : range <= 3 ? 0.5 : 1;
  const out: number[] = [];
  for (let v = step; v < range - 1e-9; v += step) out.push(v, -v);
  return out.sort((x, y) => x - y);
}

/** Cell index (r, c) containing world point (x, z) in a panel, or null. */
export function cellAt(panel: PanelModel, x: number, z: number): { r: number; c: number } | null {
  const { xe, ze } = panel;
  if (x < xe[0] || x > xe[xe.length - 1]) return null;
  // ze is descending (gray ascending).
  if (z > ze[0] || z < ze[ze.length - 1]) return null;
  let c = 0;
  while (c < xe.length - 2 && x > xe[c + 1]) c++;
  let r = 0;
  while (r < ze.length - 2 && z < ze[r + 1]) r++;
  return { r, c };
}

/** Plotted (height) value: clamped to ±cap. */
export const plotValue = (v: number, cap: number) => Math.max(-cap, Math.min(cap, v));
