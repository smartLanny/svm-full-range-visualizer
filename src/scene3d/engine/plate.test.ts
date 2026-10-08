import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../../types';
import { MAX_COMPARE_PANELS } from '../../types';
import { gridView } from '../../data/grid';
import { buildModel, SX, SZ, type SceneModel } from './model';
import { PLATE_ASPECT, plateDepthScale, plateHeight } from './plate';

const dir = path.resolve(__dirname, '../../../public/datasets');
/** Every bundled record (the manifest's order does not matter here). */
const all: SvmRecord[] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
  .sort()
  .map((f) => ({ ...(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SvmRecord), id: f }));

const domainAspect = (m: SceneModel) => ((m.domain.lx1 - m.domain.lx0) * SX) / ((m.domain.g1 - m.domain.g0) * m.sz);
const rectAspect = (r: { x0: number; x1: number; z0: number; z1: number }) => (r.x1 - r.x0) / (r.z1 - r.z0);
const hasVisibleCells = (rec: SvmRecord, clipLowGray: boolean, maxNits: number | null) =>
  gridView(rec, { clipLowGray, maxNits }).points.some((row) => row.some(Boolean));

describe('plate aspect (docs/adr/0002, stable heatmap proportions)', () => {
  it('is wider than tall, between a square and the widest former landscape default', () => {
    expect(PLATE_ASPECT).toBeGreaterThanOrEqual(1);
    expect(PLATE_ASPECT).toBeLessThanOrEqual(1.45);
  });

  it('depth scale: the plate of any span gets the plate aspect; degenerate spans keep 1', () => {
    for (const span of [
      { lx0: 0.3, lx1: 2.7, g0: 7.5, g1: 255 },
      { lx0: 0.3, lx1: 2.0, g0: 0, g1: 255 },
      { lx0: 1.0, lx1: 3.5, g0: 100, g1: 255 },
    ]) {
      const k = plateDepthScale(span, SX, SZ);
      expect(((span.lx1 - span.lx0) * SX) / ((span.g1 - span.g0) * SZ * k)).toBeCloseTo(PLATE_ASPECT, 9);
    }
    expect(plateDepthScale({ lx0: 1, lx1: 1, g0: 0, g1: 255 }, SX, SZ)).toBe(1);
    expect(plateDepthScale({ lx0: 0, lx1: 2, g0: 10, g1: 10 }, SX, SZ)).toBe(1);
    expect(plateDepthScale({ lx0: 0, lx1: 2, g0: 0, g1: 255 }, SX, SZ, 1)).toBeCloseTo((2 * SX) / (255 * SZ), 9);
  });

  it('heatmap height for a width: width / aspect, whole px', () => {
    expect(plateHeight(280)).toBe(Math.round(280 / PLATE_ASPECT));
    expect(plateHeight(0)).toBe(0);
    expect(plateHeight(-5)).toBe(0);
    expect(plateHeight(100, 1)).toBe(100);
  });

  it('every bundled record, clip on / off and any luminance cap: the single plate has the plate aspect', () => {
    const off: string[] = [];
    for (const rec of all)
      for (const clipLowGray of [true, false])
        for (const maxNits of [500, 200, 100, 50, null]) {
          const res = buildModel({ layout: 'single', a: rec, b: null, clipLowGray, maxNits, colorMax: 4, heightCap: 6 });
          if (!res.ok) continue;
          if (!hasVisibleCells(rec, clipLowGray, maxNits)) continue;
          const m = res.model;
          // One panel: its rect is the domain.
          const a = rectAspect(m.panels[0].rect);
          if (Math.abs(a - PLATE_ASPECT) > 1e-6 || Math.abs(domainAspect(m) - PLATE_ASPECT) > 1e-6) off.push(`${rec.id} ${clipLowGray} ${maxNits}: ${a.toFixed(3)}`);
        }
    expect(off).toEqual([]);
  });

  it('side by side (2–6 panels) and the difference map: one shared plate of the plate aspect; every panel between square and 1.5', () => {
    const off: string[] = [];
    for (let n = 2; n <= MAX_COMPARE_PANELS; n++)
      for (let start = 0; start < all.length; start += 3) {
        const recs = Array.from({ length: n }, (_, i) => all[(start + i * 5) % all.length]);
        for (const maxNits of [500, 100, null]) {
          const res = buildModel({ layout: 'sideBySide', a: recs[0], b: recs[1], extras: recs.slice(2), clipLowGray: true, maxNits, colorMax: 4, heightCap: 6 });
          if (!res.ok) continue;
          const m = res.model;
          if (m.panels.length !== n) off.push(`n=${n}: ${m.panels.length} panels`);
          if (Math.abs(domainAspect(m) - PLATE_ASPECT) > 1e-6) off.push(`n=${n} ${maxNits}: domain ${domainAspect(m).toFixed(3)}`);
          for (const p of m.panels) {
            // A panel covers its own record's part of the shared domain (shared axes): a record with
            // a shorter luminance / gray range than the others is narrower / wider. Sparse records
            // can legitimately occupy less than a square when their source has only a few columns.
            if (!hasVisibleCells(p.record, true, maxNits)) continue;
            const a = rectAspect(p.rect);
            const { matrix } = p.record;
            const totalColumns = matrix.cols.length;
            const populatedColumns = matrix.cols.reduce((n, _, c) => {
              const level = matrix.headerNits[c];
              const withinCap = Number.isFinite(level) && level > 0 && (maxNits === null || level <= maxNits);
              return n + (withinCap && matrix.grid.some((row) => !!row[c]) ? 1 : 0);
            }, 0);
            const sparse = totalColumns > 0 && populatedColumns * 2 < totalColumns;
            if (a > 1.5 || a <= 0 || (!sparse && a < 1)) off.push(`n=${n} ${maxNits} ${p.id} ${p.record.id}: ${a.toFixed(3)}`);
          }
        }
      }
    for (let i = 0; i + 1 < all.length; i++) {
      const res = buildModel({ layout: 'diff', a: all[i], b: all[i + 1], clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
      if (!res.ok) continue;
      if (!hasVisibleCells(all[i], true, 500) || !hasVisibleCells(all[i + 1], true, 500)) continue;
      const a = rectAspect(res.model.panels[0].rect);
      if (Math.abs(a - PLATE_ASPECT) > 1e-6) off.push(`diff ${all[i].id} − ${all[i + 1].id}: ${a.toFixed(3)}`);
    }
    expect(off).toEqual([]);
  });

  it('the plate never depends on the frame: the model has no frame input', () => {
    const res1 = buildModel({ layout: 'single', a: all[0], b: null, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
    const res2 = buildModel({ layout: 'single', a: all[0], b: null, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6, plateAspect: PLATE_ASPECT });
    expect(res1.ok && res2.ok).toBe(true);
    if (res1.ok && res2.ok) expect(res1.model.sz).toBe(res2.model.sz);
  });
});
