/**
 * Flicker (SVM) records for the database page, computed with the workbench's own pure functions
 * (src/data, src/stats — imported read-only), with the workbench's default view settings:
 * denoise on, G ≥ 15, level luminance ≤ 500 nits, gray slice G127, default scenarios.
 *
 * A record with no level at or below the 500 nits cap (Huawei Mate 90 Pro Max: 591 / 715 / 923 nits
 * only) is never shown blank: its cap is widened to the next "nice" value that covers the record,
 * and the page says so (「超出默认 ≤500 nits 显示范围」).
 */
import type { Dataset, SvmRecord } from '../../../src/types';
import { DEFAULT_MAX_NITS, LOW_GRAY_CLIP } from '../../../src/types';
import { toRecord, validateDataset } from '../../../src/data/records';
import { processRecord, rawDataset } from '../../../src/data/denoise';
import { gridView, levelRange } from '../../../src/data/grid';
import { computeRecordStats, type RecordStats } from '../../../src/data/stats';
import { DEFAULT_SCENARIOS } from '../../../src/data/scenarios';
import type { ManifestEntry } from '../../../src/data/bundled';
import type { SvmEntry } from '../../catalog/types';

export const SLICE_GRAY = 127;
export const CLIP_LOW_GRAY = true;
export { DEFAULT_MAX_NITS, LOW_GRAY_CLIP };

const NICE_CAPS = [500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000];

/** Same as the workbench's bundled loader: validated, kept RAW (excluded points restored). */
export function recordFromJson(entry: ManifestEntry, json: unknown): SvmRecord {
  const ds: Dataset = rawDataset(validateDataset(json));
  return toRecord(ds, 'bundled', {
    id: `bundled:${entry.file}`,
    device: entry.device,
    mode: entry.mode,
    deviceEn: entry.deviceEn ?? entry.device,
    modeEn: entry.modeEn ?? entry.mode,
  });
}

export interface CapChoice {
  /** Level-luminance cap used for this record (null = all levels). */
  maxNits: number | null;
  /** True when the default 500 nits cap showed nothing and was widened. */
  widened: boolean;
  /** Measured level-luminance range of the record (nits). */
  range: [number, number] | null;
}

/** Default cap (500 nits), or the smallest nice cap covering the record when 500 shows nothing. */
export function capFor(rec: Pick<Dataset, 'matrix'>): CapChoice {
  const range = levelRange(rec);
  const view = gridView(rec, { clipLowGray: CLIP_LOW_GRAY, maxNits: DEFAULT_MAX_NITS });
  if (view.x.length > 0 && view.grays.length > 0) return { maxNits: DEFAULT_MAX_NITS, widened: false, range };
  if (!range) return { maxNits: null, widened: true, range };
  const cap = NICE_CAPS.find((c) => c >= range[1]) ?? null;
  return { maxNits: cap, widened: true, range };
}

export interface SvmView {
  entry: SvmEntry;
  /** Displayed record (denoise on, as in the workbench default). */
  rec: SvmRecord;
  cap: CapChoice;
  stats: RecordStats;
}

export function svmView(entry: SvmEntry, raw: SvmRecord): SvmView {
  const rec = processRecord(raw, { denoise: true }).record;
  const cap = capFor(rec);
  const stats = computeRecordStats(rec, { clipLowGray: CLIP_LOW_GRAY, maxNits: cap.maxNits, sliceGray: SLICE_GRAY, scenarios: DEFAULT_SCENARIOS });
  return { entry, rec, cap, stats };
}

/** Mode chip label: the manifest's mode verbatim, prefixed by the screen on foldables / dual screens. */
export function svmChipLabel(entry: SvmEntry, multiDisplay: boolean): string {
  const screen = entry.display === 'inner' ? '内屏' : entry.display === 'outer' ? '外屏' : '';
  return multiDisplay && screen ? `${screen} · ${entry.mode}` : entry.mode;
}

/** Union extent (thumbnail scale) over several records, each with its own cap. */
export { thumbExtent } from '../../../src/stats/heatmap';
