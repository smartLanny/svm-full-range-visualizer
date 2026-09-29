/**
 * Export contract between views and the export module (docs/adr/0010).
 *
 * A view that can be exported (3D terrain, 2D chart) registers an ExportTarget while mounted.
 * The exporter drives it offscreen:
 *
 *   await target.begin({ width, height });            // resize rendering to exactly width×height px
 *   const canvas = await target.renderFrame(null);    // PNG of exactly what is on screen now
 *   for (i...) await target.renderFrame(i / fps);     // animation frame at t seconds
 *   target.end();                                     // restore interactive rendering
 *
 * Frames must be a pure function of t (never dependent on wall-clock), so video export is
 * deterministic and smooth regardless of machine speed. Everything that should appear in
 * the video (title, legend, colorbar, axes) must be drawn INTO the returned canvas.
 */
import type { MainTab } from '../types';

export interface ExportSize {
  /** Output size in device pixels. */
  width: number;
  height: number;
}

export interface ExportAnimation {
  duration: number;
  /** Human-readable name, e.g. "开场动画" / "灰阶扫描 G255→G50". */
  label: string;
  /**
   * Optional base filename for the VIDEO when it differs from the static view's name, e.g. the
   * 2D sweep ("SVM_2D_sweep_G255-G50" instead of "SVM_2D_G127") or the 3D intro in a
   * side-by-side layout (record A only, no "A_vs_B"). Safe characters only (see safeFileName).
   */
  fileName?: string;
}

export type ExportKindHint = 'image' | 'video';

export interface ExportTarget {
  id: MainTab;
  /**
   * Base filename without extension (safe characters only). The exporter passes what is being
   * exported; targets whose video differs from the static view can branch on it (or set
   * ExportAnimation.fileName, which takes precedence for videos).
   */
  fileName(kind?: ExportKindHint): string;
  /** The view's animation, or null if it has none. */
  animation(): ExportAnimation | null;
  begin(size: ExportSize): Promise<void>;
  /**
   * Render one frame. t = seconds into the animation (video export); null = PNG export of
   * exactly what the user sees right now. If the view's animation is open (playing, paused or
   * scrubbed), null must render the animation at its current timeline time, not the static
   * view. The exporter pauses a playing timeline before calling begin(), so that time is stable.
   */
  renderFrame(t: number | null): Promise<HTMLCanvasElement>;
  end(): void;
  /**
   * The view's current on-screen drawing-buffer size in device pixels (canvas.width/height),
   * used for the "当前视图 / Current view" preset so the export matches what the user sees
   * (size AND aspect). Both built-in views implement it. Optional only for backward
   * compatibility: without it the exporter falls back to the browser window × devicePixelRatio.
   */
  viewSize?(): ExportSize;
}

const targets = new Map<MainTab, ExportTarget>();
const listeners = new Set<() => void>();

export function registerExportTarget(target: ExportTarget): () => void {
  targets.set(target.id, target);
  listeners.forEach((fn) => fn());
  return () => {
    if (targets.get(target.id) === target) {
      targets.delete(target.id);
      listeners.forEach((fn) => fn());
    }
  };
}

export function getExportTarget(id: MainTab): ExportTarget | undefined {
  return targets.get(id);
}

export function subscribeExportTargets(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Filename-safe slug that keeps CJK characters. Separators (whitespace, characters file systems
 * reject, and the middle dot of labels like "Xiaomi 18 Pro Max · Adaptive refresh Pro on") collapse
 * into one '_': "Xiaomi_18_Pro_Max_Adaptive_refresh_Pro_on", never "…_·_…".
 */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s·•・]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'svm';
}
