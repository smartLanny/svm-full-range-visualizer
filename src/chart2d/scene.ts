/**
 * Chart model: everything that depends on the data + settings + sweep time, but not on pixels.
 * Pure function of its inputs (so the sweep frame is a pure function of t, docs/adr/0003).
 */
import type { AxisMode, Lang, SliceMode, SvmRecord } from '../types';
import type { RecordStyle } from '../data/colors';
import { deviceOrder } from '../data/colors';
import { deviceLabel, modeLabel, recordLabel } from '../data/records';
import { ANOMALY_KINDS, exclusionSummary, type ExclusionSummary } from '../data/anomalies';
import { translate } from '../i18n';
import { buildAxes, fmtTickNits, type Axes } from './scales';
import { buildCurve, evalCurve, type Curve } from './spline';
import { fmtLevel, sliceFor, slicesExtent, sweepExtent, sweepParam, SWEEP_DURATION, type CurvePoint, type Extent } from './slices';

export interface ChartInputs {
  /** All records in store order (legend lists hidden ones in the interactive view). */
  records: SvmRecord[];
  hiddenIds: string[];
  styles: Map<string, RecordStyle>;
  lang: Lang;
  sliceMode: SliceMode;
  sliceGray: number;
  sliceNits: number;
  axisMode: AxisMode;
  clipLowGray: boolean;
  presenting: boolean;
  presentBlack: boolean;
  /** overlays.title (H shortcut): draw the title + subtitle. Default true. */
  showTitle?: boolean;
  /** overlays.colorbar (H shortcut): draw the in-plot legend. Default true. */
  showLegend?: boolean;
}

export interface SeriesModel {
  id: string;
  rec: SvmRecord;
  style: RecordStyle;
  device: string;
  label: string;
  points: CurvePoint[];
  /** Curve in axis units (x: log10 nits or gray; y: SVM). */
  curve: Curve | null;
  /** Anomalous points excluded from this record (docs/adr/0012), or null. */
  exclusion: ExclusionSummary | null;
}

export interface LegendRow {
  id: string;
  label: string;
  style: RecordStyle;
  hidden: boolean;
  /** The record has excluded anomalous points: a '*' marker follows the label. */
  excluded: boolean;
}

export interface LegendGroup {
  device: string;
  label: string;
  color: string;
  rows: LegendRow[];
  /** All records of the group are hidden. */
  hidden: boolean;
}

/**
 * Curves the legend placement must keep clear of: one frame for a static slice, samples of the
 * whole sweep for a sweep (so the legend picks one corner and holds it for the entire sweep).
 */
export interface LegendProbe {
  frames: Curve[][];
}

export interface TitleSlot {
  /** Widest value the slot must hold. */
  reserve: string;
  /** Value alignment inside the slot. */
  align: 'left' | 'right';
  /** 0 = slot as wide as the value (static title), 1 = full reserve (sweep: title never moves). */
  mix: number;
}

export interface Scene {
  mode: SliceMode;
  /** Gray level (gray slice) or level nits (brightness slice). */
  param: number;
  /** Title split around the live value: [before, value, after]. */
  title: [string, string, string];
  titleSlot: TitleSlot;
  subtitle: string;
  showTitle: boolean;
  showLegend: boolean;
  xTitle: string;
  yTitle: string;
  axes: Axes;
  series: SeriesModel[];
  legend: LegendGroup[];
  legendProbe: LegendProbe;
  /** While blending between two frames: the probe of the frame blended from, and the progress. */
  legendProbeFrom: LegendProbe | null;
  legendMix: number;
  interactive: boolean;
  background: string;
  refLabels: { safe: string; critical: string };
  emptyText: string;
  lang: Lang;
}

export const CHART_BG = '#0b0e14';

/** Sweep samples used to place the legend for a whole sweep. */
const PROBE_SAMPLES = 24;

const toAxisX = (mode: SliceMode, x: number) => (mode === 'gray' ? Math.log10(x) : x);

export function curveOf(mode: SliceMode, points: CurvePoint[]): Curve | null {
  return buildCurve(points.map((p) => ({ x: toAxisX(mode, p.x), y: p.svm, a: p.a, key: p.key })));
}

const sameRecs = (a: SvmRecord[], b: SvmRecord[]) => a.length === b.length && a.every((r, i) => r === b[i]);

// Sweep extent / probe are the same for every frame of a sweep: memoise on their inputs.
let sweepMemo: { key: string; recs: SvmRecord[]; value: Extent | null } | null = null;
function memoSweepExtent(recs: SvmRecord[], mode: SliceMode, clip: boolean): Extent | null {
  const key = `${mode}|${clip}`;
  if (sweepMemo && sweepMemo.key === key && sameRecs(sweepMemo.recs, recs)) return sweepMemo.value;
  const value = sweepExtent(recs, mode, clip);
  sweepMemo = { key, recs, value };
  return value;
}

let probeMemo: { key: string; recs: SvmRecord[]; value: LegendProbe }[] = [];
function memoProbe(recs: SvmRecord[], mode: SliceMode, clip: boolean, t: number | null, param: number): LegendProbe {
  const key = t === null ? `static|${mode}|${clip}|${param}` : `sweep|${mode}|${clip}`;
  const hit = probeMemo.find((m) => m.key === key && sameRecs(m.recs, recs));
  if (hit) return hit.value;
  const params = t === null ? [param] : Array.from({ length: PROBE_SAMPLES + 1 }, (_, i) => sweepParam(mode, (i / PROBE_SAMPLES) * SWEEP_DURATION));
  const frames = params.map((p) => recs.map((r) => curveOf(mode, sliceFor(r, mode, p, clip))).filter((c): c is Curve => !!c));
  const value = { frames };
  probeMemo = [{ key, recs, value }, ...probeMemo.filter((m) => !(m.key === key && sameRecs(m.recs, recs)))].slice(0, 4);
  return value;
}

export function sliceParam(inputs: Pick<ChartInputs, 'sliceMode' | 'sliceGray' | 'sliceNits'>, t: number | null): number {
  if (t !== null) return sweepParam(inputs.sliceMode, t);
  return inputs.sliceMode === 'gray' ? inputs.sliceGray : inputs.sliceNits;
}

/** Interpolate a slice parameter (gray: linear; level luminance: logarithmic). */
export function mixParam(mode: SliceMode, a: number, b: number, p: number): number {
  if (mode === 'gray') return a + (b - a) * p;
  const la = Math.log(Math.max(1e-6, a));
  const lb = Math.log(Math.max(1e-6, b));
  return Math.exp(la + (lb - la) * p);
}

function mixExtent(mode: SliceMode, a: Extent | null, b: Extent | null, p: number): Extent | null {
  if (!a || !b) return p < 0.5 ? (a ?? b) : (b ?? a);
  const lin = (u: number, v: number) => u + (v - u) * p;
  const lg = (u: number, v: number) => (u > 0 && v > 0 ? Math.exp(lin(Math.log(u), Math.log(v))) : lin(u, v));
  const mx = mode === 'gray' ? lg : lin;
  return { xMin: mx(a.xMin, b.xMin), xMax: mx(a.xMax, b.xMax), yMin: lin(a.yMin, b.yMin), yMax: lin(a.yMax, b.yMax) };
}

/**
 * Progress (0 = sweep start, 1 = sweep end) of a slice parameter along the sweep path; may be
 * outside [0, 1]. Used to size the eased transition into / out of a sweep.
 */
export function sweepProgressOf(mode: SliceMode, param: number): number {
  const a = sweepParam(mode, 0);
  const b = sweepParam(mode, SWEEP_DURATION);
  if (mode === 'gray') return (param - a) / (b - a);
  return Math.log(Math.max(1e-6, param) / a) / Math.log(b / a);
}

/**
 * SVM read off the 2D gray-slice curve at `nits` (exactly what the chart, its tooltip and its
 * table show), or null outside the curve / in a gap / where it is fading. docs/adr/0009 asks the
 * stats' typical-luminance SVM to use the same curve as the 2D chart: this is that curve.
 */
export function graySliceSvmAt(rec: SvmRecord, gray: number, nits: number): number | null {
  if (!(nits > 0)) return null;
  const c = curveOf('gray', sliceFor(rec, 'gray', gray, false));
  return c ? evalCurve(c, Math.log10(nits)) : null;
}

/** Explanation of a record's '*' marker (legend / table tooltip): count, reasons, coverage. */
export function exclusionText(lang: Lang, sum: ExclusionSummary): string {
  const tr = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const reasons = ANOMALY_KINDS.filter((k) => sum.byReason[k]).map((k) => `${tr(`common.exclusion.reasons.${k}`)} ${sum.byReason[k]}`);
  return [`* ${tr('common.exclusion.title', { n: sum.total })}`, reasons.join(' · '), tr('common.exclusion.coverage', { valid: sum.valid, nominal: sum.nominal }), tr('chart2d.exclusion.gaps')].join('\n');
}

/** Title value text for a slice parameter. */
export function paramText(mode: SliceMode, param: number): string {
  return mode === 'gray' ? String(Math.round(param)) : fmtLevel(param);
}

export function titleText(lang: Lang, mode: SliceMode, param: number): string {
  return translate(lang, mode === 'gray' ? 'chart2d.title.gray' : 'chart2d.title.level', { v: paramText(mode, param) });
}

export interface SceneOptions {
  /** Sweep time in seconds; null = the static slice from the settings. */
  t: number | null;
  /** On-screen workbench view (hidden records listed, dimmed, in the legend). */
  interactive: boolean;
  /**
   * Eased transition from another frame (`from`: sweep time or null = static slice) to the frame
   * at `t`; p = progress 0..1 (already eased). Used for the pre-roll into a sweep and the way
   * back when it is closed, so starting / ending a sweep never hard-cuts (values, axes, legend
   * position and title width all move continuously).
   */
  blend?: { from: number | null; p: number };
}

/** Build the scene for the frame described by `opts`. */
export function buildScene(inputs: ChartInputs, opts: SceneOptions): Scene {
  const { lang, sliceMode: mode, axisMode, clipLowGray } = inputs;
  const tr = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const hidden = new Set(inputs.hiddenIds);
  const visible = inputs.records.filter((r) => !hidden.has(r.id));
  const blend = opts.blend && opts.blend.p < 1 ? { from: opts.blend.from, p: Math.max(0, opts.blend.p) } : null;
  const paramTo = sliceParam(inputs, opts.t);
  const paramFrom = blend ? sliceParam(inputs, blend.from) : paramTo;
  const param = blend ? mixParam(mode, paramFrom, paramTo, blend.p) : paramTo;

  const series: SeriesModel[] = visible.map((rec) => {
    const points = sliceFor(rec, mode, param, clipLowGray);
    return {
      id: rec.id,
      rec,
      style: inputs.styles.get(rec.id) ?? { color: '#9aa4b2', dash: [], modeIndex: 0 },
      device: rec.device,
      label: recordLabel(rec, lang),
      points,
      curve: curveOf(mode, points),
      exclusion: exclusionSummary(rec),
    };
  });

  // Axes: standard = fixed; adaptive / free = data extent of the static slice, or of the whole
  // sweep while one plays (fixed for all frames). The curve passes through every point and
  // never overshoots them (no averaging of equal-nits readings), so the extent of the points
  // is exactly the extent of what is drawn.
  const extentOf = (tt: number | null, prm: number): Extent | null => {
    if (axisMode === 'standard') return null;
    if (tt !== null) return memoSweepExtent(visible, mode, clipLowGray);
    if (prm === param) return slicesExtent(series.map((s) => s.points));
    return slicesExtent(visible.map((r) => sliceFor(r, mode, prm, clipLowGray)));
  };
  const extent = blend ? mixExtent(mode, extentOf(blend.from, paramFrom), extentOf(opts.t, paramTo), blend.p) : extentOf(opts.t, param);
  const axes = buildAxes(mode, axisMode, extent);

  // Title: split the template around the value so it can be drawn with tabular digits.
  const tpl = tr(mode === 'gray' ? 'chart2d.title.gray' : 'chart2d.title.level');
  const at = tpl.indexOf('{v}');
  const value = paramText(mode, param);
  const title: [string, string, string] = at >= 0 ? [tpl.slice(0, at), value, tpl.slice(at + 3)] : [tpl, '', ''];
  const slotMix = (tt: number | null) => (tt === null ? 0 : 1);
  const titleSlot: TitleSlot = {
    // Gray values 50–255 and level values 2 … 7.5 … 500 are at most three digits wide.
    reserve: '000',
    align: mode === 'gray' ? 'left' : 'right',
    mix: blend ? slotMix(blend.from) + (slotMix(opts.t) - slotMix(blend.from)) * blend.p : slotMix(opts.t),
  };

  // Subtitle: axis mode + ranges.
  const parts = [tr(`chart2d.axisMode.${axisMode}`)];
  const x = axes.x;
  const y = axes.y;
  const fmtY = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1));
  if (mode === 'gray') parts.push(tr('chart2d.range.nits', { a: fmtTickNits(Math.pow(10, x.u0)), b: fmtTickNits(Math.pow(10, x.u1)) }));
  else parts.push(tr('chart2d.range.gray', { a: Math.round(x.u0), b: Math.round(x.u1) }));
  parts.push(tr('chart2d.range.svm', { a: fmtY(y.u0), b: fmtY(y.u1) }));
  if (mode === 'brightness' && clipLowGray) parts.push(tr('common.lowGrayClipped'));

  // Legend groups (device order of ALL records, so the layout never reshuffles).
  const legendRecs = opts.interactive ? inputs.records : visible;
  const legend: LegendGroup[] = [];
  for (const device of deviceOrder(legendRecs)) {
    const recs = legendRecs.filter((r) => r.device === device);
    const first = recs[0];
    const rows: LegendRow[] = recs.map((r) => ({
      id: r.id,
      label: modeLabel(r, lang) || deviceLabel(r, lang),
      style: inputs.styles.get(r.id) ?? { color: '#9aa4b2', dash: [], modeIndex: 0 },
      hidden: hidden.has(r.id),
      excluded: !!r.excluded?.length,
    }));
    legend.push({
      device,
      label: deviceLabel(first, lang),
      color: rows[0].style.color,
      rows,
      hidden: rows.every((r) => r.hidden),
    });
  }

  // Legend placement probe. The interactive legend also avoids hidden records' curves, so
  // toggling a record in the legend never moves the legend away from under the pointer.
  const legendProbe = memoProbe(legendRecs, mode, clipLowGray, opts.t, paramTo);
  const legendProbeFrom = blend ? memoProbe(legendRecs, mode, clipLowGray, blend.from, paramFrom) : null;

  return {
    mode,
    param,
    title,
    titleSlot,
    subtitle: parts.join('  ·  '),
    showTitle: inputs.showTitle ?? true,
    showLegend: inputs.showLegend ?? true,
    xTitle: tr(mode === 'gray' ? 'chart2d.axis.xGray' : 'chart2d.axis.xLevel'),
    yTitle: tr('chart2d.axis.y'),
    axes,
    series,
    legend,
    legendProbe,
    legendProbeFrom,
    legendMix: blend ? blend.p : 1,
    interactive: opts.interactive,
    background: inputs.presenting && inputs.presentBlack ? '#000000' : CHART_BG,
    refLabels: { safe: tr('common.safeLine'), critical: tr('common.criticalLine') },
    emptyText: tr('chart2d.empty.canvas'),
    lang,
  };
}
