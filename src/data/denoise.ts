/**
 * 降噪 (denoise) — docs/adr/0012 (addendum, 2026-09-30).
 *
 * Records always keep their RAW measurements. `processRecord(record, { denoise })` is the one
 * pure, memoised step that turns a raw record into what the views display, the same way for
 * every record (bundled or imported). With denoise off it returns the raw record itself.
 *
 * Detection (`analyseMatrix`, pure, per raw matrix):
 *  1. Black level (黑场噪声): the instrument's reading of black, estimated from genuinely dark
 *     readings only — the G ≤ 2 rows in the dim columns (level luminance ≤ 100 nits; real signal
 *     at G2 is far below one reading step there). Robust: median ± RMS of the 90 % of readings
 *     closest to the median; quantised readings that are all 0 give 0 (no one-step floor is added).
 *     A cell whose luminance is at or below `median + 3 × spread` (never below 0) cannot be told
 *     apart from black: its SVM is meaningless.
 *  2. Duplicated row / column (copy error): two adjacent rows (columns) identical in every cell;
 *     the dimmer one is not a measurement of its own position.
 *  3. Luminance reading unreliable (the SVM of the cell is fine and is always kept):
 *     - 亮度读数疑似未更新 (lumNotUpdated): luminance departs from the table's own pattern
 *       (log nits ≈ gray effect + level effect, median polish) by > 20 % AND matches an adjacent
 *       cell within 2.5 % — the luminance was not updated after the test pattern changed.
 *     - 亮度偏离整表规律 (lumOffPattern): > 35 % off the pattern and > 20 % off its own column
 *       (so a smooth column the separable model merely fits badly is left alone).
 *     A column's level luminance comes from its G255 cell; when that luminance is unreliable the
 *     level is re-estimated from the pattern (the column's credible rows).
 *  4. SVM spike: more than 3× off the median of ≥ 2 credible neighbours (8-neighbourhood) and
 *     either more than 1.0 away from it or more than 10× off.
 *
 * Processing with denoise on (`processRecord`):
 *  - black-level and spike cells are FILLED by interpolation (log SVM; luminance geometric) only
 *    between credible measured neighbours on both sides of a short gap (≤ 2 cells) — first along
 *    gray in the same column, else along level luminance in the same row; never extrapolated.
 *    Otherwise they are shown as no data.
 *  - duplicated rows / columns → no data.
 *  - unreliable luminance → the measured SVM is kept; the luminance becomes an estimate
 *    (interpolated in the same column, else the table's pattern); a bad level is re-estimated.
 *  - every other cell is the raw DataPoint object itself (property-tested).
 */
import type { Dataset, DataPoint } from '../types';
import { restoreExcluded } from './anomalies';
import { fmtNits, fmtSvm } from './grid';

// ---------------------------------------------------------------------------------------------
// Types

/** Problem detected in a cell. The first five make the SVM unusable; the last two only the luminance. */
export type DenoiseKind = 'blackLevel' | 'duplicateColumn' | 'duplicateRow' | 'readingNotUpdated' | 'svmSpike' | 'lumNotUpdated' | 'lumOffPattern';
export const DENOISE_KINDS: DenoiseKind[] = ['blackLevel', 'duplicateColumn', 'duplicateRow', 'readingNotUpdated', 'svmSpike', 'lumNotUpdated', 'lumOffPattern'];

/** What the denoise did with a flagged cell. */
export type DenoiseAction = 'interpolated' | 'noData' | 'lumEstimated';
export const DENOISE_ACTIONS: DenoiseAction[] = ['interpolated', 'noData', 'lumEstimated'];

/**
 * Plain-language reason of a note (i18n: common.denoise.reason.<key>, params from noteParams):
 *  nonPositive  — 亮度读数 {nits} nits ≤ 0，测不到亮度
 *  blackLevel   — 亮度 {nits} nits 不高于黑场噪声 {floor} nits，和全黑分不开
 *  svmSpike     — SVM {svm} 与周围读数（约 {typical}）相差超过 {ratio} 倍
 *  duplicateColumn — {pct}% 列与 {twinPct}% 列完全相同（源表复制错误）
 *  duplicateRow — G{gray} 行与 G{twinGray} 行完全相同（源表复制错误）
 *  readingNotUpdated — 亮度和 SVM 都与相邻格（G{twinGray} · {twinPct}%）几乎相同，读数疑似未更新
 *  lumNotUpdated — 亮度 {nits} nits 与相邻格（G{twinGray} · {twinPct}%）几乎相同，比整表规律推算的约 {expected} nits 偏 {dev}
 *  lumOffPattern — 亮度 {nits} nits 比整表规律推算的约 {expected} nits 偏 {dev}
 */
export type DenoiseReason = 'nonPositive' | 'blackLevel' | 'svmSpike' | 'duplicateColumn' | 'duplicateRow' | 'readingNotUpdated' | 'lumNotUpdated' | 'lumOffPattern';

export interface BlackLevel {
  /** Dark readings used (G ≤ 2 rows in the dim columns). */
  count: number;
  /** Robust centre of the dark readings; null when there are fewer than 6. */
  median: number | null;
  /** Robust spread (RMS about the median of the closest 90 %); null when unknown. */
  spread: number | null;
  /** Readings at or below this are indistinguishable from black. Never negative (0 when unknown). */
  ceiling: number;
  /** Instrument reading step (smallest difference between low readings); 0 when unknown. */
  step: number;
}

/** SVM problem of a cell (the SVM reading cannot be used). */
export interface SvmFlag {
  kind: 'blackLevel' | 'duplicateColumn' | 'duplicateRow' | 'readingNotUpdated' | 'svmSpike';
  /** duplicateRow / duplicateColumn / readingNotUpdated: matrix [row, col] of the cell it repeats. */
  twin?: [number, number];
  /** svmSpike: median SVM of the credible neighbours. */
  typical?: number;
}

/** Luminance problem of a cell (the SVM is fine and is kept). */
export interface LumFlag {
  kind: 'lumNotUpdated' | 'lumOffPattern';
  /** Luminance the table's pattern predicts for the cell (nits). */
  expected: number;
  /** Relative deviation of the reading from `expected` (0.4 = 40 % too high). */
  deviation: number;
  /** lumNotUpdated: matrix [row, col] of the adjacent cell whose reading it repeats. */
  twin?: [number, number];
}

export interface CellFlags {
  svm?: SvmFlag;
  lum?: LumFlag;
}

export interface LevelEstimate {
  /** Level luminance as stored (matrix.headerNits). */
  raw: number;
  /** Level luminance used with denoise on. */
  value: number;
  /** True when `value` was re-estimated from the table's luminance pattern. */
  estimated: boolean;
}

/** Detection result for one raw matrix (matrix indices throughout). */
export interface DenoiseAnalysis {
  blackLevel: BlackLevel;
  /** flags[r][c]; null = nothing detected. */
  flags: (CellFlags | null)[][];
  /** Per column. */
  levels: LevelEstimate[];
  /** Estimated luminance for cells with a luminance flag (null otherwise / when no estimate). */
  lumEstimate: (number | null)[][];
  /** Number of detected cells per kind (a cell with an SVM and a luminance flag counts under both). */
  byKind: Partial<Record<DenoiseKind, number>>;
}

export interface CellRef {
  gray: number;
  brightnessPercent: number;
}

/** What the denoise did to one cell (denoise on). Matrix indices + the cell's gray / %. */
export interface CellNote extends CellRef {
  r: number;
  c: number;
  /** Main problem: the SVM problem when there is one, else the luminance problem. */
  kind: DenoiseKind;
  /** Luminance problem of a cell whose main problem is its SVM (e.g. a spike with a stale luminance). */
  also?: DenoiseKind;
  action: DenoiseAction;
  reason: DenoiseReason;
  /** The raw reading. */
  raw: DataPoint;
  /** The displayed value (null = no data). */
  value: DataPoint | null;
  /** interpolated: the two credible measured cells the value was interpolated between. */
  from?: [CellRef, CellRef];
  /** interpolated: along gray (same column) or along level luminance (same row). */
  via?: 'gray' | 'level';
  /** lumEstimated (or an interpolated spike with a bad luminance): how the luminance was estimated. */
  lumVia?: 'column' | 'pattern';
  /** Numbers for the reason text (see DenoiseReason). */
  floor?: number;
  typical?: number;
  expected?: number;
  deviation?: number;
  twin?: CellRef;
}

export interface LevelNote {
  c: number;
  brightnessPercent: number;
  raw: number;
  value: number;
  /** Problem of the G255 (max gray) cell the level came from, or null when the stored level was invalid. */
  cellKind: DenoiseKind | null;
}

export interface DenoiseSummary {
  /** Cells whose displayed value differs from the raw reading: interpolated + noData + lumEstimated. */
  touched: number;
  interpolated: number;
  noData: number;
  lumEstimated: number;
  /** Columns whose level luminance was re-estimated. */
  levelsEstimated: number;
  /** Notes per main kind. */
  byKind: Partial<Record<DenoiseKind, number>>;
  /** Nominal grid (rows × cols) and cells with a displayed value (measured + interpolated). */
  nominal: number;
  valid: number;
}

export interface DenoiseOptions {
  denoise: boolean;
}

export interface ProcessedRecord<T extends Dataset = Dataset> {
  /** What the views display. Denoise off: the raw record itself. Stable per (record, options). */
  record: T;
  /** The raw record (stored `excluded` points put back, no `excluded` field). */
  raw: T;
  denoise: boolean;
  analysis: DenoiseAnalysis;
  /** Applied notes (empty with denoise off), sorted by matrix row then column. */
  notes: CellNote[];
  /** notes by matrix index: noteGrid[r][c]. */
  noteGrid: (CellNote | null)[][];
  /** Re-estimated levels (empty with denoise off). */
  levelNotes: LevelNote[];
  summary: DenoiseSummary;
  /** Note of the cell at (gray, brightness %), or null. */
  noteAt(gray: number, brightnessPercent: number): CellNote | null;
}

// ---------------------------------------------------------------------------------------------
// Parameters

const DARK_MAX_GRAY = 2;
/** Columns at or below this level luminance carry no real signal at G ≤ 2 (≈ 0.002 nits). */
const DIM_LEVEL_MAX = 100;
const MIN_DIM_COLS = 3;
const MIN_DARK = 6;
/** Share of dark readings farthest from the median left out of the spread (outliers). */
const DARK_TRIM = 0.1;
const BLACK_K = 3;
/** Cells used to fit / judged for the luminance pattern: this many noise scales above the black level. */
const FIT_SCALES = 10;
const CHECK_SCALES = 20;
const LUM_TOL = Math.log(1.2);
const LUM_HARD = Math.log(1.35);
const COPY_TOL = 0.025;
/** A copied reading must also be more than 15 % off its own column's interpolation. */
const COPY_LOCAL_TOL = Math.log(1.15);
/** A whole reading repeated: SVM within 1 %, luminance within 15 % of an adjacent cell … */
const FROZEN_SVM_TOL = Math.log(1.01);
const FROZEN_LUM_TOL = Math.log(1.15);
/** … while the cell's own column puts its SVM more than 10 % away. */
const FROZEN_TREND = Math.log(1.1);
const SPIKE_RATIO = Math.log(3);
const SPIKE_ABS = 1.0;
const SPIKE_EXTREME = Math.log(10);
/** Interpolation sources lie this many black-noise spreads above the black level. */
const SOURCE_SCALES = 3;
/** Longest run of unusable cells an interpolation may bridge. */
export const MAX_GAP = 2;

// ---------------------------------------------------------------------------------------------
// Helpers

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const cellOf = (m: Dataset['matrix'], r: number, c: number): DataPoint | null => {
  const p = m.grid[r]?.[c];
  return p && Number.isFinite(p.nits) && Number.isFinite(p.svm) ? p : null;
};

const levelX = (nits: number) => Math.log10(Math.max(0, nits) + 1);

/** Instrument reading step: smallest difference between distinct readings below 1 nit. */
function readingStep(m: Dataset['matrix']): number {
  const vals = new Set<number>();
  for (const row of m.grid) for (const p of row) if (p && Number.isFinite(p.nits) && Math.abs(p.nits) < 1) vals.add(Math.round(p.nits * 1e6) / 1e6);
  const s = [...vals].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) step = Math.min(step, s[i] - s[i - 1]);
  return Number.isFinite(step) ? step : 0;
}

/** Robust black level from the dark readings (see header). */
export function blackLevel(m: Dataset['matrix']): BlackLevel {
  const step = readingStep(m);
  const cols = m.headerNits.map((n, c) => ({ n, c })).filter(({ n }) => Number.isFinite(n) && n > 0);
  let dim = cols.filter(({ n }) => n <= DIM_LEVEL_MAX);
  if (dim.length < MIN_DIM_COLS) dim = [...cols].sort((a, b) => a.n - b.n).slice(0, MIN_DIM_COLS);
  const dark: number[] = [];
  m.rows.forEach((g, r) => {
    if (!(g <= DARK_MAX_GRAY)) return;
    for (const { c } of dim) {
      const p = cellOf(m, r, c);
      if (p) dark.push(p.nits);
    }
  });
  if (dark.length < MIN_DARK) return { count: dark.length, median: null, spread: null, ceiling: 0, step };
  const md = median(dark);
  const byDist = [...dark].sort((a, b) => Math.abs(a - md) - Math.abs(b - md));
  const keep = byDist.slice(0, byDist.length - Math.floor(byDist.length * DARK_TRIM));
  const spread = Math.sqrt(keep.reduce((a, v) => a + (v - md) ** 2, 0) / keep.length);
  return { count: dark.length, median: md, spread, ceiling: Math.max(0, md + BLACK_K * spread), step };
}

interface Fit {
  overall: number;
  row: (number | null)[];
  col: (number | null)[];
}

/** Tukey median polish of a two-way table (nulls ignored): overall + row + column effects. */
export function medianPolishFit(table: (number | null)[][], iterations = 10): Fit {
  const res = table.map((row) => [...row]);
  const R = res.length;
  const C = R ? res[0].length : 0;
  const row: (number | null)[] = new Array(R).fill(null);
  const col: (number | null)[] = new Array(C).fill(null);
  let overall = 0;
  for (let r = 0; r < R; r++) if (res[r].some((x) => x !== null)) row[r] = 0;
  for (let c = 0; c < C; c++) if (res.some((x) => x[c] !== null)) col[c] = 0;
  /** Moves the median of an effect vector into the overall term. */
  const centre = (eff: (number | null)[]) => {
    const v = eff.filter((x): x is number => x !== null);
    if (!v.length) return;
    const md = median(v);
    for (let i = 0; i < eff.length; i++) if (eff[i] !== null) eff[i]! -= md;
    overall += md;
  };
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < R; r++) {
      const v = res[r].filter((x): x is number => x !== null);
      if (!v.length) continue;
      const md = median(v);
      for (let c = 0; c < C; c++) if (res[r][c] !== null) res[r][c]! -= md;
      row[r]! += md;
    }
    centre(col);
    for (let c = 0; c < C; c++) {
      const v: number[] = [];
      for (let r = 0; r < R; r++) if (res[r][c] !== null) v.push(res[r][c]!);
      if (!v.length) continue;
      const md = median(v);
      for (let r = 0; r < R; r++) if (res[r][c] !== null) res[r][c]! -= md;
      col[c]! += md;
    }
    centre(row);
  }
  return { overall, row, col };
}

const fitted = (f: Fit, r: number, c: number): number | null => (f.row[r] === null || f.col[c] === null ? null : f.overall + f.row[r]! + f.col[c]!);

// ---------------------------------------------------------------------------------------------
// Detection

const analysisCache = new WeakMap<Dataset['matrix'], DenoiseAnalysis>();

/** Detect problems in a RAW matrix (memoised per matrix object). */
export function analyseMatrix(m: Dataset['matrix']): DenoiseAnalysis {
  const hit = analysisCache.get(m);
  if (hit) return hit;
  const a = analyse(m);
  analysisCache.set(m, a);
  return a;
}

/** Row / column order used for neighbourhoods: gray ascending, brightness % ascending. */
function orders(m: Dataset['matrix']) {
  const R = m.rows.length;
  const C = m.cols.length;
  const rowOrd = [...Array(R).keys()].sort((a, b) => m.rows[a] - m.rows[b]);
  const colOrd = [...Array(C).keys()].sort((a, b) => m.cols[a] - m.cols[b] || m.headerNits[a] - m.headerNits[b]);
  const rpos = new Array<number>(R);
  const cpos = new Array<number>(C);
  rowOrd.forEach((r, i) => (rpos[r] = i));
  colOrd.forEach((c, i) => (cpos[c] = i));
  return { R, C, rowOrd, colOrd, rpos, cpos };
}

const samePoint = (a: DataPoint | null, b: DataPoint | null) => !!a && !!b && a.nits === b.nits && a.svm === b.svm;

function analyse(m: Dataset['matrix']): DenoiseAnalysis {
  const { R, C, rowOrd, colOrd, rpos, cpos } = orders(m);
  const bl = blackLevel(m);
  const flags: (CellFlags | null)[][] = Array.from({ length: R }, () => new Array<CellFlags | null>(C).fill(null));
  const setSvm = (r: number, c: number, f: SvmFlag) => {
    if (!cellOf(m, r, c) || flags[r][c]?.svm) return;
    flags[r][c] = { ...(flags[r][c] ?? {}), svm: f };
  };

  // 2. Duplicated adjacent columns / rows (every shared cell identical): the dimmer one.
  for (let i = 0; i + 1 < C; i++) {
    const a = colOrd[i];
    const b = colOrd[i + 1];
    let both = 0;
    let same = true;
    for (let r = 0; r < R && same; r++) {
      const p = cellOf(m, r, a);
      const q = cellOf(m, r, b);
      if (!p || !q) continue;
      both++;
      same = samePoint(p, q);
    }
    if (both >= 3 && same) for (let r = 0; r < R; r++) setSvm(r, a, { kind: 'duplicateColumn', twin: [r, b] });
  }
  for (let i = 0; i + 1 < R; i++) {
    const a = rowOrd[i];
    const b = rowOrd[i + 1];
    let both = 0;
    let same = true;
    for (let c = 0; c < C && same; c++) {
      const p = cellOf(m, a, c);
      const q = cellOf(m, b, c);
      if (!p || !q) continue;
      both++;
      same = samePoint(p, q);
    }
    if (both >= 3 && same) for (let c = 0; c < C; c++) setSvm(a, c, { kind: 'duplicateRow', twin: [b, c] });
  }

  // 1. At or below the black level.
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const p = cellOf(m, r, c);
      if (p && p.nits <= bl.ceiling) setSvm(r, c, { kind: 'blackLevel' });
    }

  // 3. Luminance pattern (median polish on log nits), refitted without flagged cells until stable.
  const scale = Math.max(bl.step, bl.spread ?? 0);
  const fitMin = bl.ceiling + FIT_SCALES * scale;
  const chkMin = bl.ceiling + CHECK_SCALES * scale;
  const lumOk = (r: number, c: number) => {
    const p = cellOf(m, r, c);
    const f = flags[r]?.[c];
    return !!p && p.nits > 0 && !f?.lum && f?.svm?.kind !== 'blackLevel' && f?.svm?.kind !== 'duplicateColumn' && f?.svm?.kind !== 'duplicateRow';
  };
  let fit: Fit = { overall: 0, row: new Array(R).fill(null), col: new Array(C).fill(null) };
  for (let pass = 0; pass < 6; pass++) {
    fit = medianPolishFit(
      Array.from({ length: R }, (_, r) =>
        Array.from({ length: C }, (_, c) => {
          const p = cellOf(m, r, c);
          return p && lumOk(r, c) && p.nits > fitMin ? Math.log(p.nits) : null;
        }),
      ),
    );
    const found: [number, number, LumFlag][] = [];
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const p = cellOf(m, r, c);
        if (!p || !lumOk(r, c) || p.nits <= chkMin) continue;
        const f = fitted(fit, r, c);
        if (f === null) continue;
        const e = Math.log(p.nits) - f;
        const dev = Math.abs(e);
        if (dev <= LUM_TOL) continue;
        // The cell against its own column: where the column runs smoothly through the reading, the
        // separable pattern merely fits this region badly (e.g. a level whose low grays behave
        // differently) and the reading stays.
        const local = columnLum(m, r, c, rowOrd, rpos, lumOk);
        const localDev = local === null ? null : Math.abs(Math.log(p.nits / local));
        const twin = copiedFrom(m, r, c, rowOrd, colOrd, rpos, cpos);
        let kind: LumFlag['kind'] | null = null;
        if (twin && (localDev === null || localDev > COPY_LOCAL_TOL)) kind = 'lumNotUpdated';
        else if (dev > LUM_HARD && ((localDev !== null && localDev > LUM_HARD) || columnOrderBroken(m, r, c, rowOrd, rpos, lumOk, bl.step))) kind = 'lumOffPattern';
        if (kind) found.push([r, c, { kind, expected: Math.exp(f), deviation: Math.exp(e) - 1, ...(kind === 'lumNotUpdated' && twin ? { twin } : {}) }]);
      }
    for (const [r, c, lum] of found) flags[r][c] = { ...(flags[r][c] ?? {}), lum };
    if (!found.length) break;
  }

  // 3b. Whole reading not updated: a cell with an unreliable luminance whose SVM also repeats an
  //     adjacent reading (SVM within 1 %, luminance within 15 %) while its own column says the SVM
  //     should differ (> 10 % off the interpolation between the nearest clean cells above and
  //     below). Then the SVM is a copy too. (Where the SVM is flat, the SVM is kept.)
  const clean = (r: number, c: number) => {
    const p = cellOf(m, r, c);
    return !!p && p.svm > 0 && !flags[r][c]?.svm && !flags[r][c]?.lum;
  };
  const frozen: [number, number, [number, number]][] = [];
  const frozenNeighbours = (r: number, c: number) =>
    (
      [
        [rowOrd[rpos[r] + 1], c],
        [rowOrd[rpos[r] - 1], c],
        [r, colOrd[cpos[c] + 1]],
        [r, colOrd[cpos[c] - 1]],
      ] as [number | undefined, number | undefined][]
    )
      .filter((x): x is [number, number] => x[0] !== undefined && x[1] !== undefined)
      .map(([rr, cc]) => [rr, cc, [r, c]] as [number, number, [number, number]]);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const f = flags[r][c];
      const p = cellOf(m, r, c);
      if (!p || !f?.lum || f.svm || !(p.svm > 0)) continue;
      const twin = repeatedFrom(m, r, c, rowOrd, colOrd, rpos, cpos);
      if (!twin) continue;
      let lo = rpos[r] - 1;
      while (lo >= 0 && !clean(rowOrd[lo], c)) lo--;
      let hi = rpos[r] + 1;
      while (hi < R && !clean(rowOrd[hi], c)) hi++;
      if (lo < 0 || hi >= R) continue;
      const r0 = rowOrd[lo];
      const r1 = rowOrd[hi];
      const t = (m.rows[r] - m.rows[r0]) / (m.rows[r1] - m.rows[r0]);
      const s0 = Math.log(cellOf(m, r0, c)!.svm);
      const s1 = Math.log(cellOf(m, r1, c)!.svm);
      if (Math.abs(Math.log(p.svm) - (s0 + (s1 - s0) * t)) > FROZEN_TREND) frozen.push([r, c, twin]);
    }
  for (const [r, c, twin] of frozen) setSvm(r, c, { kind: 'readingNotUpdated', twin });
  // A run of repeated readings: the twin of a frozen cell that repeats it back (and has an
  // unreliable luminance itself) is frozen too.
  for (let queue = frozen.map(([r, c, twin]) => [twin[0], twin[1], [r, c]] as [number, number, [number, number]]); queue.length; ) {
    const next: typeof queue = [];
    for (const [r, c, twin] of queue) {
      const f = flags[r][c];
      if (!f?.lum || f.svm) continue;
      if (!repeatedFrom(m, r, c, rowOrd, colOrd, rpos, cpos, twin)) continue;
      setSvm(r, c, { kind: 'readingNotUpdated', twin });
      next.push(...(frozenNeighbours(r, c) as typeof queue));
    }
    queue = next;
  }

  // 4. SVM spikes among the cells whose SVM is usable (luminance flags do not matter).
  const svmUsable = (r: number, c: number) => {
    const p = cellOf(m, r, c);
    return !!p && p.svm > 0 && !flags[r][c]?.svm;
  };
  const spikes: [number, number, number][] = [];
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      if (!svmUsable(r, c)) continue;
      const nb: number[] = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = rowOrd[rpos[r] + dr];
          const cc = colOrd[cpos[c] + dc];
          if (rr === undefined || cc === undefined || !svmUsable(rr, cc)) continue;
          nb.push(Math.log(cellOf(m, rr, cc)!.svm));
        }
      if (nb.length < 2) continue;
      const med = median(nb);
      const s = cellOf(m, r, c)!.svm;
      const d = Math.abs(Math.log(s) - med);
      if (d > SPIKE_RATIO && (Math.abs(s - Math.exp(med)) > SPIKE_ABS || d > SPIKE_EXTREME)) spikes.push([r, c, Math.exp(med)]);
    }
  // Non-positive / non-finite SVM next to credible cells is also unusable.
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const p = cellOf(m, r, c);
      if (p && !(p.svm > 0) && !flags[r][c]?.svm) spikes.push([r, c, NaN]);
    }
  for (const [r, c, typical] of spikes) setSvm(r, c, { kind: 'svmSpike', ...(Number.isFinite(typical) ? { typical } : {}) });

  // Level luminance per column; re-estimated when it came from an unreliable G255 cell.
  const maxRow = rowOrd.length ? rowOrd[rowOrd.length - 1] : -1;
  const levels: LevelEstimate[] = m.headerNits.map((raw, c) => {
    const top = maxRow >= 0 ? cellOf(m, maxRow, c) : null;
    const fromTop = !!top && Math.abs(top.nits - raw) <= 1e-9 * Math.max(1, Math.abs(raw));
    const f = maxRow >= 0 ? flags[maxRow][c] : null;
    const topBad = fromTop && (!!f?.lum || f?.svm?.kind === 'blackLevel');
    const bad = !(Number.isFinite(raw) && raw > 0) || topBad;
    const est = bad && maxRow >= 0 ? fitted(fit, maxRow, c) : null;
    // Only columns that keep a credible luminance somewhere can be re-estimated.
    const hasData = rowOrd.some((r) => lumOk(r, c));
    return est !== null && hasData ? { raw, value: Math.exp(est), estimated: true } : { raw, value: raw, estimated: false };
  });

  // Luminance estimates for cells with a luminance flag.
  const lumEstimate: (number | null)[][] = Array.from({ length: R }, () => new Array<number | null>(C).fill(null));
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      if (!flags[r][c]?.lum) continue;
      if (r === maxRow && levels[c].estimated) {
        lumEstimate[r][c] = levels[c].value;
        continue;
      }
      const local = columnLum(m, r, c, rowOrd, rpos, lumOk);
      const f = fitted(fit, r, c);
      lumEstimate[r][c] = local ?? (f === null ? null : Math.exp(f));
    }

  const byKind: Partial<Record<DenoiseKind, number>> = {};
  for (const row of flags)
    for (const f of row) {
      if (f?.svm) byKind[f.svm.kind] = (byKind[f.svm.kind] ?? 0) + 1;
      if (f?.lum) byKind[f.lum.kind] = (byKind[f.lum.kind] ?? 0) + 1;
    }
  return { blackLevel: bl, flags, levels, lumEstimate, byKind };
}

/** Adjacent cell (4-neighbourhood) whose whole reading (SVM and luminance) the cell repeats, or null. */
function repeatedFrom(
  m: Dataset['matrix'],
  r: number,
  c: number,
  rowOrd: number[],
  colOrd: number[],
  rpos: number[],
  cpos: number[],
  only?: [number, number],
): [number, number] | null {
  const p = cellOf(m, r, c)!;
  const around: [number | undefined, number | undefined][] = only
    ? [only]
    : [
        [rowOrd[rpos[r] + 1], c],
        [rowOrd[rpos[r] - 1], c],
        [r, colOrd[cpos[c] + 1]],
        [r, colOrd[cpos[c] - 1]],
      ];
  for (const [rr, cc] of around) {
    if (rr === undefined || cc === undefined) continue;
    const q = cellOf(m, rr, cc);
    if (q && q.svm > 0 && q.nits > 0 && p.nits > 0 && Math.abs(Math.log(p.svm / q.svm)) < FROZEN_SVM_TOL && Math.abs(Math.log(p.nits / q.nits)) < FROZEN_LUM_TOL) return [rr, cc];
  }
  return null;
}

/** Adjacent cell (4-neighbourhood) whose luminance the cell repeats within COPY_TOL, or null. */
function copiedFrom(m: Dataset['matrix'], r: number, c: number, rowOrd: number[], colOrd: number[], rpos: number[], cpos: number[]): [number, number] | null {
  const v = cellOf(m, r, c)!.nits;
  const cand: [number | undefined, number | undefined][] = [
    [rowOrd[rpos[r] + 1], c],
    [rowOrd[rpos[r] - 1], c],
    [r, colOrd[cpos[c] + 1]],
    [r, colOrd[cpos[c] - 1]],
  ];
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const [rr, cc] of cand) {
    if (rr === undefined || cc === undefined) continue;
    const q = cellOf(m, rr, cc);
    if (!q) continue;
    const d = Math.abs(q.nits - v) / Math.abs(v);
    if (d < COPY_TOL && d < bestD) {
      best = [rr, cc];
      bestD = d;
    }
  }
  return best;
}

/**
 * True when the reading breaks the order of its own column: brighter (by more than one reading
 * step) than the credible reading of the next brighter gray, or darker than the next darker one.
 * Luminance always rises with gray at a fixed level, so such a reading is certainly wrong.
 */
function columnOrderBroken(m: Dataset['matrix'], r: number, c: number, rowOrd: number[], rpos: number[], ok: (r: number, c: number) => boolean, step: number): boolean {
  const v = cellOf(m, r, c)!.nits;
  const up = rowOrd[rpos[r] + 1];
  const down = rowOrd[rpos[r] - 1];
  if (up !== undefined && ok(up, c) && v > cellOf(m, up, c)!.nits + step) return true;
  if (down !== undefined && ok(down, c) && v < cellOf(m, down, c)!.nits - step) return true;
  return false;
}

/**
 * Luminance of (r, c) interpolated in its own column between the nearest credible readings above
 * and below (log nits, linear in log gray), bridging at most MAX_GAP cells; null if not bracketed.
 */
function columnLum(m: Dataset['matrix'], r: number, c: number, rowOrd: number[], rpos: number[], ok: (r: number, c: number) => boolean): number | null {
  const run = gapRun(rpos[r], rowOrd.length, (i) => ok(rowOrd[i], c) && rowOrd[i] !== r);
  if (!run) return null;
  const lo = rowOrd[run[0]];
  const hi = rowOrd[run[1]];
  const g = m.rows[r];
  const g0 = m.rows[lo];
  const g1 = m.rows[hi];
  if (!(g0 < g && g < g1)) return null;
  const useLog = g0 > 0;
  const t = useLog ? (Math.log(g) - Math.log(g0)) / (Math.log(g1) - Math.log(g0)) : (g - g0) / (g1 - g0);
  const n0 = cellOf(m, lo, c)!.nits;
  const n1 = cellOf(m, hi, c)!.nits;
  return Math.exp(Math.log(n0) + (Math.log(n1) - Math.log(n0)) * t);
}

/**
 * The credible cells bounding the run of unusable positions around `pos` (positions in some
 * order, 0..n-1), when that run is at most MAX_GAP long and bounded on both sides; else null.
 */
function gapRun(pos: number, n: number, usable: (i: number) => boolean): [number, number] | null {
  let lo = pos - 1;
  while (lo >= 0 && !usable(lo)) lo--;
  let hi = pos + 1;
  while (hi < n && !usable(hi)) hi++;
  if (lo < 0 || hi >= n) return null;
  return hi - lo - 1 <= MAX_GAP ? [lo, hi] : null;
}

// ---------------------------------------------------------------------------------------------
// Processing

interface Built {
  matrix: Dataset['matrix'];
  data: DataPoint[];
  notes: CellNote[];
  noteGrid: (CellNote | null)[][];
  levelNotes: LevelNote[];
  summary: DenoiseSummary;
}

const builtCache = new WeakMap<Dataset['matrix'], Built>();

const refOf = (m: Dataset['matrix'], r: number, c: number): CellRef => ({ gray: m.rows[r], brightnessPercent: m.cols[c] });

function build(m: Dataset['matrix'], a: DenoiseAnalysis): Built {
  const hit = builtCache.get(m);
  if (hit) return hit;
  const { R, C, rowOrd, colOrd, rpos, cpos } = orders(m);
  const headerNits = a.levels.map((l) => l.value);
  const grid: (DataPoint | null)[][] = m.grid.map((row) => [...row]);
  const noteGrid: (CellNote | null)[][] = Array.from({ length: R }, () => new Array<CellNote | null>(C).fill(null));
  const notes: CellNote[] = [];

  // Measured cells whose SVM (and processed luminance) may serve as interpolation sources.
  // Highly credible: a usable SVM, and a luminance clearly above the black noise (for clean,
  // quantised instruments with no spread this is just above the black level).
  const sourceMin = a.blackLevel.ceiling + SOURCE_SCALES * (a.blackLevel.spread ?? 0);
  const nitsOf = (r: number, c: number) => a.lumEstimate[r][c] ?? cellOf(m, r, c)!.nits;
  const source = (r: number, c: number) => {
    const p = cellOf(m, r, c);
    return !!p && p.svm > 0 && !a.flags[r][c]?.svm && nitsOf(r, c) > sourceMin;
  };
  const levelX_ = (c: number) => levelX(headerNits[c]);

  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const f = a.flags[r][c];
      const p = cellOf(m, r, c);
      if (!f || !p) continue;
      const base: CellNote = { r, c, ...refOf(m, r, c), kind: 'blackLevel', action: 'noData', reason: 'blackLevel', raw: p, value: null };
      let note: CellNote;
      if (f.svm) {
        const k = f.svm.kind;
        note = { ...base, kind: k, reason: k === 'blackLevel' && p.nits <= 0 ? 'nonPositive' : k };
        if (f.lum) note.also = f.lum.kind;
        if (k === 'blackLevel') note.floor = a.blackLevel.ceiling;
        if (k === 'svmSpike' && f.svm.typical !== undefined) note.typical = f.svm.typical;
        if (f.svm.twin) note.twin = refOf(m, f.svm.twin[0], f.svm.twin[1]);
        if (k === 'blackLevel' || k === 'svmSpike' || k === 'readingNotUpdated') {
          const v = interpolate(m, r, c, rowOrd, colOrd, rpos, cpos, source, nitsOf, levelX_);
          if (v) {
            // A spike keeps its measured (or estimated) luminance; a black / frozen cell takes the interpolated one.
            const nits = k === 'svmSpike' ? nitsOf(r, c) : v.nits;
            note = { ...note, action: 'interpolated', value: { gray: p.gray, brightnessPercent: p.brightnessPercent, nits, svm: v.svm }, from: v.from, via: v.via };
            if (k === 'svmSpike' && a.lumEstimate[r][c] !== null) note.lumVia = lumVia(m, a, r, c, rowOrd, rpos);
          }
        }
      } else if (f.lum && a.lumEstimate[r][c] !== null) {
        note = {
          ...base,
          kind: f.lum.kind,
          reason: f.lum.kind,
          action: 'lumEstimated',
          value: { gray: p.gray, brightnessPercent: p.brightnessPercent, nits: a.lumEstimate[r][c]!, svm: p.svm },
          lumVia: lumVia(m, a, r, c, rowOrd, rpos),
          expected: f.lum.expected,
          deviation: f.lum.deviation,
        };
        if (f.lum.twin) note.twin = refOf(m, f.lum.twin[0], f.lum.twin[1]);
      } else continue;
      if (note.also && f.lum) {
        note.expected = f.lum.expected;
        note.deviation = f.lum.deviation;
      }
      grid[r][c] = note.value;
      noteGrid[r][c] = note;
      notes.push(note);
    }

  const maxRow = rowOrd.length ? rowOrd[rowOrd.length - 1] : -1;
  const levelNotes: LevelNote[] = [];
  a.levels.forEach((l, c) => {
    if (!l.estimated) return;
    const f = maxRow >= 0 ? a.flags[maxRow][c] : null;
    levelNotes.push({ c, brightnessPercent: m.cols[c], raw: l.raw, value: l.value, cellKind: f?.lum?.kind ?? (Number.isFinite(l.raw) && l.raw > 0 ? (f?.svm?.kind ?? null) : null) });
  });

  const data: DataPoint[] = [];
  for (const row of grid) for (const p of row) if (p) data.push(p);
  const byKind: Partial<Record<DenoiseKind, number>> = {};
  for (const n of notes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const count = (act: DenoiseAction) => notes.filter((n) => n.action === act).length;
  const summary: DenoiseSummary = {
    touched: notes.length,
    interpolated: count('interpolated'),
    noData: count('noData'),
    lumEstimated: count('lumEstimated'),
    levelsEstimated: levelNotes.length,
    byKind,
    nominal: R * C,
    valid: data.length,
  };
  const out: Built = { matrix: { ...m, headerNits, grid }, data, notes, noteGrid, levelNotes, summary };
  builtCache.set(m, out);
  return out;
}

function lumVia(m: Dataset['matrix'], a: DenoiseAnalysis, r: number, c: number, rowOrd: number[], rpos: number[]): 'column' | 'pattern' {
  const maxRow = rowOrd[rowOrd.length - 1];
  if (r === maxRow && a.levels[c].estimated) return 'pattern';
  const lumOk = (rr: number, cc: number) => {
    const p = cellOf(m, rr, cc);
    const f = a.flags[rr]?.[cc];
    return !!p && p.nits > 0 && !f?.lum && f?.svm?.kind !== 'blackLevel' && f?.svm?.kind !== 'duplicateColumn' && f?.svm?.kind !== 'duplicateRow';
  };
  return columnLum(m, r, c, rowOrd, rpos, lumOk) !== null ? 'column' : 'pattern';
}

/**
 * Interpolated SVM (log) and luminance (geometric) for an unusable cell: along gray in its column
 * first, else along level luminance in its row. Only between two credible measured cells that
 * bracket it, across a gap of at most MAX_GAP cells. null when neither direction qualifies.
 */
function interpolate(
  m: Dataset['matrix'],
  r: number,
  c: number,
  rowOrd: number[],
  colOrd: number[],
  rpos: number[],
  cpos: number[],
  source: (r: number, c: number) => boolean,
  nitsOf: (r: number, c: number) => number,
  xOf: (c: number) => number,
): { svm: number; nits: number; from: [CellRef, CellRef]; via: 'gray' | 'level' } | null {
  const mix = (r0: number, c0: number, r1: number, c1: number, t: number) => {
    const s0 = cellOf(m, r0, c0)!.svm;
    const s1 = cellOf(m, r1, c1)!.svm;
    const n0 = nitsOf(r0, c0);
    const n1 = nitsOf(r1, c1);
    const svm = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * t);
    const nits = n0 > 0 && n1 > 0 ? Math.exp(Math.log(n0) + (Math.log(n1) - Math.log(n0)) * t) : n0 + (n1 - n0) * t;
    return { svm, nits };
  };
  const col = gapRun(rpos[r], rowOrd.length, (i) => source(rowOrd[i], c));
  if (col) {
    const r0 = rowOrd[col[0]];
    const r1 = rowOrd[col[1]];
    const g = m.rows[r];
    const g0 = m.rows[r0];
    const g1 = m.rows[r1];
    if (g0 < g && g < g1) return { ...mix(r0, c, r1, c, (g - g0) / (g1 - g0)), from: [refOf(m, r0, c), refOf(m, r1, c)], via: 'gray' };
  }
  const row = gapRun(cpos[c], colOrd.length, (i) => source(r, colOrd[i]));
  if (row) {
    const c0 = colOrd[row[0]];
    const c1 = colOrd[row[1]];
    const x = xOf(c);
    const x0 = xOf(c0);
    const x1 = xOf(c1);
    if (x0 < x && x < x1) return { ...mix(r, c0, r, c1, (x - x0) / (x1 - x0)), from: [refOf(m, r, c0), refOf(m, r, c1)], via: 'level' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Records

const rawCache = new WeakMap<object, Dataset>();

/**
 * The raw version of a record: stored `excluded` points (older saves / bundled files cleaned by
 * the former destructive exclusion) put back into the grid, without the `excluded` field.
 * Returns the record itself when it carries no `excluded` field. Memoised per record object.
 */
export function rawDataset<T extends Dataset>(ds: T): T {
  if (ds.excluded === undefined) return ds;
  const hit = rawCache.get(ds);
  if (hit) return hit as T;
  const restored = restoreExcluded(ds);
  const { excluded: _e, ...rest } = restored as T & { excluded?: unknown };
  const out = rest as T;
  rawCache.set(ds, out);
  return out;
}

const processedCache = new WeakMap<object, Map<string, ProcessedRecord<Dataset>>>();

const EMPTY_SUMMARY = (m: Dataset['matrix'], valid: number): DenoiseSummary => ({
  touched: 0,
  interpolated: 0,
  noData: 0,
  lumEstimated: 0,
  levelsEstimated: 0,
  byKind: {},
  nominal: m.rows.length * m.cols.length,
  valid,
});

/**
 * What the views display for a record (see header). Pure and memoised per record object +
 * options: the same inputs always give the same (===) result, and a renamed record shares the
 * processed matrix of the original (grid views / stats caches keyed by matrix stay warm).
 */
export function processRecord<T extends Dataset>(record: T, opts: DenoiseOptions): ProcessedRecord<T> {
  const key = opts.denoise ? 'on' : 'off';
  let per = processedCache.get(record);
  if (!per) {
    per = new Map();
    processedCache.set(record, per);
  }
  const hit = per.get(key);
  if (hit) return hit as unknown as ProcessedRecord<T>;

  const raw = rawDataset(record);
  const analysis = analyseMatrix(raw.matrix);
  let out: ProcessedRecord<T>;
  if (!opts.denoise) {
    const noteGrid = raw.matrix.grid.map((row) => row.map(() => null));
    const valid = raw.matrix.grid.reduce((n, row) => n + row.filter((p) => !!p).length, 0);
    out = { record: raw, raw, denoise: false, analysis, notes: [], noteGrid, levelNotes: [], summary: EMPTY_SUMMARY(raw.matrix, valid), noteAt: () => null };
  } else {
    const b = build(raw.matrix, analysis);
    const byRef = new Map(b.notes.map((n) => [`${n.gray}|${n.brightnessPercent}`, n]));
    out = {
      record: { ...raw, matrix: b.matrix, data: b.data },
      raw,
      denoise: true,
      analysis,
      notes: b.notes,
      noteGrid: b.noteGrid,
      levelNotes: b.levelNotes,
      summary: b.summary,
      noteAt: (gray, pct) => byRef.get(`${gray}|${pct}`) ?? null,
    };
  }
  per.set(key, out as unknown as ProcessedRecord<Dataset>);
  return out;
}

/** Shorthand: the record the views display. */
export function displayRecord<T extends Dataset>(record: T, opts: DenoiseOptions): T {
  return processRecord(record, opts).record;
}

/** Summary of what the denoise does to a record (for badges / importer preview). */
export function denoiseSummary(record: Dataset): DenoiseSummary {
  return processRecord(record, { denoise: true }).summary;
}

/**
 * Parameters of a note's reason text (common.denoise.reason.<reason>), formatted for display:
 * nits / floor / expected in nits, svm / typical as SVM, dev as a signed percentage, twin as
 * gray / % labels.
 */
export function noteParams(n: CellNote): Record<string, string> {
  const p: Record<string, string> = {
    gray: String(n.gray),
    pct: String(n.brightnessPercent),
    nits: fmtNits(n.raw.nits),
    svm: fmtSvm(n.raw.svm),
  };
  if (n.floor !== undefined) p.floor = fmtNits(n.floor);
  if (n.typical !== undefined) {
    p.typical = fmtSvm(n.typical);
    p.ratio = String(Math.max(3, Math.floor(Math.max(n.raw.svm / n.typical, n.typical / n.raw.svm))));
  }
  if (n.expected !== undefined) p.expected = fmtNits(n.expected);
  if (n.deviation !== undefined) p.dev = `${n.deviation > 0 ? '+' : ''}${Math.round(n.deviation * 100)}%`;
  if (n.twin) {
    p.twinGray = String(n.twin.gray);
    p.twinPct = String(n.twin.brightnessPercent);
  }
  if (n.value) {
    p.valueNits = fmtNits(n.value.nits);
    p.valueSvm = fmtSvm(n.value.svm);
  }
  if (n.from) {
    p.from0 = n.via === 'gray' ? `G${n.from[0].gray}` : `${n.from[0].brightnessPercent}%`;
    p.from1 = n.via === 'gray' ? `G${n.from[1].gray}` : `${n.from[1].brightnessPercent}%`;
  }
  return p;
}
