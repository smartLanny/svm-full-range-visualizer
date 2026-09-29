/** Small canvas / download helpers shared by the PNG and video engines. */
import type { ExportSize } from './registry';

export function createCanvas(size: ExportSize): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size.width;
  c.height = size.height;
  return c;
}

/**
 * Copy `src` into `dst` (resized to `size`), letterboxing if the aspect differs.
 * Must be called synchronously right after the frame was rendered: WebGL canvases without
 * preserveDrawingBuffer are cleared once the browser composites.
 */
export function copyFrame(src: CanvasImageSource & { width: number; height: number }, dst: HTMLCanvasElement, background = '#07090d') {
  const ctx = dst.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const W = dst.width;
  const H = dst.height;
  if (src.width === W && src.height === H) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(src, 0, 0);
    return;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  const k = Math.min(W / Math.max(1, src.width), H / Math.max(1, src.height));
  const w = src.width * k;
  const h = src.height * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), type, quality);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Trigger a browser download of `blob` as `fileName`. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: the download may still be reading from the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Yield to the event loop (lets the UI update and GC run between frames). */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class ExportAbortError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'AbortError';
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ExportAbortError();
}
