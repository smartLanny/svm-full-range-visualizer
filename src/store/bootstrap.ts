import { loadBundledRecords } from '../data/bundled';
import type { SvmRecord } from '../types';
import { DEFAULT_SETTINGS, useAppStore, type Settings } from './appStore';
import { loadPersisted, setBundledIds, startAutoSave } from './persistence';

let started = false;

/**
 * Load persisted settings/preferences, bundled records and local user records, then start
 * auto-saving. Safe to call more than once (runs once).
 */
export async function bootstrap(): Promise<void> {
  if (started) return;
  started = true;
  const [persisted, bundled] = await Promise.all([loadPersisted(), loadBundledRecords()]);
  setBundledIds(bundled.map((r) => r.id));

  const removed = new Set(persisted.removedBundled ?? []);
  const edits = persisted.bundledEdits ?? {};
  const bundledKept = bundled
    .filter((r) => !removed.has(r.id))
    .map((r) => {
      const e = edits[r.id];
      if (!e) return r;
      const next: SvmRecord = { ...r, name: e.name, device: e.device, mode: e.mode };
      if (e.device !== r.device) next.deviceEn = undefined;
      if (e.mode !== r.mode) next.modeEn = undefined;
      return next;
    });
  const user = (persisted.userRecords ?? []).filter((r) => r && r.matrix && Array.isArray(r.matrix.grid));
  const records = [...bundledKept, ...user];

  const store = useAppStore.getState();
  // Settings: only known keys, merged over defaults (tolerates older / newer saves).
  const saved = persisted.settings ?? {};
  const settings: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (k in saved && saved[k] !== undefined) (settings as Record<string, unknown>)[k] = saved[k];
  }
  if (settings.overlays) settings.overlays = { ...DEFAULT_SETTINGS.overlays, ...settings.overlays };
  store.patch(settings);

  const prefs = persisted.prefs ?? {};
  const ids = new Set(records.map((r) => r.id));
  useAppStore.setState({
    hiddenIds: (prefs.hiddenIds ?? []).filter((id) => ids.has(id)),
    activeId: prefs.activeId && ids.has(prefs.activeId) ? prefs.activeId : null,
    compareId: prefs.compareId && ids.has(prefs.compareId) ? prefs.compareId : null,
    deviceColors: prefs.deviceColors ?? {},
  });
  useAppStore.getState().setRecords(records);
  useAppStore.setState({ ready: true });
  startAutoSave();
}
