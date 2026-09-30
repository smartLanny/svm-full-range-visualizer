/**
 * Scenario-weighted SVM reference ("场景加权 SVM，参考值"; docs/adr/0009 addendum). Pure and memoized.
 *
 * Three usage scenarios are rectangles in the (level luminance, gray) plane: 夜间 / Night, 室内 /
 * Indoor, 户外 / Outdoor. Per scenario the reference is the AREA-WEIGHTED ARITHMETIC MEAN SVM of
 * the record's cells inside the rectangle, area measured in log10(level nits) × gray (perception
 * is logarithmic in luminance). Cells straddling a bound count with their overlapping part only;
 * cells without a valid value (null / non-finite SVM, the denoise's "no data") count nothing, and
 * the covered share of the rectangle is reported. The composite is the weighted average of the
 * scenario means; a scenario covered less than SCENARIO_MIN_COVERAGE is left out and the other
 * weights are renormalised.
 *
 * Independent of the view: the rectangles have their own luminance / gray bounds (the gray range
 * starts at G15 by default), so neither the level-luminance cap nor the low-gray clip changes the
 * number. Pass the record as displayed (processed by the denoise), like computeRecordStats.
 *
 * Cell layout: the NOMINAL layout of the matrix (every row with a finite gray, every column with a
 * positive level luminance, sorted ascending), interior edges at the midpoints between neighbours
 * (cellEdges, as the stats / heatmap do), x = log10(level nits). The outermost edges stop at the
 * first / last measured row and column: the reference never extrapolates past the measured range,
 * so a device whose brightest column is below 400 nits simply has no outdoor data.
 */
import type { Dataset } from '../types';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import { cellEdges } from './grid';

export const SCENARIO_IDS = ['night', 'indoor', 'outdoor'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** One scenario rectangle and its weight. */
export interface ScenarioSpec {
  /** Level luminance (G255 nits of the column): 0 < nitsMin < nitsMax ≤ SCENARIO_NITS_CAP. */
  nitsMin: number;
  nitsMax: number;
  /** Gray levels: 0 ≤ grayMin < grayMax ≤ 255. */
  grayMin: number;
  grayMax: number;
  /** Relative weight, 0–100 (the composite normalises the weights; not all may be 0). */
  weight: number;
}

export type ScenarioConfig = Record<ScenarioId, ScenarioSpec>;

/** Unified upper limit of the scenario luminance axis (user decision: 500 nits). */
export const SCENARIO_NITS_CAP = 500;
/** Largest weight a scenario can be given (weights are normalised, so this is only a UI range). */
export const SCENARIO_WEIGHT_MAX = 100;

export const DEFAULT_SCENARIOS: ScenarioConfig = {
  night: { nitsMin: 2, nitsMax: 20, grayMin: 15, grayMax: 100, weight: 30 },
  indoor: { nitsMin: 50, nitsMax: 250, grayMin: 15, grayMax: 255, weight: 50 },
  outdoor: { nitsMin: 400, nitsMax: 500, grayMin: 128, grayMax: 255, weight: 20 },
};

/**
 * A scenario enters the composite only when valid cells cover at least this share of its
 * rectangle (log-luminance × gray area): below it the mean describes too small a part of the
 * scenario, so its weight goes to the others instead. 40 % rather than exactly half: the bundled
 * Xiaomi 18 Pro Max (Pro off) covers 49.98 % of the night scenario once the denoise has turned its
 * black-level readings into "no data" — a 50 % cut would sit on a real record and drop its strong
 * night (5.19), making its composite look like the best of all (0.83 instead of 2.14).
 */
export const SCENARIO_MIN_COVERAGE = 0.4;

/** Lower bound of the 强烈 / Strong grade (a display choice; 0.4 / 1.0 are SVM_SAFE / SVM_CRITICAL). */
export const SCENARIO_STRONG = 3.0;

export const SCENARIO_GRADES = ['imperceptible', 'slight', 'visible', 'strong'] as const;
export type ScenarioGrade = (typeof SCENARIO_GRADES)[number];

/** Grade of a scenario mean / composite: < 0.4 无感, 0.4–1.0 轻微, 1.0–3.0 可见, ≥ 3.0 强烈. */
export function scenarioGrade(v: number): ScenarioGrade {
  return v < SVM_SAFE ? 'imperceptible' : v < SVM_CRITICAL ? 'slight' : v < SCENARIO_STRONG ? 'visible' : 'strong';
}

// ---- configuration ---------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True for a usable scenario: numeric fields, min < max, nits in (0, 500], gray in 0–255, weight 0–100. */
export function validScenarioSpec(v: unknown): v is ScenarioSpec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  const { nitsMin, nitsMax, grayMin, grayMax, weight } = s;
  return (
    finite(nitsMin) &&
    finite(nitsMax) &&
    finite(grayMin) &&
    finite(grayMax) &&
    finite(weight) &&
    nitsMin > 0 &&
    nitsMin < nitsMax &&
    nitsMax <= SCENARIO_NITS_CAP &&
    grayMin >= 0 &&
    grayMin < grayMax &&
    grayMax <= 255 &&
    weight >= 0 &&
    weight <= SCENARIO_WEIGHT_MAX
  );
}

/**
 * A saved scenario configuration, scenario by scenario: a valid scenario is kept (its known fields
 * only), an invalid or missing one falls back to its default; weights that are all 0 fall back to
 * the default weights. Always returns a complete, valid configuration.
 */
export function sanitizeScenarios(saved: unknown): ScenarioConfig {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const out = {} as ScenarioConfig;
  for (const id of SCENARIO_IDS) {
    const s = src[id];
    out[id] = validScenarioSpec(s) ? { nitsMin: s.nitsMin, nitsMax: s.nitsMax, grayMin: s.grayMin, grayMax: s.grayMax, weight: s.weight } : { ...DEFAULT_SCENARIOS[id] };
  }
  if (SCENARIO_IDS.every((id) => out[id].weight === 0)) for (const id of SCENARIO_IDS) out[id] = { ...out[id], weight: DEFAULT_SCENARIOS[id].weight };
  return out;
}

/** True when every scenario is valid and the weights are not all 0. */
export function validScenarios(c: ScenarioConfig): boolean {
  return SCENARIO_IDS.every((id) => validScenarioSpec(c[id])) && SCENARIO_IDS.some((id) => c[id].weight > 0);
}

/** Cache / comparison key of a configuration. */
export function scenarioKey(c: ScenarioConfig): string {
  return SCENARIO_IDS.map((id) => {
    const s = c[id];
    return `${s.nitsMin},${s.nitsMax},${s.grayMin},${s.grayMax},${s.weight}`;
  }).join('|');
}

export const isDefaultScenarios = (c: ScenarioConfig) => scenarioKey(c) === scenarioKey(DEFAULT_SCENARIOS);

/** Configured weights normalised to shares (0..1) summing to 1 (all 0 when every weight is 0). */
export function weightShares(c: ScenarioConfig): Record<ScenarioId, number> {
  const sum = SCENARIO_IDS.reduce((a, id) => a + Math.max(0, c[id].weight), 0);
  const out = {} as Record<ScenarioId, number>;
  for (const id of SCENARIO_IDS) out[id] = sum > 0 ? Math.max(0, c[id].weight) / sum : 0;
  return out;
}

// ---- computation -----------------------------------------------------------------------------

export interface ScenarioResult {
  id: ScenarioId;
  /** Area-weighted arithmetic mean SVM of the covered part of the rectangle; null without data. */
  mean: number | null;
  /** Valid-cell area ÷ rectangle area, both in log10(nits) × gray (0..1). */
  coverage: number;
  /** Counted in the composite: it has data covering ≥ SCENARIO_MIN_COVERAGE of the rectangle. */
  used: boolean;
  /** Configured weight as a share of the three (0..1). */
  weight: number;
  /** Weight applied in the composite: renormalised over the used scenarios; 0 when not used. */
  effectiveWeight: number;
}

export interface ScenarioReference {
  /** Weighted average of the used scenarios' means; null when none is used. */
  composite: number | null;
  /** One entry per scenario, in SCENARIO_IDS order. */
  scenarios: ScenarioResult[];
  /**
   * Scenarios with a non-zero weight left out of the composite (no data / coverage below
   * SCENARIO_MIN_COVERAGE): their weight went to the others ("缺户外数据，权重已重新分配").
   */
  dropped: ScenarioId[];
}

/** The rectangle of a scenario in (x = log10 nits, gray). */
export function scenarioRect(s: ScenarioSpec): { x0: number; x1: number; g0: number; g1: number } {
  return { x0: Math.log10(s.nitsMin), x1: Math.log10(s.nitsMax), g0: s.grayMin, g1: s.grayMax };
}

/** Nominal cell layout of a matrix in (log10 nits, gray): edges clamped to the measured range. */
function layoutOf(m: Dataset['matrix']) {
  const rows = m.rows
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => Number.isFinite(g))
    .sort((a, b) => a.g - b.g);
  const cols = m.headerNits
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a.n - b.n);
  const xs = cols.map(({ n }) => Math.log10(n));
  const gs = rows.map(({ g }) => g);
  // Interior edges at the midpoints (cellEdges); the outer ones at the first / last sample.
  const xe = xs.length ? cellEdges(xs, xs[0], xs[xs.length - 1]) : [];
  const ge = gs.length ? cellEdges(gs, gs[0], gs[gs.length - 1]) : [];
  return { rows, cols, xe, ge };
}

function compute(ds: Pick<Dataset, 'matrix'>, config: ScenarioConfig): ScenarioReference {
  const m = ds.matrix;
  const { rows, cols, xe, ge } = layoutOf(m);
  const shares = weightShares(config);
  const partial = SCENARIO_IDS.map((id) => {
    const rect = scenarioRect(config[id]);
    const rectArea = Math.max(0, rect.x1 - rect.x0) * Math.max(0, rect.g1 - rect.g0);
    let area = 0;
    let weighted = 0;
    for (let r = 0; r < rows.length; r++) {
      const dg = Math.min(ge[r + 1], rect.g1) - Math.max(ge[r], rect.g0);
      if (!(dg > 0)) continue;
      for (let c = 0; c < cols.length; c++) {
        const dx = Math.min(xe[c + 1], rect.x1) - Math.max(xe[c], rect.x0);
        if (!(dx > 0)) continue;
        const p = m.grid[rows[r].i]?.[cols[c].i];
        if (!p || !Number.isFinite(p.svm)) continue;
        area += dx * dg;
        weighted += dx * dg * p.svm;
      }
    }
    const mean = area > 0 ? weighted / area : null;
    const coverage = rectArea > 0 ? Math.min(1, area / rectArea) : 0;
    return { id, mean, coverage, used: mean !== null && coverage >= SCENARIO_MIN_COVERAGE - 1e-9, weight: shares[id] };
  });
  const wsum = partial.reduce((a, s) => a + (s.used ? s.weight : 0), 0);
  const scenarios: ScenarioResult[] = partial.map((s) => ({ ...s, effectiveWeight: s.used && wsum > 0 ? s.weight / wsum : 0 }));
  const composite = wsum > 0 ? scenarios.reduce((a, s) => a + (s.used && s.mean !== null ? s.mean * s.effectiveWeight : 0), 0) : null;
  return { composite, scenarios, dropped: scenarios.filter((s) => !s.used && s.weight > 0).map((s) => s.id) };
}

const cache = new WeakMap<Dataset['matrix'], Map<string, ScenarioReference>>();

/** Scenario reference of one record (as displayed). Memoized per matrix + configuration. */
export function scenarioReference(ds: Pick<Dataset, 'matrix'>, config: ScenarioConfig = DEFAULT_SCENARIOS): ScenarioReference {
  const key = scenarioKey(config);
  let perMatrix = cache.get(ds.matrix);
  if (!perMatrix) {
    perMatrix = new Map();
    cache.set(ds.matrix, perMatrix);
  }
  const hit = perMatrix.get(key);
  if (hit) return hit;
  const res = compute(ds, config);
  perMatrix.set(key, res);
  return res;
}

/** The result of one scenario. */
export const scenarioOf = (ref: ScenarioReference, id: ScenarioId): ScenarioResult => ref.scenarios.find((s) => s.id === id)!;

/** A scenario's mean as it counts (used in the composite), else null. */
export const usedMean = (ref: ScenarioReference, id: ScenarioId): number | null => {
  const s = scenarioOf(ref, id);
  return s.used ? s.mean : null;
};
