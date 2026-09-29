import { describe, expect, it } from 'vitest';
import type { SvmRecord } from '../types';
import type { RecordStats } from '../data/stats';
import { bestValues, defaultDir, isBest, sortRows, toTsv, type StatsRow } from './model';
import { translate } from '../i18n';

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
  coverage: { grayMin: 15, grayMax: 255, levelMin: 2, levelMax: 500 },
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
