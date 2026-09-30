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

/** File name of an image content (undefined = legacy: the frame on screen). */
export function pngFileName(target: ExportTarget, size: ExportSize, content?: string): string {
  return `${target.fileName('image', content)}_${size.width}x${size.height}.png`;
}

/**
 * Render an image content of the target (undefined / 'current' = exactly what is on screen) at
 * exactly `size` and encode it as PNG.
 */
export async function exportPng(target: ExportTarget, size: ExportSize, content?: string): Promise<PngResult> {
  const out = createCanvas(size);
  // Named from the state the export starts from (before begin() applies any override).
  const fileName = pngFileName(target, size, content);
  try {
    await target.begin(size, content);
    const canvas = await target.renderFrame(null, content);
    // Snapshot synchronously (WebGL drawing buffers are cleared after compositing).
    copyFrame(canvas, out);
  } finally {
    // Also after a failed begin(): the view may be half-way into export mode.
    safeEnd(target);
  }
  const blob = await canvasToBlob(out, 'image/png');
  return { blob, fileName, size };
}

/** end() must never throw out of the exporter (the view must always return to interactive mode). */
export function safeEnd(target: ExportTarget) {
  try {
    target.end();
  } catch (e) {
    console.warn('Export target end() failed:', e);
  }
}
