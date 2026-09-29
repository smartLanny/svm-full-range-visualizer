/**
 * Sweep smoothness over every bundled record (docs/adr/0003, review findings F11 / F62):
 * between consecutive 1/60 s frames nothing on the curves may appear, vanish or jump.
 *
 * - A point (tracked by its measured column / row) that enters or leaves the slice does so at
 *   ≤ 10 % opacity, and its opacity changes by ≤ 0.2 per frame (a fade of ≥ ~8 frames).
 * - A visible point (endpoints included) never moves by > 2 % of the axis span in one frame
 *   unless that motion is continuous: split into 8 sub-steps, no sub-step may carry more than a
 *   half of it (a genuine pop keeps its whole size in one sub-step; steep but continuous data
 *   refines). Positions are clamped to the visible axis window and weighted by opacity.
 * - Dotted gap bridges fade in / out the same way (≤ 0.2 per frame).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, SliceMode, SvmRecord } from '../types';
import { sliceFor, sweepExtent, sweepParam, SWEEP_DURATION, type CurvePoint } from './slices';
import { buildAxes } from './scales';
import { curveOf } from './scene';

const dir = path.resolve(__dirname, '../../public/datasets');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { file: string; device: string; mode: string }[];
const records: SvmRecord[] = manifest.map((m) => ({ ...(JSON.parse(fs.readFileSync(path.join(dir, m.file), 'utf8')) as Dataset), id: m.file, device: m.device, mode: m.mode, source: 'bundled' }));

const FPS = 60;
const MAX_STEP = 0.02;
const MAX_ENTER_ALPHA = 0.1;
const MAX_DALPHA = 0.2;

interface Case {
  mode: SliceMode;
  axisMode: 'standard' | 'free';
  clip: boolean;
}
const cases: Case[] = [
  { mode: 'gray', axisMode: 'standard', clip: true },
  { mode: 'gray', axisMode: 'free', clip: true },
  { mode: 'brightness', axisMode: 'standard', clip: true },
  { mode: 'brightness', axisMode: 'free', clip: true },
  { mode: 'brightness', axisMode: 'free', clip: false },
];

function check(rec: SvmRecord, c: Case): string[] {
  const ext = c.axisMode === 'standard' ? null : sweepExtent([rec], c.mode, c.clip);
  const ax = buildAxes(c.mode, c.axisMode, ext);
  const nx = (x: number) => (Math.min(ax.x.u1, Math.max(ax.x.u0, c.mode === 'gray' ? Math.log10(x) : x)) - ax.x.u0) / (ax.x.u1 - ax.x.u0);
  const ny = (y: number) => (Math.min(ax.y.u1, Math.max(ax.y.u0, y)) - ax.y.u0) / (ax.y.u1 - ax.y.u0);
  const frame = (t: number) => sliceFor(rec, c.mode, sweepParam(c.mode, t), c.clip);
  const byKey = (pts: CurvePoint[]) => new Map(pts.map((p) => [p.key, p]));
  const dist = (p: CurvePoint, q: CurvePoint) => Math.max(Math.abs(nx(p.x) - nx(q.x)), Math.abs(ny(p.svm) - ny(q.svm))) * Math.max(p.a, q.a);
  const bridges = (pts: CurvePoint[]) => {
    const keys = [...pts].sort((a, b) => a.key - b.key).map((p) => p.key);
    const m = new Map<string, number>();
    for (const b of curveOf(c.mode, pts)?.bridges ?? []) m.set(`${keys[b.i0]}-${keys[b.i1]}`, b.alpha);
    return m;
  };
  const errors: string[] = [];
  const N = SWEEP_DURATION * FPS;
  let prev = frame(0);
  let prevB = bridges(prev);
  for (let f = 1; f <= N; f++) {
    const t0 = (f - 1) / FPS;
    const t = f / FPS;
    const cur = frame(t);
    const curB = bridges(cur);
    const pm = byKey(prev);
    const cm = byKey(cur);
    const at = `${rec.id} ${c.mode}/${c.axisMode}/${c.clip ? 'clip' : 'all'} t=${t.toFixed(3)}`;
    for (const [k, p] of cm) {
      const q = pm.get(k);
      if (!q) {
        if (p.a > MAX_ENTER_ALPHA) errors.push(`${at} key ${k} appears at alpha ${p.a.toFixed(2)}`);
        continue;
      }
      if (Math.abs(p.a - q.a) > MAX_DALPHA) errors.push(`${at} key ${k} alpha ${q.a.toFixed(2)} -> ${p.a.toFixed(2)}`);
      const d = dist(p, q);
      if (d > MAX_STEP) {
        // continuous motion or a pop? Refine the frame interval.
        let last = q;
        let maxSub = 0;
        for (let k2 = 1; k2 <= 8; k2++) {
          const s = byKey(frame(t0 + (k2 / 8) * (t - t0))).get(k);
          if (!s) {
            maxSub = Infinity;
            break;
          }
          maxSub = Math.max(maxSub, dist(s, last));
          last = s;
        }
        if (maxSub > d / 2) errors.push(`${at} key ${k} jumps ${(d * 100).toFixed(1)} % (largest sub-step ${(maxSub * 100).toFixed(1)} %)`);
      }
    }
    for (const [k, q] of pm) if (!cm.has(k) && q.a > MAX_ENTER_ALPHA) errors.push(`${at} key ${k} vanishes at alpha ${q.a.toFixed(2)}`);
    for (const k of new Set([...curB.keys(), ...prevB.keys()])) {
      const d = Math.abs((curB.get(k) ?? 0) - (prevB.get(k) ?? 0));
      if (d > MAX_DALPHA) errors.push(`${at} bridge ${k} alpha changes by ${d.toFixed(2)}`);
    }
    prev = cur;
    prevB = curB;
  }
  return errors;
}

describe('sweeps never pop (all bundled records, 60 fps)', () => {
  it('has the bundled records, including the two with excluded cells', () => {
    expect(records.length).toBe(14);
    expect(records.filter((r) => r.excluded?.length).length).toBe(2);
  });
  for (const c of cases) {
    it(`${c.mode} sweep, ${c.axisMode} axes${c.clip ? '' : ', low grays shown'}`, () => {
      const errors = records.flatMap((r) => check(r, c));
      expect(errors.slice(0, 10)).toEqual([]);
    });
  }
});
