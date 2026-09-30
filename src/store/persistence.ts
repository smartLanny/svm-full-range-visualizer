import { createStore, del, get, promisifyRequest, set, type UseStore } from 'idb-keyval';
import type { SvmRecord } from '../types';
import { DEFAULT_SETTINGS, SETTINGS_REV, useAppStore, type RecordPrefs, type Settings } from './appStore';

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

export type RecordNames = Pick<SvmRecord, 'name' | 'device' | 'mode'>;
/**
 * Local edit of a bundled record. `orig` = the manifest values the edit was made against, so a
 * field the user did not change follows later manifest fixes (older saves have no `orig`).
 */
export interface RecordEdit extends RecordNames {
  orig?: RecordNames;
}

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

/**
 * Write several keys in one transaction and commit it right away. Used by the autosave so a
 * flush started from pagehide is handed to the database before the page is torn down (an
 * uncommitted transaction is aborted with the page).
 */
async function writeMany(entries: [string, unknown][]): Promise<void> {
  const s = store();
  if (!s || !entries.length) return;
  try {
    await s('readwrite', (os) => {
      for (const [k, v] of entries) os.put(v, k);
      const tx = os.transaction as IDBTransaction & { commit?: () => void };
      tx.commit?.();
      return promisifyRequest(tx);
    });
  } catch (e) {
    console.warn('Persistence write failed:', entries.map(([k]) => k).join(', '), e);
  }
}

/**
 * Changes flushed while the page was being hidden / closed are also written synchronously to
 * localStorage: Chrome aborts IndexedDB transactions still running when the document is torn
 * down, so the IndexedDB write alone can lose the last change. The next start applies this
 * snapshot over IndexedDB, writes it there and removes it.
 */
const PENDING_LS = 'svm.persist.pending.v1';

function writePendingSnapshot(entries: [string, unknown][]) {
  if (!entries.length) return;
  try {
    localStorage.setItem(PENDING_LS, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota (large imported records): keep at least the small keys.
    try {
      localStorage.setItem(PENDING_LS, JSON.stringify(Object.fromEntries(entries.filter(([k]) => k !== KEY.userRecords))));
    } catch {
      /* storage unavailable */
    }
  }
}

function readPendingSnapshot(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(PENDING_LS);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dropPendingSnapshot() {
  try {
    localStorage.removeItem(PENDING_LS);
  } catch {
    /* ignore */
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
  const out: PersistedState = { settings, prefs, userRecords, bundledEdits, removedBundled };
  const pending = readPendingSnapshot();
  if (pending) {
    const known = Object.entries(KEY) as [keyof PersistedState, string][];
    const entries: [string, unknown][] = [];
    for (const [field, key] of known) {
      if (!(key in pending)) continue;
      (out as Record<string, unknown>)[field] = pending[key];
      entries.push([key, pending[key]]);
    }
    await writeMany(entries);
    dropPendingSnapshot();
  }
  return out;
}

/** Forget the saved display settings and record roles (keeps records, edits and the language). */
export async function resetPersistedView(lang?: Settings['lang']): Promise<void> {
  dropPendingSnapshot();
  const s = store();
  if (!s) return;
  await Promise.all([lang ? safeSet(KEY.settings, { lang }) : del(KEY.settings, s).catch(() => undefined), del(KEY.prefs, s).catch(() => undefined)]);
}

/** Wipe everything stored locally (settings, imported records, edits). */
export async function clearPersisted(): Promise<void> {
  dropPendingSnapshot();
  const s = store();
  if (!s) return;
  await Promise.all(Object.values(KEY).map((k) => del(k, s).catch(() => undefined)));
}

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/** Bundled records as loaded from the manifest (id -> names); used for removals and edits. */
let bundledManifest = new Map<string, RecordNames>();
export function setBundledManifest(records: Pick<SvmRecord, 'id' | 'name' | 'device' | 'mode'>[]) {
  bundledManifest = new Map(records.map((r) => [r.id, { name: r.name, device: r.device, mode: r.mode }]));
}

const NAME_FIELDS = ['name', 'device', 'mode'] as const;

/** Edits worth saving: only bundled records whose name / device / mode differ from the manifest. */
export function bundledEditsOf(records: SvmRecord[], manifest: Map<string, RecordNames>): Record<string, RecordEdit> {
  const edits: Record<string, RecordEdit> = {};
  for (const r of records) {
    const orig = r.source === 'bundled' ? manifest.get(r.id) : undefined;
    if (!orig || NAME_FIELDS.every((f) => r[f] === orig[f])) continue;
    edits[r.id] = { name: r.name, device: r.device, mode: r.mode, orig };
  }
  return edits;
}

/**
 * Apply a saved edit to a freshly loaded bundled record, field by field: a field the user changed
 * wins; a field left as it was follows the current manifest. English aliases are dropped only
 * for a device / mode that really differs from the manifest.
 */
export function applyBundledEdit(rec: SvmRecord, e: RecordEdit | undefined): SvmRecord {
  if (!e || typeof e !== 'object') return rec;
  const next: SvmRecord = { ...rec };
  let changed = false;
  for (const f of NAME_FIELDS) {
    const v = e[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (e.orig && v === e.orig[f]) continue; // not edited: keep the manifest value
    if (v === rec[f]) continue;
    next[f] = v;
    changed = true;
  }
  if (!changed) return rec;
  if (next.device !== rec.device) next.deviceEn = undefined;
  if (next.mode !== rec.mode) next.modeEn = undefined;
  return next;
}

let flushNow: (() => void) | null = null;
let suspended = false;

/** Write pending changes immediately (page hide / close). */
export function flushAutoSave() {
  flushNow?.();
}

/** Stop saving for good (before wiping local data and reloading). */
export function suspendAutoSave() {
  suspended = true;
}

/** Subscribe to the store and save (debounced). Returns an unsubscribe function. */
export function startAutoSave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSettings = '';
  let lastPrefs = '';
  let lastRecords: SvmRecord[] | null = null;

  /** `sync`: the page is going away — also keep a synchronous snapshot (see PENDING_LS). */
  const flush = (sync = false) => {
    timer = null;
    if (suspended) return;
    const s = useAppStore.getState();
    const writes: [string, unknown][] = [];
    const settings: Partial<Settings> & { rev: number } = { rev: SETTINGS_REV };
    for (const k of SETTINGS_KEYS) (settings as Record<string, unknown>)[k] = s[k];
    const settingsJson = JSON.stringify(settings);
    if (settingsJson !== lastSettings) {
      lastSettings = settingsJson;
      writes.push([KEY.settings, settings]);
    }
    const prefs: RecordPrefs = { hiddenIds: s.hiddenIds, activeId: s.activeId, compareId: s.compareId, compareExtraIds: s.compareExtraIds, deviceColors: s.deviceColors };
    const prefsJson = JSON.stringify(prefs);
    if (prefsJson !== lastPrefs) {
      lastPrefs = prefsJson;
      writes.push([KEY.prefs, prefs]);
    }
    if (s.records !== lastRecords) {
      lastRecords = s.records;
      writes.push([KEY.userRecords, s.records.filter((r) => r.source === 'user')]);
      writes.push([KEY.bundledEdits, bundledEditsOf(s.records, bundledManifest)]);
      const present = new Set(s.records.map((r) => r.id));
      writes.push([KEY.removedBundled, [...bundledManifest.keys()].filter((id) => !present.has(id))]);
    }
    void writeMany(writes);
    if (sync) writePendingSnapshot(writes);
  };

  const unsub = useAppStore.subscribe((state, prev) => {
    if (!state.ready || suspended) return;
    if (state === prev) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => flush(), 400);
  });

  // The debounce must not lose the last change when the page goes away: write it now. IndexedDB
  // transactions started from pagehide / visibilitychange normally complete.
  const flushPending = () => {
    if (!timer || suspended) return;
    clearTimeout(timer);
    flush(true);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushPending();
  };
  window.addEventListener('pagehide', flushPending);
  document.addEventListener('visibilitychange', onVisibility);
  flushNow = flushPending;
  return () => {
    unsub();
    window.removeEventListener('pagehide', flushPending);
    document.removeEventListener('visibilitychange', onVisibility);
    if (flushNow === flushPending) flushNow = null;
    if (timer) clearTimeout(timer);
  };
}
