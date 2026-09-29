/**
 * Chart model: everything that depends on the data + settings + sweep time, but not on pixels.
 * Pure function of its inputs (so the sweep frame is a pure function of t, docs/adr/0003).
 */
import type { AxisMode, Lang, SliceMode, SvmRecord } from '../types';
import type { RecordStyle } from '../data/colors';
import { deviceOrder } from '../data/colors';
import { deviceLabel, modeLabel, recordLabel } from '../data/records';
import type { SlicePoint } from '../data/grid';
import { translate } from '../i18n';
import { buildAxes, fmtTickNits, type Axes } from './scales';
import { buildSpline, type Spline } from './spline';
import { fmtLevel, sliceFor, slicesExtent, sweepExtent, sweepParam, type Extent } from './slices';

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
}

export interface SeriesModel {
  id: string;
  rec: SvmRecord;
  style: RecordStyle;
  device: string;
  label: string;
  points: SlicePoint[];
  /** Spline in axis units (x: log10 nits or gray; y: SVM). */
  spline: Spline | null;
}

export interface LegendRow {
  id: string;
  label: string;
  style: RecordStyle;
  hidden: boolean;
}

export interface LegendGroup {
  device: string;
  label: string;
  color: string;
  rows: LegendRow[];
  /** All records of the group are hidden. */
  hidden: boolean;
}

export interface Scene {
  mode: SliceMode;
  /** Gray level (gray slice) or level nits (brightness slice). */
  param: number;
  /** Title split around the live value: [before, value, after]. */
  title: [string, string, string];
  /** Characters of the widest value the title slot must hold (keeps the title still). */
  titleReserve: string;
  subtitle: string;
  xTitle: string;
  yTitle: string;
  axes: Axes;
  series: SeriesModel[];
  legend: LegendGroup[];
  interactive: boolean;
  background: string;
  refLabels: { safe: string; critical: string };
  emptyText: string;
  lang: Lang;
}

export const CHART_BG = '#0b0e14';

// Sweep extent is the same for every frame of a sweep: memoise on its inputs.
let sweepMemo: { key: string; recs: SvmRecord[]; value: Extent | null } | null = null;
function memoSweepExtent(recs: SvmRecord[], mode: SliceMode, clip: boolean): Extent | null {
  const key = `${mode}|${clip}|${recs.map((r) => r.id).join(',')}`;
  if (sweepMemo && sweepMemo.key === key && sweepMemo.recs.length === recs.length && sweepMemo.recs.every((r, i) => r === recs[i])) return sweepMemo.value;
  const value = sweepExtent(recs, mode, clip);
  sweepMemo = { key, recs, value };
  return value;
}

export function sliceParam(inputs: Pick<ChartInputs, 'sliceMode' | 'sliceGray' | 'sliceNits'>, t: number | null): number {
  if (t !== null) return sweepParam(inputs.sliceMode, t);
  return inputs.sliceMode === 'gray' ? inputs.sliceGray : inputs.sliceNits;
}

/** Title value text for a slice parameter. */
export function paramText(mode: SliceMode, param: number): string {
  return mode === 'gray' ? String(Math.round(param)) : fmtLevel(param);
}

export function titleText(lang: Lang, mode: SliceMode, param: number): string {
  return translate(lang, mode === 'gray' ? 'chart2d.title.gray' : 'chart2d.title.level', { v: paramText(mode, param) });
}

/**
 * Build the scene. `t` = sweep time in seconds (null = the static slice from the settings).
 * `interactive` = on-screen workbench view (hidden records listed, dimmed, in the legend).
 */
export function buildScene(inputs: ChartInputs, opts: { t: number | null; interactive: boolean }): Scene {
  const { lang, sliceMode: mode, axisMode, clipLowGray } = inputs;
  const tr = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const hidden = new Set(inputs.hiddenIds);
  const visible = inputs.records.filter((r) => !hidden.has(r.id));
  const param = sliceParam(inputs, opts.t);

  const series: SeriesModel[] = visible.map((rec) => {
    const points = sliceFor(rec, mode, param, clipLowGray);
    const spline = buildSpline(points.map((p) => ({ x: mode === 'gray' ? Math.log10(p.x) : p.x, y: p.svm })));
    return {
      id: rec.id,
      rec,
      style: inputs.styles.get(rec.id) ?? { color: '#9aa4b2', dash: [], modeIndex: 0 },
      device: rec.device,
      label: recordLabel(rec, lang),
      points,
      spline,
    };
  });

  const extent = axisMode === 'standard' ? null : opts.t !== null ? memoSweepExtent(visible, mode, clipLowGray) : slicesExtent(series.map((s) => s.points));
  const axes = buildAxes(mode, axisMode, extent);

  // Title: split the template around the value so it can be drawn with tabular digits.
  const tpl = tr(mode === 'gray' ? 'chart2d.title.gray' : 'chart2d.title.level');
  const at = tpl.indexOf('{v}');
  const value = paramText(mode, param);
  const title: [string, string, string] = at >= 0 ? [tpl.slice(0, at), value, tpl.slice(at + 3)] : [tpl, '', ''];

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
    }));
    legend.push({
      device,
      label: deviceLabel(first, lang),
      color: rows[0].style.color,
      rows,
      hidden: rows.every((r) => r.hidden),
    });
  }

  return {
    mode,
    param,
    title,
    titleReserve: mode === 'gray' ? '000' : '000',
    subtitle: parts.join('  ·  '),
    xTitle: tr(mode === 'gray' ? 'chart2d.axis.xGray' : 'chart2d.axis.xLevel'),
    yTitle: tr('chart2d.axis.y'),
    axes,
    series,
    legend,
    interactive: opts.interactive,
    background: inputs.presenting && inputs.presentBlack ? '#000000' : CHART_BG,
    refLabels: { safe: tr('common.safeLine'), critical: tr('common.criticalLine') },
    emptyText: tr('chart2d.empty.canvas'),
    lang,
  };
}
