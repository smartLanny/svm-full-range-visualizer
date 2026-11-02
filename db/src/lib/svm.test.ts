import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../catalog/types';
import type { ManifestEntry } from '../../../src/data/bundled';
import { capFor, recordFromJson, svmChipLabel, svmView } from './svm';

const ROOT = path.resolve(__dirname, '../../..');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const catalog = read<Catalog>('data/devices.json');
const manifest = read<ManifestEntry[]>('public/datasets/manifest.json');
const record = (file: string) => recordFromJson(manifest.find((m) => m.file === file)!, read(`public/datasets/${file}`));
const entry = (file: string) => catalog.devices.flatMap((d) => d.svm).find((s) => s.record === file)!;

describe('flicker records on the database page', () => {
  it('reproduces the workbench reference for iPhone 18 Pro Max 标准 (scenario composite 1.64)', () => {
    const v = svmView(entry('iPhone18ProMax.json'), record('iPhone18ProMax.json'));
    expect(v.cap).toMatchObject({ maxNits: 500, widened: false });
    expect(v.stats.scenario.composite).not.toBeNull();
    expect(v.stats.scenario.composite!.toFixed(2)).toBe('1.64');
  });

  it('keeps the 500 nits cap for every record that has a level under it', () => {
    for (const m of manifest) {
      if (m.file === 'huawei_mate90promax.json') continue;
      expect(capFor(record(m.file)), m.file).toMatchObject({ maxNits: 500, widened: false });
    }
  });

  it('widens the cap for Mate 90 (591–923 nits only) instead of showing nothing', () => {
    const v = svmView(entry('huawei_mate90promax.json'), record('huawei_mate90promax.json'));
    expect(v.cap.widened).toBe(true);
    expect(v.cap.maxNits).toBe(1000);
    expect(v.cap.range![0]).toBeGreaterThan(500);
    expect(v.stats.cellCount).toBeGreaterThan(0);
  });

  it('prefixes the screen only on dual-screen devices', () => {
    expect(svmChipLabel(entry('iPhoneDuo_outer_smooth_120hz.json'), true)).toBe('外屏 · 脉冲平滑 120Hz');
    expect(svmChipLabel(entry('iPhone18ProMax_smooth.json'), false)).toBe('平滑脉冲');
  });
});
