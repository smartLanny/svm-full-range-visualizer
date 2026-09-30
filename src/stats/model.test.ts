import { describe, expect, it } from 'vitest';
import type { SvmRecord } from '../types';
import type { RecordStats } from '../data/stats';
import type { ScenarioReference } from '../data/scenarios';
import { bestValues, defaultDir, isBest, markOf, median, metricByKey, rankRows, sortRows, toTsv, type StatsRow } from './model';
import { translate } from '../i18n';

/** Scenario reference fixture: means per scenario (null = no data -> dropped, weights renormalised). */
const scen = (night: number | null, indoor: number | null, outdoor: number | null): ScenarioReference => {
  const w = { night: 0.3, indoor: 0.5, outdoor: 0.2 };
  const means = { night, indoor, outdoor };
  const ids = ['night', 'indoor', 'outdoor'] as const;
  const wsum = ids.reduce((a, id) => a + (means[id] === null ? 0 : w[id]), 0);
  const scenarios = ids.map((id) => ({
    id,
    mean: means[id],
    coverage: means[id] === null ? 0 : 1,
    used: means[id] !== null,
    weight: w[id],
    effectiveWeight: means[id] === null || !wsum ? 0 : w[id] / wsum,
  }));
  return {
    composite: wsum ? scenarios.reduce((a, x) => a + (x.mean ?? 0) * x.effectiveWeight, 0) : null,
    scenarios,
    dropped: ids.filter((id) => means[id] === null),
  };
};

const stats = (p: Partial<RecordStats>): RecordStats => ({
  cellCount: 10,
  safeShare: 0.5,
  midShare: 0.3,
  criticalShare: 0.2,
  meanSvm: 0.8,
  peak: { svm: 2, gray: 15, levelNits: 2, nits: 0.1 },
  fullWhiteSafeNits: 10,
  fullWhiteAllSafe: false,
  fullWhiteGray: 255,
  svmAt: [2, 10, 50, 100].map((nits) => ({ nits, svm: 0.5 })),
  sliceGray: 127,
  nominalCount: 10,
  coverageShare: 1,
  denoise: { interpolated: 0, noData: 0, lumEstimated: 0 },
  validExtent: { grayMin: 15, grayMax: 255, levelMin: 2, levelMax: 500 },
  scenario: scen(1, 0.5, 0.2),
  ...p,
});
const rec = (id: string, device: string, mode = '') => ({ id, device, mode }) as unknown as SvmRecord;
const rows: StatsRow[] = [
  { rec: rec('a', 'B phone', 'x'), order: 0, stats: stats({ safeShare: 0.4, fullWhiteSafeNits: null }) },
  { rec: rec('b', 'A phone', 'y\tz'), order: 1, stats: stats({ safeShare: 0.7, fullWhiteSafeNits: 30 }) },
  { rec: rec('c', 'C phone'), order: 2, stats: stats({ safeShare: null, fullWhiteSafeNits: 5 }) },
];

describe('sortRows', () => {
  it('keeps nulls last in both directions', () => {
    expect(sortRows(rows, 'safe', 'desc', 'zh').map((r) => r.rec.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'safe', 'asc', 'zh').map((r) => r.rec.id)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 'fullWhite', 'asc', 'zh').map((r) => r.rec.id)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, 'fullWhite', 'desc', 'zh').map((r) => r.rec.id)).toEqual(['b', 'c', 'a']);
  });
  it('by name and by record order', () => {
    expect(sortRows(rows, 'name', 'asc', 'en').map((r) => r.rec.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'order', 'desc', 'en').map((r) => r.rec.id)).toEqual(['c', 'b', 'a']);
  });
  it('default direction puts the best first', () => {
    expect(defaultDir('safe')).toBe('desc');
    expect(defaultDir('critical')).toBe('asc');
    expect(defaultDir('name')).toBe('asc');
  });
});

describe('bestValues', () => {
  it('picks the best per ranked column and skips all-equal columns', () => {
    const b = bestValues(rows);
    expect(b.safe).toBe(0.7);
    expect(b.fullWhite).toBe(5);
    expect(b.mean).toBeUndefined(); // all equal
    expect(b.mid).toBeUndefined(); // neutral column
    expect(isBest(b, 'safe', 0.7)).toBe(true);
    expect(isBest(b, 'safe', 0.4)).toBe(false);
    expect(isBest(b, 'safe', null)).toBe(false);
  });
  it('values equal at display resolution tie', () => {
    const r2: StatsRow[] = [
      { rec: rec('a', 'a'), order: 0, stats: stats({ meanSvm: 0.1101 }) },
      { rec: rec('b', 'b'), order: 1, stats: stats({ meanSvm: 0.1098 }) },
      { rec: rec('c', 'c'), order: 2, stats: stats({ meanSvm: 0.5 }) },
    ];
    const b = bestValues(r2);
    expect(isBest(b, 'mean', 0.1101)).toBe(true);
    expect(isBest(b, 'mean', 0.1098)).toBe(true);
    expect(isBest(b, 'mean', 0.5)).toBe(false);
  });
});

describe('rankRows / markOf (coverage caveat)', () => {
  const mk = (id: string, coverageShare: number | null, p: Partial<RecordStats> = {}): StatsRow => ({
    rec: rec(id, id),
    order: 0,
    stats: stats({ coverageShare, ...p }),
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('rows below 90 % of the median coverage never win best; the best goes to the comparable rows', () => {
    const r = [
      mk('full1', 1, { criticalShare: 0.45, safeShare: 0.3 }),
      mk('full2', 1, { criticalShare: 0.5, safeShare: 0.2 }),
      mk('full3', 0.99, { criticalShare: 0.6, safeShare: 0.25 }),
      mk('low', 0.854, { criticalShare: 0.36, safeShare: 0.26 }),
    ];
    const rank = rankRows(r);
    expect([...rank.low]).toEqual(['low']);
    expect(rank.medianCoverage).toBeCloseTo(0.995, 9);
    expect(rank.best.critical).toBe(0.45);
    expect(markOf(rank, 'critical', r[0], 0.45)).toBe('best');
    expect(markOf(rank, 'critical', r[3], 0.36)).toBe('caveat'); // would beat the best
    expect(markOf(rank, 'safe', r[3], 0.26)).toBeNull(); // not better than the best (0.3)
    expect(markOf(rank, 'safe', r[0], 0.3)).toBe('best');
    expect(markOf(rank, 'safe', r[3], null)).toBeNull();
  });
  it('exactly 90 % of the median is still comparable; null coverage is ignored', () => {
    const r = [mk('a', 1), mk('b', 1), mk('c', 0.9), mk('d', null)];
    expect(rankRows(r).low.size).toBe(0);
  });
});

describe('toTsv', () => {
  it('one header + one line per row, tabs in names cleaned, missing = empty', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
    const tsv = toTsv(rows, t, 'en').split('\n');
    expect(tsv.length).toBe(4);
    const cols = tsv[0].split('\t').length;
    tsv.forEach((l) => expect(l.split('\t').length).toBe(cols));
    expect(tsv[0].startsWith('Device\tMode\tSafe share (%)')).toBe(true);
    expect(tsv[2].split('\t')[1]).toBe('y z');
    expect(tsv[1].split('\t')[2]).toBe('40.0');
    expect(tsv[1].split('\t')[5]).toBe(''); // fullWhite null
  });
});

describe('scenario reference columns (docs/adr/0009 addendum)', () => {
  const mk = (id: string, order: number, scenario: ScenarioReference, p: Partial<RecordStats> = {}): StatsRow => ({ rec: rec(id, id), order, stats: stats({ scenario, ...p }) });
  const r = [
    mk('a', 0, scen(1.2, 0.6, 0.3)), // 0.36 + 0.3 + 0.06 = 0.72
    mk('b', 1, scen(0.5, 0.2, 0.1)), // 0.15 + 0.1 + 0.02 = 0.27
    mk('c', 2, scen(0.3, 0.1, null)), // renormalised: (0.09 + 0.05) / 0.8 = 0.175
    mk('d', 3, scen(null, null, null)), // no composite
  ];

  it('sorts by the composite, lower first by default, missing last', () => {
    expect(defaultDir('scenario')).toBe('asc');
    expect(defaultDir('scOutdoor')).toBe('asc');
    expect(metricByKey('scenario').better).toBe('lower');
    expect(sortRows(r, 'scenario', 'asc', 'zh').map((x) => x.rec.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(sortRows(r, 'scenario', 'desc', 'zh').map((x) => x.rec.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRows(r, 'scOutdoor', 'asc', 'zh').map((x) => x.rec.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('a renormalised composite is not ranked (caveat instead of best); per-scenario columns are', () => {
    const rank = rankRows(r);
    expect(rank.best.scenario).toBeCloseTo(0.27, 9);
    expect(markOf(rank, 'scenario', r[1], r[1].stats.scenario.composite)).toBe('best');
    expect(markOf(rank, 'scenario', r[2], r[2].stats.scenario.composite)).toBe('caveat');
    expect(rank.best.scNight).toBe(0.3);
    expect(markOf(rank, 'scNight', r[2], 0.3)).toBe('best');
  });

  it('the scope coverage rule does not apply to the scenario columns', () => {
    const low = [mk('a', 0, scen(1.2, 0.6, 0.3)), mk('b', 1, scen(1, 1, 1)), mk('c', 2, scen(0.1, 0.1, 0.1), { coverageShare: 0.5 })];
    const rank = rankRows(low);
    expect([...rank.low]).toEqual(['c']);
    expect(markOf(rank, 'scenario', low[2], low[2].stats.scenario.composite)).toBe('best');
  });

  it('TSV: composite + the three scenario means as the last columns (missing = empty)', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
    const tsv = toTsv(r, t, 'zh').split('\n');
    const head = tsv[0].split('\t');
    expect(head.slice(-4)).toEqual(['场景加权 SVM（参考）', '夜间 SVM（参考）', '室内 SVM（参考）', '户外 SVM（参考）']);
    expect(tsv[1].split('\t').slice(-4)).toEqual(['0.720', '1.200', '0.600', '0.300']);
    expect(tsv[3].split('\t').slice(-4)).toEqual(['0.175', '0.300', '0.100', '']);
    expect(tsv[4].split('\t').slice(-4)).toEqual(['', '', '', '']);
    tsv.forEach((l) => expect(l.split('\t').length).toBe(head.length));
    const en = toTsv(r, (k, v) => translate('en', k, v), 'en').split('\n')[0].split('\t');
    expect(en.slice(-4)).toEqual(['Scenario SVM (ref.)', 'Night SVM (ref.)', 'Indoor SVM (ref.)', 'Outdoor SVM (ref.)']);
  });
});
