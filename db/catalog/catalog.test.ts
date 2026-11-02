/**
 * Invariants of the device catalog (data/devices.json). These hold for any future batch, plus a few
 * anchors from the user's existing data that must never silently change meaning.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../pipeline/catalog/build_catalog.mjs';
import type { AngleSummary, Catalog, Device } from './types';

const ROOT = path.resolve(__dirname, '../..');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const catalog = read<Catalog>('data/devices.json');
const manifest = read<{ file: string; device: string; mode: string }[]>('public/datasets/manifest.json');
const summary = read<AngleSummary>('data/angle/summary.json');
const dev = (id: string): Device => {
  const d = catalog.devices.find((x) => x.id === id);
  if (!d) throw new Error(`no device ${id}`);
  return d;
};

describe('device catalog', () => {
  it('is exactly what the generator produces from the current sources', () => {
    expect(buildCatalog(ROOT)).toEqual(catalog);
  });

  it('has unique, stable kebab-case ids, including every atlas id', () => {
    const ids = catalog.devices.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    // the 24 atlas ids are kept unchanged (old links translate to them), plus iphone-duo
    const atlas = read<{ phones: { id: string }[] }>('data/reflectance/index.json').phones.map((p) => p.id);
    for (const id of [...atlas, 'iphone-duo']) expect(ids).toContain(id);
  });

  it('puts every SVM record under exactly one device, with the manifest mode label verbatim', () => {
    const owners = new Map<string, string[]>();
    for (const d of catalog.devices) for (const e of d.svm) owners.set(e.record, [...(owners.get(e.record) ?? []), d.id]);
    for (const m of manifest) {
      expect(owners.get(m.file), m.file).toHaveLength(1);
      const e = catalog.devices.flatMap((d) => d.svm).find((x) => x.record === m.file)!;
      expect(e.mode).toBe(m.mode);
    }
    expect([...owners.keys()].sort()).toEqual(manifest.map((m) => m.file).sort());
  });

  it('maps every standalone angle profile exactly once', () => {
    const profiles = catalog.devices.flatMap((d) => d.angle.map((e) => e.profile));
    expect(profiles.sort()).toEqual(summary.profiles.map((p) => p.id).sort());
  });

  it('never folds an unspecified or display-only reflectance state into default', () => {
    const refl = read<{ phones: { id: string; conditions: { id: string }[] }[] }>('data/reflectance/index.json');
    for (const p of refl.phones) {
      for (const c of p.conditions) {
        const e = dev(p.id).reflectance.find((x) => x.condition === c.id)!;
        if (c.id === 'as-measured' || c.id.startsWith('screen-unspecified')) expect(e.state).toBe('unspecified');
        expect(e.state).not.toBe('default');
      }
    }
    expect(catalog.vocabulary.states.unspecified.zh).toBe('原始样品 · 状态未注明');
  });

  it('keeps panel codes on units only, and aliases free of collisions', () => {
    const panels = new Set(catalog.devices.flatMap((d) => d.units.map((u) => u.panel?.toLowerCase())).filter(Boolean));
    const seen = new Map<string, string>();
    for (const d of catalog.devices) {
      for (const a of d.aliases) expect(panels.has(a.toLowerCase()), `${d.id} alias ${a}`).toBe(false);
      for (const k of new Set([d.id, d.name.zh, d.name.en, ...d.aliases].map((s) => s.toLowerCase()))) {
        expect(seen.get(k) ?? d.id, `${k} used by two devices`).toBe(d.id);
        seen.set(k, d.id);
      }
    }
  });

  it('references only units, displays and states that exist', () => {
    const states = Object.keys(catalog.vocabulary.states);
    for (const d of catalog.devices) {
      const units = d.units.map((u) => u.id);
      for (const e of [...d.svm, ...d.angle, ...d.uniformity, ...d.reflectance]) {
        expect(states).toContain(e.state);
        if (e.unit !== null) expect(units).toContain(e.unit);
        if (e.display !== null) expect(d.displays).toContain(e.display);
      }
    }
  });

  it('has an availability status for every data type that agrees with the entries', () => {
    for (const d of catalog.devices) {
      for (const t of ['svm', 'angle', 'uniformity', 'reflectance'] as const) {
        const s = d.availability[t].status;
        const n = t === 'angle' ? d.angle.filter((e) => e.measured).length : d[t].length;
        if (s === 'pending-import' || s === 'not-measured') expect(n, `${d.id} ${t}`).toBe(0);
        else expect(n, `${d.id} ${t}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('anchors from the existing data', () => {
  it('iPhone Duo: SVM inner + outer; angle inner measured, outer an unmeasured stand-in for p0', () => {
    const duo = dev('iphone-duo');
    expect(duo.displays).toEqual(['inner', 'outer']);
    expect(duo.svm.map((e) => `${e.display}:${e.mode}`)).toEqual(['inner:普通 120Hz', 'inner:脉冲平滑 120Hz', 'outer:普通 120Hz', 'outer:脉冲平滑 120Hz']);
    const inner = duo.angle.find((e) => e.profile === 'duo-inner')!;
    const outer = duo.angle.find((e) => e.profile === 'duo-outer')!;
    expect(inner).toMatchObject({ measured: true, state: 'inner', display: 'inner' });
    expect(outer).toMatchObject({ measured: false, status: 'not-measured', substituteOf: 'p0', state: 'outer' });
    expect(duo.availability.angle.status).toBe('partial');
    expect(catalog.vocabulary.availability['not-measured'].zh).toBe('未测');
  });

  it('iPhone 18 Pro Max: default and privacy-film angle profiles on the same GH3 unit', () => {
    const ip = dev('iphone-18-pro-max');
    expect(ip.units).toEqual([expect.objectContaining({ id: 'gh3', panel: 'GH3' })]);
    expect(ip.angle.map((e) => [e.profile, e.state, e.unit])).toEqual([['p0', 'default', 'gh3'], ['p1', 'privacy-film', 'gh3']]);
    expect(ip.aliases).not.toContain('GH3');
  });

  it('Xiaomi 18 Pro Max: built-in privacy mode is `privacy`, not a film', () => {
    expect(dev('xiaomi-18-pro-max').angle.map((e) => [e.profile, e.state])).toEqual([['p2', 'default'], ['p3', 'privacy']]);
  });

  it('uniformity: 14 phones, all with heatmaps (63 maps); Find X9 has only 100 nits G20', () => {
    const withMaps = catalog.devices.filter((d) => d.uniformity.some((e) => e.maps.length));
    expect(withMaps.map((d) => d.id).sort()).toEqual([
      'honor-magic-v5', 'huawei-mate-70-air', 'huawei-mate-80-rs', 'huawei-mate-90-pro-max', 'huawei-pura-80-ultra', 'iphone-17-pro-max',
      'iphone-18-pro-max', 'oneplus-15', 'oppo-find-x9', 'oppo-find-x9-ultra', 'oppo-find-x9s-pro', 'xiaomi-15-ultra', 'xiaomi-17-ultra', 'xiaomi-18-pro-max',
    ]);
    expect(withMaps.flatMap((d) => d.uniformity.flatMap((e) => e.maps))).toHaveLength(63);
    for (const d of withMaps) expect(d.availability.uniformity.status).toBe('complete');
    expect(catalog.devices.filter((d) => d.availability.uniformity.status === 'metrics-only')).toEqual([]);
    for (const id of ['xiaomi-18-pro-max', 'iphone-18-pro-max', 'xiaomi-17-ultra', 'huawei-mate-90-pro-max']) {
      expect(dev(id).uniformity.map((e) => [e.condition, e.maps.length])).toEqual([['300', 2], ['100', 2], ['10', 1]]);
    }
    // Magic V5: the outer screen was measured
    expect(dev('honor-magic-v5').uniformity.map((e) => e.display)).toEqual(['outer', 'outer', 'outer']);
    expect(dev('oppo-find-x9-ultra').uniformity.map((e) => e.condition)).toEqual(['300', '100']);
    expect(dev('oppo-find-x9').uniformity.map((e) => [e.condition, e.maps.length])).toEqual([['100', 1]]);
  });

  it('reflectance: Find N5 has 5 conditions over 3 dates; Magic V5 inner / outer', () => {
    const n5 = dev('oppo-find-n5').reflectance;
    expect(n5).toHaveLength(5);
    expect(new Set(n5.map((e) => e.date))).toEqual(new Set(['2026-03-01', '2026-02-28', '2025-08-08']));
    expect(n5.map((e) => `${e.display}:${e.state}`).sort()).toEqual(['inner:inner', 'inner:inner', 'null:unspecified', 'outer:outer', 'outer:outer']);
    expect(dev('honor-magic-v5').reflectance.map((e) => e.state)).toEqual(['inner', 'outer']);
    expect(catalog.devices.reduce((n, d) => n + d.reflectance.length, 0)).toBe(32);
    expect(catalog.devices.filter((d) => d.reflectance.length).length).toBe(24);
  });

  it('Mate 90 Pro Max 典藏版: its single SVM record keeps the label 默认 and a note on the 500 nits cap', () => {
    const [e] = dev('huawei-mate-90-pro-max').svm;
    expect(e).toMatchObject({ record: 'huawei_mate90promax.json', mode: '默认' });
    expect(e.note).toContain('500 nits');
  });
});
