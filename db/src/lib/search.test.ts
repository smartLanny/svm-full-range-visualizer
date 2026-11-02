import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../catalog/types';
import { filterDevices, matchReason } from './search';

const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../data/devices.json'), 'utf8')) as Catalog;
const ids = (q: string, has: Parameters<typeof filterDevices>[2] = null) => filterDevices(catalog, q, has).map((d) => d.id);

describe('device search', () => {
  it('matches names, aliases and panel codes, ignoring case and spaces', () => {
    expect(ids('gh3')).toEqual(['iphone-18-pro-max']);
    expect(ids('GV3')).toEqual(['iphone-17-pro-max']);
    expect(ids('mi17u')).toEqual(['xiaomi-17-ultra']);
    expect(ids('小米17ultra')).toEqual(['xiaomi-17-ultra']);
    expect(ids('mate90')).toEqual(['huawei-mate-90-pro-max']);
    expect(ids('华为 Mate Air')).toEqual(['huawei-mate-70-air']);
    expect(ids('Huawei')).toContain('huawei-pura70');
    expect(ids('')).toHaveLength(catalog.devices.length);
  });

  it('filters by data type', () => {
    expect(ids('', 'uniformity')).toHaveLength(14);
    expect(ids('', 'uniformity')).toEqual(expect.arrayContaining(['xiaomi-18-pro-max', 'iphone-18-pro-max', 'xiaomi-17-ultra', 'oneplus-15']));
    expect(ids('', 'uniformity')).toEqual(expect.arrayContaining(['huawei-mate-90-pro-max', 'oppo-find-x9']));
    expect(ids('', 'uniformity')).not.toContain('iphone-duo');
    expect(ids('', 'angle')).toContain('iphone-duo');
  });

  it('says why a result matched when it was not the name', () => {
    const ip18 = catalog.devices.find((d) => d.id === 'iphone-18-pro-max')!;
    expect(matchReason(ip18, 'gh3')).toBe('面板 GH3');
    expect(matchReason(ip18, 'ip18pm')).toBe('别名 ip18pm');
    expect(matchReason(ip18, 'iPhone')).toBeNull();
  });
});
