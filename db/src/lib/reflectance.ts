/**
 * Reflectance read-out (data/reflectance/index.json, instrument XML points, 400–700 nm every 10 nm).
 * SCI = specular component included (全反射), SCE = specular component excluded (漫反射).
 * Values are the instrument's own points; nothing is interpolated or smoothed.
 */
import type { Device, ReflectanceEntry } from '../../catalog/types';
import type { ReflectanceCondition, ReflectanceIndex } from './types';

export interface ReflectanceView {
  entry: ReflectanceEntry;
  cond: ReflectanceCondition;
}

export function reflectanceViews(device: Device, index: ReflectanceIndex | null): ReflectanceView[] {
  if (!index) return [];
  const phone = index.phones.find((p) => p.id === device.id);
  if (!phone) return [];
  return device.reflectance.flatMap((entry) => {
    const cond = phone.conditions.find((c) => c.id === entry.condition);
    return cond ? [{ entry, cond }] : [];
  });
}

/** Arithmetic mean of the measured points (each point counts once; 31 points at 10 nm). */
export function meanOf(samples: [number, number][] | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  return samples.reduce((s, [, v]) => s + v, 0) / samples.length;
}

/** Value at exactly `nm` (a measured point), else null. */
export function valueAt(samples: [number, number][] | undefined, nm: number): number | null {
  const p = samples?.find(([w]) => w === nm);
  return p ? p[1] : null;
}

/**
 * Index of the measured wavelength nearest to `nm` (hover snapping). `wavelengths` ascending;
 * ties go to the shorter wavelength. −1 for an empty list.
 */
export function snapIndex(wavelengths: number[], nm: number): number {
  if (wavelengths.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < wavelengths.length; i++) if (Math.abs(wavelengths[i] - nm) < Math.abs(wavelengths[best] - nm)) best = i;
  return best;
}

/** Upper bound of the y axis: the next step of 1 % (2 % above 10 %) over the largest value. */
export function axisMax(maxValue: number): number {
  if (!(maxValue > 0)) return 1;
  const step = maxValue > 10 ? 2 : 1;
  return Math.ceil((maxValue * 1.04) / step) * step;
}

/** Chip text: the catalog label (it already names the state, screen and date where the source does). */
export const conditionChipLabel = (v: ReflectanceView) => v.entry.label;
