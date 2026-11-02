import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Catalog } from '../../catalog/types';
import type { UniformityIndex } from './types';
import { rankUniformity } from './ranking';

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const catalog = read<Catalog>('data/devices.json');
const index = read<UniformityIndex>('data/uniformity/index.json');

describe('uniformity leaderboard', () => {
  it('ranks measured devices best first and lists the rest as missing', () => {
    const r = rankUniformity(catalog.devices, index, '300', 'area');
    expect(r.rows).toHaveLength(13); // Find X9 has no 300 nits white field
    expect(r.rows[0].device.id).toBe('iphone-18-pro-max');
    expect(r.rows[1].device.id).toBe('huawei-mate-90-pro-max');
    expect(r.missing.map((d) => d.id)).toContain('oppo-find-x9');
    expect(r.rows.at(-1)!.device.id).toBe('xiaomi-18-pro-max');
    // 一加 15 and 小米 17 Ultra both 93.6 %: same rank
    const tie = r.rows.filter((x) => ['oneplus-15', 'xiaomi-17-ultra'].includes(x.device.id));
    expect(tie.map((x) => x.rank)).toEqual([3, 3]);
    expect(r.rows.find((x) => x.device.id === 'honor-magic-v5')!.display).toBe('outer');
    expect(r.rows.every((x) => x.hasMap)).toBe(true);
    expect(r.rows.length + r.missing.length).toBe(catalog.devices.length);
    expect(r.rows[0].reference).toBeNull(); // white field: no Gamma reference
  });

  it('sorts "lower is better" metrics ascending and gives G20 rows a reference', () => {
    const r = rankUniformity(catalog.devices, index, '100', 'deviation');
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i].value).toBeGreaterThanOrEqual(r.rows[i - 1].value);
    for (const row of r.rows) expect(row.reference).toBeCloseTo(100 * (20 / 255) ** 2.2, 6);
  });

  it('gives equal values the same rank', () => {
    const d = catalog.devices.filter((x) => ['iphone-18-pro-max', 'xiaomi-17-ultra'].includes(x.id));
    const copy = structuredClone(index);
    const lum = (id: string) => copy.phones.find((p) => p.id === id)!.conditions.find((c) => c.id === '300')!.metrics.luminance!;
    lum('xiaomi-17-ultra').areaUniformityPct = lum('iphone-18-pro-max').areaUniformityPct + 0.01;
    expect(rankUniformity(d, copy, '300', 'area').rows.map((x) => x.rank)).toEqual([1, 1]);
  });
});
