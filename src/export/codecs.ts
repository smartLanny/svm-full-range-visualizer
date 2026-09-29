/**
 * Codec string selection for WebCodecs video export. Pure functions, unit-tested.
 */
import type { ExportSize } from './registry';

interface AvcLevel {
  /** level_idc as 2 hex digits. */
  hex: string;
  /** Max frame size in macroblocks. */
  maxFs: number;
  /** Max macroblocks per second. */
  maxMbps: number;
}

// H.264 Table A-1 (levels that matter for 720p … 4K).
const AVC_LEVELS: AvcLevel[] = [
  { hex: '1F', maxFs: 3600, maxMbps: 108000 }, // 3.1
  { hex: '20', maxFs: 5120, maxMbps: 216000 }, // 3.2
  { hex: '28', maxFs: 8192, maxMbps: 245760 }, // 4.0
  { hex: '2A', maxFs: 8704, maxMbps: 522240 }, // 4.2
  { hex: '32', maxFs: 22080, maxMbps: 589824 }, // 5.0
  { hex: '33', maxFs: 36864, maxMbps: 983040 }, // 5.1
  { hex: '34', maxFs: 36864, maxMbps: 2073600 }, // 5.2
  { hex: '3C', maxFs: 139264, maxMbps: 4177920 }, // 6.0
  { hex: '3D', maxFs: 139264, maxMbps: 8355840 }, // 6.1
];

/** Index into AVC_LEVELS of the lowest level that fits size @ fps (or the last level). */
export function avcLevelIndex(size: ExportSize, fps: number): number {
  const mbW = Math.ceil(size.width / 16);
  const mbH = Math.ceil(size.height / 16);
  const fs = mbW * mbH;
  const maxSide = Math.max(mbW, mbH);
  for (let i = 0; i < AVC_LEVELS.length; i++) {
    const l = AVC_LEVELS[i];
    // Each side is limited to sqrt(8 * MaxFS) macroblocks.
    if (fs <= l.maxFs && fs * fps <= l.maxMbps && maxSide <= Math.sqrt(8 * l.maxFs)) return i;
  }
  return AVC_LEVELS.length - 1;
}

/**
 * H.264 codec strings to try, best first: High → Main → Constrained Baseline, each at the
 * minimum level that fits and a couple of higher levels (some encoders only accept specific ones).
 */
export function avcCandidates(size: ExportSize, fps: number): string[] {
  const start = avcLevelIndex(size, fps);
  const levels = AVC_LEVELS.slice(start, start + 3).map((l) => l.hex);
  // Encoders commonly advertise 5.1/5.2; keep them as extra candidates for large frames.
  for (const extra of ['33', '34']) if (AVC_LEVELS.findIndex((l) => l.hex === extra) >= start && !levels.includes(extra)) levels.push(extra);
  const out: string[] = [];
  for (const profile of ['6400', '4D00', '42E0']) for (const lv of levels) out.push(`avc1.${profile}${lv}`);
  return out;
}

/** VP9 (profile 0, 8-bit) codec strings, used offline when H.264 encoding is unavailable. */
export function vp9Candidates(size: ExportSize, fps: number): string[] {
  const px = size.width * size.height;
  const rate = px * fps;
  // VP9 levels by luma samples per second (approx.): 4.0 ≈ 1080p30, 4.1 ≈ 1080p60, 5.0 ≈ 4K30, 5.1 ≈ 4K60.
  const levels = rate <= 2048 * 1152 * 30 ? ['40', '41', '50', '51'] : rate <= 2048 * 1152 * 60 ? ['41', '50', '51'] : rate <= 4096 * 2176 * 30 ? ['50', '51', '52'] : ['51', '52', '60'];
  if (px <= 1280 * 720) levels.unshift('31');
  return levels.map((l) => `vp09.00.${l}.08`);
}

export type VideoCodecFamily = 'avc' | 'vp9';

export function codecFamily(codec: string): VideoCodecFamily {
  return codec.startsWith('avc1') ? 'avc' : 'vp9';
}

/** MediaRecorder mime types, best first (MP4/H.264 where the browser supports recording it). */
export const RECORDER_MIME_TYPES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];
