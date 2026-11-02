/**
 * The page reads what the uniformity importer writes: a metrics-only import (numbers, no heatmaps)
 * must show up on the device page with its own numbers, not as 「仅指标」 with nothing under it.
 *
 * The iPhone 17 Pro Max numbers are SYNTHETIC test values (the real ones are still on the user's
 * NAS). They exist only in the temporary fixture; data/ is never touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../pipeline/catalog/build_catalog.mjs';
import { makeFixture, type Fixture } from '../../../pipeline/testing/fixture';
import { runPython, writeJsonFile } from '../../../pipeline/testing/python';
import type { Catalog } from '../../catalog/types';
import type { UniformityIndex } from './types';
import { gammaReadout, uniformityViews } from './uniformity';

const SYNTH = [
  { id: 'ip17pm', level: '300', kind: 'lum', cond: '', typ: 301.2345678, u9: 91.23456, ua: 87.65432, dev10: 0.12345 },
  { id: 'ip17pm', level: '300', kind: 'cct', cond: '', typ: 6612.34567, d9: 120.1234, da: 250.9876 },
  { id: 'ip17pm', level: '100', kind: 'lum', cond: '', typ: 0.3512, u9: 93.1, ua: 89.2, dev10: 0 },
];

let fx: Fixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

describe('metrics-only uniformity import → database page', () => {
  it('before the import iPhone 17 Pro Max has no views (pending import)', () => {
    fx = makeFixture();
    const index = fx.readJson<UniformityIndex>('data/uniformity/index.json');
    const catalog = buildCatalog(fx.root) as unknown as Catalog;
    const d = catalog.devices.find((x) => x.id === 'iphone-17-pro-max')!;
    expect(d.availability.uniformity.status).toBe('pending-import');
    expect(uniformityViews(d, index)).toEqual([]);
  });

  it('after the import the page finds the imported conditions and numbers', () => {
    fx = makeFixture();
    writeJsonFile(fx.path('metrics.json'), SYNTH);
    writeJsonFile(fx.path('opts.json'), { devices: ['iphone-17-pro-max'] });
    const r = runPython('pipeline/import/uniformity_metrics.py', [
      '--root', fx.root, '--options', fx.path('opts.json'), '--metrics', fx.path('metrics.json'),
      '--source-name', '视频项目/data/uniformity_metrics.json', '--batch', '2026-11-05-test',
    ]);
    expect(r.status, r.stderr).toBe(0);

    const index = fx.readJson<UniformityIndex>('data/uniformity/index.json');
    const catalog = buildCatalog(fx.root) as unknown as Catalog;
    const d = catalog.devices.find((x) => x.id === 'iphone-17-pro-max')!;
    expect(d.availability.uniformity.status).toBe('metrics-only');

    const views = uniformityViews(d, index);
    expect(views.map((v) => v.cond.id)).toEqual(['300', '100']);
    for (const v of views) expect(v.cond.maps?.luminance).toBeUndefined();
    const v300 = views.find((v) => v.cond.id === '300')!;
    const lum = v300.cond.metrics.luminance!;
    // the page shows exactly what the importer stored (export_maps.py rounding), nothing else
    expect(lum.areaUniformityPct).toBe(index.metricsOnly!.find((m) => m.id === d.id)!.conditions[0].metrics.luminance!.areaUniformityPct);
    expect(Math.abs(lum.areaUniformityPct - 87.65432)).toBeLessThan(1e-3);
    const v100 = views.find((v) => v.cond.id === '100')!;
    const readout = gammaReadout(v100.cond, v100.cond.metrics.luminance!.typical)!;
    expect(readout.basis).toBe('nominal');
    expect(readout.flag).toBeNull();
  });
});
