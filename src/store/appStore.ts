import { create } from 'zustand';
import { processRecord, type ProcessedRecord } from '../data/denoise';
import type {
  AxisMode,
  Dataset,
  Lang,
  LightingMode,
  MainTab,
  Representation,
  SceneLayout,
  SliceMode,
  StageAspect,
  SvmRecord,
  ViewPreset,
} from '../types';
import { ColormapType, DEFAULT_MAX_NITS, MAX_COMPARE_PANELS } from '../types';

/** Animated views. */
export type AnimTab = 'scene3d' | 'chart2d';

export interface Overlays {
  contours: boolean;
  /** Numeric SVM values printed in cells (top view). */
  values: boolean;
  axes: boolean;
  colorbar: boolean;
  /** In-canvas title (record name / slice). */
  title: boolean;
}

/** Persisted user settings. Everything here survives reloads (docs/adr/0007). */
export interface Settings {
  lang: Lang;
  tab: MainTab;
  /** Hide gray < 15 (docs/adr/0004). Shared by 3D, brightness slice and stats. */
  clipLowGray: boolean;
  /** Level-luminance cap for 3D / stats; null = show all columns. */
  maxNits: number | null;
  /**
   * 降噪 (docs/adr/0012 addendum): views show every record through processRecord — black-level
   * readings, SVM spikes and repeated readings filled by short-gap interpolation or shown as no
   * data, unreliable luminance estimated. Off: raw values everywhere. Records always stay raw.
   */
  denoise: boolean;

  // 3D terrain
  representation: Representation;
  view: ViewPreset;
  layout: SceneLayout;
  colormap: ColormapType;
  lighting: LightingMode;
  /** Vertical exaggeration multiplier (1 = default). */
  heightScale: number;
  /** SVM value at which terrain heights are capped (true value still shown in tooltips). */
  heightCap: number;
  /** SVM value mapped to the top of the colormap. */
  colorMax: number;
  overlays: Overlays;

  // 2D cross-section
  sliceMode: SliceMode;
  /** Gray level for the gray slice (0-255). */
  sliceGray: number;
  /** Level luminance (G255 nits) for the brightness slice. */
  sliceNits: number;
  axisMode: AxisMode;

  // Presentation
  stageAspect: StageAspect;
  /** Pure black background in presentation mode. */
  presentBlack: boolean;
}

/**
 * Revision of the saved settings format. Bumped when a default changes and older saves must
 * adopt the new default once; the revision is saved next to the settings (persistence.ts; migrations in bootstrap.ts sanitizeSettings).
 * 2: the 2D chart defaults to adaptive axes (a save without a revision still has the old
 *    'standard' default, which is dropped once so the new default applies).
 */
export const SETTINGS_REV = 2;

export const DEFAULT_SETTINGS: Settings = {
  lang: 'zh',
  tab: 'scene3d',
  clipLowGray: true,
  maxNits: DEFAULT_MAX_NITS,
  denoise: true,
  representation: 'surface',
  view: 'perspective',
  layout: 'single',
  colormap: ColormapType.RD_YL_BU_ENHANCED,
  lighting: 'studio',
  heightScale: 1,
  heightCap: 6,
  colorMax: 4,
  overlays: { contours: true, values: false, axes: true, colorbar: true, title: true },
  sliceMode: 'gray',
  sliceGray: 127,
  sliceNits: 100,
  axisMode: 'adaptive',
  stageAspect: 'fit',
  presentBlack: false,
};

/** Persisted per-record preferences. */
export interface RecordPrefs {
  /** Records hidden from the 2D chart / stats. */
  hiddenIds: string[];
  /** Record shown in 3D (A). */
  activeId: string | null;
  /** Second record for side-by-side / diff (B). */
  compareId: string | null;
  /**
   * Extra side-by-side panels C–F, in panel order (docs/adr/0002): at most four, unique, never A
   * or B, existing records only (see cleanExtras). Only the side-by-side layout shows them.
   */
  compareExtraIds: string[];
  /** device -> color override. */
  deviceColors: Record<string, string>;
}

export interface AppState extends Settings, RecordPrefs {
  /** Bundled first (manifest order), then user records (import order). */
  records: SvmRecord[];
  /** True once bundled + persisted records are loaded. */
  ready: boolean;

  /** Presentation mode (fullscreen, panels hidden). Not persisted. */
  presenting: boolean;
  /**
   * While presenting: CSS px from the stage's left edge that in-canvas titles must keep clear
   * because the presentation exit button (fixed top-left of the window) sits over the stage there.
   * 0 when not presenting or when the stage is letterboxed away from the button. Set by the shell.
   */
  presentSafeLeft: number;

  /** Views watch these nonces: increment = "start / stop your animation". */
  playNonce: Record<AnimTab, number>;
  stopNonce: Record<AnimTab, number>;
  /** Set by the views while their animation (timeline) is active. */
  animating: Record<AnimTab, boolean>;

  // --- actions ---
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (partial: Partial<Settings>) => void;
  setOverlay: (key: keyof Overlays, value: boolean) => void;
  resetSettings: () => void;

  setRecords: (records: SvmRecord[]) => void;
  addRecords: (records: SvmRecord[]) => void;
  /**
   * Put a record back at `index` (undo of a delete), restoring its hidden state and its A / B role
   * or its extra side-by-side panel (`extra` = index into compareExtraIds).
   */
  insertRecord: (record: SvmRecord, index: number, roles?: { a?: boolean; b?: boolean; hidden?: boolean; extra?: number }) => void;
  removeRecord: (id: string) => void;
  updateRecord: (id: string, patch: Partial<Pick<SvmRecord, 'name' | 'device' | 'mode'>>) => void;
  toggleHidden: (id: string) => void;
  setHidden: (ids: string[], hidden: boolean) => void;
  /** Set A. B picked as A swaps them; an extra panel picked as A takes the old A in its place. */
  setActive: (id: string | null) => void;
  /** Set B. A picked as B swaps them; an extra panel picked as B takes the old B in its place. */
  setCompare: (id: string | null) => void;
  /**
   * Side-by-side panels (docs/adr/0002): [A, B, ...extras], 2–6 records. `addComparePanel` appends
   * a record as the next extra panel (no-op when it is already a panel or all six are used);
   * `removeComparePanel` drops a panel (an extra, or A / B whose place the next panel takes —
   * never below two panels); `setComparePanel` puts a record in panel `index` (a record already
   * in another panel swaps with it); `setComparePanels` sets the whole ordered list (reorder, fill).
   */
  addComparePanel: (id: string) => void;
  removeComparePanel: (id: string) => void;
  setComparePanel: (index: number, id: string) => void;
  setComparePanels: (ids: string[]) => void;
  setDeviceColor: (device: string, color: string | null) => void;

  setPresenting: (on: boolean) => void;
  requestPlay: (tab: AnimTab) => void;
  requestStop: (tab: AnimTab) => void;
  setAnimating: (tab: AnimTab, on: boolean) => void;
}

/** First record other than `id` (B's default). */
const firstOther = (records: SvmRecord[], id: string | null) => records.find((r) => r.id !== id)?.id ?? null;

/**
 * Extra side-by-side panels, cleaned: existing records only, unique, never A or B, at most
 * MAX_COMPARE_PANELS − 2 (order kept). Returns `extras` itself when nothing changes (no store churn).
 */
export function cleanExtras(extras: readonly string[], ids: ReadonlySet<string>, a: string | null, b: string | null): string[] {
  const out: string[] = [];
  for (const id of extras) {
    if (out.length >= MAX_COMPARE_PANELS - 2) break;
    if (typeof id !== 'string' || !ids.has(id) || id === a || id === b || out.includes(id)) continue;
    out.push(id);
  }
  return out.length === extras.length && out.every((id, i) => id === extras[i]) ? (extras as string[]) : out;
}

/**
 * A record promoted to A / B leaves the extra panels: the record it displaced (the old A / B)
 * takes its slot, so the compared set stays the same; without a displaced record the slot closes.
 */
function promoteFromExtras(extras: string[], id: string | null, displaced: string | null, keep: (string | null)[]): string[] {
  const k = id === null ? -1 : extras.indexOf(id);
  if (k < 0) return extras;
  const next = [...extras];
  if (displaced !== null && !keep.includes(displaced) && !next.includes(displaced)) next[k] = displaced;
  else next.splice(k, 1);
  return next;
}

/** Side-by-side and diff need two records: with fewer, the layout falls back to single. */
const layoutFor = (records: SvmRecord[], layout: SceneLayout): { layout?: SceneLayout } =>
  records.length < 2 && layout !== 'single' ? { layout: 'single' } : {};

export const useAppStore = create<AppState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  hiddenIds: [],
  activeId: null,
  compareId: null,
  compareExtraIds: [],
  deviceColors: {},
  records: [],
  ready: false,
  presenting: false,
  presentSafeLeft: 0,
  playNonce: { scene3d: 0, chart2d: 0 },
  stopNonce: { scene3d: 0, chart2d: 0 },
  animating: { scene3d: false, chart2d: false },

  set: (key, value) => set({ [key]: value } as Partial<AppState>),
  patch: (partial) => set(partial),
  setOverlay: (key, value) => set({ overlays: { ...get().overlays, [key]: value } }),
  resetSettings: () => set({ ...DEFAULT_SETTINGS, lang: get().lang }),

  setRecords: (records) => {
    const { activeId, compareId } = get();
    const ids = new Set(records.map((r) => r.id));
    const a = activeId && ids.has(activeId) ? activeId : (records[0]?.id ?? null);
    const b = compareId && ids.has(compareId) && compareId !== a ? compareId : firstOther(records, a);
    set({
      records,
      activeId: a,
      compareId: b,
      compareExtraIds: cleanExtras(get().compareExtraIds, ids, a, b),
      ...layoutFor(records, get().layout),
    });
  },
  addRecords: (recs) => {
    const existing = get().records;
    const ids = new Set(existing.map((r) => r.id));
    const fresh = recs.filter((r) => !ids.has(r.id));
    const records = [...existing, ...fresh];
    const activeId = get().activeId ?? fresh[0]?.id ?? null;
    // B gets the next record when it is empty, so side-by-side / diff work right after an import.
    const compareId = get().compareId ?? firstOther(records, activeId);
    set({ records, activeId, compareId, compareExtraIds: cleanExtras(get().compareExtraIds, new Set(records.map((r) => r.id)), activeId, compareId) });
  },
  insertRecord: (rec, index, roles) => {
    const existing = get().records.filter((r) => r.id !== rec.id);
    const records = [...existing.slice(0, index), rec, ...existing.slice(index)];
    const next: Partial<AppState> = { records };
    if (roles?.hidden) next.hiddenIds = [...get().hiddenIds.filter((h) => h !== rec.id), rec.id];
    set(next);
    if (roles?.a) get().setActive(rec.id);
    else if (roles?.b) get().setCompare(rec.id);
    else if (get().compareId === null) set({ compareId: firstOther(get().records, get().activeId) });
    else if (roles?.extra !== undefined) {
      const { compareExtraIds: extras, activeId, compareId } = get();
      const next = [...extras.slice(0, roles.extra), rec.id, ...extras.slice(roles.extra)];
      set({ compareExtraIds: cleanExtras(next, new Set(get().records.map((r) => r.id)), activeId, compareId) });
    }
  },
  removeRecord: (id) => {
    const records = get().records.filter((r) => r.id !== id);
    const { activeId, compareId } = get();
    const a = activeId === id ? (records.find((r) => r.id !== compareId)?.id ?? records[0]?.id ?? null) : activeId;
    const b = compareId === id || compareId === a ? firstOther(records, a) : compareId;
    set({
      records,
      hiddenIds: get().hiddenIds.filter((h) => h !== id),
      activeId: a,
      compareId: b,
      compareExtraIds: cleanExtras(get().compareExtraIds, new Set(records.map((r) => r.id)), a, b),
      ...layoutFor(records, get().layout),
    });
  },
  updateRecord: (id, patch) =>
    set({
      records: get().records.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        // Editing device/mode drops the English aliases of bundled records.
        if (patch.device !== undefined && patch.device !== r.device) next.deviceEn = undefined;
        if (patch.mode !== undefined && patch.mode !== r.mode) next.modeEn = undefined;
        return next;
      }),
    }),
  toggleHidden: (id) => {
    const hidden = new Set(get().hiddenIds);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    set({ hiddenIds: [...hidden] });
  },
  setHidden: (ids, on) => {
    const hidden = new Set(get().hiddenIds);
    for (const id of ids) {
      if (on) hidden.add(id);
      else hidden.delete(id);
    }
    set({ hiddenIds: [...hidden] });
  },
  setActive: (id) => {
    const { compareId, activeId, compareExtraIds } = get();
    // Keep A != B: picking B as A swaps them.
    const b = id !== null && id === compareId ? activeId : compareId;
    set({ activeId: id, compareId: b, compareExtraIds: promoteFromExtras(compareExtraIds, id, activeId, [id, b]) });
  },
  setCompare: (id) => {
    const { compareId, activeId, compareExtraIds } = get();
    const a = id !== null && id === activeId ? compareId : activeId;
    set({ compareId: id, activeId: a, compareExtraIds: promoteFromExtras(compareExtraIds, id, compareId, [id, a]) });
  },
  addComparePanel: (id) => {
    const { activeId, compareId, compareExtraIds, records } = get();
    if (!records.some((r) => r.id === id) || id === activeId || id === compareId || compareExtraIds.includes(id)) return;
    // B is empty only with a single record (then there is nothing to compare).
    if (compareId === null) {
      if (activeId === null) get().setActive(id);
      else get().setCompare(id);
      return;
    }
    if (compareExtraIds.length >= MAX_COMPARE_PANELS - 2) return;
    set({ compareExtraIds: [...compareExtraIds, id] });
  },
  removeComparePanel: (id) => {
    const { activeId, compareId, compareExtraIds: extras } = get();
    if (extras.includes(id)) set({ compareExtraIds: extras.filter((x) => x !== id) });
    // A / B: the next panel moves up (side by side keeps at least two panels).
    else if (extras.length && id === compareId) set({ compareId: extras[0], compareExtraIds: extras.slice(1) });
    else if (extras.length && id === activeId) set({ activeId: compareId, compareId: extras[0], compareExtraIds: extras.slice(1) });
  },
  setComparePanel: (index, id) => {
    if (index === 0) return get().setActive(id);
    if (index === 1) return get().setCompare(id);
    const { activeId, compareId, compareExtraIds: extras, records } = get();
    const k = index - 2;
    if (k < 0 || k > extras.length || k >= MAX_COMPARE_PANELS - 2 || !records.some((r) => r.id === id)) return;
    const current = extras[k] ?? null;
    if (current === id) return;
    // Already in another panel: the two panels swap.
    if (id === activeId || id === compareId) {
      if (current === null) return;
      const next = [...extras];
      next[k] = id;
      set({ activeId: id === activeId ? current : activeId, compareId: id === compareId ? current : compareId, compareExtraIds: next });
      return;
    }
    const next = [...extras];
    const j = next.indexOf(id);
    if (j >= 0) {
      if (current === null) return;
      next[j] = current;
    }
    next[k] = id;
    set({ compareExtraIds: next });
  },
  setComparePanels: (ids) => {
    const known = new Set(get().records.map((r) => r.id));
    const list = ids.filter((id, i) => known.has(id) && ids.indexOf(id) === i);
    if (list.length < 2) return;
    set({ activeId: list[0], compareId: list[1], compareExtraIds: cleanExtras(list.slice(2), known, list[0], list[1]) });
  },
  setDeviceColor: (device, color) => {
    const next = { ...get().deviceColors };
    if (color) next[device] = color;
    else delete next[device];
    set({ deviceColors: next });
  },

  setPresenting: (on) => set({ presenting: on }),
  requestPlay: (tab) => set({ playNonce: { ...get().playNonce, [tab]: get().playNonce[tab] + 1 } }),
  requestStop: (tab) => set({ stopNonce: { ...get().stopNonce, [tab]: get().stopNonce[tab] + 1 } }),
  setAnimating: (tab, on) => {
    if (get().animating[tab] === on) return;
    set({ animating: { ...get().animating, [tab]: on } });
  },
}));

/** Non-React access (render loops, canvas drawing). */
export const getAppState = () => useAppStore.getState();

/**
 * A record as processed under the current denoise setting (docs/adr/0012 addendum): `.record`
 * is what views, stats and exports display; notes / summary explain what was changed. Memoised
 * per record + setting (same inputs → the same object). Non-React callers; React: useProcessed.
 */
export function processedOf<T extends Dataset>(rec: T, s: Pick<AppState, 'denoise'> = getAppState()): ProcessedRecord<T> {
  return processRecord(rec, { denoise: s.denoise });
}

/** The record the views display under the current denoise setting (see processedOf). */
export function displayOf<T extends Dataset>(rec: T, s: Pick<AppState, 'denoise'> = getAppState()): T {
  return processRecord(rec, { denoise: s.denoise }).record;
}

/** Records visible in the 2D chart / stats (not hidden), in record order. */
export const selectVisibleRecords = (s: AppState) => s.records.filter((r) => !s.hiddenIds.includes(r.id));
export const selectActiveRecord = (s: AppState) => s.records.find((r) => r.id === s.activeId) ?? null;
export const selectCompareRecord = (s: AppState) => s.records.find((r) => r.id === s.compareId) ?? null;
/**
 * Ordered side-by-side panel ids [A, B, ...extras] (existing records only; 2–6 when two or more
 * records exist). A new array per call: in React, select it with useShallow.
 */
export const selectComparePanelIds = (s: AppState): string[] => {
  const ids = new Set(s.records.map((r) => r.id));
  return [s.activeId, s.compareId, ...s.compareExtraIds].filter((id, i, all): id is string => id !== null && ids.has(id) && all.indexOf(id) === i);
};
/**
 * Panels filled from the visible (not hidden) records, at most six: the current panels that are
 * visible keep their order (A stays A when it is visible), then the other visible records in list
 * order. Fewer than two visible records: the current panels.
 */
export function fillPanelIds(current: readonly string[], visible: readonly string[]): string[] {
  const vis = new Set(visible);
  const out = current.filter((id) => vis.has(id));
  for (const id of visible) if (!out.includes(id)) out.push(id);
  return out.length >= 2 ? out.slice(0, MAX_COMPARE_PANELS) : [...current];
}

/** The record "add a panel" picks: the first visible record not shown yet, else any; null if none. */
export function nextPanelCandidate(s: Pick<AppState, 'records' | 'hiddenIds'>, panels: readonly string[]): string | null {
  const free = s.records.filter((r) => !panels.includes(r.id));
  return (free.find((r) => !s.hiddenIds.includes(r.id)) ?? free[0])?.id ?? null;
}

/** Records of the extra side-by-side panels C–F, in order (a new array per call). */
export const selectCompareExtras = (s: AppState): SvmRecord[] =>
  s.compareExtraIds.map((id) => s.records.find((r) => r.id === id)).filter((r): r is SvmRecord => !!r);
/** Records of the side-by-side panels, in panel order (see selectComparePanelIds). */
export const selectComparePanels = (s: AppState): SvmRecord[] => {
  const byId = new Map(s.records.map((r) => [r.id, r]));
  return selectComparePanelIds(s).map((id) => byId.get(id)!);
};
