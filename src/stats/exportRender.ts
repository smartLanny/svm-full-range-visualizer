/**
 * Canvas2D renderer of the stats page exports (docs/adr/0010, addendum "stats page"): the cards
 * grid and the table, redrawn offline at any size from the same view model as the screen
 * (sorted rows, "best" marks, coverage caveats, exclusion badges, record keys, heatmap
 * thumbnails via heatmap.ts). The on-screen design is replicated in "design px" (the CSS px of
 * StatsCard / StatsTable) and scaled into the export: the cards are laid out on a grid chosen
 * for the export's aspect (exportLayout.ts), the page title and scope line on top.
 *
 * Every card / table band is drawn by one "pass" that walks it top to bottom: without a context
 * it only measures (natural height), with one it also draws, so layout and drawing never disagree.
 * Interactive-only parts (the "在 3D 中查看" buttons, hover states, sort icons of inactive columns,
 * the scroll affordance) are left out.
 */
import type { ColormapType, Lang } from '../types';
import type { RecordStyle } from '../data/colors';
import { deviceLabel, modeLabel } from '../data/records';
import { fmtNits, gridView, type GridView } from '../data/grid';
import { exclusionSummary } from '../data/anomalies';
import { SVM_AT_NITS } from '../data/stats';
import { translate, type TFunction } from '../i18n';
import { FONT_STACK } from '../chart2d/render';
import { band, BAND_COLORS, fmtNitsOrDash, fmtPct, fmtSvmOrDash, markOf, metricByKey, type MetricKey, type Ranking, type SortDir, type SortKey, type StatsRow } from './model';
import { drawHeatmap, HATCH_BASE, HATCH_LINE, hasNoDataCells, THUMB_HEIGHT, thumbGrayLabels, thumbTicks, type ThumbExtent } from './heatmap';
import {
  cachedMeasure,
  chooseCardGrid,
  chromeScale,
  ellipsize,
  fitTable,
  HEADER,
  HEADER_H,
  pageFrame,
  STRIP,
  wrapText,
  type Box,
  type CardGrid,
  type Measure,
  type TableFit,
} from './exportLayout';

export type StatsContentId = 'cards' | 'table';

/** Everything the export draws: the same inputs as the stats page. */
export interface StatsExportInput {
  lang: Lang;
  /** Visible records in on-screen order (the page's sort). */
  rows: StatsRow[];
  styles: Map<string, RecordStyle>;
  rank: Ranking;
  extent: ThumbExtent | null;
  clipLowGray: boolean;
  maxNits: number | null;
  sliceGray: number;
  colormap: ColormapType;
  colorMax: number;
  sortKey: SortKey;
  sortDir: SortDir;
  /** "统计范围" text as on the page ("G ≥ 15 · 档位亮度 ≤ 500 nits · 当前灰阶截面 G127"). */
  scope: string;
}

/** Where things ended up (output px), for the verification script and tests. */
export interface StatsRenderInfo {
  content: StatsContentId;
  width: number;
  height: number;
  header: Box;
  body: Box;
  strip: Box | null;
  /** Output px per design px of the cards / table. */
  scale: number;
  /** Cards: grid and each card's rectangle (in row order). */
  grid?: CardGrid;
  cards?: Box[];
  /** Table: the bands (column keys) and their rectangles. */
  bands?: { cols: string[]; box: Box }[];
}

// ---- design tokens (tailwind.config.js) ------------------------------------------------------

export const C = {
  canvas: '#07090d',
  s1: '#0b0e14',
  s2: '#11151d',
  s3: '#171c26',
  s4: '#1e2430',
  line: '#232a36',
  lineStrong: '#2f3847',
  ink1: '#f3f5f8',
  ink2: '#b6bfcc',
  ink3: '#7d8796',
  ink4: '#566070',
  accent: '#4c8dff',
  accentHover: '#6aa1ff',
  accentMuted: 'rgba(76,141,255,0.14)',
  accent15: 'rgba(76,141,255,0.15)',
  accent30: 'rgba(76,141,255,0.30)',
  amber: '#fcd34d',
  amberBg: 'rgba(245,158,11,0.15)',
  amberRing: 'rgba(251,191,36,0.25)',
  red300: '#fca5a5',
} as const;

const fontOf = (weight: number, size: number) => `${weight} ${size}px ${FONT_STACK}`;
/** Baseline of a line box (CSS line-height `lh`, top `top`) for Inter: half-leading + ascent. */
const baseline = (top: number, lh: number, size: number) => top + lh / 2 + 0.3637 * size;

// lucide icons (24×24, stroke 2)
const ICONS = {
  warn: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  up: ['m5 12 7-7 7 7', 'M12 19V5'],
  down: ['M12 5v14', 'm19 12-7 7-7-7'],
  chart: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
} as const;
type IconName = keyof typeof ICONS;
let iconPaths: Record<IconName, Path2D[]> | null = null;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]) {
  const [tl, tr, br, bl] = (typeof r === 'number' ? [r, r, r, r] : r).map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** Drawing in design px (the current transform maps them to output px). No-op without a context. */
class Pen {
  constructor(
    readonly ctx: CanvasRenderingContext2D | null,
    readonly m: Measure,
  ) {}

  get on(): boolean {
    return this.ctx !== null;
  }

  /** Text on `base` (alphabetic baseline); returns its width. `spacing` = letter-spacing in px. */
  textB(str: string, x: number, base: number, size: number, weight: number, color: string, align: CanvasTextAlign = 'left', spacing = 0): number {
    const w = this.m(str, size, weight) + spacing * Array.from(str).length;
    const ctx = this.ctx;
    if (ctx && str) {
      ctx.font = fontOf(weight, size);
      ctx.fillStyle = color;
      ctx.textBaseline = 'alphabetic';
      const ls = spacing !== 0 && 'letterSpacing' in ctx;
      if (ls) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
      // Aligned by measured width (letter-spacing included), always drawn left-aligned.
      ctx.textAlign = 'left';
      ctx.fillText(str, align === 'right' || align === 'end' ? x - w : align === 'center' ? x - w / 2 : x, base);
      if (ls) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    }
    return w;
  }

  /** Text in a CSS line box (`top`, line-height `lh`); returns its width. */
  text(str: string, x: number, top: number, lh: number, size: number, weight: number, color: string, align: CanvasTextAlign = 'left'): number {
    return this.textB(str, x, baseline(top, lh, size), size, weight, color, align);
  }

  fill(x: number, y: number, w: number, h: number, color: string, r: number | [number, number, number, number] = 0) {
    const ctx = this.ctx;
    if (!ctx || w <= 0 || h <= 0) return;
    ctx.fillStyle = color;
    if (!r) ctx.fillRect(x, y, w, h);
    else {
      roundRectPath(ctx, x, y, w, h, r);
      ctx.fill();
    }
  }

  /** 1 px inset ring (tailwind ring-1 ring-inset). */
  ring(x: number, y: number, w: number, h: number, r: number, color: string, width = 1, dash?: number[]) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    roundRectPath(ctx, x + width / 2, y + width / 2, w - width, h - width, Math.max(0, r - width / 2));
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  icon(name: IconName, x: number, y: number, size: number, color: string, stroke = 2) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!iconPaths) iconPaths = Object.fromEntries(Object.entries(ICONS).map(([k, ds]) => [k, ds.map((d) => new Path2D(d))])) as Record<IconName, Path2D[]>;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of iconPaths[name]) ctx.stroke(p);
    ctx.restore();
  }

  dot(cx: number, cy: number, r: number, color: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, width: number, dash: number[] = [], cap: CanvasLineCap = 'butt') {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = cap;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * An image rendered at the exact output-pixel size of the design rect (x, y, w, h), clipped to
   * radius r: `render(pxW, pxH, scale)` returns the canvas to draw (the heatmaps).
   */
  image(x: number, y: number, w: number, h: number, r: number, render: (pw: number, ph: number, scale: number) => HTMLCanvasElement | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const T = ctx.getTransform();
    const X0 = Math.round(T.a * x + T.e);
    const Y0 = Math.round(T.d * y + T.f);
    const pw = Math.max(1, Math.round(T.a * (x + w) + T.e) - X0);
    const ph = Math.max(1, Math.round(T.d * (y + h) + T.f) - Y0);
    const img = render(pw, ph, T.a);
    if (!img) return;
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, X0, Y0, pw, ph);
    ctx.restore();
  }
}

// ---- shared parts (parts.tsx) ----------------------------------------------------------------

interface Env {
  t: TFunction;
  lang: Lang;
  input: StatsExportInput;
  /** Grid views of the records (thumbnails), memoized per render. */
  views: Map<string, GridView>;
  /** Heatmap canvases drawn during this render (their backing stores are released at the end). */
  scratch: HTMLCanvasElement[];
}

function viewOf(e: Env, row: StatsRow): GridView {
  let v = e.views.get(row.rec.id);
  if (!v) {
    v = gridView(row.rec, { clipLowGray: e.input.clipLowGray, maxNits: e.input.maxNits });
    e.views.set(row.rec.id, v);
  }
  return v;
}

/** Row-level caveat of a low-coverage record (parts.tsx caveatText). */
function caveatOf(e: Env, row: StatsRow): boolean {
  const { rank } = e.input;
  return rank.low.has(row.rec.id) && row.stats.coverageShare !== null && rank.medianCoverage !== null;
}

/** Device colour chip + line sample in the mode dash (RecordKey), 40×12 at (x, y). */
function recordKey(p: Pen, x: number, y: number, style: RecordStyle | undefined) {
  const color = style?.color ?? '#7d8796';
  const dash = style?.dash ?? [];
  p.fill(x, y, 12, 12, color, 3);
  p.ring(x, y, 12, 12, 3, 'rgba(255,255,255,0.15)');
  p.line(x + 18, y + 6, x + 40, y + 6, color, 2, dash.map((d) => d * 0.6), dash.length ? 'butt' : 'round');
}

/** Width of the exclusion badge "⚠ 已剔除 N" (px-1.5, icon 10, gap 1). */
const badgeWidth = (p: Pen, label: string) => 6 + 10 + 4 + p.m(label, 10, 500) + 6;

/** Exclusion badge, 18 tall at (x, y). Returns its width. */
function exclusionBadge(p: Pen, label: string, x: number, y: number): number {
  const w = badgeWidth(p, label);
  p.fill(x, y, w, 18, C.amberBg, 4);
  p.ring(x, y, w, 18, 4, C.amberRing);
  p.icon('warn', x + 6, y + 4, 10, C.amber);
  p.text(label, x + 20, y + 1, 16, 10, 500, C.amber);
  return w;
}

const BANDS = ['safe', 'mid', 'critical'] as const;

/** Stacked safe / mid / critical bar (ShareBar), percentages in segments ≥ 13 % unless compact. */
function shareBar(p: Pen, row: StatsRow, x: number, y: number, w: number, h: number, compact: boolean) {
  const s = row.stats;
  const shares = { safe: s.safeShare ?? 0, mid: s.midShare ?? 0, critical: s.criticalShare ?? 0 };
  const ctx = p.ctx;
  if (!ctx) return;
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 4);
  ctx.clip();
  p.fill(x, y, w, h, compact ? C.s4 : C.s3);
  const segs = BANDS.filter((b) => shares[b] > 0);
  let cx = x;
  segs.forEach((b, i) => {
    const sw = shares[b] * w;
    p.fill(cx, y, sw, h, BAND_COLORS[b]);
    if (i < segs.length - 1) p.fill(cx + sw - 1, y, 1, h, 'rgba(0,0,0,0.4)');
    if (!compact && shares[b] >= 0.13) p.text(fmtPct(shares[b], 0), cx + sw / 2, y + (h - 14) / 2, 14, 10, 600, 'rgba(0,0,0,0.75)', 'center');
    cx += sw;
  });
  ctx.restore();
}

/** SVM value with its status dot (SvmValue); '—' in ink-4 when missing. Returns the width. */
function svmValue(p: Pen, v: number | null, x: number, top: number, lh: number, size: number, weight: number, color: string, align: 'left' | 'right' = 'left', digits = 2): number {
  const missing = v === null || !Number.isFinite(v);
  const str = missing ? '—' : v.toFixed(digits);
  const tw = p.m(str, size, weight);
  const w = missing ? tw : 12 + tw;
  const x0 = align === 'right' ? x - w : x;
  if (missing) p.text(str, x0, top, lh, size, weight, C.ink4);
  else {
    p.dot(x0 + 3, top + lh / 2, 3, BAND_COLORS[band(v)]);
    p.text(str, x0 + 12, top, lh, size, weight, color);
  }
  return w;
}

const svmValueWidth = (p: Pen, v: number | null, size: number, weight: number, digits = 2) =>
  v === null || !Number.isFinite(v) ? p.m('—', size, weight) : 12 + p.m(v.toFixed(digits), size, weight);

// ---- card (StatsCard) ------------------------------------------------------------------------

/**
 * One card at card width `cw` (design px, origin = its top-left). `h` = the height to draw (the
 * grid row's height, ≥ natural); null = measure only. Returns the natural height.
 */
function cardPass(p: Pen, e: Env, row: StatsRow, cw: number, h: number | null): number {
  const { t, input } = e;
  const { rec, stats: s } = row;
  const iw = cw - 32;
  const R = cw - 16;
  const mark = (k: MetricKey, v: number | null) => markOf(input.rank, k, row, v);
  const caveat = caveatOf(e, row);

  if (h !== null) {
    p.fill(0, 0, cw, h, C.s2, 12);
    p.ring(0, 0, cw, h, 12, C.line);
  }

  // header: key + name (two lines at most; no "在 3D 中查看" button in a picture), mode + badge
  recordKey(p, 16, 18, input.styles.get(rec.id));
  const textW = iw - 50;
  const names = wrapText(deviceLabel(rec, e.lang), textW, 2, 14, 600, p.m);
  names.forEach((l, i) => p.text(l, 66, 14 + i * 20, 20, 14, 600, C.ink1));
  let y = 14 + names.length * 20;
  const mode = modeLabel(rec, e.lang);
  const modes = mode ? wrapText(mode, textW, 2, 12, 400, p.m) : [''];
  const sum = exclusionSummary(rec);
  const badge = sum ? t('common.exclusion.badge', { n: sum.total }) : null;
  const modeW = mode ? p.m(modes[0], 12, 400) : p.m(' ', 12, 400);
  if (badge && modes.length === 1 && modeW + 6 + badgeWidth(p, badge) <= textW) {
    p.text(modes[0], 66, y + 1, 16, 12, 400, C.ink3);
    exclusionBadge(p, badge, 66 + modeW + 6, y);
    y += 18;
  } else {
    modes.forEach((l, i) => p.text(l, 66, y + i * 16, 16, 12, 400, C.ink3));
    y += modes.length * 16;
    if (badge) {
      exclusionBadge(p, badge, 66, y + 4);
      y += 22;
    }
  }
  y += 12;

  if (s.cellCount === 0) {
    // No valid cell in scope: a dashed box filling the card.
    const natural = 40 + 16 + 4 + 14 + 40;
    const boxH = h !== null ? Math.max(natural, h - y - 16) : natural;
    p.ring(16, y, iw, boxH, 8, C.lineStrong, 1, [4, 3]);
    const top = y + (boxH - 34) / 2;
    p.text(t('stats.noCells'), cw / 2, top, 16, 12, 400, C.ink2, 'center');
    p.text(t('stats.noCellsHint'), cw / 2, top + 20, 14, 10, 400, C.ink3, 'center');
    return y + natural + 16;
  }

  // hero: safe share (big), critical share (right), share bar + legend + coverage
  const y0 = y;
  const safeMark = mark('safe', s.safeShare);
  const lw = p.text(t('stats.metric.safeShare'), 16, y0, 16, 12, 400, C.ink2);
  if (safeMark === 'best') {
    const bw = 6 + p.m(t('stats.best'), 10, 500) + 6;
    p.fill(16 + lw + 6, y0 - 2, bw, 20, C.accentMuted, 4);
    p.text(t('stats.best'), 16 + lw + 12, y0, 16, 10, 500, C.accentHover);
  } else if (safeMark === 'caveat') p.icon('warn', 16 + lw + 6, y0 + 2.5, 11, C.amber);
  const heroBase = baseline(y0 + 18, 34, 34);
  const nw = p.textB(s.safeShare === null ? '—' : (s.safeShare * 100).toFixed(1), 16, heroBase, 34, 600, C.ink1, 'left', -0.85);
  p.textB('%', 16 + nw + 2, heroBase, 18, 500, C.ink3);

  const critMark = mark('critical', s.criticalShare);
  p.text(t('stats.col.critical'), R, y0 + 15, 16, 12, 400, C.ink2, 'right');
  const critBase = baseline(y0 + 35, 20, 20);
  // flex gap-1 + ml-0.5 between the number and "%"
  const pw = p.textB('%', R, critBase, 14, 500, C.ink3, 'right');
  const cvw = p.textB(s.criticalShare === null ? '—' : (s.criticalShare * 100).toFixed(1), R - pw - 6, critBase, 20, 600, critMark === 'best' ? C.accentHover : C.ink1, 'right');
  if (critMark === 'caveat') p.icon('warn', R - pw - 6 - cvw - 4 - 11, y0 + 35 + 4.5, 11, C.amber);

  shareBar(p, row, 16, y0 + 67, iw, 20, false);

  // legend line(s): three bands, then the coverage read-out pushed right (flex-wrap, ml-auto)
  const ly = y0 + 93;
  const shares = { safe: s.safeShare, mid: s.midShare, critical: s.criticalShare };
  let lx = 0;
  let line = 0;
  for (const b of BANDS) {
    const label = t(`stats.band.${b}`);
    const value = fmtPct(shares[b] ?? 0);
    const w = 8 + 4 + p.m(label, 10, 400) + 4 + p.m(value, 10, 400);
    if (lx > 0 && lx + 12 + w > iw) {
      line++;
      lx = 0;
    } else if (lx > 0) lx += 12;
    const x = 16 + lx;
    const top = ly + line * 16;
    p.fill(x, top + 3, 8, 8, BAND_COLORS[b], 2);
    const l1 = p.text(label, x + 12, top, 14, 10, 400, C.ink3);
    p.text(value, x + 12 + l1 + 4, top, 14, 10, 400, C.ink2);
    lx += w;
  }
  const covLabel = t('stats.metric.coverage');
  const covValue = fmtPct(s.coverageShare);
  const covW = p.m(covLabel, 10, 400) + 4 + (caveat ? 15 : 0) + p.m(covValue, 10, 400);
  if (lx > 0 && lx + 12 + covW > iw) line++;
  {
    const top = ly + line * 16;
    const vw = p.text(covValue, R, top, 14, 10, 400, caveat ? C.amber : C.ink1, 'right');
    if (caveat) p.icon('warn', R - vw - 15, top + 1.5, 11, C.amber);
    p.text(covLabel, R - vw - (caveat ? 15 : 0) - 4, top, 14, 10, 400, C.ink3, 'right');
  }
  const heroH = 93 + (line + 1) * 14 + line * 2;

  // key metrics: full-white safe luminance, peak, mean
  const y1 = y0 + heroH + 16;
  p.fill(16, y1, iw, 1, C.line);
  const mt = y1 + 13;
  const colW = (iw - 24) / 3;
  const metrics: { label: string; value: string | null; unit?: string; sub?: string; subColor?: string; mark: 'best' | 'caveat' | null }[] = [
    {
      label: t('stats.metric.fullWhite'),
      value: s.fullWhiteSafeNits === null ? null : fmtNits(s.fullWhiteSafeNits),
      unit: 'nits',
      sub: s.fullWhiteSafeNits === null ? t('stats.metric.fullWhiteNever') : s.fullWhiteAllSafe ? t('stats.metric.fullWhiteAll') : t('stats.metric.fullWhiteFrom'),
      subColor: s.fullWhiteSafeNits === null ? C.red300 : undefined,
      mark: mark('fullWhite', s.fullWhiteSafeNits),
    },
    {
      label: t('stats.metric.peak'),
      value: fmtSvmOrDash(s.peak?.svm ?? null),
      sub: s.peak ? t('stats.metric.peakWhere', { g: s.peak.gray, n: fmtNits(s.peak.levelNits) }) : undefined,
      mark: mark('peak', s.peak?.svm ?? null),
    },
    { label: t('stats.metric.mean'), value: fmtSvmOrDash(s.meanSvm), sub: t('stats.metric.meanHint'), mark: mark('mean', s.meanSvm) },
  ];
  metrics.forEach((mm, i) => {
    const x = 16 + i * (colW + 12);
    p.text(ellipsize(mm.label, colW, 11, 400, p.m), x, mt, 16, 11, 400, C.ink3);
    let vx = x;
    if (mm.mark === 'caveat') {
      p.icon('warn', vx, mt + 18 + 4.5, 11, C.amber);
      vx += 15;
    }
    const vb = baseline(mt + 18, 20, 15);
    if (mm.value === null) p.textB('—', vx, vb, 15, 600, C.ink4);
    else {
      vx += p.textB(mm.value, vx, vb, 15, 600, mm.mark === 'best' ? C.accentHover : C.ink1);
      // flex gap-1 + ml-1 before the unit
      if (mm.unit) p.textB(mm.unit, vx + 8, vb, 10, 400, C.ink3);
    }
    if (mm.sub) p.text(ellipsize(mm.sub, colW, 10, 400, p.m), x, mt + 38, 14, 10, 400, mm.subColor ?? C.ink3);
  });

  // heatmap thumbnail (Thumbnail.tsx)
  let y3 = y1 + 65 + 12;
  const extent = input.extent;
  if (extent) {
    const y2 = y1 + 65 + 16;
    const avail = iw - 36;
    const view = viewOf(e, row);
    const noData = hasNoDataCells(view);
    const caption = t('stats.thumb.caption');
    const keys: { kind: 'hatch' | 'safe' | 'critical'; label: string }[] = [
      ...(noData ? [{ kind: 'hatch' as const, label: t('common.noValidData') }] : []),
      { kind: 'safe', label: '0.4' },
      { kind: 'critical', label: '1.0' },
    ];
    const keysW = keys.reduce((a, k, i) => a + (i ? 10 : 0) + 14 + 4 + p.m(k.label, 10, 400), 0);
    const capW = p.m(caption, 10, 400);
    const oneLine = capW + 8 + keysW <= avail;
    p.text(oneLine ? caption : ellipsize(caption, avail, 10, 400, p.m), 52, y2, 14, 10, 400, C.ink3);
    const ky = oneLine ? y2 : y2 + 16;
    let kx = R - keysW;
    keys.forEach((k) => {
      if (k.kind === 'hatch') {
        const ctx = p.ctx;
        if (ctx) {
          ctx.save();
          roundRectPath(ctx, kx, ky + 2, 14, 10, 2);
          ctx.clip();
          p.fill(kx, ky + 2, 14, 10, HATCH_BASE);
          for (let d = -10; d < 14; d += 4) p.line(kx + d, ky + 12, kx + d + 10, ky + 2, HATCH_LINE, 1);
          ctx.restore();
          p.ring(kx, ky + 2, 14, 10, 2, 'rgba(255,255,255,0.10)');
        }
      } else if (k.kind === 'safe') {
        p.fill(kx - 1, ky + 5, 16, 4, 'rgba(0,0,0,0.6)', 2);
        p.fill(kx, ky + 6, 14, 2, '#ffffff', 1);
      } else {
        p.fill(kx - 1, ky + 4.5, 16, 5, 'rgba(255,255,255,0.75)', 2);
        p.fill(kx, ky + 5.5, 14, 3, '#0b0e14', 1);
      }
      kx += 18 + p.text(k.label, kx + 18, ky, 14, 10, 400, C.ink3) + 10;
    });
    const hy = y2 + (oneLine ? 14 : 30) + 6;
    const sliceGray = row.stats.sliceGray;
    p.image(52, hy, avail, THUMB_HEIGHT, 6, (pw, ph, scale) => {
      const c = document.createElement('canvas');
      c.width = pw;
      c.height = ph;
      const hctx = c.getContext('2d');
      if (!hctx) return null;
      drawHeatmap(hctx, view, { W: pw, H: ph, dpr: scale, colormap: input.colormap, colorMax: input.colorMax, sliceGray, extent });
      e.scratch.push(c);
      return c;
    });
    p.ring(52, hy, avail, THUMB_HEIGHT, 6, C.line);
    for (const g of thumbGrayLabels(extent, sliceGray)) {
      p.text(`G${g.g}`, 44, hy + g.top, 14, 10, g.accent ? 500 : 400, g.accent ? C.accentHover : C.ink3, 'right');
    }
    for (const tk of thumbTicks(avail, extent)) {
      const label = String(tk.v);
      if (tk.px < 8) p.text(label, 52, hy + THUMB_HEIGHT + 4, 14, 10, 400, C.ink3);
      else if (tk.px > avail - 12) p.text(label, 52 + avail, hy + THUMB_HEIGHT + 4, 14, 10, 400, C.ink3, 'right');
      else p.text(label, 52 + tk.px, hy + THUMB_HEIGHT + 4, 14, 10, 400, C.ink3, 'center');
    }
    y3 = hy + THUMB_HEIGHT + 4 + 14 + 12;
  }

  // SVM at typical luminances (gray slice)
  p.fill(16, y3, iw, 79, C.s1, 8);
  p.ring(16, y3, iw, 79, 8, C.line);
  p.text(t('stats.metric.svmAt'), 28, y3 + 10, 14, 10, 400, C.ink3);
  if (s.sliceGray !== null) p.text(t('stats.metric.svmAtSlice', { g: Math.round(s.sliceGray) }), R - 12, y3 + 10, 14, 10, 400, C.ink3, 'right');
  const aw = (iw - 24 - 24) / 4;
  s.svmAt.forEach((a, i) => {
    const x = 28 + i * (aw + 8);
    p.text(`${a.nits} nits`, x, y3 + 30, 14, 10, 400, C.ink4);
    const m = mark(`at${i}` as MetricKey, a.svm);
    const w = svmValue(p, a.svm, x, y3 + 49, 20, 14, 500, m === 'best' ? C.accentHover : C.ink1);
    if (m === 'caveat') p.icon('warn', x + w + 4, y3 + 49 + 4.5, 11, C.amber);
  });
  return y3 + 79 + 16;
}

// ---- table (StatsTable) ------------------------------------------------------------------------

type ColKey = 'record' | 'dist' | MetricKey;

interface Col {
  key: ColKey;
  label: string;
  sub?: string;
  align: 'left' | 'right';
  /** Right padding of the cells (the coverage column has pr-3). */
  padR: number;
  /** Member of the "SVM @ 实测亮度" group (second header row). */
  group?: boolean;
}

function tableCols(t: TFunction): Col[] {
  return [
    { key: 'record', label: t('stats.col.record'), align: 'left', padR: 12 },
    { key: 'dist', label: t('stats.col.dist'), align: 'left', padR: 8 },
    { key: 'safe', label: t('stats.col.safe'), sub: 'SVM < 0.4', align: 'right', padR: 8 },
    { key: 'mid', label: t('stats.col.mid'), sub: '0.4 – 1.0', align: 'right', padR: 8 },
    { key: 'critical', label: t('stats.col.critical'), sub: '≥ 1.0', align: 'right', padR: 8 },
    { key: 'fullWhite', label: t('stats.col.fullWhite'), sub: 'nits', align: 'right', padR: 8 },
    { key: 'peak', label: t('stats.col.peak'), sub: t('stats.col.peakWhere'), align: 'right', padR: 8 },
    { key: 'mean', label: t('stats.col.mean'), sub: t('stats.metric.meanHint'), align: 'right', padR: 8 },
    ...SVM_AT_NITS.map((n, i): Col => ({ key: `at${i}` as MetricKey, label: String(n), sub: 'nits', align: 'right', padR: 8, group: true })),
    { key: 'coverage', label: t('stats.col.coverage'), sub: t('stats.col.coverageSub'), align: 'right', padR: 12 },
  ];
}

/** Portrait split: shares / luminance / peak / mean — then the SVM @ nits group and coverage. */
function tableSplit(cols: Col[]): [number[], number[]] {
  const a: number[] = [0];
  const b: number[] = [0];
  cols.forEach((c, i) => {
    if (i === 0) return;
    (c.group || c.key === 'coverage' ? b : a).push(i);
  });
  return [a, b];
}

const ROW1 = 26;
const HEAD_H = 68;
const RECORD_MAX = 280;
const RECORD_MIN = 180;

const sortKeyOf = (c: Col): SortKey | null => (c.key === 'record' ? 'name' : c.key === 'dist' ? null : c.key);

/** Content of one value cell (a Cell / the peak / coverage cells): width, height and drawer. */
function cellOf(p: Pen, e: Env, row: StatsRow, col: Col): { w: number; h: number; draw: (right: number, midY: number) => void } {
  const { t, input } = e;
  const s = row.stats;
  const key = col.key as MetricKey;
  const mk = markOf(input.rank, key, row, metricByKey(key).value(s));
  const best = mk === 'best';
  const weight = best ? 600 : 400;
  const color = best ? C.accentHover : C.ink1;
  const warn = mk === 'caveat' ? 15 : 0;
  /** Inner span (px-1.5 py-0.5, best: accent fill + ring) of width w + 12, height h + 4. */
  const span = (right: number, midY: number, w: number, h: number) => {
    if (!best) return;
    p.fill(right - w - 12, midY - h / 2 - 2, w + 12, h + 4, C.accent15, 4);
    p.ring(right - w - 12, midY - h / 2 - 2, w + 12, h + 4, 4, C.accent30);
  };
  const warnAt = (x: number, midY: number) => p.icon('warn', x, midY - 5.5, 11, C.amber);

  if (key === 'safe' || key === 'mid' || key === 'critical' || key === 'fullWhite') {
    const v = key === 'fullWhite' ? s.fullWhiteSafeNits : key === 'safe' ? s.safeShare : key === 'mid' ? s.midShare : s.criticalShare;
    const str = key === 'fullWhite' ? fmtNitsOrDash(v) : fmtPct(v);
    const tw = p.m(str, 12, weight);
    const w = warn + tw;
    return {
      w,
      h: 16,
      draw: (right, midY) => {
        span(right, midY, w, 16);
        p.text(str, right - 6, midY - 8, 16, 12, weight, key === 'fullWhite' && v === null ? C.ink4 : color, 'right');
        if (warn) warnAt(right - 6 - tw - 15, midY);
      },
    };
  }
  if (key === 'peak') {
    const v = s.peak?.svm ?? null;
    const vw = warn + svmValueWidth(p, v, 12, weight);
    const sub = s.peak ? t('stats.metric.peakWhere', { g: s.peak.gray, n: fmtNits(s.peak.levelNits) }) : null;
    const w = Math.max(vw, sub ? p.m(sub, 10, 400) : 0);
    const h = sub ? 30 : 16;
    return {
      w,
      h,
      draw: (right, midY) => {
        span(right, midY, w, h);
        const top = midY - h / 2;
        const sw = svmValue(p, v, right - 6, top, 16, 12, weight, color, 'right');
        if (warn) warnAt(right - 6 - sw - 15, top + 8);
        if (sub) p.text(sub, right - 6, top + 16, 14, 10, 400, C.ink3, 'right');
      },
    };
  }
  if (key === 'coverage') {
    const cav = caveatOf(e, row);
    const val = fmtPct(s.coverageShare);
    const sub = t('common.exclusion.coverage', { valid: s.cellCount, nominal: s.nominalCount });
    const vw = (cav ? 15 : 0) + p.m(val, 12, 400);
    const w = Math.max(vw, p.m(sub, 10, 400));
    return {
      w,
      h: 30,
      draw: (right, midY) => {
        const top = midY - 15;
        const tw = p.text(val, right - 6, top, 16, 12, 400, cav ? C.amber : C.ink1, 'right');
        if (cav) warnAt(right - 6 - tw - 15, top + 8);
        p.text(sub, right - 6, top + 16, 14, 10, 400, C.ink3, 'right');
      },
    };
  }
  // mean, SVM @ nits
  const v = key === 'mean' ? s.meanSvm : (s.svmAt[Number(key.slice(2))]?.svm ?? null);
  const vw = svmValueWidth(p, v, 12, weight);
  const w = warn + vw;
  return {
    w,
    h: 16,
    draw: (right, midY) => {
      span(right, midY, w, 16);
      svmValue(p, v, right - 6, midY - 8, 16, 12, weight, color, 'right');
      if (warn) warnAt(right - 6 - vw - 15, midY);
    },
  };
}

/** Record cell: key, device (truncated), mode + exclusion badge + caveat mark. */
function recordCell(p: Pen, e: Env, row: StatsRow, width: number | null, x: number, midY: number): { w: number; h: number } {
  const { rec } = row;
  const device = deviceLabel(rec, e.lang);
  const mode = modeLabel(rec, e.lang);
  const sum = exclusionSummary(rec);
  const badge = sum ? e.t('common.exclusion.badge', { n: sum.total }) : null;
  const cav = caveatOf(e, row);
  const extra = (badge ? 6 + badgeWidth(p, badge) : 0) + (cav ? 6 + 11 : 0);
  const line2 = !!mode || !!badge || cav;
  const textW = Math.max(p.m(device, 12, 500), (mode ? p.m(mode, 10, 400) : 0) + (mode ? extra : Math.max(0, extra - 6)));
  const h = line2 ? (badge ? 34 : 30) : 16;
  if (width !== null) {
    const avail = width - 16 - 50 - 12;
    const top = midY - h / 2;
    recordKey(p, x + 16, midY - 6, e.input.styles.get(rec.id));
    p.text(ellipsize(device, avail, 12, 500, p.m), x + 66, top, 16, 12, 500, C.ink1);
    if (line2) {
      const lh = badge ? 18 : 14;
      const ly = top + 16;
      let lx = x + 66;
      if (mode) {
        const mw = Math.max(0, avail - extra);
        const m = ellipsize(mode, mw, 10, 400, p.m);
        lx += p.text(m, lx, ly + (lh - 14) / 2, 14, 10, 400, C.ink3) + 6;
      }
      if (badge) lx += exclusionBadge(p, badge, lx, ly) + 6;
      if (cav) p.icon('warn', lx, ly + (lh - 11) / 2, 11, C.amber);
    }
  }
  return { w: 16 + 50 + textW + 12, h };
}

/** Natural width of every column (design px). */
function naturalWidths(p: Pen, e: Env, cols: Col[], rows: StatsRow[]): number[] {
  const widths = cols.map((c, ci) => {
    if (c.key === 'dist') return 96;
    const head = c.key === 'record' ? 16 + p.m(c.label, 12, 500) + 4 + 11 + 16 : 12 + Math.max(p.m(c.label, 12, 500), c.sub ? p.m(c.sub, 10, 400) : 0) + 22;
    let w = head;
    for (const r of rows) {
      const cw = c.key === 'record' ? recordCell(p, e, r, null, 0, 0).w : 8 + 6 + cellOf(p, e, r, c).w + 6 + c.padR;
      w = Math.max(w, cw);
    }
    return ci === 0 ? Math.min(RECORD_MAX, Math.max(RECORD_MIN, w)) : Math.ceil(w);
  });
  // The group header must fit over its columns.
  const g = cols.map((c, i) => (c.group ? i : -1)).filter((i) => i >= 0);
  if (g.length) {
    const need = 24 + p.m(e.t('stats.col.atGroup', { g: Math.round(e.input.sliceGray) }), 12, 500);
    const have = g.reduce((a, i) => a + widths[i], 0);
    if (need > have) g.forEach((i) => (widths[i] += (need - have) / g.length));
  }
  return widths;
}

/** Height of each body row (py-2 around the tallest cell, 1 px border except the last). */
function rowHeights(p: Pen, e: Env, cols: Col[], rows: StatsRow[]): number[] {
  return rows.map((r, i) => {
    let h = 16 + 4;
    for (const c of cols) {
      if (c.key === 'dist') continue;
      h = Math.max(h, c.key === 'record' ? recordCell(p, e, r, null, 0, 0).h : cellOf(p, e, r, c).h + 4);
    }
    return 8 + h + 8 + (i < rows.length - 1 ? 1 : 0);
  });
}

/** One table band (columns `idx` with widths `ws`) at the origin. Returns its height. */
function tablePass(p: Pen, e: Env, cols: Col[], idx: number[], ws: number[], rows: StatsRow[], heights: number[]): number {
  const { t, input } = e;
  const W = ws.reduce((a, w) => a + w, 0);
  const H = HEAD_H + heights.reduce((a, h) => a + h, 0);
  p.fill(0, 0, W, H, C.s1, 12);
  // header background (top corners rounded) and its bottom border
  p.fill(0, 0, W, HEAD_H, C.s2, [12, 12, 0, 0]);
  p.fill(0, HEAD_H - 1, W, 1, C.lineStrong);
  const xs: number[] = [];
  let x = 0;
  for (const w of ws) {
    xs.push(x);
    x += w;
  }
  const groupAt = idx.map((i, k) => (cols[i].group ? k : -1)).filter((k) => k >= 0);
  idx.forEach((ci, k) => {
    const c = cols[ci];
    const x0 = xs[k];
    const w = ws[k];
    const sk = sortKeyOf(c);
    const active = sk !== null && input.sortKey === sk;
    const color = active ? C.ink1 : C.ink3;
    const top = c.group ? ROW1 : 0;
    const hh = c.group ? HEAD_H - ROW1 : HEAD_H;
    if (c.key === 'record') {
      const lw = p.text(c.label, x0 + 16, top + (hh - 15) / 2, 15, 12, 500, color);
      if (active) p.icon(input.sortDir === 'asc' ? 'up' : 'down', x0 + 16 + lw + 4, top + (hh - 11) / 2, 11, C.accentHover);
    } else if (c.key === 'dist') {
      p.text(c.label, x0 + 8, top + (hh - 16) / 2, 16, 12, 500, C.ink3);
    } else {
      const bh = c.sub ? 29 : 15;
      const bt = top + (hh - bh) / 2;
      p.text(c.label, x0 + w - 22, bt, 15, 12, 500, color, 'right');
      if (c.sub) p.text(c.sub, x0 + w - 22, bt + 15, 14, 10, 400, C.ink4, 'right');
      if (active) p.icon(input.sortDir === 'asc' ? 'up' : 'down', x0 + w - 6 - 11, top + (hh - 11) / 2, 11, C.accentHover);
    }
  });
  if (groupAt.length) {
    const gx = xs[groupAt[0]];
    const gw = groupAt.reduce((a, k) => a + ws[k], 0);
    p.text(t('stats.col.atGroup', { g: Math.round(input.sliceGray) }), gx + gw / 2, 6, 16, 12, 500, C.ink2, 'center');
    p.fill(gx, ROW1 - 1, gw, 1, C.line);
  }
  // body
  let y = HEAD_H;
  rows.forEach((r, ri) => {
    const rh = heights[ri];
    const mid = y + (rh - (ri < rows.length - 1 ? 1 : 0)) / 2;
    idx.forEach((ci, k) => {
      const c = cols[ci];
      const x0 = xs[k];
      const w = ws[k];
      if (c.key === 'record') recordCell(p, e, r, w, x0, mid);
      else if (c.key === 'dist') {
        if (r.stats.cellCount > 0) shareBar(p, r, x0 + 8, mid - 4, w - 16, 8, true);
      } else cellOf(p, e, r, c).draw(x0 + w - c.padR, mid);
    });
    if (ri < rows.length - 1) p.fill(0, y + rh - 1, W, 1, C.line);
    y += rh;
  });
  p.ring(0, 0, W, H, 12, C.line);
  return H;
}

// ---- page ------------------------------------------------------------------------------------

function measureContext(): Measure {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  return cachedMeasure((text, size, weight = 400) => {
    ctx.font = fontOf(weight, size);
    return ctx.measureText(text).width;
  });
}

function sortText(t: TFunction, key: SortKey, dir: SortDir): string {
  const name =
    key === 'name'
      ? t('stats.sort.name')
      : key === 'at0' || key === 'at1' || key === 'at2' || key === 'at3'
        ? `SVM @${SVM_AT_NITS[Number(key.slice(2))]} nits`
        : t(`stats.col.${key}`);
  return t('stats.export.sortedBy', { key: name, dir: t(dir === 'asc' ? 'stats.sort.asc' : 'stats.sort.desc') });
}

/** Title band: "统计摘要  16 条记录" / "统计范围：…", optional right-aligned note. */
function drawHeader(ctx: CanvasRenderingContext2D, p: Pen, e: Env, box: Box, hs: number, right: string | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.s1;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = C.line;
  ctx.fillRect(box.x, box.y + box.h - Math.max(1, Math.round(hs)), box.w, Math.max(1, Math.round(hs)));
  ctx.setTransform(hs, 0, 0, hs, box.x, box.y);
  const W = box.w / hs;
  const { t } = e;
  const top = (box.h / hs - (HEADER_H - 2 * HEADER.padY)) / 2;
  const tb = baseline(top, HEADER.titleLine, 16);
  const tw = p.textB(t('stats.title'), HEADER.padX, tb, 16, 600, C.ink1);
  p.textB(t('stats.count', { n: e.input.rows.length }), HEADER.padX + tw + 10, tb, 12, 400, C.ink3);
  const st = top + HEADER.titleLine + HEADER.scopeGap;
  const label = `${t('stats.scope.label')}${e.lang === 'zh' ? '：' : ': '}`;
  const rw = right ? p.m(right, 12, 400) + 24 : 0;
  const lw = p.text(label, HEADER.padX, st, HEADER.scopeLine, 12, 400, C.ink2);
  p.text(ellipsize(e.input.scope, W - 2 * HEADER.padX - lw - rw, 12, 400, p.m), HEADER.padX + lw, st, HEADER.scopeLine, 12, 400, C.ink3);
  if (right) p.text(right, W - HEADER.padX, top, HEADER.titleLine, 12, 400, C.ink3, 'right');
}

interface StripItem {
  kind: 'best' | 'warn' | 'text';
  text: string;
}

const stripItemWidth = (p: Pen, it: StripItem) => (it.kind === 'best' ? 16 + 6 : it.kind === 'warn' ? 11 + 6 : 0) + p.m(it.text, 10, 400);

/** Lines of the legend strip at design width W (flex-wrap, gap-x 16). */
function stripLines(p: Pen, items: StripItem[], W: number): StripItem[][] {
  const lines: StripItem[][] = [];
  let cur: StripItem[] = [];
  let x = 0;
  for (const it of items) {
    const w = stripItemWidth(p, it);
    if (cur.length && x + 16 + w > W) {
      lines.push(cur);
      cur = [];
      x = 0;
    }
    x += (cur.length ? 16 : 0) + w;
    cur.push(it);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function drawStrip(ctx: CanvasRenderingContext2D, p: Pen, box: Box, hs: number, lines: StripItem[][]) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.s1;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = C.line;
  ctx.fillRect(box.x, box.y, box.w, Math.max(1, Math.round(hs)));
  ctx.setTransform(hs, 0, 0, hs, box.x, box.y);
  const W = box.w / hs - 2 * STRIP.padX;
  lines.forEach((line, li) => {
    const top = STRIP.padY + li * (STRIP.line + STRIP.gapY);
    let x = STRIP.padX;
    for (const it of line) {
      if (it.kind === 'best') {
        p.fill(x, top + 2, 16, 10, C.accent15, 2);
        p.ring(x, top + 2, 16, 10, 2, C.accent30);
        x += 22;
      } else if (it.kind === 'warn') {
        p.icon('warn', x, top + 1.5, 11, C.amber);
        x += 17;
      }
      x += p.text(ellipsize(it.text, W - (x - STRIP.padX), 10, 400, p.m), x, top, STRIP.line, 10, 400, C.ink3) + 16;
    }
  });
}

/** "没有可统计的记录" in the middle of the body (all records hidden). */
function drawEmpty(ctx: CanvasRenderingContext2D, p: Pen, e: Env, body: Box, hs: number) {
  const w = body.w / hs;
  const h = body.h / hs;
  ctx.setTransform(hs, 0, 0, hs, body.x, body.y);
  const top = h / 2 - 60;
  const cx = w / 2;
  p.fill(cx - 24, top, 48, 48, C.s3, 12);
  p.ring(cx - 24, top, 48, 48, 12, C.line);
  p.icon('chart', cx - 11, top + 13, 22, C.ink3);
  p.text(e.t('stats.empty.title'), cx, top + 64, 20, 14, 500, C.ink1, 'center');
  wrapText(e.t('stats.empty.hint'), Math.min(384, w - 32), 3, 12, 400, p.m).forEach((l, i) => p.text(l, cx, top + 88 + i * 19.5, 19.5, 12, 400, C.ink3, 'center'));
}

/**
 * Render `content` of the stats page into `canvas` (its current size). Returns where the parts
 * were placed (output px).
 */
export function renderStatsExport(canvas: HTMLCanvasElement, input: StatsExportInput, content: StatsContentId): StatsRenderInfo {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const width = canvas.width;
  const height = canvas.height;
  const m = measureContext();
  const t: TFunction = (k, v) => translate(input.lang, k, v);
  const e: Env = { t, lang: input.lang, input, views: new Map(), scratch: [] };
  const measure = new Pen(null, m);
  const pen = new Pen(ctx, m);
  const rows = input.rows;

  // legend strip: the table's legend line (as under the table on screen); the cards only carry
  // the low-coverage footnote when some record is left out of the ranking
  const footnote: StripItem[] = input.rank.low.size > 0 ? [{ kind: 'warn', text: t('stats.caveat.footnote') }] : [];
  const items: StripItem[] = content === 'table' && rows.length ? [{ kind: 'best', text: t('stats.bestHint') }, ...footnote, { kind: 'text', text: t('stats.metric.svmAtHint') }] : rows.length ? footnote : [];

  // Cards: uniform card height per width (grid rows stretch to their tallest card).
  const memo = new Map<number, number>();
  const heightAt = (cw: number) => {
    let h = memo.get(cw);
    if (h === undefined) {
      h = Math.max(...rows.map((r) => cardPass(measure, e, r, cw, null)));
      memo.set(cw, h);
    }
    return h;
  };
  // Table: natural column widths and band heights.
  const cols = tableCols(t);
  const natural = content === 'table' && rows.length ? naturalWidths(measure, e, cols, rows) : [];
  const bandHeight = (idx: number[]) => HEAD_H + rowHeights(measure, e, idx.map((i) => cols[i]), rows).reduce((a, h) => a + h, 0);

  // Layout for a chrome scale hs. The chrome (title band, legend strip) follows the content when
  // few records make the content large (up to 1.5× the base scale), so the title never looks lost.
  const hs0 = chromeScale(width, height);
  const plan = (hs: number) => {
    const lines = items.length ? stripLines(measure, items, width / hs - 2 * STRIP.padX) : [];
    const frame = pageFrame(width, height, lines.length, hs);
    if (!rows.length) return { lines, frame, s: hs };
    if (content === 'cards') {
      const grid = chooseCardGrid(rows.length, frame.body, heightAt, 2.2 * hs0);
      return { lines, frame, grid, s: grid.scale };
    }
    const fit = fitTable(natural, frame.body, bandHeight, tableSplit(cols), 1.8 * hs0);
    return { lines, frame, fit, s: fit.scale };
  };
  let P = plan(hs0);
  const hs1 = Math.min(1.5 * hs0, Math.max(hs0, P.s));
  if (hs1 > hs0 * 1.02) P = plan(hs1);
  const { frame, lines } = P;
  const { hs, body } = frame;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.canvas;
  ctx.fillRect(0, 0, width, height);
  const right = content === 'cards' && input.sortKey !== 'order' ? sortText(t, input.sortKey, input.sortDir) : null;
  drawHeader(ctx, pen, e, frame.header, hs, right);
  if (frame.strip) drawStrip(ctx, pen, frame.strip, hs, lines);
  const info: StatsRenderInfo = { content, width, height, header: frame.header, body, strip: frame.strip, scale: hs };

  if (!rows.length) {
    drawEmpty(ctx, pen, e, body, hs);
  } else if (P.grid) {
    const grid = P.grid;
    const s = grid.scale;
    const gx = body.x + (body.w - grid.width) / 2;
    const gy = body.y + (body.h - grid.height) / 2;
    const cards: Box[] = [];
    rows.forEach((r, i) => {
      const col = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      const x = Math.round(gx + col * (grid.cardW + 16) * s);
      const y = Math.round(gy + row * (grid.cardH + 16) * s);
      ctx.setTransform(s, 0, 0, s, x, y);
      cardPass(pen, e, r, grid.cardW, grid.cardH);
      cards.push({ x, y, w: grid.cardW * s, h: grid.cardH * s });
    });
    Object.assign(info, { scale: s, grid, cards });
  } else if (P.fit) {
    const fit: TableFit = P.fit;
    const s = fit.scale;
    // Width-limited (square / portrait): rows get up to 50 % more padding instead of a large
    // empty band above and below the table.
    const rowsH = fit.bandH.reduce((a, h) => a + h - HEAD_H, 0);
    const spare = body.h / s - (fit.bandH.reduce((a, h) => a + h, 0) + (fit.bands.length - 1) * fit.gap);
    const stretch = spare > 0 ? Math.min(0.5, spare / rowsH) : 0;
    const bandHs = fit.bandH.map((h) => HEAD_H + (h - HEAD_H) * (1 + stretch));
    const totalH = bandHs.reduce((a, h) => a + h, 0) + (fit.bands.length - 1) * fit.gap;
    const tx = Math.round(body.x + (body.w - fit.bandW * s) / 2);
    let ty = body.y + (body.h - totalH * s) / 2;
    const bands: { cols: string[]; box: Box }[] = [];
    fit.bands.forEach((idx, bi) => {
      const hts = rowHeights(measure, e, idx.map((i) => cols[i]), rows).map((h) => h * (1 + stretch));
      const y = Math.round(ty);
      ctx.setTransform(s, 0, 0, s, tx, y);
      const h = tablePass(pen, e, cols, idx, fit.widths[bi], rows, hts);
      bands.push({ cols: idx.map((i) => cols[i].key), box: { x: tx, y, w: fit.bandW * s, h: h * s } });
      ty += (h + fit.gap) * s;
    });
    Object.assign(info, { scale: s, bands });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Release the heatmap canvases' backing stores right away.
  for (const c of e.scratch) c.width = c.height = 0;
  return info;
}

/**
 * One card alone at (cw × ch design px) × scale — the verification compares it with the card on
 * screen (same width) to check the export's fidelity.
 */
export function renderStatsCard(canvas: HTMLCanvasElement, input: StatsExportInput, index: number, cw: number, ch: number, scale: number): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const m = measureContext();
  const e: Env = { t: (k, v) => translate(input.lang, k, v), lang: input.lang, input, views: new Map(), scratch: [] };
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.canvas;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const h = cardPass(new Pen(ctx, m), e, input.rows[index], cw, ch);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const c of e.scratch) c.width = c.height = 0;
  return h;
}

/** Natural card height at width cw with a given measure (unit tests, no canvas). */
export function cardHeight(input: StatsExportInput, index: number, cw: number, measure: Measure): number {
  const e: Env = { t: (k, v) => translate(input.lang, k, v), lang: input.lang, input, views: new Map(), scratch: [] };
  return cardPass(new Pen(null, measure), e, input.rows[index], cw, null);
}
