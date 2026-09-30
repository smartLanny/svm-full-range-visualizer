import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../../types';
import { logNits } from '../../data/grid';
import { DEFAULT_SCENARIOS } from '../../data/scenarios';
import { buildModel, SX, type SceneModel } from './model';
import { scenarioOutlines } from './scenarioOverlay';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/datasets', f), 'utf8')) as SvmRecord;
const iphone = load('iPhone17ProMax.json');

function model(maxNits: number | null, layout: 'single' | 'sideBySide' = 'single'): SceneModel {
  const res = buildModel({ layout, a: iphone, b: layout === 'single' ? null : iphone, clipLowGray: true, maxNits, colorMax: 4, heightCap: 6 });
  if (!res.ok) throw new Error(res.reason);
  return res.model;
}

describe('scenario outlines (top-view overlay, docs/adr/0009 addendum)', () => {
  it('maps the rectangles like the cells: x = log10(nits + 1) · SX, z = −gray · sz', () => {
    const m = model(500);
    const p = m.panels[0];
    const out = scenarioOutlines(p, m.sz, DEFAULT_SCENARIOS);
    expect(out.map((o) => o.id)).toEqual(['night', 'indoor', 'outdoor']);
    const wx = (n: number) => p.xs[0] + (logNits(n) - p.view.x[0]) * SX;
    const wz = (g: number) => p.zs[0] - (g - p.view.grays[0]) * m.sz;
    const night = out[0];
    expect(night.x0).toBeCloseTo(wx(2), 9);
    expect(night.x1).toBeCloseTo(wx(20), 9);
    expect(night.z0).toBeCloseTo(wz(100), 9); // back edge = higher gray
    expect(night.z1).toBeCloseTo(wz(15), 9);
    for (const o of out) {
      expect(o.x0).toBeGreaterThanOrEqual(p.rect.x0 - 1e-9);
      expect(o.x1).toBeLessThanOrEqual(p.rect.x1 + 1e-9);
      expect(o.z0).toBeGreaterThanOrEqual(p.rect.z0 - 1e-9);
      expect(o.z1).toBeLessThanOrEqual(p.rect.z1 + 1e-9);
    }
    // G255 is the plate's back edge: the indoor / outdoor tops are clipped to it
    expect(out[1].z0).toBeCloseTo(p.rect.z0, 9);
  });

  it('clips to the plate and leaves out rectangles outside it (luminance cap)', () => {
    const m = model(300);
    const p = m.panels[0];
    const out = scenarioOutlines(p, m.sz, DEFAULT_SCENARIOS);
    expect(out.map((o) => o.id)).toEqual(['night', 'indoor']);
    // uncapped: outdoor present again
    const all = model(null);
    expect(scenarioOutlines(all.panels[0], all.sz, DEFAULT_SCENARIOS).map((o) => o.id)).toEqual(['night', 'indoor', 'outdoor']);
  });

  it('side by side: each panel gets its own (shifted) outlines', () => {
    const m = model(500, 'sideBySide');
    const [a, b] = m.panels.map((p) => scenarioOutlines(p, m.sz, DEFAULT_SCENARIOS));
    expect(b[0].x0 - a[0].x0).toBeCloseTo(m.panels[1].offsetX - m.panels[0].offsetX, 9);
    expect(b[0].z0).toBeCloseTo(a[0].z0, 9);
  });
});
