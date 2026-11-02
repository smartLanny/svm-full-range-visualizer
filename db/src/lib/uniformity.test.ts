import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../catalog/types';
import type { UniformityIndex } from './types';
import { fmtSig, fmtSignedPct } from './format';
import { barPosition, G20_FACTOR, gammaReadout, gammaRef, liftFlag, liftOf, liftText, uniformityViews, whiteFieldContext } from './uniformity';

const ROOT = path.resolve(__dirname, '../../..');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const catalog = read<Catalog>('data/devices.json');
const index = read<UniformityIndex>('data/uniformity/index.json');
const views = (id: string) => uniformityViews(catalog.devices.find((d) => d.id === id)!, index);

describe('Gamma 2.2 reference of the G20 pattern', () => {
  it('ref = W × (20/255)^2.2', () => {
    expect(G20_FACTOR).toBeCloseTo(0.0036972, 7);
    expect(gammaRef(100)).toBeCloseTo(0.36972, 5);
    expect(gammaRef(10)).toBeCloseTo(0.036972, 6);
    expect(liftOf(0.4868, gammaRef(100))).toBeCloseTo(0.3167, 4);
  });

  it('never flags with a nominal white level, whatever the lift (plan review)', () => {
    expect(liftFlag(0.317, 'nominal')).toBeNull();
    expect(liftFlag(0.9, 'nominal')).toBeNull();
  });

  it('flags a measured white level at +10 % / +25 %, never below the reference', () => {
    expect(liftFlag(0.099, 'measured')).toBeNull();
    expect(liftFlag(0.1, 'measured')).toBe('raised');
    expect(liftFlag(0.25, 'measured')).toBe('strongly-raised');
    expect(liftFlag(-0.4, 'measured')).toBeNull();
  });

  it('uses whiteMeasuredNits when a batch recorded it', () => {
    const r = gammaReadout({ pattern: 'G20', referenceNits: 100, whiteMeasuredNits: 110 }, 0.4868);
    expect(r?.basis).toBe('measured');
    expect(r?.ref).toBeCloseTo(110 * G20_FACTOR, 9);
    expect(r?.flag).toBe('raised');
    expect(gammaReadout({ pattern: '全白场', referenceNits: 300 }, 296)).toBeNull();
  });

  // gamma.md rounds 小米 18 Pro Max 10 nits to +2.85 % → "+2.9"; the exact +2.848 % shows as +2.8 %.
  it('reads the real data as in gamma.md', () => {
    const mi17u = views('xiaomi-17-ultra').find((v) => v.cond.id === '100')!;
    const r = gammaReadout(mi17u.cond, mi17u.cond.metrics.luminance!.typical)!;
    expect(r.basis).toBe('nominal');
    expect(fmtSignedPct(r.lift)).toBe('+31.7 %');
    expect(liftText(r.lift)).toBe('高于参考 31.7 %');
    expect(r.gammaEff).toBeCloseTo(2.092, 3);
    expect(r.flag).toBeNull();

    const ip10 = views('iphone-18-pro-max').find((v) => v.cond.id === '10')!;
    expect(fmtSig(ip10.cond.metrics.luminance!.typical)).toBe('0.03723');
    const lifts = ['xiaomi-18-pro-max', 'iphone-18-pro-max', 'xiaomi-17-ultra'].flatMap((id) =>
      views(id)
        .map((v) => gammaReadout(v.cond, v.cond.metrics.luminance!.typical))
        .filter((x) => x !== null)
        .map((x) => fmtSignedPct(x!.lift)),
    );
    expect(lifts).toEqual(['+0.9 %', '+2.8 %', '+7.3 %', '+0.7 %', '+31.7 %', '+10.5 %']);
  });

  it('gives the 300 nits white field as context (measured / set)', () => {
    expect(whiteFieldContext(views('iphone-18-pro-max'))?.ratio).toBeCloseTo(1.1118, 4);
    expect(whiteFieldContext(views('xiaomi-18-pro-max'))?.ratio).toBeCloseTo(0.9871, 4);
    expect(whiteFieldContext([])).toBeNull();
  });

  it('places values on the colour bar, or nowhere when outside it', () => {
    expect(barPosition(100, 68.97, 114.94)).toBeCloseTo(0.675, 3);
    expect(barPosition(60, 68.97, 114.94)).toBeNull();
  });
});

describe('number formatting', () => {
  it('keeps 4 significant digits, trailing zeros included', () => {
    expect(fmtSig(0.037227)).toBe('0.03723');
    expect(fmtSig(0.396789)).toBe('0.3968');
    expect(fmtSig(296.120574)).toBe('296.1');
    expect(fmtSig(0.37)).toBe('0.3700');
    expect(fmtSig(12345.6)).toBe('12346');
  });
  it('signs percentages with a real minus', () => {
    expect(fmtSignedPct(0.0732)).toBe('+7.3 %');
    expect(fmtSignedPct(-0.17)).toBe('−17.0 %');
    expect(fmtSignedPct(0.0001)).toBe('0.0 %');
  });
});
