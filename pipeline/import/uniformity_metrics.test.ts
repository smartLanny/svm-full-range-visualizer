/**
 * pipeline/import/uniformity_metrics.py — regression against the current index, metrics-only
 * devices, measured white, and refusals. All runs use a temporary copy of the database.
 *
 * The numbers for iPhone 16 Pro Max / Mate 90 below are SYNTHETIC test values (the real ones are
 * still on the user's NAS); they only ever exist inside the temporary fixture.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog/build_catalog.mjs';
import { runCheck } from '../check.mjs';
import { makeFixture, type Fixture } from '../testing/fixture';
import { ROOT, runPython, writeJsonFile } from '../testing/python';

const SCRIPT = 'pipeline/import/uniformity_metrics.py';
const INDEX = 'data/uniformity/index.json';

type Row = Record<string, string | number>;

/** uniformity_metrics.json rows equivalent to what the current index was built from. */
function rowsFromIndex(index: any): Row[] {
  const rows: Row[] = [];
  for (const p of index.phones) {
    for (const c of p.conditions) {
      const sid = c.maps.luminance.sourceKey.split('_').slice(2).join('_');
      const l = c.metrics.luminance;
      rows.push({ id: sid, level: c.id, kind: 'lum', cond: '', typ: l.typical, u9: l.ninePointUniformityPct, ua: l.areaUniformityPct, dev10: l.deviation10PctArea });
      const t = c.metrics.colorTemperature;
      if (t) rows.push({ id: sid, level: c.id, kind: 'cct', cond: '', typ: t.typical, d9: t.ninePointSpreadK, da: t.areaSpreadK });
    }
  }
  return rows;
}

const SYNTH_IP16PM: Row[] = [
  { id: 'ip16pm', level: '300', kind: 'lum', cond: '', typ: 301.2345678, u9: 91.23456, ua: 87.65432, dev10: 0.12345 },
  { id: 'ip16pm', level: '300', kind: 'cct', cond: '', typ: 6612.34567, d9: 120.1234, da: 250.9876 },
  { id: 'ip16pm', level: '100', kind: 'lum', cond: '', typ: 0.3512, u9: 93.1, ua: 89.2, dev10: 0 },
  { id: 'ip16pm', level: '10', kind: 'lum', cond: '', typ: 0.0307, u9: 85, ua: 77.7, dev10: 3.2 },
  { id: 'ip16pm', level: '100', kind: 'lum', cond: '防窥', typ: 0.2, u9: 50, ua: 40, dev10: 9 },
];

let fx: Fixture | null = null;
afterEach(() => { fx?.cleanup(); fx = null; });

function run(rows: Row[] | null, options: unknown, extra: string[] = []) {
  if (!fx) fx = makeFixture();
  const args = ['--root', fx.root, '--options', fx.path('opts.json'), '--batch', '2026-11-05-test', '--audit', fx.path('audit.json'), ...extra];
  writeJsonFile(fx.path('opts.json'), options);
  if (rows) {
    writeJsonFile(fx.path('metrics.json'), rows);
    args.push('--metrics', fx.path('metrics.json'), '--source-name', '视频项目/data/uniformity_metrics.json');
  }
  return runPython(SCRIPT, args);
}

const index = () => fx!.readJson(INDEX);
const MAP_PHONES = ['xiaomi-18-pro-max', 'iphone-18-pro-max', 'xiaomi-17-ultra'];

describe('uniformity_metrics.py', () => {
  it('regression: the metrics the current heatmaps were made with change nothing (byte-identical)', () => {
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, INDEX), 'utf8'));
    const r = run(rowsFromIndex(current), { devices: MAP_PHONES });
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.changedFiles).toEqual([]);
    expect(r.result.audit.devices.map((d: { status: string }) => d.status)).toEqual(['verified-unchanged', 'verified-unchanged', 'verified-unchanged']);
    expect(fs.readFileSync(fx!.path(INDEX)).equals(fs.readFileSync(path.join(ROOT, INDEX)))).toBe(true);
  });

  it('refuses different numbers for a device that has heatmaps (they would disagree)', () => {
    const rows = rowsFromIndex(JSON.parse(fs.readFileSync(path.join(ROOT, INDEX), 'utf8')));
    (rows.find((x) => x.id === 'mi17u' && x.level === '100' && x.kind === 'lum') as Row).ua = 80;
    const r = run(rows, { devices: ['xiaomi-17-ultra'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/xiaomi-17-ultra 的热力图是按旧指标导出的.*100 lum areaUniformityPct（库内 91\.8\d*，新文件 80/);
    expect(fs.readFileSync(fx!.path(INDEX)).equals(fs.readFileSync(path.join(ROOT, INDEX)))).toBe(true);
  });

  it('imports a metrics-only device; the catalog then shows 仅指标', () => {
    const r = run(SYNTH_IP16PM, { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.changedFiles).toEqual([INDEX]);
    const entry = index().metricsOnly.find((m: { id: string }) => m.id === 'iphone-16-pro-max');
    expect(entry.metricSourceId).toBe('ip16pm');
    expect(entry.metricsSource).toMatchObject({ file: '视频项目/data/uniformity_metrics.json', batch: '2026-11-05-test' });
    expect(entry.conditions.map((c: { id: string }) => c.id)).toEqual(['300', '100', '10']);
    expect(entry.conditions[0]).toEqual({
      id: '300', label: '300 nits 白场', pattern: '全白场', referenceNits: 300,
      metrics: {
        luminance: { typical: 301.234568, unit: 'nit', ninePointUniformityPct: 91.2346, areaUniformityPct: 87.6543, deviation10PctArea: 0.1235 },
        colorTemperature: { typical: 6612.346, unit: 'K', ninePointSpreadK: 120.123, areaSpreadK: 250.988 },
      },
    });
    expect(Object.keys(entry.conditions[1].metrics)).toEqual(['luminance']);
    // the 防窥 row is not a default-condition row: listed, not imported
    expect(r.result.audit.skippedNonDefaultRows).toEqual([{ id: 'ip16pm', level: '100', kind: 'lum', cond: '防窥' }]);
    expect(r.result.changelog[0]).toContain('iPhone 16 Pro Max 新增仅指标数据（300 nits、100 nits、10 nits');

    // second run: nothing changes
    const before = fs.readFileSync(fx!.path(INDEX));
    const again = run(SYNTH_IP16PM, { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } } });
    expect(again.result.changedFiles).toEqual([]);
    expect(fs.readFileSync(fx!.path(INDEX)).equals(before)).toBe(true);

    fx!.writeJson('data/devices.json', buildCatalog(fx!.root));
    const ip17 = fx!.readJson('data/devices.json').devices.find((d: { id: string }) => d.id === 'iphone-16-pro-max');
    expect(ip17.availability.uniformity).toEqual({ status: 'metrics-only', sourceId: 'ip16pm' });
    expect(ip17.uniformity.map((e: { condition: string; maps: unknown[] }) => [e.condition, e.maps.length])).toEqual([['300', 0], ['100', 0], ['10', 0]]);
    // db:check objects only because the index changed outside db:import (hash chain + data version)
    const errors = runCheck({ root: fx!.root }).errors;
    expect(errors.some((e: string) => e.startsWith('[来源与哈希'))).toBe(true);
    expect(errors.some((e: string) => e.startsWith('[批次与数据版本') && e.includes('数据变了却没有记录版本'))).toBe(true);
    expect(errors.filter((e: string) => !e.startsWith('[来源与哈希') && !e.startsWith('[批次与数据版本'))).toEqual([]);
  });

  it('refuses to overwrite different metrics unless replace is set', () => {
    expect(run(SYNTH_IP16PM, { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } } }).status).toBe(0);
    const changed = SYNTH_IP16PM.map((x) => (x.level === '10' && x.kind === 'lum' ? { ...x, ua: 70 } : x));
    const r = run(changed, { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/已存在且不同；原始数据不覆盖/);
    const ok = run(changed, { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } }, replace: true });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.result.audit.devices[0].status).toBe('replaced');
  });

  it('records a measured white with γ_eff, and passes it to the catalog', () => {
    const r = run(null, { white: { 'xiaomi-17-ultra': { '100': { nits: 101.5, note: '复测白场（合成测试值）' } } } });
    expect(r.status, r.stderr).toBe(0);
    const cond = index().phones.find((p: { id: string }) => p.id === 'xiaomi-17-ultra').conditions.find((c: { id: string }) => c.id === '100');
    expect(cond.whiteMeasuredNits).toBe(101.5);
    expect(cond.whiteMeasuredSource).toEqual({ batch: '2026-11-05-test', note: '复测白场（合成测试值）' });
    const w = r.result.audit.white[0];
    expect(w.gamma22ReferenceNits).toBeCloseTo(101.5 * (20 / 255) ** 2.2, 6);
    expect(w.gammaEffective).toBeCloseTo(Math.log(0.4868 / 101.5) / Math.log(20 / 255), 2);
    fx!.writeJson('data/devices.json', buildCatalog(fx!.root));
    const e = fx!.readJson('data/devices.json').devices.find((d: { id: string }) => d.id === 'xiaomi-17-ultra').uniformity.find((u: { condition: string }) => u.condition === '100');
    expect(e.whiteMeasuredNits).toBe(101.5);
    expect(runCheck({ root: fx!.root }).errors.filter((x: string) => !x.startsWith('[来源与哈希') && !x.startsWith('[批次与数据版本'))).toEqual([]);
  });

  it('refuses an implausible white (γ_eff far from 2.2 means a typo or wrong unit)', () => {
    const r = run(null, { white: { 'xiaomi-17-ultra': { '100': { nits: 10, note: '写错的值' } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/γ_eff = 1\.1\d+，不在 1\.6–2\.8/);
  });

  it('moves a device recorded as not measured to metrics-only, with a warning', () => {
    fx = makeFixture();
    fx.edit(INDEX, (i) => { i.notRecorded = [{ id: 'oppo-find-n5', name: 'OPPO Find N5', conditions: [] }]; });
    const rows: Row[] = [{ id: 'n5', level: '300', kind: 'lum', cond: '', typ: 300.5, u9: 90, ua: 85, dev10: 0.5 }];
    const r = run(rows, { devices: { 'oppo-find-n5': { sourceId: 'n5' } } });
    expect(r.status, r.stderr).toBe(0);
    expect(index().notRecorded).toEqual([]);
    expect(index().metricsOnly.at(-1)).toMatchObject({ id: 'oppo-find-n5', metricSourceId: 'n5' });
    expect(r.result.warnings[0]).toMatch(/原记为「未测」/);
  });

  it('refuses unknown devices, unknown source ids and files without a device list', () => {
    expect(run(SYNTH_IP16PM, { devices: ['some-new-phone'] }).stderr).toMatch(/some-new-phone 不在 data\/catalog-overrides\.json 中/);
    expect(run(SYNTH_IP16PM, { devices: { 'oppo-find-n5': {} } }).stderr).toMatch(/请在 options\.devices 里写 sourceId（文件里有：ip16pm）/);
    expect(run(SYNTH_IP16PM, {}).stderr).toMatch(/没有列出要导入的机型/);
  });
});
