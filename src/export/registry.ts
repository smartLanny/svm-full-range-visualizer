/**
 * Export contract between views and the export module (docs/adr/0010).
 *
 * A view that can be exported (3D terrain, 2D chart, stats page) registers an ExportTarget while
 * mounted. It lists what it can export — its CONTENTS (addendum 2026-09-30):
 * the frame on screen, other renderings of the same data (the 3D layout in top view, the other 2D
 * slice, …) and its animations. The dialog shows that list for the active tab; the exporter then
 * drives the chosen content offscreen:
 *
 *   const list = target.contents?.() ?? legacy;       // [{ id: 'current', kind: 'image', … }, …]
 *   await target.begin({ width, height }, id);         // resize rendering to exactly width×height px
 *                                                      // and apply the content's overrides
 *   const canvas = await target.renderFrame(null, id); // image content: its still frame
 *   for (i...) await target.renderFrame(i / fps, id);  // video content: frame at t seconds
 *   target.end();                                      // remove the overrides, restore the view
 *
 * Rules every target keeps:
 * - Frames are a pure function of (content, t) — never dependent on wall-clock — so video export
 *   is deterministic and smooth regardless of machine speed.
 * - Everything that should appear in the file (title, legend, colorbar, axes) is drawn INTO the
 *   returned canvas. The canvas may come from WebGL, Canvas2D or a DOM snapshot drawn into a 2D
 *   canvas: the exporter only reads its pixels synchronously after renderFrame() resolves.
 * - A content that renders something other than the screen (another view preset, layout, slice
 *   mode) does so through overrides applied in begin() and removed in end(). It never changes the
 *   app store or persisted settings, and the on-screen view is exactly what it was after end()
 *   (no flash while exporting, no state change afterwards).
 * - Content ids are stable strings per view (the dialog remembers the last choice per view);
 *   CURRENT_CONTENT = exactly what is on screen now. A view whose screen is a page rather than a
 *   picture (the stats page) may list only its renderings instead ('cards', 'table'), marking the
 *   one on screen `current`; it still accepts CURRENT_CONTENT / undefined as "the one on screen".
 *
 * Backward compatibility: a target without contents() exports two implicit contents — the frame on
 * screen (CURRENT_CONTENT) and, if animation() returns one, its animation (ANIMATION_CONTENT) —
 * and every method may ignore the content argument, which is undefined for legacy callers
 * (image = the frame on screen, video = the view's animation).
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

/** Id of the content "exactly what is on screen now" (every target has it, legacy ones implicitly). */
export const CURRENT_CONTENT = 'current';
/** Id of a legacy target's (one) animation, see ExportTarget.contents. */
export const ANIMATION_CONTENT = 'animation';

/** Glyph the dialog shows next to a content (a generic one when omitted). */
export type ExportContentIcon = 'screen' | 'top' | 'perspective' | 'sideBySide' | 'diff' | 'intro' | 'slice' | 'sweep' | 'table' | 'chart';

/** One exportable content of a view (docs/adr/0010, addendum "export contents"). */
export interface ExportContent {
  /** Stable id within the view, e.g. 'current', 'top', 'intro', 'graySweep'. */
  id: string;
  kind: ExportKindHint;
  /** Short name in the dialog, e.g. "俯视热力图" / "Top-view heatmap" (UI language). */
  label: string;
  /** One-line description of what exactly is rendered (UI language). */
  detail?: string;
  /** Seconds of video (kind 'video'); the exporter uses animation(id).duration. */
  duration?: number;
  /**
   * The content shows exactly what is on screen now (the dialog's default when nothing is
   * remembered). CURRENT_CONTENT always does.
   */
  current?: boolean;
  icon?: ExportContentIcon;
}

export interface ExportTarget {
  id: MainTab;
  /**
   * What this view can export right now, in display order, CURRENT_CONTENT first. Called each time
   * the dialog opens (the list follows the view's state: layout, records, slice mode, …). Optional
   * for backward compatibility (see the module comment).
   */
  contents?(): ExportContent[];
  /**
   * Base filename without extension (safe characters only) of the content (`content`, undefined =
   * legacy: the frame on screen for images, the animation for videos). `kind` says what is being
   * exported; ExportAnimation.fileName takes precedence for videos.
   */
  fileName(kind?: ExportKindHint, content?: string): string;
  /** The animation of a video content (undefined = the view's one animation), or null if none. */
  animation(content?: string): ExportAnimation | null;
  /** Prepare an export of `content` at exactly `size` (apply its offscreen overrides). */
  begin(size: ExportSize, content?: string): Promise<void>;
  /**
   * Render one frame of `content`. t = seconds into the content's animation (video export); null =
   * the content's still image. For CURRENT_CONTENT (and legacy undefined) null is exactly what the
   * user sees right now: if the view's animation is open (playing, paused or scrubbed), the
   * animation at its current timeline time, not the static view. The exporter pauses a playing
   * timeline before calling begin(), so that time is stable.
   */
  renderFrame(t: number | null, content?: string): Promise<HTMLCanvasElement>;
  /** Remove every override of begin() and restore interactive rendering (always called). */
  end(): void;
  /**
   * The view's current on-screen drawing-buffer size in device pixels (canvas.width/height),
   * used for the "当前视图 / Current view" preset so the export matches what the user sees
   * (size AND aspect). Both built-in views implement it. Optional only for backward
   * compatibility: without it the exporter falls back to the browser window × devicePixelRatio.
   * A DOM-based target returns its element's size × devicePixelRatio.
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
