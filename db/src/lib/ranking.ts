/**
 * Uniformity leaderboard: one measured number per device for a chosen condition and metric, sorted
 * best first. Pure functions over the catalog and data/uniformity/index.json; a device without the
 * number is listed separately (never ranked as 0 or estimated).
 */
import type { Device } from '../../catalog/types';
import type { UniformityIndex } from './types';
import { CONDITION_ORDER, gammaReadout, uniformityViews } from './uniformity';

export type RankCond = (typeof CONDITION_ORDER)[number];

export const RANK_METRICS = ['area', 'ninePoint', 'deviation', 'cctArea'] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

export const RANK_METRIC_META: Record<
  RankMetric,
  {
    label: string;
    unit: string;
    digits: number;
    higherIsBetter: boolean;
    note: string;
  }
> = {
  area: {
    label: '面均匀性',
    unit: '%',
    digits: 1,
    higherIsBetter: true,
    note: '越高越均匀',
  },
  ninePoint: {
    label: '9 点均匀性',
    unit: '%',
    digits: 1,
    higherIsBetter: true,
    note: '越高越均匀',
  },
  deviation: {
    label: '偏离典型值 >10 % 的面积',
    unit: '%',
    digits: 2,
    higherIsBetter: false,
    note: '越低越好',
  },
  cctArea: {
    label: '面色温差',
    unit: 'K',
    digits: 0,
    higherIsBetter: false,
    note: '越低越好',
  },
};

export const isRankCond = (s: string | null): s is RankCond => !!s && (CONDITION_ORDER as readonly string[]).includes(s);
export const isRankMetric = (s: string | null): s is RankMetric => !!s && (RANK_METRICS as readonly string[]).includes(s);

export interface RankRow {
  device: Device;
  value: number;
  /** 1-based; equal values (at the shown precision) share a rank. */
  rank: number;
  typical: number | null;
  /** Gamma 2.2 reference of a G20 condition, else null. */
  reference: number | null;
  areaUniformity: number | null;
  hasMap: boolean;
}

export interface Ranking {
  rows: RankRow[];
  /** Devices in the catalog without this number (status word shown instead). */
  missing: Device[];
}

export function metricValue(
  metrics: {
    luminance?: {
      areaUniformityPct: number;
      ninePointUniformityPct: number;
      deviation10PctArea: number;
    };
    colorTemperature?: { areaSpreadK: number };
  },
  metric: RankMetric,
): number | null {
  const lum = metrics.luminance;
  const v =
    metric === 'area'
      ? lum?.areaUniformityPct
      : metric === 'ninePoint'
        ? lum?.ninePointUniformityPct
        : metric === 'deviation'
          ? lum?.deviation10PctArea
          : metrics.colorTemperature?.areaSpreadK;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function rankUniformity(devices: Device[], index: UniformityIndex, cond: RankCond, metric: RankMetric): Ranking {
  const meta = RANK_METRIC_META[metric];
  const rows: Omit<RankRow, 'rank'>[] = [];
  const missing: Device[] = [];
  for (const device of devices) {
    const view = uniformityViews(device, index).find((v) => v.cond.id === cond);
    const value = view ? metricValue(view.cond.metrics, metric) : null;
    if (!view || value === null) {
      missing.push(device);
      continue;
    }
    const lum = view.cond.metrics.luminance;
    rows.push({
      device,
      value,
      typical: lum?.typical ?? null,
      reference: lum ? (gammaReadout(view.cond, lum.typical)?.ref ?? null) : null,
      areaUniformity: lum?.areaUniformityPct ?? null,
      hasMap: !!view.cond.maps?.luminance,
    });
  }
  rows.sort((a, b) => (meta.higherIsBetter ? b.value - a.value : a.value - b.value) || a.device.name.zh.localeCompare(b.device.name.zh, 'zh'));
  const key = (v: number) => v.toFixed(meta.digits);
  const ranked: RankRow[] = [];
  rows.forEach((r, i) => {
    const prev = ranked[i - 1];
    ranked.push({
      ...r,
      rank: prev && key(prev.value) === key(r.value) ? prev.rank : i + 1,
    });
  });
  return { rows: ranked, missing };
}
