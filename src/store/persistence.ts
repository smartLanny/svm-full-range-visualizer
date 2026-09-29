import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { SvmRecord } from '../types';
import { DEFAULT_SETTINGS, useAppStore, type RecordPrefs, type Settings } from './appStore';

/**
 * Local persistence (IndexedDB, never uploaded). docs/adr/0007.
 * Everything is best-effort: if IndexedDB is unavailable (private mode, blocked storage)
 * the app runs normally without persistence.
 */

const KEY = {
  settings: 'settings.v2',
  prefs: 'prefs.v2',
  userRecords: 'userRecords.v2',
  bundledEdits: 'bundledEdits.v2',
  removedBundled: 'removedBundled.v2',
} as const;

export type RecordEdit = Pick<SvmRecord, 'name' | 'device' | 'mode'>;

export interface PersistedState {
  settings?: Partial<Settings>;
  prefs?: Partial<RecordPrefs>;
  userRecords?: SvmRecord[];
  bundledEdits?: Record<string, RecordEdit>;
  removedBundled?: string[];
}

let kv: UseStore | null = null;
function store(): UseStore | null {
  if (kv) return kv;
  try {
    if (typeof indexedDB === 'undefined') return null;
    kv = createStore('svm-full-range-visualizer', 'kv');
    return kv;
  } catch {
    return null;
  }
}

async function safeGet<T>(key: string): Promise<T | undefined> {
  const s = store();
  if (!s) return undefined;
  try {
    return (await get(key, s)) as T | undefined;
  } catch (e) {
    console.warn('Persistence read failed:', key, e);
    return undefined;
  }
}

async function safeSet(key: string, value: unknown): Promise<void> {
  const s = store();
  if (!s) return;
  try {
    await set(key, value, s);
  } catch (e) {
    console.warn('Persistence write failed:', key, e);
  }
}

export async function loadPersisted(): Promise<PersistedState> {
  const [settings, prefs, userRecords, bundledEdits, removedBundled] = await Promise.all([
    safeGet<Partial<Settings>>(KEY.settings),
    safeGet<Partial<RecordPrefs>>(KEY.prefs),
    safeGet<SvmRecord[]>(KEY.userRecords),
    safeGet<Record<string, RecordEdit>>(KEY.bundledEdits),
    safeGet<string[]>(KEY.removedBundled),
  ]);
  return { settings, prefs, userRecords, bundledEdits, removedBundled };
}

/** Wipe everything stored locally (settings, imported records, edits). */
export async function clearPersisted(): Promise<void> {
  const s = store();
  if (!s) return;
  await Promise.all(Object.values(KEY).map((k) => del(k, s).catch(() => undefined)));
}

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/** Bundled record ids present at startup; used to compute removals. */
let bundledIds: string[] = [];
export function setBundledIds(ids: string[]) {
  bundledIds = ids;
}

/** Subscribe to the store and save (debounced). Returns an unsubscribe function. */
export function startAutoSave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSettings = '';
  let lastPrefs = '';
  let lastRecords: SvmRecord[] | null = null;

  const flush = () => {
    timer = null;
    const s = useAppStore.getState();
    const settings: Partial<Settings> = {};
    for (const k of SETTINGS_KEYS) (settings as Record<string, unknown>)[k] = s[k];
    const settingsJson = JSON.stringify(settings);
    if (settingsJson !== lastSettings) {
      lastSettings = settingsJson;
      void safeSet(KEY.settings, settings);
    }
    const prefs: RecordPrefs = { hiddenIds: s.hiddenIds, activeId: s.activeId, compareId: s.compareId, deviceColors: s.deviceColors };
    const prefsJson = JSON.stringify(prefs);
    if (prefsJson !== lastPrefs) {
      lastPrefs = prefsJson;
      void safeSet(KEY.prefs, prefs);
    }
    if (s.records !== lastRecords) {
      lastRecords = s.records;
      void safeSet(
        KEY.userRecords,
        s.records.filter((r) => r.source === 'user'),
      );
      const edits: Record<string, RecordEdit> = {};
      for (const r of s.records) if (r.source === 'bundled') edits[r.id] = { name: r.name, device: r.device, mode: r.mode };
      void safeSet(KEY.bundledEdits, edits);
      const present = new Set(s.records.map((r) => r.id));
      void safeSet(
        KEY.removedBundled,
        bundledIds.filter((id) => !present.has(id)),
      );
    }
  };

  const unsub = useAppStore.subscribe((state, prev) => {
    if (!state.ready) return;
    if (state === prev) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}
