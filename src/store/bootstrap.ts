import { loadBundledRecords } from '../data/bundled';
import { validateDataset } from '../data/records';
import { ColormapType, type SvmRecord } from '../types';
import { cleanExtras, DEFAULT_SETTINGS, useAppStore, type Overlays, type RecordPrefs, type Settings } from './appStore';
import { applyBundledEdit, loadPersisted, setBundledManifest, startAutoSave } from './persistence';

let started = false;

export interface BootstrapResult {
  /** Stored user records that failed validation and were dropped. */
  droppedRecords: number;
}

type Check = (v: unknown) => boolean;
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v) =>
    values.includes(v);
const isBool: Check = (v) => typeof v === 'boolean';
const inRange =
  (lo: number, hi: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Allowed values per persisted setting; anything else falls back to the default. */
const SETTING_CHECKS: { [K in keyof Settings]: Check } = {
  lang: oneOf('zh', 'en'),
  tab: oneOf('scene3d', 'chart2d', 'stats'),
  clipLowGray: isBool,
  maxNits: (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0),
  representation: oneOf('surface', 'bars'),
  view: oneOf('perspective', 'top', 'front', 'side'),
  layout: oneOf('single', 'sideBySide', 'diff'),
  colormap: oneOf(...Object.values(ColormapType)),
  lighting: oneOf('studio', 'flat'),
  heightScale: inRange(0.1, 10),
  heightCap: inRange(0.5, 50),
  colorMax: inRange(0.5, 50),
  overlays: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  sliceMode: oneOf('gray', 'brightness'),
  sliceGray: inRange(0, 255),
  sliceNits: inRange(0.01, 100000),
  axisMode: oneOf('standard', 'adaptive', 'free'),
  stageAspect: oneOf('fit', '16:9', '9:16', '1:1'),
  presentBlack: isBool,
};

/**
 * Persisted settings, key by key: only known keys with an allowed value survive (an unknown
 * language or view would otherwise break rendering on every start); the rest use defaults.
 */
export function sanitizeSettings(saved: unknown): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!saved || typeof saved !== 'object') return out;
  const src = saved as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(k in src) || !SETTING_CHECKS[k](src[k])) continue;
    (out as Record<string, unknown>)[k] = src[k];
  }
  if (out.overlays) {
    const o = out.overlays as unknown as Record<string, unknown>;
    const overlays: Overlays = { ...DEFAULT_SETTINGS.overlays };
    for (const k of Object.keys(overlays) as (keyof Overlays)[]) if (typeof o[k] === 'boolean') overlays[k] = o[k] as boolean;
    out.overlays = overlays;
  }
  return out;
}

/**
 * Stored user records, validated like an import (structure, numeric cells, at least one valid
 * cell). Invalid ones are dropped so one bad record can never blank the app.
 */
export function sanitizeUserRecords(saved: unknown): { records: SvmRecord[]; dropped: number } {
  if (!Array.isArray(saved)) return { records: [], dropped: 0 };
  const records: SvmRecord[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const r of saved as Partial<SvmRecord>[]) {
    try {
      const ds = validateDataset(r);
      const id = r && typeof r.id === 'string' ? r.id : '';
      if (!id || seen.has(id) || id.startsWith('bundled:')) throw new Error('INVALID_ID');
      seen.add(id);
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const device = str(r.device)?.trim() || ds.name;
      records.push({
        ...ds,
        id,
        source: 'user',
        device,
        mode: str(r.mode) ?? '',
        deviceEn: str(r.deviceEn),
        modeEn: str(r.modeEn),
      });
    } catch (e) {
      dropped++;
      console.warn('Dropped an invalid stored record:', (e as Error).message);
    }
  }
  return { records, dropped };
}

/**
 * Persisted record roles, checked against the loaded records: unknown ids are dropped; the extra
 * side-by-side panels are made unique, never A or B, at most four (setRecords re-checks them
 * against the final A / B).
 */
export function sanitizePrefs(saved: unknown, ids: Set<string>): Partial<RecordPrefs> {
  const p = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const colors: Record<string, string> = {};
  if (p.deviceColors && typeof p.deviceColors === 'object')
    for (const [k, v] of Object.entries(p.deviceColors as Record<string, unknown>)) if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)) colors[k] = v;
  const id = (v: unknown) => (typeof v === 'string' && ids.has(v) ? v : null);
  const activeId = id(p.activeId);
  const compareId = id(p.compareId);
  return {
    hiddenIds: strings(p.hiddenIds).filter((h) => ids.has(h)),
    activeId,
    compareId,
    compareExtraIds: cleanExtras(strings(p.compareExtraIds), ids, activeId, compareId),
    deviceColors: colors,
  };
}

/**
 * Load persisted settings/preferences, bundled records and local user records, then start
 * auto-saving. Safe to call more than once (runs once).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  if (started) return { droppedRecords: 0 };
  started = true;
  const [persisted, bundled] = await Promise.all([loadPersisted(), loadBundledRecords()]);
  setBundledManifest(bundled);

  const removed = new Set(Array.isArray(persisted.removedBundled) ? persisted.removedBundled : []);
  const edits = persisted.bundledEdits && typeof persisted.bundledEdits === 'object' ? persisted.bundledEdits : {};
  const bundledKept = bundled.filter((r) => !removed.has(r.id)).map((r) => applyBundledEdit(r, edits[r.id]));
  const user = sanitizeUserRecords(persisted.userRecords);
  const records = [...bundledKept, ...user.records];

  useAppStore.getState().patch(sanitizeSettings(persisted.settings));
  const ids = new Set(records.map((r) => r.id));
  useAppStore.setState(sanitizePrefs(persisted.prefs, ids));
  useAppStore.getState().setRecords(records);
  useAppStore.setState({ ready: true });
  startAutoSave();
  return { droppedRecords: user.dropped };
}
