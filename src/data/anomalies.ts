/**
 * Rule-based detection of obviously invalid measurements (docs/adr/0012).
 *
 * Rules, applied in order (a cell gets the first matching reason):
 *  1. belowNoise     — measured nits at or below the instrument's black-level noise ceiling
 *                      (mean + 3σ of the gray ≤ 2 rows; at least 0). Such readings cannot be told
 *                      apart from black, so the SVM computed from them is meaningless.
 *  2. duplicateColumn / duplicateRow — two adjacent columns (rows) hold identical values in every
 *                      cell: a copy error in the source table. The dimmer one (lower % / lower
 *                      gray) is flagged, because its real values must be lower than its twin's.
 *  3. nitsShift      — a luminance reading that departs from the panel's own luminance pattern
 *                      (log nits ≈ gray effect + level effect, fitted by median polish) by more than
 *                      20 % while matching an adjacent cell's reading within 2.5 % — a stale reading
 *                      taken before the test pattern changed, or a value pasted into the wrong
 *                      row — or by more than 35 % outright. Only judged well above the noise floor.
 *  4. svmSpike       — an SVM more than 3× (or less than ⅓ of) the median of its valid
 *                      neighbours AND more than 1.0 away from it, with luminance above the floor.
 *
 * Detection never modifies data; `excludeAnomalies` returns a cleaned copy that keeps the removed
 * raw values (with the reason) in `dataset.excluded`, so every removal stays auditable.
 */
import type { Dataset, DataPoint, ExcludedPoint } from '../types';

export type AnomalyKind = 'belowNoise' | 'duplicateColumn' | 'duplicateRow' | 'nitsShift' | 'svmSpike';

export interface Anomaly {
  /** Matrix indices (original order). */
  r: number;
  c: number;
  point: DataPoint;
  kind: AnomalyKind;
  /** Human-readable explanation (zh). */
  detail: string;
}

export interface NoiseFloor {
  /** Mean / σ of the black rows (gray ≤ 2); null when there are too few black readings. */
  mean: number | null;
  sd: number | null;
  /** Readings at or below this are "below noise". Never negative. */
  ceiling: number;
}

const BLACK_MAX_GRAY = 2;
const NITS_SHIFT_TOL = Math.log(1.2);
/** Beyond this deviation a luminance reading is flagged even without a copy signature. */
const NITS_SHIFT_HARD = Math.log(1.35);
/** Relative difference under which two adjacent readings count as a copy. */
const NITS_COPY_TOL = 0.025;
const SPIKE_RATIO = Math.log(3);
const SPIKE_ABS = 1.0;

export function noiseFloor(ds: Pick<Dataset, 'matrix' | 'excluded'>): NoiseFloor {
  // Always judged on the raw readings: previously excluded black cells still describe the instrument.
  const m = ds.excluded?.length ? restoreExcluded(ds as Dataset).matrix : ds.matrix;
  const black: number[] = [];
  m.rows.forEach((g, r) => {
    if (g <= BLACK_MAX_GRAY) for (const p of m.grid[r]) if (p && Number.isFinite(p.nits)) black.push(p.nits);
  });
  if (black.length < 6) return { mean: null, sd: null, ceiling: 0 };
  const mean = black.reduce((a, b) => a + b, 0) / black.length;
  const sd = Math.sqrt(black.reduce((a, b) => a + (b - mean) ** 2, 0) / black.length);
  return { mean, sd, ceiling: Math.max(0, mean + 3 * sd) };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Tukey median polish of a two-way table (nulls ignored); returns the residuals. */
export function medianPolish(table: (number | null)[][], iterations = 10): (number | null)[][] {
  const res = table.map((row) => [...row]);
  const R = res.length;
  const C = R ? res[0].length : 0;
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < R; r++) {
      const v = res[r].filter((x): x is number => x !== null);
      if (!v.length) continue;
      const md = median(v);
      for (let c = 0; c < C; c++) if (res[r][c] !== null) res[r][c]! -= md;
    }
    for (let c = 0; c < C; c++) {
      const v: number[] = [];
      for (let r = 0; r < R; r++) if (res[r][c] !== null) v.push(res[r][c]!);
      if (!v.length) continue;
      const md = median(v);
      for (let r = 0; r < R; r++) if (res[r][c] !== null) res[r][c]! -= md;
    }
  }
  return res;
}

const same = (a: DataPoint | null, b: DataPoint | null) => !!a && !!b && a.nits === b.nits && a.svm === b.svm;

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function detectAnomalies(ds: Pick<Dataset, 'matrix' | 'excluded'>): Anomaly[] {
  const m = ds.matrix;
  const R = m.rows.length;
  const C = m.cols.length;
  const floor = noiseFloor(ds);
  const flagged = new Map<string, Anomaly>();
  const key = (r: number, c: number) => `${r},${c}`;
  const flag = (r: number, c: number, kind: AnomalyKind, detail: string) => {
    const p = m.grid[r][c];
    if (!p || flagged.has(key(r, c))) return;
    flagged.set(key(r, c), { r, c, point: p, kind, detail });
  };

  // 1. Below the black-level noise ceiling.
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const p = m.grid[r][c];
      if (p && p.nits <= floor.ceiling)
        flag(r, c, 'belowNoise', p.nits <= 0 ? `亮度 ${fmt(p.nits)} nits ≤ 0` : `亮度 ${fmt(p.nits)} nits 低于噪声底 ${fmt(floor.ceiling)} nits`);
    }

  // 2. Duplicated adjacent columns / rows (every cell identical).
  for (let c = 0; c + 1 < C; c++) {
    const rowsBoth = m.grid.filter((row) => row[c] && row[c + 1]);
    if (rowsBoth.length >= 3 && rowsBoth.every((row) => same(row[c], row[c + 1]))) {
      const dim = m.cols[c] <= m.cols[c + 1] ? c : c + 1;
      const twin = dim === c ? c + 1 : c;
      for (let r = 0; r < R; r++) flag(r, dim, 'duplicateColumn', `${m.cols[dim]}% 列与 ${m.cols[twin]}% 列完全相同`);
    }
  }
  for (let r = 0; r + 1 < R; r++) {
    const both = m.grid[r].map((p, c) => [p, m.grid[r + 1][c]] as const).filter(([a, b]) => a && b);
    if (both.length >= 3 && both.every(([a, b]) => same(a, b))) {
      const dim = m.rows[r] <= m.rows[r + 1] ? r : r + 1;
      const twin = dim === r ? r + 1 : r;
      for (let c = 0; c < C; c++) flag(dim, c, 'duplicateRow', `G${m.rows[dim]} 行与 G${m.rows[twin]} 行完全相同`);
    }
  }

  // 3. Luminance readings inconsistent with a separable model of the panel: log(nits) ≈ row
  //    effect (gray response) + column effect (level luminance), fitted by median polish, which
  //    shrugs off a minority of bad cells. Fitted on everything clearly above the floor; only
  //    cells well above it are judged. Refit without flagged cells until stable.
  const fitMin = Math.max(0.3, floor.ceiling * 3);
  const chkMin = Math.max(1, floor.ceiling * 10);
  const copied = (r: number, c: number) => {
    const v = m.grid[r][c]!.nits;
    for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]] as const) {
      const q = m.grid[rr]?.[cc];
      if (q && Math.abs(q.nits - v) / v < NITS_COPY_TOL) return true;
    }
    return false;
  };
  for (let pass = 0; pass < 5; pass++) {
    const res = medianPolish(
      m.grid.map((row, r) => row.map((p, c) => (p && p.nits > fitMin && !flagged.has(key(r, c)) ? Math.log(p.nits) : null))),
    );
    let added = 0;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const p = m.grid[r][c];
        const e = res[r][c];
        if (!p || e === null || p.nits <= chkMin || flagged.has(key(r, c))) continue;
        const dev = Math.abs(e);
        const isCopy = copied(r, c);
        if (dev > NITS_SHIFT_HARD || (dev > NITS_SHIFT_TOL && isCopy)) {
          const expected = p.nits / Math.exp(e);
          flag(r, c, 'nitsShift', `亮度 ${fmt(p.nits)} nits 与整表亮度规律推算的约 ${fmt(expected)} nits 相差 ${e > 0 ? '+' : ''}${Math.round((Math.exp(e) - 1) * 100)}%${isCopy ? '，且与相邻格读数几乎相同（疑似画面未切换时的陈旧读数）' : '，疑似错行或错列'}`);
          added++;
        }
      }
    if (!added) break;
  }

  // 4. SVM spikes among the remaining valid cells.
  const valid = (r: number, c: number) => {
    const p = m.grid[r]?.[c];
    return !!p && p.nits > floor.ceiling && p.svm > 0 && !flagged.has(key(r, c));
  };
  const spikes: [number, number, number][] = [];
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      if (!valid(r, c)) continue;
      const nb: number[] = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && valid(r + dr, c + dc)) nb.push(Math.log(m.grid[r + dr][c + dc]!.svm));
      if (nb.length < 3) continue;
      const med = median(nb);
      const s = m.grid[r][c]!.svm;
      if (Math.abs(Math.log(s) - med) > SPIKE_RATIO && Math.abs(s - Math.exp(med)) > SPIKE_ABS) spikes.push([r, c, Math.exp(med)]);
    }
  for (const [r, c, e] of spikes) flag(r, c, 'svmSpike', `SVM ${fmt(m.grid[r][c]!.svm)} 与周围单元格中位数 ${fmt(e)} 相差超过 3 倍`);

  return [...flagged.values()].sort((a, b) => a.r - b.r || a.c - b.c);
}

/**
 * Cleaned copy: flagged cells become null (missing), `data` is rebuilt, and the removed raw
 * values are appended to `excluded` with their reasons. `kinds` limits which rules remove cells.
 */
export function excludeAnomalies<T extends Dataset>(ds: T, anomalies: Anomaly[], kinds?: AnomalyKind[]): T {
  const take = anomalies.filter((a) => !kinds || kinds.includes(a.kind));
  const grid = ds.matrix.grid.map((row) => [...row]);
  const excluded: ExcludedPoint[] = [...(ds.excluded ?? [])];
  for (const a of take) {
    if (!grid[a.r][a.c]) continue;
    grid[a.r][a.c] = null;
    excluded.push({ ...a.point, reason: a.kind, detail: a.detail });
  }
  const data: DataPoint[] = [];
  for (const row of grid) for (const p of row) if (p) data.push(p);
  return { ...ds, data, matrix: { ...ds.matrix, grid }, excluded };
}

/** Raw copy: puts every `excluded` point back into its grid cell (matched by gray + brightness %). */
export function restoreExcluded<T extends Dataset>(ds: T): T {
  if (!ds.excluded?.length) return ds;
  const grid = ds.matrix.grid.map((row) => [...row]);
  for (const x of ds.excluded) {
    const r = ds.matrix.rows.indexOf(x.gray);
    const c = ds.matrix.cols.indexOf(x.brightnessPercent);
    if (r >= 0 && c >= 0 && !grid[r][c]) grid[r][c] = { gray: x.gray, brightnessPercent: x.brightnessPercent, nits: x.nits, svm: x.svm };
  }
  const data: DataPoint[] = [];
  for (const row of grid) for (const p of row) if (p) data.push(p);
  const { excluded: _e, ...rest } = ds;
  return { ...(rest as T), data, matrix: { ...ds.matrix, grid } };
}

export interface ExclusionSummary {
  /** Number of excluded raw points. */
  total: number;
  /** Count per reason (AnomalyKind). */
  byReason: Partial<Record<AnomalyKind, number>>;
  /** Nominal grid size (rows × cols) and valid cells left. */
  nominal: number;
  valid: number;
}

/** Summary of a record's excluded points for UI badges / tooltips (null when nothing was excluded). */
export function exclusionSummary(ds: Pick<Dataset, 'matrix' | 'excluded' | 'data'>): ExclusionSummary | null {
  const ex = ds.excluded ?? [];
  if (!ex.length) return null;
  const byReason: Partial<Record<AnomalyKind, number>> = {};
  for (const x of ex) byReason[x.reason as AnomalyKind] = (byReason[x.reason as AnomalyKind] ?? 0) + 1;
  return { total: ex.length, byReason, nominal: ds.matrix.rows.length * ds.matrix.cols.length, valid: ds.data.length };
}

/** i18n keys (common namespace) for each anomaly kind: common.exclusion.reasons.<kind>. */
export const ANOMALY_KINDS: AnomalyKind[] = ['belowNoise', 'duplicateColumn', 'duplicateRow', 'nitsShift', 'svmSpike'];
