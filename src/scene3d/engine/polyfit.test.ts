import { describe, expect, it } from 'vitest';
import { PolyCurve } from './polyfit';

describe('PolyCurve', () => {
  it('reproduces a polynomial of its degree exactly', () => {
    const xs = Array.from({ length: 30 }, (_, i) => 0.2 + i * 0.05);
    const f = (x: number) => 1 - 2 * x + 0.5 * x * x * x;
    const c = new PolyCurve(0.2, 1.65, xs, xs.map(f), 3);
    for (const x of [0.2, 0.7, 1.3, 1.65]) expect(c.at(x)).toBeCloseTo(f(x), 9);
  });

  it('smooths a kink instead of following it', () => {
    const xs = Array.from({ length: 49 }, (_, i) => i / 48);
    const kink = (x: number) => Math.abs(x - 0.3);
    const c = new PolyCurve(0, 1, xs, xs.map(kink), 5);
    // Close to the data, but the slope changes gradually through the kink.
    for (const x of xs) expect(Math.abs(c.at(x) - kink(x))).toBeLessThan(0.05);
    const h = 1e-3;
    const slope = (x: number) => (c.at(x + h) - c.at(x - h)) / (2 * h);
    expect(Math.abs(slope(0.31) - slope(0.29))).toBeLessThan(0.2);
  });
});
