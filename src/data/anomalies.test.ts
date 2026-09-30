import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, DataPoint } from '../types';
import { detectAnomalies, excludeAnomalies, medianPolish, noiseFloor, restoreExcluded } from './anomalies';
import { gridView } from './grid';

// The first Xiaomi 18 Pro Max session (superseded by a re-test) lives on in test-fixtures/ as
// real-world defects: xiaomi18promax_v1_off/on.json (with the exclusions stored at the time).
const fixtures = path.resolve(__dirname, '../../test-fixtures');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')) as Dataset;

/** Synthetic separable panel: nits = level * (gray/255)^2.2, svm = 1 / sqrt(nits). */
function panel(grays: number[], levels: number[], tweak?: (g: number, lv: number, p: DataPoint) => DataPoint | null): Dataset {
  const grid = grays.map((g) =>
    levels.map((lv, c) => {
      const nits = lv * Math.pow(g / 255, 2.2);
      const p: DataPoint = { gray: g, brightnessPercent: 100 - c * 10, nits, svm: 1 / Math.sqrt(Math.max(nits, 0.01)) };
      return tweak ? tweak(g, lv, p) : p;
    }),
  );
  const data = grid.flat().filter((p): p is DataPoint => !!p);
  return { id: 's', name: 's', data, matrix: { rows: grays, cols: levels.map((_, c) => 100 - c * 10), headerNits: levels, grid } };
}
const GRAYS = [255, 224, 192, 160, 128, 96, 64, 48, 32, 24, 16, 2, 1];
const LEVELS = [500, 400, 300, 200, 120, 80, 50, 30, 20, 10];

describe('noiseFloor', () => {
  it('uses mean + 3σ of the gray ≤ 2 rows, never below 0', () => {
    const ds = panel(GRAYS, LEVELS, (g, _lv, p) => (g <= 2 ? { ...p, nits: g === 1 ? -0.1 : 0.1 } : p));
    const nf = noiseFloor(ds);
    expect(nf.mean).toBeCloseTo(0, 9);
    expect(nf.sd).toBeCloseTo(0.1, 9);
    expect(nf.ceiling).toBeCloseTo(0.3, 9);
    expect(noiseFloor(panel([255, 128], [100, 50, 10])).ceiling).toBe(0);
  });
});

describe('detectAnomalies (synthetic)', () => {
  it('a clean separable panel has only the black rows below noise', () => {
    const a = detectAnomalies(panel(GRAYS, LEVELS));
    expect(a.every((x) => x.kind === 'belowNoise')).toBe(true);
    expect(a.every((x) => x.point.gray <= 16 || x.point.nits <= 0.3)).toBe(true);
  });
  it('flags a stale reading copied from the row above, not its neighbours', () => {
    const ds = panel(GRAYS, LEVELS);
    const r = GRAYS.indexOf(128);
    ds.matrix.grid[r][2] = { ...ds.matrix.grid[r][2]!, nits: ds.matrix.grid[r - 1][2]!.nits * 1.005 };
    const a = detectAnomalies(ds).filter((x) => x.kind === 'nitsShift');
    expect(a.map((x) => [x.point.gray, x.c])).toEqual([[128, 2]]);
  });
  it('flags the dimmer of two identical adjacent columns', () => {
    const ds = panel(GRAYS, LEVELS);
    for (const row of ds.matrix.grid) row[5] = row[4] ? { ...row[4], brightnessPercent: 50 } : null;
    const a = detectAnomalies(ds).filter((x) => x.kind === 'duplicateColumn');
    expect(new Set(a.map((x) => x.c))).toEqual(new Set([5]));
  });
  it('flags an isolated SVM spike', () => {
    const ds = panel(GRAYS, LEVELS);
    const r = GRAYS.indexOf(96);
    ds.matrix.grid[r][6] = { ...ds.matrix.grid[r][6]!, svm: ds.matrix.grid[r][6]!.svm * 6 };
    const a = detectAnomalies(ds).filter((x) => x.kind === 'svmSpike');
    expect(a.map((x) => [x.point.gray, x.c])).toEqual([[96, 6]]);
  });
});

describe('exclude / restore', () => {
  it('round-trips and records reasons', () => {
    const ds = panel(GRAYS, LEVELS);
    const a = detectAnomalies(ds);
    const clean = excludeAnomalies(ds, a);
    expect(clean.excluded!.length).toBe(a.length);
    expect(clean.data.length).toBe(ds.data.length - a.length);
    expect(clean.excluded!.every((x) => x.reason && x.detail)).toBe(true);
    expect(restoreExcluded(clean).matrix.grid).toEqual(ds.matrix.grid);
  });
  it('medianPolish leaves ~0 residuals on an additive table', () => {
    const t = [0, 1, 2].map((r) => [0, 10, 20].map((c) => r + c));
    medianPolish(t).flat().forEach((x) => expect(Math.abs(x!)).toBeLessThan(1e-9));
  });
});

describe('first Xiaomi 18 Pro Max session (test fixtures, cleaned at the time)', () => {
  for (const f of ['xiaomi18promax_v1_off.json', 'xiaomi18promax_v1_on.json']) {
    const clean = load(f);
    const raw = restoreExcluded(clean);
    it(`${f}: excluded set is exactly what the rules detect on the raw data`, () => {
      const a = detectAnomalies(raw);
      expect(clean.excluded!.length).toBe(a.length);
      const key = (p: DataPoint) => `${p.gray}|${p.brightnessPercent}`;
      expect(new Set(clean.excluded!.map(key))).toEqual(new Set(a.map((x) => key(x.point))));
      expect(detectAnomalies(clean).length).toBe(0);
    });
    it(`${f}: nothing left below the noise floor or ≤ 0 nits`, () => {
      const ceil = noiseFloor(raw).ceiling;
      expect(clean.data.every((p) => p.nits > ceil)).toBe(true);
      expect(gridView(clean, { clipLowGray: true }).grays.length).toBeGreaterThan(10);
    });
  }
  it('the eight stale readings of the "off" record are the known copy errors', () => {
    const off = load('xiaomi18promax_v1_off.json');
    const stale = off.excluded!.filter((x) => x.reason === 'nitsShift').map((x) => `G${x.gray}@${x.brightnessPercent}`);
    expect(stale.sort()).toEqual(['G139@90', 'G192@100', 'G27@100', 'G27@90', 'G51@100', 'G51@90', 'G83@100', 'G96@90'].sort());
  });
});
