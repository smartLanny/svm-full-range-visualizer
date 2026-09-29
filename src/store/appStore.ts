import { create } from 'zustand';
import type {
  AxisMode,
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
import { ColormapType, DEFAULT_MAX_NITS } from '../types';

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

export const DEFAULT_SETTINGS: Settings = {
  lang: 'zh',
  tab: 'scene3d',
  clipLowGray: true,
  maxNits: DEFAULT_MAX_NITS,
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
  axisMode: 'standard',
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
  removeRecord: (id: string) => void;
  updateRecord: (id: string, patch: Partial<Pick<SvmRecord, 'name' | 'device' | 'mode'>>) => void;
  toggleHidden: (id: string) => void;
  setHidden: (ids: string[], hidden: boolean) => void;
  setActive: (id: string | null) => void;
  setCompare: (id: string | null) => void;
  setDeviceColor: (device: string, color: string | null) => void;

  setPresenting: (on: boolean) => void;
  requestPlay: (tab: AnimTab) => void;
  requestStop: (tab: AnimTab) => void;
  setAnimating: (tab: AnimTab, on: boolean) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  hiddenIds: [],
  activeId: null,
  compareId: null,
  deviceColors: {},
  records: [],
  ready: false,
  presenting: false,
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
    set({
      records,
      activeId: activeId && ids.has(activeId) ? activeId : (records[0]?.id ?? null),
      compareId: compareId && ids.has(compareId) ? compareId : (records.find((r) => r.id !== (activeId ?? records[0]?.id))?.id ?? null),
    });
  },
  addRecords: (recs) => {
    const existing = get().records;
    const ids = new Set(existing.map((r) => r.id));
    const fresh = recs.filter((r) => !ids.has(r.id));
    const records = [...existing, ...fresh];
    set({ records, activeId: get().activeId ?? fresh[0]?.id ?? null });
  },
  removeRecord: (id) => {
    const records = get().records.filter((r) => r.id !== id);
    const { activeId, compareId } = get();
    set({
      records,
      hiddenIds: get().hiddenIds.filter((h) => h !== id),
      activeId: activeId === id ? (records[0]?.id ?? null) : activeId,
      compareId: compareId === id ? (records.find((r) => r.id !== (activeId === id ? records[0]?.id : activeId))?.id ?? null) : compareId,
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
    const { compareId, activeId } = get();
    // Keep A != B: picking B as A swaps them.
    set({ activeId: id, compareId: id !== null && id === compareId ? activeId : compareId });
  },
  setCompare: (id) => {
    const { compareId, activeId } = get();
    set({ compareId: id, activeId: id !== null && id === activeId ? compareId : activeId });
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

/** Records visible in the 2D chart / stats (not hidden), in record order. */
export const selectVisibleRecords = (s: AppState) => s.records.filter((r) => !s.hiddenIds.includes(r.id));
export const selectActiveRecord = (s: AppState) => s.records.find((r) => r.id === s.activeId) ?? null;
export const selectCompareRecord = (s: AppState) => s.records.find((r) => r.id === s.compareId) ?? null;
