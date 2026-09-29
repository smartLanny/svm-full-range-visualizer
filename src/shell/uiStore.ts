import { create } from 'zustand';
import type { FileResult } from './fileImport';

/**
 * Shell-local UI state (panels, dialogs). Not part of the app store: none of it affects
 * rendering of the views. Panel open/closed state is a per-viewer convenience kept in
 * localStorage (best effort).
 */
export type ImporterTab = 'paste' | 'json';

/** Content handed to the importer when it opens (window drop / file picker). */
export interface ImporterSeed {
  /** Table text for the paste tab, with a fallback record name (the file's base name). */
  text?: string;
  name?: string;
  /** Already-read files for the file tab. */
  files?: FileResult[];
}

interface ShellUi {
  sidebarOpen: boolean;
  /** Docked inspector (wide windows). */
  inspectorOpen: boolean;
  /** Overlay inspector (narrow windows, < INSPECTOR_DOCK_MIN). Starts closed. */
  inspectorOverlayOpen: boolean;
  collapsedDevices: string[];
  importer: { open: boolean; tab: ImporterTab; seed?: ImporterSeed | null };
  shortcutsOpen: boolean;
  aboutOpen: boolean;
  clearOpen: boolean;
  /** Presentation only: the stage's window rect (CSS px), for the shell's own overlay chrome. */
  presentStage: StageRect | null;
}

export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LS_KEY = 'svm.shell.ui.v1';

function loadLocal(): Partial<Pick<ShellUi, 'sidebarOpen' | 'inspectorOpen' | 'collapsedDevices'>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      sidebarOpen: typeof v.sidebarOpen === 'boolean' ? v.sidebarOpen : undefined,
      inspectorOpen: typeof v.inspectorOpen === 'boolean' ? v.inspectorOpen : undefined,
      collapsedDevices: Array.isArray(v.collapsedDevices) ? (v.collapsedDevices as string[]) : undefined,
    };
  } catch {
    return {};
  }
}

const local = loadLocal();

export const useShellUi = create<ShellUi>(() => ({
  sidebarOpen: local.sidebarOpen ?? true,
  inspectorOpen: local.inspectorOpen ?? true,
  inspectorOverlayOpen: false,
  collapsedDevices: local.collapsedDevices ?? [],
  importer: { open: false, tab: 'paste' },
  shortcutsOpen: false,
  aboutOpen: false,
  clearOpen: false,
  presentStage: null,
}));

useShellUi.subscribe((s, prev) => {
  if (s.sidebarOpen === prev.sidebarOpen && s.inspectorOpen === prev.inspectorOpen && s.collapsedDevices === prev.collapsedDevices) return;
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        sidebarOpen: s.sidebarOpen,
        inspectorOpen: s.inspectorOpen,
        collapsedDevices: s.collapsedDevices,
      }),
    );
  } catch {
    /* storage unavailable: fine */
  }
});

export const shellUi = {
  openImporter: (tab: ImporterTab = 'paste', seed: ImporterSeed | null = null) => useShellUi.setState({ importer: { open: true, tab, seed } }),
  /** The importer took the seed over into its own state. */
  consumeImporterSeed: () => useShellUi.setState((s) => ({ importer: { ...s.importer, seed: null } })),
  closeImporter: () => useShellUi.setState((s) => ({ importer: { ...s.importer, open: false } })),
  setImporterTab: (tab: ImporterTab) => useShellUi.setState((s) => ({ importer: { ...s.importer, tab } })),
  toggleSidebar: () => useShellUi.setState((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleInspector: () => useShellUi.setState((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOverlay: (on: boolean) => useShellUi.setState({ inspectorOverlayOpen: on }),
  toggleDevice: (device: string) =>
    useShellUi.setState((s) => ({
      collapsedDevices: s.collapsedDevices.includes(device) ? s.collapsedDevices.filter((d) => d !== device) : [...s.collapsedDevices, device],
    })),
  setShortcuts: (on: boolean) => useShellUi.setState({ shortcutsOpen: on }),
  toggleShortcuts: () => useShellUi.setState((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
  setAbout: (on: boolean) => useShellUi.setState({ aboutOpen: on }),
  setClear: (on: boolean) => useShellUi.setState({ clearOpen: on }),
  setPresentStage: (r: StageRect | null) =>
    useShellUi.setState((s) => {
      const p = s.presentStage;
      if (p === r || (p && r && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h)) return s;
      return { presentStage: r };
    }),
};

/** Width below which the inspector stops docking and becomes an overlay drawer. */
export const INSPECTOR_DOCK_MIN = 1180;
