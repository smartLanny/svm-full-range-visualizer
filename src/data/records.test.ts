import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../types';
import { parseRawData } from './parse';
import { EXAMPLE_TSV } from './exampleTsv';
import { deviceLabel, guessDeviceMode, modeLabel, recordLabel, toDatasetJson, toRecord, validateDataset } from './records';
import { DEVICE_PALETTE, MODE_DASHES, recordStyles } from './colors';
import { gridView } from './grid';

const dir = path.resolve(__dirname, '../../public/datasets');
const raw = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;

describe('parseRawData(EXAMPLE_TSV)', () => {
  const ds = parseRawData(EXAMPLE_TSV, '  示例 标准  ');
  it('finds the header row and every gray row', () => {
    expect(ds.matrix.cols).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 27, 25, 22, 20, 16, 13, 10, 6, 4, 0]);
    expect(ds.matrix.rows.length).toBe(24);
    expect(ds.matrix.rows[0]).toBe(255);
    expect(ds.matrix.rows[23]).toBe(1);
    ds.matrix.grid.forEach((row) => expect(row.length).toBe(18));
    expect(ds.data.length).toBe(24 * 18);
    expect(ds.name).toBe('示例 标准');
  });
  it('reads dual-column nits / svm pairs', () => {
    expect(ds.matrix.grid[0][0]).toEqual({ gray: 255, brightnessPercent: 100, nits: 804.15, svm: 0.052 });
    expect(ds.matrix.grid[23][17]).toEqual({ gray: 1, brightnessPercent: 0, nits: 0, svm: 0.33 });
  });
  it('headerNits = G255 row nits', () => {
    expect(ds.matrix.headerNits[0]).toBe(804.15);
    expect(ds.matrix.headerNits[17]).toBe(1.72);
    expect(ds.matrix.headerNits).toEqual(ds.matrix.grid[0].map((p) => p!.nits));
  });
  it('applies the correction factor to every nits value (svm untouched)', () => {
    const k = parseRawData(EXAMPLE_TSV, 'x', 1.1);
    expect(k.matrix.headerNits[0]).toBeCloseTo(804.15 * 1.1, 9);
    expect(k.matrix.grid[5][3]!.nits).toBeCloseTo(ds.matrix.grid[5][3]!.nits * 1.1, 9);
    expect(k.matrix.grid[5][3]!.svm).toBe(ds.matrix.grid[5][3]!.svm);
  });
  it('compact "nits svm" cells, missing cells -> null (never 0), CRLF', () => {
    const t = 'x\t100%\t50%\t10%\r\n255\t500 0.1\t200 0.2\t20 0.9\r\n128\t100 0.3\t\t4 1.5\r\n';
    const d = parseRawData(t, 'c');
    expect(d.matrix.cols).toEqual([100, 50, 10]);
    expect(d.matrix.grid[0][2]).toEqual({ gray: 255, brightnessPercent: 10, nits: 20, svm: 0.9 });
    expect(d.matrix.grid[1][0]).toEqual({ gray: 128, brightnessPercent: 100, nits: 100, svm: 0.3 });
    expect(d.matrix.grid[1][1]).toBeNull();
    expect(d.matrix.grid[1][2]).toEqual({ gray: 128, brightnessPercent: 10, nits: 4, svm: 1.5 });
    expect(d.data.every((p) => p !== null)).toBe(true);
  });
  it('a missing dual-column pair stays in its column (empty cells do not shift data left)', () => {
    const t = ['亮度\t100\t\t50\t\t10\t', '255\t500\t0.1\t200\t0.2\t20\t0.9', '128\t100\t0.3\t\t\t4\t1.5'].join('\n');
    const d = parseRawData(t, 'gap');
    expect(d.matrix.cols).toEqual([100, 50, 10]);
    expect(d.matrix.grid[1][0]).toEqual({ gray: 128, brightnessPercent: 100, nits: 100, svm: 0.3 });
    expect(d.matrix.grid[1][1]).toBeNull();
    expect(d.matrix.grid[1][2]).toEqual({ gray: 128, brightnessPercent: 10, nits: 4, svm: 1.5 });
  });
  it('a dual-column row with missing trailing pairs keeps its leading values', () => {
    const t = ['亮度\t100\t\t50\t\t10\t', '255\t500\t0.1\t200\t0.2\t20\t0.9', '128\t100\t0.3\t\t\t\t'].join('\n');
    const d = parseRawData(t, 'tail');
    expect(d.matrix.grid[1]).toEqual([{ gray: 128, brightnessPercent: 100, nits: 100, svm: 0.3 }, null, null]);
  });
  it('rejects garbage', () => {
    expect(() => parseRawData('hello', 'x')).toThrow('TOO_FEW_LINES');
    expect(() => parseRawData('a\tb\nc\td', 'x')).toThrow('NO_HEADER');
    expect(() => parseRawData('1\t2\t3\nfoo\tbar', 'x')).toThrow('NO_ROWS');
  });
});

describe('validateDataset', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  it.each(files)('accepts v1 file %s', (f) => {
    const ds = validateDataset(raw(f));
    expect(ds.matrix.grid.length).toBe(ds.matrix.rows.length);
    expect(ds.matrix.headerNits.length).toBe(ds.matrix.cols.length);
    expect(ds.data.length).toBe(ds.matrix.grid.flat().filter(Boolean).length);
    expect(ds.name.length).toBeGreaterThan(0);
  });
  it('rebuilds missing headerNits from the max-gray row', () => {
    const j = raw('iPhone17ProMax.json') as { matrix: { headerNits?: number[] } };
    const expected = (j.matrix.headerNits ?? []).slice();
    delete j.matrix.headerNits;
    const ds = validateDataset(j);
    const top = ds.matrix.rows.indexOf(Math.max(...ds.matrix.rows));
    expect(ds.matrix.headerNits).toEqual(ds.matrix.grid[top].map((p) => p?.nits ?? 0));
    expect(ds.matrix.headerNits.length).toBe(expected.length);
  });
  it('names untitled datasets', () => {
    expect(validateDataset({ name: '  ', matrix: { rows: [255], cols: [100], headerNits: [1], grid: [[null]] } }).name).toBe('Untitled');
  });
  it('rejects malformed input', () => {
    expect(() => validateDataset(null)).toThrow('INVALID_JSON');
    expect(() => validateDataset('str')).toThrow('INVALID_JSON');
    expect(() => validateDataset({})).toThrow('INVALID_MATRIX');
    expect(() => validateDataset({ matrix: { rows: [1], cols: [1] } })).toThrow('INVALID_MATRIX');
    expect(() => validateDataset({ matrix: { rows: [1, 2], cols: [1], grid: [[null]] } })).toThrow('INVALID_MATRIX');
    expect(() => validateDataset({ matrix: { rows: [1], cols: [1, 2], grid: [[null]] } })).toThrow('INVALID_MATRIX');
    expect(() => validateDataset({ matrix: { rows: [1], cols: [1], grid: ['x'] } })).toThrow('INVALID_MATRIX');
  });
});

describe('guessDeviceMode / labels', () => {
  it('splits at the first whitespace', () => {
    expect(guessDeviceMode('华为Mate70Air 60Hz')).toEqual({ device: '华为Mate70Air', mode: '60Hz' });
    expect(guessDeviceMode('  小米17Ultra徕卡   DC  120Hz ')).toEqual({ device: '小米17Ultra徕卡', mode: 'DC 120Hz' });
    expect(guessDeviceMode('iPhone17ProMax')).toEqual({ device: 'iPhone17ProMax', mode: '' });
    expect(guessDeviceMode('')).toEqual({ device: '', mode: '' });
  });
  it('labels use English aliases only in en', () => {
    const r = { device: '华为 Mate 70 Air', deviceEn: 'Huawei Mate 70 Air', mode: '低频闪', modeEn: 'Low-flicker' };
    expect(recordLabel(r, 'zh')).toBe('华为 Mate 70 Air · 低频闪');
    expect(recordLabel(r, 'en')).toBe('Huawei Mate 70 Air · Low-flicker');
    expect(deviceLabel({ device: 'X' }, 'en')).toBe('X');
    expect(modeLabel({ mode: '' }, 'en')).toBe('');
    expect(recordLabel({ device: 'X', mode: '' }, 'zh')).toBe('X');
  });
  it('toRecord / toDatasetJson round trip', () => {
    const ds = validateDataset(raw('huawei_mate70air_60hz.json'));
    const rec = toRecord(ds, 'user');
    expect(rec.device).toBe('华为Mate70Air');
    expect(rec.mode).toBe('60Hz');
    const json = toDatasetJson({ ...rec, deviceEn: 'H' });
    expect('source' in json).toBe(false);
    expect('deviceEn' in json).toBe(false);
    expect(json.device).toBe('华为Mate70Air');
    expect(gridView(json).grays.length).toBe(24);
  });
});

describe('recordStyles', () => {
  const mk = (id: string, device: string, mode: string) => ({ id, device, mode }) as unknown as SvmRecord;
  const all = [mk('a1', 'A', 's'), mk('a2', 'A', '60'), mk('b1', 'B', 's'), mk('a3', 'A', 'lf'), mk('c1', 'C', 's')];
  it('device colour by first appearance, dash by mode index within device', () => {
    const s = recordStyles(all);
    expect(s.get('a1')!.color).toBe(DEVICE_PALETTE[0]);
    expect(s.get('a3')!.color).toBe(DEVICE_PALETTE[0]);
    expect(s.get('b1')!.color).toBe(DEVICE_PALETTE[1]);
    expect(s.get('c1')!.color).toBe(DEVICE_PALETTE[2]);
    expect(s.get('a1')!.dash).toEqual(MODE_DASHES[0]);
    expect(s.get('a2')!.dash).toEqual(MODE_DASHES[1]);
    expect(s.get('a3')!.dash).toEqual(MODE_DASHES[2]);
    expect(s.get('b1')!.modeIndex).toBe(0);
  });
  it('colours are stable when records are hidden (styles are computed over ALL records)', () => {
    const s = recordStyles(all);
    const hidden = new Set(['a1', 'a2', 'a3']);
    const visible = all.filter((r) => !hidden.has(r.id));
    visible.forEach((r) => expect(s.get(r.id)).toEqual(recordStyles(all).get(r.id)));
    expect(s.get('b1')!.color).not.toBe(DEVICE_PALETTE[0]);
  });
  it('overrides win and palette wraps', () => {
    expect(recordStyles(all, { B: '#123456' }).get('b1')!.color).toBe('#123456');
    const many = Array.from({ length: DEVICE_PALETTE.length + 1 }, (_, i) => mk(`r${i}`, `D${i}`, ''));
    expect(recordStyles(many).get(`r${DEVICE_PALETTE.length}`)!.color).toBe(DEVICE_PALETTE[0]);
  });
});
