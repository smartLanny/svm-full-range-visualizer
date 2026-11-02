/**
 * Uniformity read-out: the Gamma 2.2 reference of a G20 (gray 20 / 255) full-screen pattern and the
 * flag policy (decision: scratchpad db-plan/gamma.md, overridden by the plan review).
 *
 *   ref  = W × (20/255)^2.2 = W × 0.0036972
 *   lift = typical / ref − 1
 *   γeff = ln(typical / W) / ln(20/255)
 *
 * W is the measured white (G255) at the same brightness setting when a batch recorded one
 * (`whiteMeasuredNits`), else the nominal setting (100 or 10 nits) — then the reference carries the
 * setting error, about ±10 % (the 300 nits white fields measured 98.7–111.2 % of their setting).
 *
 * Flags (review): a coloured 「低灰阶亮度偏高」 flag only when W is measured (+10 % / +25 %). With a
 * nominal W there is never a flag: the page shows the neutral signed number, 「白场未实测，约 ±10%」
 * and the device's own 300 nits measured / set ratio as context. Below the reference: never a flag.
 */
import type { Device, UniformityEntry } from '../../catalog/types';
import type { UniformityCondition, UniformityIndex } from './types';

export const G20 = 20;
export const GAMMA = 2.2;
/** (20/255)^2.2 */
export const G20_FACTOR = (G20 / 255) ** GAMMA;
/** Setting error assumed when the white level was not measured (gamma.md: observed −1.3 … +11.2 %). */
export const NOMINAL_WHITE_ERROR = 0.1;

export const gammaRef = (whiteNits: number) => whiteNits * G20_FACTOR;
export const liftOf = (typical: number, ref: number) => typical / ref - 1;
export const gammaEff = (typical: number, whiteNits: number) => Math.log(typical / whiteNits) / Math.log(G20 / 255);

export type WhiteBasis = 'measured' | 'nominal';
export type LiftFlag = 'raised' | 'strongly-raised' | null;

/** Thresholds of the coloured flag, only ever applied to a measured white level. */
export const MEASURED_THRESHOLDS = { raised: 0.1, strong: 0.25 } as const;

export function liftFlag(lift: number, basis: WhiteBasis): LiftFlag {
  if (basis !== 'measured' || !Number.isFinite(lift)) return null;
  if (lift >= MEASURED_THRESHOLDS.strong) return 'strongly-raised';
  if (lift >= MEASURED_THRESHOLDS.raised) return 'raised';
  return null;
}

export const FLAG_TEXT: Record<Exclude<LiftFlag, null>, string> = {
  raised: '低灰阶亮度偏高',
  'strongly-raised': '低灰阶亮度明显偏高',
};

export interface GammaReadout {
  white: number;
  basis: WhiteBasis;
  ref: number;
  lift: number;
  gammaEff: number;
  flag: LiftFlag;
}

/** Reference read-out of one G20 condition (null for other patterns, e.g. the 300 nits white field). */
export function gammaReadout(cond: Pick<UniformityCondition, 'pattern' | 'referenceNits' | 'whiteMeasuredNits'>, typical: number): GammaReadout | null {
  if (cond.pattern !== 'G20' || !(typical > 0)) return null;
  const measured = typeof cond.whiteMeasuredNits === 'number' && cond.whiteMeasuredNits > 0;
  const white = measured ? (cond.whiteMeasuredNits as number) : cond.referenceNits;
  if (!(white > 0)) return null;
  const ref = gammaRef(white);
  const lift = liftOf(typical, ref);
  const basis: WhiteBasis = measured ? 'measured' : 'nominal';
  return { white, basis, ref, lift, gammaEff: gammaEff(typical, white), flag: liftFlag(lift, basis) };
}

/** "高于参考 7.3 %" / "低于参考 17.0 %" / "与参考持平". */
export function liftText(lift: number): string {
  const pct = Math.abs(lift * 100).toFixed(1);
  if (Number(pct) === 0) return '与参考持平';
  return `${lift > 0 ? '高于' : '低于'}参考 ${pct} %`;
}

/** Ratio measured / set of a white-field condition (300 nits): context for the reference error. */
export function whiteRatio(cond: Pick<UniformityCondition, 'pattern' | 'referenceNits'>, typical: number): number | null {
  if (cond.pattern === 'G20' || !(cond.referenceNits > 0) || !(typical > 0)) return null;
  return typical / cond.referenceNits;
}

/** One uniformity condition of a device: catalog entry joined with the verbatim index. */
export interface UniformityView {
  entry: UniformityEntry;
  cond: UniformityCondition;
}

export function uniformityViews(device: Device, index: UniformityIndex | null): UniformityView[] {
  if (!index) return [];
  const phone = index.phones.find((p) => p.id === device.id);
  if (!phone) return [];
  return device.uniformity.flatMap((entry) => {
    const cond = phone.conditions.find((c) => c.id === entry.condition);
    return cond ? [{ entry, cond }] : [];
  });
}

/** The 300 nits white field of the same device (context line under a G20 reference). */
export function whiteFieldContext(views: UniformityView[]): { typical: number; set: number; ratio: number } | null {
  for (const v of views) {
    const typ = v.cond.metrics.luminance?.typical;
    if (typ === undefined) continue;
    const r = whiteRatio(v.cond, typ);
    if (r !== null) return { typical: typ, set: v.cond.referenceNits, ratio: r };
  }
  return null;
}

/** Position (0–1 from the bottom) of `pct` on a colour bar spanning [min, max] percent; null outside. */
export function barPosition(pct: number, min: number, max: number): number | null {
  if (!(max > min)) return null;
  const f = (pct - min) / (max - min);
  return f >= 0 && f <= 1 ? f : null;
}

/** Condition chip text: "300 nits 白场" / "100 nits G20". */
export const CONDITION_ORDER = ['300', '100', '10'] as const;
