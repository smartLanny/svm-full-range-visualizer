import type { SvmRecord } from '../types';

/**
 * Categorical device palette (dark-surface steps of the validated reference palette,
 * checked with the dataviz validator against #0b0e14: CVD ΔE ≥ 8.4, normal ΔE ≥ 19.3,
 * contrast ≥ 3:1). Assigned to devices in order of first appearance — fixed order,
 * color follows the device, never its rank. See docs/adr/0006.
 */
export const DEVICE_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

/**
 * Line dash patterns (canvas setLineDash units, px at 1x) for the modes of one device, in
 * record order: solid, long dash, dot, dash-dot, short dash, long-short.
 */
export const MODE_DASHES: readonly number[][] = [[], [10, 6], [2, 5], [12, 5, 2, 5], [6, 4], [16, 4, 4, 4]];

/** Unique devices in order of first appearance. */
export function deviceOrder(records: Pick<SvmRecord, 'device'>[]): string[] {
  const seen: string[] = [];
  for (const r of records) if (!seen.includes(r.device)) seen.push(r.device);
  return seen;
}

/** device -> color. Overrides (user-picked colors) win; others take palette slots in order. */
export function deviceColors(records: Pick<SvmRecord, 'device'>[], overrides: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>();
  deviceOrder(records).forEach((d, i) => map.set(d, overrides[d] ?? DEVICE_PALETTE[i % DEVICE_PALETTE.length]));
  return map;
}

/** record id -> index of its mode within its device (record order). Drives MODE_DASHES. */
export function modeIndices(records: Pick<SvmRecord, 'id' | 'device'>[]): Map<string, number> {
  const perDevice = new Map<string, number>();
  const out = new Map<string, number>();
  for (const r of records) {
    const i = perDevice.get(r.device) ?? 0;
    out.set(r.id, i);
    perDevice.set(r.device, i + 1);
  }
  return out;
}

export function dashFor(modeIndex: number): number[] {
  return MODE_DASHES[modeIndex % MODE_DASHES.length];
}

export interface RecordStyle {
  color: string;
  dash: number[];
  modeIndex: number;
}

/** Style (color + dash) for every record, keyed by record id. */
export function recordStyles(records: SvmRecord[], overrides: Record<string, string> = {}): Map<string, RecordStyle> {
  const colors = deviceColors(records, overrides);
  const modes = modeIndices(records);
  const out = new Map<string, RecordStyle>();
  for (const r of records) {
    const modeIndex = modes.get(r.id) ?? 0;
    out.set(r.id, { color: colors.get(r.device)!, dash: dashFor(modeIndex), modeIndex });
  }
  return out;
}
