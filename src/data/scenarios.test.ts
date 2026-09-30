import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, DataPoint } from '../types';
import { computeRecordStats } from './stats';
import { processRecord, rawDataset } from './denoise';
import { validateDataset } from './records';
import {
  DEFAULT_SCENARIOS,
  isDefaultScenarios,
  sanitizeScenarios,
  scenarioGrade,
  scenarioKey,
  scenarioOf,
  scenarioReference,
  SCENARIO_MIN_COVERAGE,
  usedMean,
  validScenarios,
  weightShares,
  type ScenarioConfig,
} from './scenarios';

/** Synthetic dataset in the on-disk ordering (gray / brightness descending), cell(g, level) -> svm | null. */
function synth(rows: number[], header: number[], cell: (gray: number, level: number) => number | null): Dataset {
  const cols = header.map((_, i) => 100 - i);
  const grid: (DataPoint | null)[][] = rows.map((g) =>
    header.map((lv, c) => {
      const v = cell(g, lv);
      return v === null ? null : { gray: g, brightnessPercent: cols[c], nits: (lv * g) / 255, svm: v };
    }),
  );
  return { id: 'x', name: 'x', data: [], matrix: { rows, cols, headerNits: header, grid } };
}

const GRAYS = [255, 192, 128, 100, 64, 30, 15, 5, 1];
const LEVELS = [600, 500, 400, 300, 200, 100, 50, 20, 10, 5, 2, 1];

/** A config with one scenario only (the others weight 0, far away from the test grid). */
const only = (nitsMin: number, nitsMax: number, grayMin = 0, grayMax = 255): ScenarioConfig => ({
  night: { nitsMin, nitsMax, grayMin, grayMax, weight: 100 },
  indoor: { nitsMin: 400, nitsMax: 500, grayMin: 0, grayMax: 1, weight: 0 },
  outdoor: { nitsMin: 400, nitsMax: 500, grayMin: 0, grayMax: 1, weight: 0 },
});

describe('scenario reference — synthetic grids', () => {
  it('a uniform matrix gives the uniform value everywhere, full coverage', () => {
    const ref = scenarioReference(synth(GRAYS, LEVELS, () => 0.7));
    for (const s of ref.scenarios) {
      expect(s.mean).toBeCloseTo(0.7, 12);
      expect(s.coverage).toBeCloseTo(1, 12);
      expect(s.used).toBe(true);
    }
    expect(ref.composite).toBeCloseTo(0.7, 12);
    expect(ref.dropped).toEqual([]);
    expect(ref.scenarios.map((s) => s.weight)).toEqual([0.3, 0.5, 0.2].map((w) => expect.closeTo(w, 12)));
    expect(ref.scenarios.map((s) => s.effectiveWeight)).toEqual([0.3, 0.5, 0.2].map((w) => expect.closeTo(w, 12)));
  });

  it('composite = weighted average of the scenario means', () => {
    // night (≤ 20 nits) 2.0, indoor (50–250) 0.5, outdoor (≥ 400) 0.1 — each scenario's cells lie
    // entirely in one of these bands (the cell borders between 20 / 50 and 300 / 400 fall outside).
    const ds = synth(GRAYS, LEVELS, (_g, lv) => (lv <= 20 ? 2 : lv <= 300 ? 0.5 : 0.1));
    const ref = scenarioReference(ds);
    expect(usedMean(ref, 'night')).toBeCloseTo(2, 12);
    expect(usedMean(ref, 'indoor')).toBeCloseTo(0.5, 12);
    expect(usedMean(ref, 'outdoor')).toBeCloseTo(0.1, 12);
    expect(ref.composite).toBeCloseTo(0.3 * 2 + 0.5 * 0.5 + 0.2 * 0.1, 12);
  });

  it('clips partial cells to the rectangle (luminance and gray)', () => {
    // columns 1 / 10 / 100 nits: x = 0, 1, 2 -> edges 0, 0.5, 1.5, 2; rows G0 / G255 -> edges 0, 127.5, 255
    const ds = synth([255, 0], [100, 10, 1], (g, lv) => (lv === 1 ? 1 : lv === 10 ? 3 : 5) + (g === 255 ? 10 : 0));
    // x ∈ [0.25, 1.25]: 0.25 of the 1-nit cell, 0.75 of the 10-nit cell; full gray range
    const lum = scenarioOf(scenarioReference(ds, only(10 ** 0.25, 10 ** 1.25)), 'night');
    expect(lum.mean).toBeCloseTo((0.25 * 1 + 0.75 * 3 + 0.25 * 11 + 0.75 * 13) / 2, 12);
    expect(lum.coverage).toBeCloseTo(1, 12);
    // gray ∈ [100, 200] inside the 10-nit column (x ∈ [0.6, 1.4]): 27.5 of G0, 72.5 of G255
    const gray = scenarioOf(scenarioReference(ds, only(10 ** 0.6, 10 ** 1.4, 100, 200)), 'night');
    expect(gray.mean).toBeCloseTo((27.5 * 3 + 72.5 * 13) / 100, 12);
  });

  it('weights by log-luminance area: a cell spanning a decade outweighs a narrow one', () => {
    // columns 10 / 100 / 120 nits: x = 1, 2, 2.079 -> widths 0.5, 0.54, 0.04 inside [10, 120]
    const ds = synth([255, 0], [120, 100, 10], (_g, lv) => (lv === 120 ? 4 : 0));
    const s = scenarioOf(scenarioReference(ds, only(10, 120)), 'night');
    const x = [1, 2, Math.log10(120)];
    const edges = [x[0], (x[0] + x[1]) / 2, (x[1] + x[2]) / 2, x[2]];
    const narrow = edges[3] - edges[2];
    expect(s.mean).toBeCloseTo((4 * narrow) / (edges[3] - edges[0]), 12);
    expect(s.mean!).toBeLessThan(0.2); // a plain cell average would be 4 / 3
    // the decade-wide 10-nit cell alone weighs as much as the other two together (0.5 of 1.079)
    const ds2 = synth([255, 0], [120, 100, 10], (_g, lv) => (lv === 10 ? 4 : 0));
    expect(scenarioOf(scenarioReference(ds2, only(10, 120)), 'night').mean).toBeCloseTo((4 * 0.5) / (edges[3] - edges[0]), 12);
  });

  it('missing cells count nothing; the covered share is reported', () => {
    // half of the rectangle's gray range has no valid cell
    const ds = synth([255, 0], [100, 10, 1], (g) => (g === 255 ? null : 0.8));
    const s = scenarioOf(scenarioReference(ds, only(1, 100)), 'night');
    expect(s.mean).toBeCloseTo(0.8, 12);
    expect(s.coverage).toBeCloseTo(0.5, 12);
    const none = scenarioOf(scenarioReference(synth([255, 0], [100, 10, 1], () => null), only(1, 100)), 'night');
    expect(none.mean).toBeNull();
    expect(none.coverage).toBe(0);
    expect(none.used).toBe(false);
  });

  it('never extrapolates past the measured range: no outdoor data below 400 nits', () => {
    const dim = synth(GRAYS, [380, 300, 200, 100, 50, 20, 10, 5, 2, 1], () => 0.5);
    const o = scenarioOf(scenarioReference(dim), 'outdoor');
    expect(o.mean).toBeNull();
    expect(o.coverage).toBe(0);
  });

  it('a scenario without data is dropped and the others are renormalised', () => {
    const ds = synth(GRAYS, [300, 200, 100, 50, 20, 10, 5, 2, 1], (_g, lv) => (lv <= 20 ? 2 : 0.5));
    const ref = scenarioReference(ds);
    expect(ref.dropped).toEqual(['outdoor']);
    const out = scenarioOf(ref, 'outdoor');
    expect([out.used, out.effectiveWeight, out.weight]).toEqual([false, 0, expect.closeTo(0.2, 12)]);
    expect(scenarioOf(ref, 'night').effectiveWeight).toBeCloseTo(0.3 / 0.8, 12);
    expect(scenarioOf(ref, 'indoor').effectiveWeight).toBeCloseTo(0.5 / 0.8, 12);
    expect(ref.composite).toBeCloseTo((0.3 * 2 + 0.5 * 0.5) / 0.8, 12);
    // nothing usable at all -> null
    const empty = scenarioReference(synth([10, 5], [1000, 800], () => 1));
    expect(empty.composite).toBeNull();
    expect(empty.dropped).toEqual(['night', 'indoor', 'outdoor']);
  });

  it(`drops a scenario covered below ${SCENARIO_MIN_COVERAGE * 100} % (brightest column just above / below the cut)`, () => {
    expect(SCENARIO_MIN_COVERAGE).toBe(0.4);
    const upTo = (top: number) => synth(GRAYS, [top, 300, 200, 100, 50, 20, 10, 5, 2, 1], () => 0.5);
    // outdoor = 400–500 nits: a brightest column at 400 · 1.25^k covers the share k of it
    const top = (k: number) => 400 * 1.25 ** k;
    const above = scenarioOf(scenarioReference(upTo(top(SCENARIO_MIN_COVERAGE + 0.03))), 'outdoor');
    expect(above.coverage).toBeCloseTo(SCENARIO_MIN_COVERAGE + 0.03, 9);
    expect(above.used).toBe(true);
    const rBelow = scenarioReference(upTo(top(SCENARIO_MIN_COVERAGE - 0.03)));
    const below = scenarioOf(rBelow, 'outdoor');
    expect(below.coverage).toBeCloseTo(SCENARIO_MIN_COVERAGE - 0.03, 9);
    expect(below.mean).toBeCloseTo(0.5, 12); // computed, but not counted
    expect(below.used).toBe(false);
    expect(usedMean(rBelow, 'outdoor')).toBeNull();
    expect(rBelow.dropped).toEqual(['outdoor']);
    // exactly half covered still counts
    expect(scenarioOf(scenarioReference(upTo(top(0.5))), 'outdoor').used).toBe(true);
  });

  it('a weight of 0 takes a scenario out without flagging a renormalisation', () => {
    const cfg: ScenarioConfig = { ...DEFAULT_SCENARIOS, outdoor: { ...DEFAULT_SCENARIOS.outdoor, weight: 0 } };
    const ref = scenarioReference(synth(GRAYS, [300, 200, 100, 50, 20, 10, 5, 2, 1], (_g, lv) => (lv <= 20 ? 2 : 0.5)), cfg);
    expect(ref.dropped).toEqual([]);
    expect(ref.composite).toBeCloseTo((0.3 * 2 + 0.5 * 0.5) / 0.8, 12);
  });
});

describe('grades', () => {
  it('boundaries: 0.4 / 1.0 / 3.0 belong to the upper grade', () => {
    expect(scenarioGrade(0)).toBe('imperceptible');
    expect(scenarioGrade(0.3999)).toBe('imperceptible');
    expect(scenarioGrade(0.4)).toBe('slight');
    expect(scenarioGrade(0.9999)).toBe('slight');
    expect(scenarioGrade(1)).toBe('visible');
    expect(scenarioGrade(2.9999)).toBe('visible');
    expect(scenarioGrade(3)).toBe('strong');
    expect(scenarioGrade(12)).toBe('strong');
  });
});

describe('independence from the view', () => {
  const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/datasets', f), 'utf8')) as Dataset;
  it('the same reference under every clip / cap (and equal to scenarioReference)', () => {
    const shown = processRecord(rawDataset(validateDataset(load('iPhone17ProMax.json'))), { denoise: true }).record;
    const a = computeRecordStats(shown, { clipLowGray: true, maxNits: 500, sliceGray: 127 });
    const b = computeRecordStats(shown, { clipLowGray: false, maxNits: null, sliceGray: 30 });
    const c = computeRecordStats(shown, { clipLowGray: true, maxNits: 100, sliceGray: 127 });
    expect(a.scenario).toEqual(b.scenario);
    expect(a.scenario).toEqual(c.scenario);
    expect(a.scenario).toBe(scenarioReference(shown));
    expect(a.scenario.composite).not.toBeNull();
    // a different configuration is a different cache entry
    const cfg: ScenarioConfig = { ...DEFAULT_SCENARIOS, night: { ...DEFAULT_SCENARIOS.night, weight: 60 } };
    const d = computeRecordStats(shown, { clipLowGray: true, maxNits: 500, sliceGray: 127, scenarios: cfg });
    expect(d.scenario.composite).not.toBe(a.scenario.composite);
    expect(d.scenario).toBe(scenarioReference(shown, cfg));
  });
});

describe('bundled records', () => {
  const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/datasets', f), 'utf8')) as Dataset;
  it('Xiaomi 18 Pro Max (Pro off): a half-covered night still counts (why the cut is 40 %, not 50 %)', () => {
    const shown = processRecord(rawDataset(validateDataset(load('xiaomi18promax_adaptive_pro_off.json'))), { denoise: true }).record;
    const ref = scenarioReference(shown);
    const night = scenarioOf(ref, 'night');
    expect(night.coverage).toBeGreaterThan(SCENARIO_MIN_COVERAGE);
    expect(night.coverage).toBeLessThan(0.5); // the denoise shows its black-level readings as no data
    expect(night.used).toBe(true);
    expect(ref.dropped).toEqual([]);
    expect(scenarioGrade(ref.composite!)).toBe('visible');
  });
});

describe('configuration', () => {
  it('sanitizes saved scenarios one by one, falling back to the defaults', () => {
    expect(sanitizeScenarios(undefined)).toEqual(DEFAULT_SCENARIOS);
    expect(sanitizeScenarios([1, 2])).toEqual(DEFAULT_SCENARIOS);
    const good = { nitsMin: 1, nitsMax: 30, grayMin: 10, grayMax: 90, weight: 40 };
    const out = sanitizeScenarios({
      night: { ...good, extra: 'x' },
      indoor: { ...DEFAULT_SCENARIOS.indoor, nitsMin: 300, nitsMax: 100 }, // min > max
      outdoor: { ...DEFAULT_SCENARIOS.outdoor, nitsMax: 800 }, // above the 500-nit cap
    });
    expect(out).toEqual({ night: good, indoor: DEFAULT_SCENARIOS.indoor, outdoor: DEFAULT_SCENARIOS.outdoor });
    const bad = [
      { ...good, nitsMin: 0 },
      { ...good, nitsMin: -1 },
      { ...good, grayMin: -5 },
      { ...good, grayMax: 300 },
      { ...good, grayMin: 90, grayMax: 90 },
      { ...good, weight: -1 },
      { ...good, weight: 101 },
      { ...good, weight: 'a' },
      { ...good, nitsMax: NaN },
      null,
      'night',
    ];
    for (const b of bad) expect(sanitizeScenarios({ night: b }).night).toEqual(DEFAULT_SCENARIOS.night);
  });

  it('all-zero weights fall back to the default weights', () => {
    const zero = sanitizeScenarios({
      night: { ...DEFAULT_SCENARIOS.night, weight: 0 },
      indoor: { ...DEFAULT_SCENARIOS.indoor, weight: 0, grayMax: 200 },
      outdoor: { ...DEFAULT_SCENARIOS.outdoor, weight: 0 },
    });
    expect(zero.night.weight).toBe(30);
    expect(zero.indoor).toEqual({ ...DEFAULT_SCENARIOS.indoor, grayMax: 200 });
    expect(validScenarios(zero)).toBe(true);
    expect(validScenarios({ ...zero, night: { ...zero.night, weight: 0 }, indoor: { ...zero.indoor, weight: 0 }, outdoor: { ...zero.outdoor, weight: 0 } })).toBe(false);
  });

  it('keys, defaults and weight shares', () => {
    expect(isDefaultScenarios(sanitizeScenarios({}))).toBe(true);
    expect(scenarioKey(DEFAULT_SCENARIOS)).toBe('2,20,15,100,30|50,250,15,255,50|400,500,128,255,20');
    const w = weightShares({ ...DEFAULT_SCENARIOS, indoor: { ...DEFAULT_SCENARIOS.indoor, weight: 0 } });
    expect(w).toEqual({ night: 0.6, indoor: 0, outdoor: 0.4 });
  });
});
