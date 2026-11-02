/**
 * Viewing-angle summary (data/angle/summary.json): numbers computed by the standalone
 * phone-view-angle-sim model itself (pipeline/angle/summarise.mjs); the page only reads them.
 * Profiles the catalog marks as not measured (iPhone Duo outer: a temporary copy of p0) get no
 * numbers here, whatever the summary file holds.
 */
import type { AngleAtTheta, AngleEntry, AngleProfileSummary, AngleSummary, Device } from '../../catalog/types';

export const VIEW_ANGLE_SIM_URL = 'https://smartlanny.github.io/phone-view-angle-sim/';
export const THETAS = ['30', '45', '60'] as const;
export type Theta = (typeof THETAS)[number];

export const DIRECTIONS = [
  { group: 'horizontal', key: 'left', label: '左' },
  { group: 'horizontal', key: 'right', label: '右' },
  { group: 'vertical', key: 'up', label: '上' },
  { group: 'vertical', key: 'down', label: '下' },
] as const;
export type DirectionKey = (typeof DIRECTIONS)[number]['key'];

export interface AngleView {
  entry: AngleEntry;
  /** null when the catalog says not measured (no numbers are shown). */
  profile: AngleProfileSummary | null;
}

export function angleViews(device: Device, summary: AngleSummary | null): AngleView[] {
  return device.angle.map((entry) => {
    const p = summary?.profiles.find((x) => x.id === entry.profile) ?? null;
    return { entry, profile: entry.measured && p?.measured && p.metrics ? p : null };
  });
}

export function atTheta(p: AngleProfileSummary, dir: DirectionKey, theta: Theta): AngleAtTheta {
  const m = p.metrics!;
  const d = dir === 'left' || dir === 'right' ? m.horizontal[dir] : m.vertical[dir];
  return d.atTheta[theta];
}

export function halfLuminance(p: AngleProfileSummary, dir: DirectionKey): number | null {
  const m = p.metrics!;
  const d = dir === 'left' || dir === 'right' ? m.horizontal[dir] : m.vertical[dir];
  return d.halfLuminanceDeg;
}

/** [min, max] of a value over the four directions. */
export function rangeOver(p: AngleProfileSummary, f: (dir: DirectionKey) => number | null): [number, number] | null {
  const vals = DIRECTIONS.map((d) => f(d.key)).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!vals.length) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

/** State chip text: 默认 / 防窥膜 / 防窥模式 / 内屏 / 外屏. */
export function angleStateLabel(entry: AngleEntry, states: Record<string, { zh: string }>): string {
  return states[entry.state]?.zh ?? entry.state;
}
