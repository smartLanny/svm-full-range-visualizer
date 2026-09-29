/**
 * Export sizes, frame timing and bitrates (docs/adr/0010). Pure functions, unit-tested.
 */
import type { ExportSize } from './registry';

export type ExportKind = 'image' | 'video';
export type ExportAspect = '16:9' | '9:16' | '1:1';
/** 'window' = the view's current on-screen size (device pixels); otherwise the short side in px. */
export type ExportQuality = 'window' | '1080' | '1440' | '2160';
export type ExportFps = 30 | 60;

export const ASPECTS: ExportAspect[] = ['16:9', '9:16', '1:1'];
export const QUALITIES: ExportQuality[] = ['window', '1080', '1440', '2160'];
export const FPS_OPTIONS: ExportFps[] = [30, 60];

/** Largest side we ever render for "window" size (GPU texture / encoder limits). */
export const MAX_WINDOW_SIDE = 4096;

/** Output size for a preset. For 'window' the aspect is ignored and `windowSize` is used (capped). */
export function resolveSize(aspect: ExportAspect, quality: ExportQuality, windowSize: ExportSize): ExportSize {
  if (quality === 'window') return capSize(windowSize, MAX_WINDOW_SIDE);
  const short = Number(quality);
  const long = Math.round((short * 16) / 9);
  if (aspect === '16:9') return { width: long, height: short };
  if (aspect === '9:16') return { width: short, height: long };
  return { width: short, height: short };
}

/** Scale down (keeping aspect) so neither side exceeds `max`; never below 16 px. */
export function capSize(size: ExportSize, max: number): ExportSize {
  const w = Math.max(16, Math.round(size.width));
  const h = Math.max(16, Math.round(size.height));
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(16, Math.round(w * k)), height: Math.max(16, Math.round(h * k)) };
}

/** Video encoders need even dimensions (4:2:0 chroma). Rounds down. */
export function evenSize(size: ExportSize): ExportSize {
  return { width: Math.max(2, Math.floor(size.width / 2) * 2), height: Math.max(2, Math.floor(size.height / 2) * 2) };
}

/**
 * Frames rendered for an animation of `duration` seconds: t = 0, 1/fps, … up to and including
 * the final state, so the video ends on the finished frame.
 */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(Math.max(0, duration) * fps) + 1);
}

/** Timeline time of frame i (clamped to the animation duration). */
export function frameTime(i: number, fps: number, duration: number): number {
  return Math.min(duration, i / fps);
}

/** Frame timestamp in microseconds (integer, monotonic, exact multiple of the frame period on average). */
export function frameTimestampUs(i: number, fps: number): number {
  return Math.round((i * 1e6) / fps);
}

const PX_1080 = 1920 * 1080;
const PX_1440 = 2560 * 1440;
const PX_2160 = 3840 * 2160;

/**
 * Target bitrate (bits/s): ≈12 Mbps @1080p30, 18 @1080p60, 24 @1440p30, 45 @4K30; 60 fps × 1.5.
 * Other sizes scale with pixel count against the nearest tier.
 */
export function videoBitrate(size: ExportSize, fps: number): number {
  const px = size.width * size.height;
  let base: number;
  if (px <= PX_1080 * 1.1) base = 12e6 * (px / PX_1080);
  else if (px <= PX_1440 * 1.1) base = 24e6 * (px / PX_1440);
  else base = 45e6 * (px / PX_2160);
  base = Math.max(3e6, base);
  const fpsFactor = 1 + 0.5 * Math.max(0, Math.min(1, (fps - 30) / 30));
  return Math.round((base * fpsFactor) / 1e5) * 1e5;
}

/** Keyframe every 2 seconds. */
export function keyframeInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

/** Rough size estimate (bytes) for the UI. */
export function estimateVideoBytes(size: ExportSize, fps: number, duration: number): number {
  return (videoBitrate(size, fps) * (frameCount(duration, fps) / fps)) / 8;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** m:ss */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function sizeLabel(size: ExportSize): string {
  return `${size.width}×${size.height}`;
}
