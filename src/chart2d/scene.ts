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
import { buildAxes, fmtTickNits, tickLevel, xDomain, yDomain, X_COUNT, Y_COUNT, type AxisMotion, type Axes } from './scales';
import { buildCurve, evalCurve, type Curve } from './spline';
import { fmtLevel, settleSlice, sliceFor, slicesExtent, staticSliceFor, sweepParam, SWEEP_DURATION, type CurvePoint, type Extent } from './slices';
import { GLIDE_SAMPLES, glideTrack, holdSmooth, levelTrack, seriesAt, sweepTrack, trackAt, TRACK_DT, TRACK_HOLD, type RangeTrack, type URange } from './axisTrack';

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

/**
 * Axes the probe's frames are drawn with: one set for every frame, or one per frame (a sweep with
 * moving adaptive / free axes: each sample is placed where it is drawn at its own time).
 */
export type ProbeAxes = Axes | Axes[];

/** A value slot in the subtitle (a moving axis range): fixed width while the axes move. */
export interface SubtitleSlot {
  value: string;
  /** Widest value the slot must hold while the axes move. */
  reserve: string;
  /** Value alignment in the slot ('right' before the dash, 'left' after it: the dash stays put). */
  align: 'left' | 'right';
}
export type SubtitlePart = string | SubtitleSlot;

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
  /** The subtitle split into text and range-value slots (see subtitleMix). */
  subtitleParts: SubtitlePart[];
  /**
   * 0 = draw the subtitle as one centred string (static frames, still axes); 1 = value slots at
   * their reserved widths with tabular digits, so the text around the moving numbers stays put
   * (a sweep with moving axes); in between during a glide.
   */
  subtitleMix: number;
  showTitle: boolean;
  showLegend: boolean;
  xTitle: string;
  yTitle: string;
  axes: Axes;
  series: SeriesModel[];
  legend: LegendGroup[];
  legendProbe: LegendProbe;
  /** Axes the probe is placed with (the frame's own for a static slice / still axes). */
  legendAxes: ProbeAxes;
  /** While blending between two frames: the probe of the frame blended from, and the progress. */
  legendProbeFrom: LegendProbe | null;
  legendAxesFrom: ProbeAxes | null;
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

const toRange = (mode: SliceMode, e: Extent | null): URange | null =>
  e && (mode !== 'gray' || e.xMin > 0) ? { x0: toAxisX(mode, e.xMin), x1: toAxisX(mode, e.xMax), y0: e.yMin, y1: e.yMax } : null;
const toExtent = (mode: SliceMode, r: URange | null): Extent | null =>
  r ? { xMin: mode === 'gray' ? Math.pow(10, r.x0) : r.x0, xMax: mode === 'gray' ? Math.pow(10, r.x1) : r.x1, yMin: r.y0, yMax: r.y1 } : null;

/**
 * A sweep's range track (axisTrack.ts) over the visible records, with the per-sample axes of the
 * legend probe and the widest subtitle values, per axis mode. The same for every frame of a
 * sweep: memoised on its inputs (a pure function of them, so every frame is a pure function of t).
 */
interface TrackMemo {
  key: string;
  recs: SvmRecord[];
  track: RangeTrack | null;
  probeAxes: Map<AxisMode, Axes[]>;
  reserve: Map<AxisMode, string[]>;
  levels: Map<AxisMode, { x: Float64Array; y: Float64Array }>;
  speeds: Map<AxisMode, Float64Array[]>;
}
let trackMemo: TrackMemo[] = [];
function memoTrack(recs: SvmRecord[], mode: SliceMode, clip: boolean): TrackMemo {
  const key = `${mode}|${clip}`;
  const hit = trackMemo.find((m) => m.key === key && sameRecs(m.recs, recs));
  if (hit) return hit;
  const value: TrackMemo = { key, recs, track: sweepTrack(recs, mode, clip), probeAxes: new Map(), reserve: new Map(), levels: new Map(), speeds: new Map() };
  trackMemo = [value, ...trackMemo].slice(0, 3);
  return value;
}

/** Legend probe axes of a sweep: the moving axes at each probe sample time. */
function sweepProbeAxes(m: TrackMemo, mode: SliceMode, axisMode: AxisMode): Axes[] {
  let v = m.probeAxes.get(axisMode);
  if (!v) {
    v = Array.from({ length: PROBE_SAMPLES + 1 }, (_, i) => buildAxes(mode, axisMode, toExtent(mode, m.track ? trackAt(m.track, (i / PROBE_SAMPLES) * SWEEP_DURATION) : null)));
    m.probeAxes.set(axisMode, v);
  }
  return v;
}

/** Tick density levels of both axes of a domain (scales.tickLevel), nudged by `bias`. */
function domainLevels(mode: SliceMode, axisMode: AxisMode, e: Extent | null, bias = 0): { x: number; y: number } {
  const [x0, x1] = xDomain(mode, axisMode, e);
  const [y0, y1] = yDomain(axisMode, e);
  return { x: tickLevel(mode === 'gray', x1 - x0, X_COUNT, bias), y: tickLevel(false, y1 - y0, Y_COUNT, bias) };
}

/** Tick density levels over a sweep (axisTrack.levelTrack: hysteresis + smoothing over time). */
function sweepLevels(m: TrackMemo, mode: SliceMode, axisMode: AxisMode): { x: Float64Array; y: Float64Array } {
  let v = m.levels.get(axisMode);
  if (!v) {
    const tr = m.track;
    const n = tr ? tr.x0.length : 1;
    const ext = Array.from({ length: n }, (_, i) => toExtent(mode, tr ? trackAt(tr, i * TRACK_DT) : null));
    const cache = new Map<string, { x: number; y: number }>();
    const lv = (i: number, bias: number) => {
      const k = `${i}|${bias}`;
      let r = cache.get(k);
      if (!r) cache.set(k, (r = domainLevels(mode, axisMode, ext[i], bias)));
      return r;
    };
    v = { x: levelTrack(n, TRACK_DT, (i, b) => lv(i, b).x), y: levelTrack(n, TRACK_DT, (i, b) => lv(i, b).y) };
    m.levels.set(axisMode, v);
  }
  return v;
}

/**
 * Edge speeds of the domains along a range function sampled at n points `step` apart: share of the
 * span per unit of the sample coordinate, per edge [x0, x1, y0, y1], held and smoothed over ±hold
 * samples (axisTrack.holdSmooth).
 */
function speedSeries(mode: SliceMode, axisMode: AxisMode, n: number, step: number, at: (i: number) => Extent | null, hold: number): Float64Array[] {
  const doms = Array.from({ length: n }, (_, i) => {
    const e = at(i);
    return [...xDomain(mode, axisMode, e), ...yDomain(axisMode, e)];
  });
  const out = [0, 1, 2, 3].map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const a = doms[Math.max(0, i - 1)];
    const b = doms[Math.min(n - 1, i + 1)];
    const dt = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step || 1;
    for (let k = 0; k < 4; k++) {
      const span = k < 2 ? doms[i][1] - doms[i][0] : doms[i][3] - doms[i][2];
      out[k][i] = Math.abs(b[k] - a[k]) / dt / Math.max(1e-9, span);
    }
  }
  return out.map((v) => holdSmooth(v, hold));
}

/** Edge speeds over a sweep (share of the span per second), memoised with its track. */
function sweepSpeeds(m: TrackMemo, mode: SliceMode, axisMode: AxisMode): Float64Array[] {
  let v = m.speeds.get(axisMode);
  if (!v) {
    const tr = m.track;
    v = tr ? speedSeries(mode, axisMode, tr.x0.length, TRACK_DT, (i) => toExtent(mode, trackAt(tr, i * TRACK_DT)), Math.round(TRACK_HOLD / TRACK_DT)) : [0, 1, 2, 3].map(() => new Float64Array(1));
    m.speeds.set(axisMode, v);
  }
  return v;
}

/** Visual width proxy of a range value in tabular digits (reserve strings). */
const valueWidth = (v: string) => [...v].reduce((a, ch) => a + (ch >= '0' && ch <= '9' ? 1 : ch === '.' ? 0.45 : 0.9), 0);
const widest = (vs: string[]) => vs.reduce((a, b) => (valueWidth(b) > valueWidth(a) ? b : a), '');

/** Subtitle range values [x0, x1, y0, y1] of a domain. */
function rangeValues(mode: SliceMode, x: [number, number], y: [number, number]): string[] {
  const fmtY = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1));
  const xs = mode === 'gray' ? x.map((u) => fmtTickNits(Math.pow(10, u))) : x.map((u) => String(Math.round(u)));
  return [...xs, ...y.map(fmtY)];
}

/** Widest subtitle values over a whole sweep (the slots keep this width while it plays). */
function sweepReserve(m: TrackMemo, mode: SliceMode, axisMode: AxisMode): string[] {
  let v = m.reserve.get(axisMode);
  if (!v) {
    const cols: string[][] = [[], [], [], []];
    const n = m.track ? m.track.x0.length : 0;
    for (let i = 0; i < n; i++) {
      const e = toExtent(mode, trackAt(m.track!, i * TRACK_DT));
      rangeValues(mode, xDomain(mode, axisMode, e), yDomain(axisMode, e)).forEach((s, k) => cols[k].push(s));
    }
    v = cols.map(widest);
    m.reserve.set(axisMode, v);
  }
  return v;
}

/** A glide's range function (axisTrack.glideTrack) and edge speeds (per unit of p), memoised per glide. */
interface GlideMemo {
  range: ((p: number) => URange | null) | null;
  speeds: Float64Array[] | null;
}
let glideMemo: { key: string; recs: SvmRecord[]; value: GlideMemo }[] = [];
function memoGlide(recs: SvmRecord[], key: string, make: () => GlideMemo): GlideMemo {
  const hit = glideMemo.find((m) => m.key === key && sameRecs(m.recs, recs));
  if (hit) return hit.value;
  const value = make();
  glideMemo = [{ key, recs, value }, ...glideMemo].slice(0, 2);
  return value;
}

let probeMemo: { key: string; recs: SvmRecord[]; value: LegendProbe }[] = [];
function memoProbe(recs: SvmRecord[], mode: SliceMode, clip: boolean, t: number | null, param: number): LegendProbe {
  const key = t === null ? `static|${mode}|${clip}|${param}` : `sweep|${mode}|${clip}`;
  const hit = probeMemo.find((m) => m.key === key && sameRecs(m.recs, recs));
  if (hit) return hit.value;
  const params = t === null ? [param] : Array.from({ length: PROBE_SAMPLES + 1 }, (_, i) => sweepParam(mode, (i / PROBE_SAMPLES) * SWEEP_DURATION));
  const slice = t === null ? staticSliceFor : sliceFor;
  const frames = params.map((p) => recs.map((r) => curveOf(mode, slice(r, mode, p, clip))).filter((c): c is Curve => !!c));
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
 * SVM read off the static 2D gray-slice curve at `nits` (exactly what the chart, its tooltip and
 * its table show), or null outside the curve / in a gap. docs/adr/0009 asks the stats'
 * typical-luminance SVM to use the same curve as the 2D chart: this is that curve.
 */
export function graySliceSvmAt(rec: SvmRecord, gray: number, nits: number): number | null {
  if (!(nits > 0)) return null;
  const c = curveOf('gray', staticSliceFor(rec, 'gray', gray, false));
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
   * position and title width all move continuously). `rate` = dp/dt (1/s) of the eased progress,
   * for the edge fades of moving axes (default 1).
   */
  blend?: { from: number | null; p: number; rate?: number };
}

/** Build the scene for the frame described by `opts`. */
export function buildScene(inputs: ChartInputs, opts: SceneOptions): Scene {
  const { lang, sliceMode: mode, axisMode, clipLowGray } = inputs;
  const tr = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const hidden = new Set(inputs.hiddenIds);
  const visible = inputs.records.filter((r) => !hidden.has(r.id));
  const blend = opts.blend && opts.blend.p < 1 ? { from: opts.blend.from, p: Math.max(0, opts.blend.p), rate: opts.blend.rate ?? 1 } : null;
  const paramTo = sliceParam(inputs, opts.t);
  const paramFrom = blend ? sliceParam(inputs, blend.from) : paramTo;
  const param = blend ? mixParam(mode, paramFrom, paramTo, blend.p) : paramTo;
  // How static the frame is (1 = a static slice: readings only, no fading ghosts; 0 = a sweep
  // frame with its fades; in between during a glide, so the glide never pops; see settleSlice).
  const staticW = (tt: number | null) => (tt === null ? 1 : 0);
  const settle = blend ? staticW(blend.from) + (staticW(opts.t) - staticW(blend.from)) * blend.p : staticW(opts.t);

  // the static end of a glide (for the per-point gains of settleSlice)
  const paramStatic = blend && blend.from === null ? paramFrom : paramTo;

  // Points of a frame at param `prm` that is `w` static (the glide's static end: paramStatic).
  const refCache = new Map<SvmRecord, CurvePoint[]>();
  const refOf = (rec: SvmRecord) => {
    let r = refCache.get(rec);
    if (!r) refCache.set(rec, (r = sliceFor(rec, mode, paramStatic, clipLowGray)));
    return r;
  };
  const framePoints = (rec: SvmRecord, prm: number, w: number): CurvePoint[] => {
    const raw = sliceFor(rec, mode, prm, clipLowGray);
    return w === 1 ? settleSlice(raw) : w > 0 ? settleSlice(raw, w, refOf(rec)) : raw;
  };

  const series: SeriesModel[] = visible.map((rec) => {
    const points = framePoints(rec, param, settle);
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

  // Axes (docs/adr/0006): standard = fixed. Adaptive / free = the data extent of the frame: a
  // static slice's exact extent (the curve passes through every point and never overshoots them,
  // so the extent of the points is exactly the extent of what is drawn); while a sweep plays, the
  // smoothed opacity-weighted range of the current frame (axisTrack.ts, a pure function of t);
  // during a glide, the glide's own frames, pinned to the exact ranges of its two ends.
  const moving = axisMode !== 'standard' && (opts.t !== null || !!blend);
  const tm = moving && (opts.t !== null || (blend && blend.from !== null)) ? memoTrack(visible, mode, clipLowGray) : null;
  const staticExtent = (prm: number): Extent | null =>
    prm === param && settle === 1 ? slicesExtent(series.map((se) => se.points)) : slicesExtent(visible.map((r) => staticSliceFor(r, mode, prm, clipLowGray)));
  const endRange = (tt: number | null, prm: number): URange | null => (tt === null ? toRange(mode, staticExtent(prm)) : tm?.track ? trackAt(tm.track, tt) : null);
  const endLevels = (tt: number | null, prm: number) => {
    if (tt === null || !tm) return domainLevels(mode, axisMode, staticExtent(prm));
    const lv = sweepLevels(tm, mode, axisMode);
    return { x: seriesAt(lv.x, TRACK_DT, tt), y: seriesAt(lv.y, TRACK_DT, tt) };
  };
  let extent: Extent | null = null;
  let motion: AxisMotion | undefined;
  let staticEnd: Extent | null = null;
  if (axisMode !== 'standard') {
    if (!moving) extent = staticExtent(param);
    else if (!blend) {
      extent = toExtent(mode, endRange(opts.t, paramTo));
      const tt = opts.t!;
      const tr = tm!.track;
      const sp = tr ? sweepSpeeds(tm!, mode, axisMode).map((a) => seriesAt(a, TRACK_DT, tt)) : null;
      const spd: AxisMotion['speed'] = sp ? { x: [sp[0], sp[1]], y: [sp[2], sp[3]] } : undefined;
      motion = { settle: 0, from: null, level: endLevels(tt, paramTo), speed: spd };
    } else {
      const bl = blend;
      const key = `${mode}|${clipLowGray}|${bl.from}|${paramFrom}|${opts.t}|${paramTo}`;
      const gm = memoGlide(visible, `${key}|${axisMode}`, () => {
        const w = (p: number) => staticW(bl.from) + (staticW(opts.t) - staticW(bl.from)) * p;
        const frameAt = (p: number) => visible.map((r) => framePoints(r, mixParam(mode, paramFrom, paramTo, p), w(p)));
        const range = glideTrack(mode, frameAt, endRange(bl.from, paramFrom), endRange(opts.t, paramTo));
        const speeds = range ? speedSeries(mode, axisMode, GLIDE_SAMPLES + 1, 1 / GLIDE_SAMPLES, (i) => toExtent(mode, range(i / GLIDE_SAMPLES)), 4) : null;
        return { range, speeds };
      });
      const glide = gm.range;
      extent = toExtent(mode, glide ? glide(bl.p) : null);
      staticEnd = bl.from === null ? staticExtent(paramFrom) : opts.t === null ? staticExtent(paramTo) : null;
      const la = endLevels(bl.from, paramFrom);
      const lb = endLevels(opts.t, paramTo);
      const sp = gm.speeds ? gm.speeds.map((a) => seriesAt(a, 1 / GLIDE_SAMPLES, bl.p) * bl.rate) : null;
      const spd: AxisMotion['speed'] = sp ? { x: [sp[0], sp[1]], y: [sp[2], sp[3]] } : undefined;
      motion = { settle, from: staticEnd, level: { x: la.x + (lb.x - la.x) * bl.p, y: la.y + (lb.y - la.y) * bl.p }, speed: spd };
    }
  }
  const axes = buildAxes(mode, axisMode, extent, motion);

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

  // Subtitle: axis mode + ranges. The ranges of moving axes are value slots (fixed width while
  // the axes move, so the text around them never shifts).
  const [xa, xb, ya, yb] = rangeValues(mode, [axes.x.u0, axes.x.u1], [axes.y.u0, axes.y.u1]);
  let reserve = [xa, xb, ya, yb];
  if (moving && tm) reserve = sweepReserve(tm, mode, axisMode).map((r, k) => widest([r, reserve[k]]));
  if (moving && staticEnd) {
    const se = rangeValues(mode, xDomain(mode, axisMode, staticEnd), yDomain(axisMode, staticEnd));
    reserve = reserve.map((r, k) => widest([r, se[k]]));
  }
  const slot = (k: number, align: 'left' | 'right', live: boolean): SubtitlePart => {
    const v = [xa, xb, ya, yb][k];
    return live ? { value: v, reserve: reserve[k], align } : v;
  };
  const range = (key: string, a: SubtitlePart, b: SubtitlePart): SubtitlePart[] => {
    const tp = tr(key);
    const ia = tp.indexOf('{a}');
    const ib = tp.indexOf('{b}');
    if (ia < 0 || ib < ia) return [tr(key, { a: typeof a === 'string' ? a : a.value, b: typeof b === 'string' ? b : b.value })];
    return [tp.slice(0, ia), a, tp.slice(ia + 3, ib), b, tp.slice(ib + 3)].filter((x) => x !== '');
  };
  const sep = '  ·  ';
  const subtitleParts: SubtitlePart[] = [tr(`chart2d.axisMode.${axisMode}`), sep];
  subtitleParts.push(...range(mode === 'gray' ? 'chart2d.range.nits' : 'chart2d.range.gray', slot(0, 'right', moving), slot(1, 'left', moving)));
  subtitleParts.push(sep, ...range('chart2d.range.svm', slot(2, 'right', moving && axisMode === 'free'), slot(3, 'left', moving && axisMode === 'free')));
  if (mode === 'brightness' && clipLowGray) subtitleParts.push(sep, tr('common.lowGrayClipped'));
  const subtitle = subtitleParts.map((pt) => (typeof pt === 'string' ? pt : pt.value)).join('');

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
  // Each end is placed with the axes it is drawn with: a static slice with its own axes, a sweep
  // with every probe sample's moving axes (one corner for the whole sweep either way).
  const legendProbe = memoProbe(legendRecs, mode, clipLowGray, opts.t, paramTo);
  const legendProbeFrom = blend ? memoProbe(legendRecs, mode, clipLowGray, blend.from, paramFrom) : null;
  const probeAxes = (tt: number | null, prm: number): ProbeAxes => {
    if (axisMode === 'standard') return axes;
    if (tt !== null) return sweepProbeAxes(tm ?? memoTrack(visible, mode, clipLowGray), mode, axisMode);
    return !moving ? axes : buildAxes(mode, axisMode, staticExtent(prm));
  };
  const legendAxes = probeAxes(opts.t, paramTo);
  const legendAxesFrom = blend ? probeAxes(blend.from, paramFrom) : null;

  return {
    mode,
    param,
    title,
    titleSlot,
    subtitle,
    subtitleParts,
    subtitleMix: moving ? 1 - settle : 0,
    showTitle: inputs.showTitle ?? true,
    showLegend: inputs.showLegend ?? true,
    xTitle: tr(mode === 'gray' ? 'chart2d.axis.xGray' : 'chart2d.axis.xLevel'),
    yTitle: tr('chart2d.axis.y'),
    axes,
    series,
    legend,
    legendProbe,
    legendAxes,
    legendProbeFrom,
    legendAxesFrom,
    legendMix: blend ? blend.p : 1,
    interactive: opts.interactive,
    background: inputs.presenting && inputs.presentBlack ? '#000000' : CHART_BG,
    refLabels: { safe: tr('common.safeLine'), critical: tr('common.criticalLine') },
    emptyText: tr('chart2d.empty.canvas'),
    lang,
  };
}
