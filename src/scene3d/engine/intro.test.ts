import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import type { SvmRecord } from '../../types';
import { buildModel, SY } from './model';
import { fitPose, PERSP_TAN, poseBasis, type CamPose } from './camera';
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
      for (let i = 0; i < cur.growth.length; i++) expect(Math.abs(cur.growth[i] - prev.growth[i])).toBeLessThan(0.03);
      for (let i = 0; i < cur.reveal.length; i++) expect(Math.abs(cur.reveal[i] - prev.reveal[i])).toBeLessThan(0.02);
      prev = cur;
    }
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
    const fp = p.evaluate(INTRO.camStart, makeFrameParams());
    const g = fp.growth!;
    // At the start of the crane move only the top row has grown.
    const grown = Array.from(g).filter((x) => x > 0.999).length;
    const partial = Array.from(g).filter((x) => x > 0 && x < 0.999).length;
    expect(grown).toBeGreaterThan(0);
    expect(partial).toBe(0);
  });
});
