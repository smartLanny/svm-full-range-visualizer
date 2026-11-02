import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../catalog/types';
import type { ReflectanceIndex } from './types';
import { axisMax, meanOf, reflectanceViews, snapIndex, valueAt } from './reflectance';

const ROOT = path.resolve(__dirname, '../../..');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const catalog = read<Catalog>('data/devices.json');
const index = read<ReflectanceIndex>('data/reflectance/index.json');

describe('reflectance read-out', () => {
  it('joins every catalog condition with its curves (24 devices, 32 samples)', () => {
    const all = catalog.devices.flatMap((d) => reflectanceViews(d, index));
    expect(all).toHaveLength(32);
    for (const v of all) {
      expect(v.cond.curves.total?.samples).toHaveLength(31);
      expect(v.cond.curves.diffuse?.samples).toHaveLength(31);
    }
  });

  it('snaps the hover to the nearest measured 10 nm point', () => {
    const nm = Array.from({ length: 31 }, (_, i) => 400 + i * 10);
    expect(nm[snapIndex(nm, 397)]).toBe(400);
    expect(nm[snapIndex(nm, 554.9)]).toBe(550);
    expect(nm[snapIndex(nm, 555.1)]).toBe(560);
    expect(nm[snapIndex(nm, 720)]).toBe(700);
    expect(snapIndex([], 500)).toBe(-1);
  });

  it('reads measured points only and averages them', () => {
    const v = reflectanceViews(catalog.devices.find((d) => d.id === 'xiaomi-18-pro-max')!, index)[0];
    expect(valueAt(v.cond.curves.total!.samples, 400)).toBeCloseTo(4.7136, 4);
    expect(valueAt(v.cond.curves.total!.samples, 405)).toBeNull();
    expect(meanOf(v.cond.curves.total!.samples)!).toBeCloseTo(4.84, 2);
  });

  it('rounds the axis up to a whole percent', () => {
    expect(axisMax(5.2)).toBe(6);
    expect(axisMax(1.6)).toBe(2);
    expect(axisMax(0)).toBe(1);
  });
});
