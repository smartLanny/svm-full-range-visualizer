/**
 * PNG export: begin(size) → renderFrame(null) → PNG → end(). docs/adr/0010.
 */
import { canvasToBlob, copyFrame, createCanvas } from './canvas';
import type { ExportSize, ExportTarget } from './registry';

export interface PngResult {
  blob: Blob;
  fileName: string;
  size: ExportSize;
}

export function pngFileName(target: ExportTarget, size: ExportSize): string {
  return `${target.fileName('image')}_${size.width}x${size.height}.png`;
}

/** Render the target's current static state at exactly `size` and encode it as PNG. */
export async function exportPng(target: ExportTarget, size: ExportSize): Promise<PngResult> {
  const out = createCanvas(size);
  try {
    await target.begin(size);
    const canvas = await target.renderFrame(null);
    // Snapshot synchronously (WebGL drawing buffers are cleared after compositing).
    copyFrame(canvas, out);
  } finally {
    // Also after a failed begin(): the view may be half-way into export mode.
    safeEnd(target);
  }
  const blob = await canvasToBlob(out, 'image/png');
  return { blob, fileName: pngFileName(target, size), size };
}

/** end() must never throw out of the exporter (the view must always return to interactive mode). */
export function safeEnd(target: ExportTarget) {
  try {
    target.end();
  } catch (e) {
    console.warn('Export target end() failed:', e);
  }
}
