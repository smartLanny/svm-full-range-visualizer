/**
 * Scene model: turns records + settings into world-space cells (docs/adr/0002).
 *
 * World axes: x = log10(level nits + 1) · SX (luminance to the right), z = −gray · SZ · depthScale
 * (gray increases away from the viewer / upward in top view), y = value · SY · heightScale.
 * Pure data — no three.js objects — so it can be unit tested.
 */
import type { SceneLayout, SvmRecord } from '../../types';
import { CONTOUR_LEVELS } from '../../types';
import { cellEdges, diffRecords, gridView, sampleView, terrainNitsTicks, type GridView } from '../../data/grid';

/** World units per log10(nits + 1). */
export const SX = 6;
/** World units per gray level (depthScale 1). */
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
  /** World units per gray level (SZ · depthScale). */
  sz: number;
}

export interface ModelInput {
  layout: SceneLayout;
  a: SvmRecord | null;
  b: SvmRecord | null;
  clipLowGray: boolean;
  maxNits: number | null;
  colorMax: number;
  heightCap: number;
  /**
   * Depth (gray axis) stretch, default 1. Portrait frames use a deeper plate so the plot (and the
   * heatmap) fills a tall frame instead of a thin band; cells stay the same cells in every view.
   */
  depthScale?: number;
}

export type ModelResult = { ok: true; model: SceneModel } | { ok: false; reason: 'noRecord' | 'needB' | 'empty' | 'noOverlap' };

const GRAY_TICKS = [0, 32, 64, 96, 128, 160, 192, 224, 255];

/** Nice symmetric ΔSVM color ranges (the colorbar / contour levels are designed for these). */
export const DIFF_RANGES = [0.5, 1, 1.5, 2, 3] as const;

/**
 * Symmetric ΔSVM color range ±R, robust to outliers: the 95th percentile of |Δ| rounded up to the
 * next nice range (0.5 … 3). Differences beyond ±R saturate to the end colors (the colorbar ends
 * read "≥ +R" / "≤ −R"); tooltips and the value table keep the true value.
 */
export function diffRange(absDiffs: readonly number[]): number {
  const v = absDiffs.filter((x) => Number.isFinite(x)).map(Math.abs).sort((a, b) => a - b);
  if (v.length === 0) return DIFF_RANGES[0];
  const p95 = v[Math.max(0, Math.ceil(v.length * 0.95) - 1)];
  return DIFF_RANGES.find((r) => p95 <= r + 1e-9) ?? DIFF_RANGES[DIFF_RANGES.length - 1];
}

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
  const sz = SZ * Math.max(0.25, input.depthScale ?? 1);

  if (layout === 'diff') {
    const raw = diffRecords(a, b!, opts);
    if (raw.view.grays.length === 0 || raw.view.x.length === 0) return { ok: false, reason: 'empty' };
    if (raw.count === 0) return { ok: false, reason: 'noOverlap' };
    // Rows / columns without a single valid difference are removed (docs/adr/0012), like gridView
    // does for a single record.
    const diff = dropEmptyDiffLines(raw.view, raw.values);
    const bView = gridView(b!);
    const ex = extents(diff.view);
    const domain: Domain = { lx0: ex.lx0, lx1: ex.lx1, g0: ex.g0, g1: ex.g1 };
    const { mapX, mapZ } = mappers(domain, 0, sz);
    const panel = makePanel('D', a, diff.view, 'diff', diff.values, mapX, mapZ, 0);
    panel.other = b!;
    panel.otherValues = diff.view.points.map((row, r) =>
      row.map((_, c) => {
        const smp = sampleView(bView, diff.view.x[c], diff.view.grays[r]);
        return smp ? smp.svm : null;
      }),
    );
    const range = diffRange(diff.values.flat().filter((v): v is number => v !== null));
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
    const { mapX, mapZ } = mappers(domain, offset, sz);
    const values = views[i].points.map((row) => row.map((p) => (p && Number.isFinite(p.svm) ? p.svm : null)));
    return makePanel(recs.length === 1 ? 'A' : i === 0 ? 'A' : 'B', rec, views[i], 'svm', values, mapX, mapZ, offset);
  });
  return { ok: true, model: finish(input, 'svm', panels, domain, input.colorMax) };
}

/** Keep only the rows / columns of a diff grid that have at least one non-null difference. */
export function dropEmptyDiffLines(view: GridView, values: (number | null)[][]): { view: GridView; values: (number | null)[][] } {
  const rows = values.map((_, r) => r).filter((r) => values[r].some((v) => v !== null));
  const cols = view.x.map((_, c) => c).filter((c) => rows.some((r) => values[r][c] !== null));
  if (rows.length === values.length && cols.length === view.x.length) return { view, values };
  const pick = <T>(arr: T[], idx: number[]) => idx.map((i) => arr[i]);
  return {
    view: {
      grays: pick(view.grays, rows),
      levelNits: pick(view.levelNits, cols),
      x: pick(view.x, cols),
      percents: pick(view.percents, cols),
      rowIndex: pick(view.rowIndex, rows),
      colIndex: pick(view.colIndex, cols),
      points: rows.map((r) => pick(view.points[r], cols)),
    },
    values: rows.map((r) => pick(values[r], cols)),
  };
}

function mappers(domain: Domain, offsetX: number, sz: number) {
  const lxMid = (domain.lx0 + domain.lx1) / 2;
  const gMid = (domain.g0 + domain.g1) / 2;
  return {
    mapX: (lx: number) => (lx - lxMid) * SX + offsetX,
    mapZ: (g: number) => -(g - gMid) * sz,
  };
}

function finish(input: ModelInput, kind: ValueKind, panels: PanelModel[], domain: Domain, colorMax: number): SceneModel {
  const bounds = {
    x0: Math.min(...panels.map((p) => p.rect.x0)),
    x1: Math.max(...panels.map((p) => p.rect.x1)),
    z0: Math.min(...panels.map((p) => p.rect.z0)),
    z1: Math.max(...panels.map((p) => p.rect.z1)),
  };
  const eps = 1e-6;
  const lx = (n: number) => Math.log10(n + 1);
  const nitsTicks = terrainNitsTicks(input.maxNits ?? 1e5).filter((n) => lx(n) >= domain.lx0 - eps && lx(n) <= domain.lx1 + eps);
  const grayTicks = GRAY_TICKS.filter((g) => g >= domain.g0 - eps && g <= domain.g1 + eps);
  const model: SceneModel = {
    layout: input.layout,
    kind,
    panels,
    domain,
    bounds,
    colorMax: kind === 'diff' ? colorMax : Math.max(0.1, colorMax),
    heightCap: 0,
    contourLevels: kind === 'diff' ? diffContourLevels(colorMax) : [...CONTOUR_LEVELS],
    nitsTicks,
    grayTicks,
    valueTicks: [],
    plotMax: 0,
    plotMin: 0,
    sz: SZ * Math.max(0.25, input.depthScale ?? 1),
  };
  setModelHeightCap(model, input.heightCap);
  return model;
}

/**
 * Apply a height cap to a built model in place (heights only: cells, colors and contour levels do
 * not depend on it), so the height-cap slider never rebuilds the scene.
 */
export function setModelHeightCap(model: SceneModel, heightCap: number) {
  const { panels } = model;
  const cap = Math.max(0.1, heightCap);
  model.heightCap = cap;
  model.plotMax = Math.min(cap, Math.max(0, ...panels.map((p) => p.maxValue)));
  model.plotMin = Math.max(-cap, Math.min(0, ...panels.map((p) => p.minValue)));
  model.valueTicks = model.kind === 'diff' ? diffTicks(model.plotMin, model.plotMax) : svmTicks(model.plotMax);
}

function svmTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max - 1e-6));
  const step = top > 6 ? 2 : 1;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v);
  return out;
}

/** Height-axis ticks of a diff terrain: steps follow the plotted extent (not the color range). */
function diffTicks(min: number, max: number): number[] {
  const span = Math.max(Math.abs(min), Math.abs(max));
  const step = span <= 1.5 ? 0.5 : span <= 4 ? 1 : 2;
  const out: number[] = [];
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(3)));
  if (!out.includes(0)) out.push(0);
  return out.sort((x, y) => x - y);
}

/** Positive diff contour levels for a color range (at most two per sign, nice values). */
function diffLevelSet(range: number): number[] {
  if (range <= 0.5 + 1e-9) return [0.25];
  if (range <= 1 + 1e-9) return [0.5];
  if (range <= 2 + 1e-9) return [0.5, 1];
  return [1, 2];
}

/**
 * Diff contours: at most two symmetric ± levels inside the color range (e.g. ±0.5 / ±1 for ±1.5).
 * The zero line is left out on purpose: measurement noise turns it into many tiny loops, and the
 * blue / red colors already show the sign.
 */
export function diffContourLevels(range: number): number[] {
  const out: number[] = [];
  for (const v of diffLevelSet(range)) if (v < range - 1e-9) out.push(v, -v);
  return out.sort((x, y) => x - y);
}

/** Colorbar ticks of a diff range: 0, the contour levels and the saturating ends. */
export function diffColorbarTicks(range: number): number[] {
  const out = [0, range, -range];
  for (const v of diffLevelSet(range)) if (v < range - 1e-9) out.push(v, -v);
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
