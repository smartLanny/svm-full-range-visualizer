import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import type { SvmRecord } from '../../types';
import { buildModel, SY } from './model';
import { fitPose, PERSP_MIN, PERSP_TAN, poseBasis, type CamPose } from './camera';
import { IntroPlan, INTRO, INTRO_DURATION } from './intro';
import { makeFrameParams, type FrameParams } from './frame';

const load = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/datasets', f), 'utf8')) as SvmRecord;

function plan() {
  const rec = load('iPhone17ProMax.json');
  const res = buildModel({ layout: 'single', a: rec, b: null, clipLowGray: true, maxNits: 500, colorMax: 4, heightCap: 6 });
  if (!res.ok) throw new Error('model');
  const m = res.model;
  const vp = { width: 1600, height: 900 };
  const ins = { left: 70, right: 96, top: 84, bottom: 62 };
  const b = m.bounds;
  const box = (flat: boolean) => {
    const pts: THREE.Vector3[] = [];
    for (const x of [b.x0, b.x1]) for (const z of [b.z0, b.z1]) for (const y of [0, flat ? 0 : m.plotMax * SY]) pts.push(new THREE.Vector3(x, y, z));
    return pts;
  };
  const barCells: { r: number; c: number }[] = [];
  m.panels[0].values.forEach((row, r) => row.forEach((v, c) => v !== null && barCells.push({ r, c })));
  return new IntroPlan({
    grays: m.panels[0].view.grays,
    nCols: m.panels[0].xs.length,
    barCells,
    front: fitPose(box(false), 0, 1.36, PERSP_TAN, vp, ins),
    top: fitPose(box(true), 0, 0, 0, vp, ins),
    fitAtPhi: (phi) => fitPose(box(false), 0, phi, PERSP_TAN, vp, ins),
    overlays: { contours: true, values: false, axes: true, colorbar: true, title: true },
    levelCount: 3,
  });
}

function snapshot(fp: FrameParams) {
  return {
    pose: { ...fp.pose, target: fp.pose.target.clone() } as CamPose,
    heightK: fp.heightK,
    surface: fp.surfaceOpacity,
    values: fp.valuesOpacity,
    reveal: [...(fp.contourReveal ?? [])],
    growth: fp.growth ? Array.from(fp.growth) : [],
    title: fp.hud.title,
    colorbar: fp.hud.colorbar,
    lum: fp.axes.lum,
  };
}

describe('intro storyboard', () => {
  it('is a pure function of t', () => {
    const p = plan();
    const a = snapshot(p.evaluate(5.123, makeFrameParams()));
    p.evaluate(11.7, makeFrameParams());
    const b = snapshot(p.evaluate(5.123, makeFrameParams()));
    expect(b).toEqual(a);
  });

  it('has no jumps: every quantity changes smoothly between 60 fps frames', () => {
    const p = plan();
    const dt = 1 / 120;
    let prev = snapshot(p.evaluate(0, makeFrameParams()));
    let worstCam = 0;
    let worstGrowth = 0;
    let worstReveal = 0;
    for (let t = dt; t <= INTRO_DURATION; t += dt) {
      const cur = snapshot(p.evaluate(t, makeFrameParams()));
      // Screen-space camera motion proxy: target move and zoom relative to the visible height.
      const move = cur.pose.target.distanceTo(prev.pose.target) / cur.pose.h;
      const zoom = Math.abs(Math.log(cur.pose.h / prev.pose.h));
      const rot = Math.abs(cur.pose.phi - prev.pose.phi) + Math.abs(cur.pose.theta - prev.pose.theta);
      worstCam = Math.max(worstCam, move, zoom, rot);
      expect(move).toBeLessThan(0.01);
      expect(zoom).toBeLessThan(0.01);
      expect(rot).toBeLessThan(0.01);
      expect(Math.abs(cur.pose.persp - prev.pose.persp)).toBeLessThan(0.006);
      expect(Math.abs(cur.heightK - prev.heightK)).toBeLessThan(0.02);
      expect(Math.abs(cur.surface - prev.surface)).toBeLessThan(0.02);
      expect(Math.abs(cur.values - prev.values)).toBeLessThan(0.03);
      expect(Math.abs(cur.title - prev.title)).toBeLessThan(0.03);
      for (let i = 0; i < cur.growth.length; i++) worstGrowth = Math.max(worstGrowth, Math.abs(cur.growth[i] - prev.growth[i]));
      for (let i = 0; i < cur.reveal.length; i++) worstReveal = Math.max(worstReveal, Math.abs(cur.reveal[i] - prev.reveal[i]));
      prev = cur;
    }
    expect(worstGrowth).toBeLessThan(0.03);
    expect(worstReveal).toBeLessThan(0.02);
    expect(worstCam).toBeGreaterThan(0);
  });

  it('keeps other rows invisible while G255 grows, and ends flat, orthographic, top-down', () => {
    const p = plan();
    const early = p.evaluate(1.5, makeFrameParams());
    expect(early.growth!.some((g) => g > 0)).toBe(true);
    const end = p.evaluate(INTRO_DURATION, makeFrameParams());
    expect(end.heightK).toBe(0);
    expect(end.pose.persp).toBe(0);
    expect(end.pose.phi).toBe(0);
    expect(end.surfaceOpacity).toBe(1);
    expect(end.barsOpacity).toBe(0);
    expect(end.valuesOpacity).toBe(0);
    expect(end.contourReveal!.every((r) => r === 1)).toBe(true);
    // Top view orientation: gray increases upward (-z on screen up), luminance rightward.
    const { right, up } = poseBasis(end.pose.theta, end.pose.phi);
    expect(right.x).toBeCloseTo(1);
    expect(up.z).toBeCloseTo(-1);
  });

  it('grows the G255 row before any other row', () => {
    const p = plan();
    const ctx = (p as unknown as { ctx: { grays: number[]; barCells: { r: number; c: number }[] } }).ctx;
    const top = ctx.grays.length - 1;
    // Just before the wave starts: every G255 bar has started, no other bar has.
    const fp = p.evaluate(INTRO.rowsStart - 1e-3, makeFrameParams());
    ctx.barCells.forEach(({ r }, i) => {
      if (r === top) expect(fp.growth![i]).toBeGreaterThan(0);
      else {
        expect(fp.growth![i]).toBe(0);
        expect(fp.barFade![i]).toBe(0);
      }
    });
  });

  it('starts every bar at zero velocity and fades it in (no row pops in)', () => {
    const p = plan();
    const dt = 1 / 60;
    const n = (p.evaluate(0, makeFrameParams()).growth ?? []).length;
    const first = new Array(n).fill(-1);
    let prevFade = new Float32Array(n);
    let onsetGrowth = 0;
    let onsetFade = 0;
    let fadeStep = 0;
    for (let t = 0; t <= INTRO_DURATION; t += dt) {
      const fp = p.evaluate(t, makeFrameParams());
      for (let i = 0; i < n; i++) {
        const g = fp.growth![i];
        const f = fp.barFade![i];
        if (first[i] < 0 && (g > 0 || f > 0)) {
          first[i] = t;
          // First visible frame: a sliver of height, mostly plate-colored (fade just begun).
          onsetGrowth = Math.max(onsetGrowth, g);
          onsetFade = Math.max(onsetFade, f);
        }
        fadeStep = Math.max(fadeStep, Math.abs(f - prevFade[i]));
      }
      prevFade = Float32Array.from(fp.barFade!);
    }
    expect(onsetGrowth).toBeLessThan(2e-4);
    expect(onsetFade).toBeLessThan(0.02);
    expect(fadeStep).toBeLessThan(0.2);
    expect(first.every((x) => x >= 0)).toBe(true);
  });

  it('keeps the amount of growth motion even across the wave (no periodic spikes)', () => {
    const p = plan();
    const dt = 1 / 30;
    const energy: { t: number; e: number }[] = [];
    let prev = Array.from(p.evaluate(0, makeFrameParams()).growth!);
    for (let t = dt; t <= INTRO.rowsStart + INTRO.rowsSpread + INTRO.rowDur; t += dt) {
      const cur = Array.from(p.evaluate(t, makeFrameParams()).growth!);
      energy.push({ t, e: cur.reduce((a, g, i) => a + Math.abs(g - prev[i]), 0) });
      prev = cur;
    }
    // Inside the wave (away from its ramps), every frame stays within ±30 % of its local median.
    const lo = INTRO.rowsStart + INTRO.rowDur;
    const hi = INTRO.rowsStart + INTRO.rowsSpread;
    for (let k = 0; k < energy.length; k++) {
      if (energy[k].t < lo || energy[k].t > hi) continue;
      const win = energy.slice(Math.max(0, k - 15), k + 16).map((x) => x.e).sort((a, b) => a - b);
      const med = win[win.length >> 1];
      expect(energy[k].e).toBeLessThan(med * 1.3);
      expect(energy[k].e).toBeGreaterThan(med * 0.7);
    }
  });

  it('moves the camera along a C2 path: no sudden change of speed or direction anywhere', () => {
    const p = plan();
    const dt = 1 / 60;
    const pose = makeFrameParams().pose;
    // The final swap of the narrowest perspective (PERSP_MIN) to the orthographic camera is
    // invisible by construction (parallax < 0.1 %): compare persp with the ortho end as PERSP_MIN.
    const ch = (q: CamPose) => [q.target.x, q.target.y, q.target.z, Math.log(q.h), q.phi, q.theta, Math.max(PERSP_MIN, q.persp)];
    const xs: number[][] = [];
    for (let t = 0; t <= INTRO_DURATION + 1e-9; t += dt) xs.push(ch(p.cameraAt(t, pose)));
    for (let c = 0; c < xs[0].length; c++) {
      const v = xs.slice(1).map((x, i) => x[c] - xs[i][c]);
      const vmax = Math.max(1e-9, ...v.map(Math.abs));
      // Change of per-frame velocity relative to the channel's top speed (linear interpolation
      // between sampled framings gave up to 0.79 here).
      let worst = 0;
      for (let i = 1; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i] - v[i - 1]) / vmax);
      expect(worst, `channel ${c}`).toBeLessThan(0.05);
    }
    // Ends exactly on the static top view.
    const end = p.cameraAt(INTRO_DURATION, pose);
    const top = (p as unknown as { ctx: { top: CamPose } }).ctx.top;
    expect(end.target.distanceTo(top.target)).toBe(0);
    expect(end.h).toBe(top.h);
    expect(end.persp).toBe(0);
  });

  it('follows the exact crane framing closely and never frames tighter than it', () => {
    const p = plan();
    const ctx = (p as unknown as { ctx: { front: CamPose; fitAtPhi: (phi: number) => CamPose } }).ctx;
    const pose = makeFrameParams().pose;
    for (let i = 0; i <= 120; i++) {
      const phi = (ctx.front.phi * i) / 120;
      const exact = ctx.fitAtPhi(phi);
      const smooth = p.craneAt(phi, pose);
      const off = smooth.target.distanceTo(exact.target) / exact.h;
      expect(off).toBeLessThan(0.01);
      // Room for the target offset on both sides, and at most a few percent looser.
      expect(Math.log(smooth.h / exact.h)).toBeGreaterThan(2 * off - 0.004);
      expect(Math.log(smooth.h / exact.h)).toBeLessThan(0.08);
    }
  });

  it('hides plate-edge axis labels while the lens narrows and brings them back flat', () => {
    const p = plan();
    const mid = p.evaluate((INTRO.nar0 + INTRO.nar1) / 2, makeFrameParams());
    expect(mid.axes.gray).toBe(0);
    expect(mid.axes.lum).toBe(0);
    const end = p.evaluate(INTRO.axShow1, makeFrameParams());
    expect(end.axes.gray).toBe(1);
    expect(end.heightK).toBeLessThan(0.01);
    // The flatten → orthographic step is not rushed.
    expect(INTRO.nar1 - INTRO.nar0).toBeGreaterThanOrEqual(1.2);
    expect(INTRO.flat1 - INTRO.flat0).toBeGreaterThanOrEqual(1.2);
  });
});
