/**
 * data/angle/summary.json against the standalone view-angle project. The reproducibility tests
 * need a local checkout of phone-view-angle-sim (VAS_DIR or a sibling folder) and are skipped
 * without one; the file-only tests always run.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSummary, findStandalone, loadStandalone } from './summarise.mjs';
import type { AngleSummary } from '../../db/catalog/types';

const ROOT = path.resolve(__dirname, '../..');
const summary: AngleSummary = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/angle/summary.json'), 'utf8'));
const standalone = findStandalone();

describe('angle summary file', () => {
  it('records the standalone commit and the model call it ran', () => {
    expect(summary.standalone.commit).toMatch(/^20ef8e6[0-9a-f]{33}$/);
    expect(summary.standalone.modelCall).toContain("fill: 'vmirror'");
  });

  it('has numbers for measured profiles only (Duo outer is a stand-in → none)', () => {
    const outer = summary.profiles.find((p) => p.id === 'duo-outer')!;
    expect(outer).toMatchObject({ measured: false, metrics: null, substituteOf: 'p0', setsIdenticalToSubstitute: true });
    const measured = summary.profiles.filter((p) => p.measured).map((p) => p.id);
    expect(measured).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'duo-inner']);
  });

  it('privacy profiles lose far more luminance sideways than their default counterparts', () => {
    const at45 = (id: string) => summary.profiles.find((p) => p.id === id)!.metrics!.horizontal.right.atTheta['45'].luminancePct;
    expect(at45('p1')).toBeLessThan(at45('p0') / 5); // GH3 privacy film
    expect(at45('p3')).toBeLessThan(at45('p2') / 2); // Xiaomi privacy mode
  });
});

describe.skipIf(!standalone)('angle summary vs the standalone model (local checkout)', () => {
  it('regenerates byte-identically at the recorded commit', () => {
    const fresh = buildSummary(loadStandalone(standalone!, summary.standalone.commit));
    expect(fresh).toEqual(summary);
  });

  it('on a 2° grid angle equals the measured ratio, with ψ = 0 / 180 / 90 / 270 = right / left / up / down', () => {
    const s = loadStandalone(standalone!, summary.standalone.commit);
    const p0 = s.DATA.profiles.find((p: { id: string }) => p.id === 'p0');
    const A: number[] = s.DATA.angles;
    const ratio = (phi: number, theta: number) => {
      const set = p0.sets.find((x: { phi: number }) => x.phi === phi);
      return (set.data.W[A.indexOf(theta)][1] / set.data.W[A.indexOf(0)][1]) * 100;
    };
    const m = summary.profiles.find((p) => p.id === 'p0')!.metrics!;
    expect(m.horizontal.right.atTheta['30'].luminancePct).toBeCloseTo(ratio(0, 30), 2);
    expect(m.horizontal.left.atTheta['30'].luminancePct).toBeCloseTo(ratio(0, -30), 2);
    expect(m.vertical.up.atTheta['30'].luminancePct).toBeCloseTo(ratio(90, 30), 2);
    expect(m.vertical.down.atTheta['30'].luminancePct).toBeCloseTo(ratio(90, -30), 2);
  });

  it('devIndexAtCommit follows the standalone device order', () => {
    const order = summary.standalone.devicesAtCommit;
    for (const p of summary.profiles) expect(order[p.devIndexAtCommit]).toBe(p.device);
    expect(order).toEqual(['小米 18 Pro Max', 'iPhone 18 Pro Max GH3', '华为 Mate 90 Pro Max 典藏版', 'iPhone 17 Pro Max GV3', 'iPhone Duo']);
  });
});
