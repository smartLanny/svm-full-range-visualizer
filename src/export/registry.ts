/**
 * Export contract between views and the export module (docs/adr/0010).
 *
 * A view that can be exported (3D terrain, 2D chart) registers an ExportTarget while mounted.
 * The exporter drives it offscreen:
 *
 *   await target.begin({ width, height });            // resize rendering to exactly width×height px
 *   const canvas = await target.renderFrame(null);    // static PNG of the current state
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
}

export interface ExportTarget {
  id: MainTab;
  /** Base filename without extension (safe characters only). */
  fileName(): string;
  /** The view's animation, or null if it has none. */
  animation(): ExportAnimation | null;
  begin(size: ExportSize): Promise<void>;
  /** Render one frame. t = seconds into the animation; null = current static state. */
  renderFrame(t: number | null): Promise<HTMLCanvasElement>;
  end(): void;
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

/** Filename-safe slug that keeps CJK characters. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'svm';
}
