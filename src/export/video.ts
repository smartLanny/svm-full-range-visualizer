/**
 * Video export (docs/adr/0010).
 *
 * Preferred: WebCodecs VideoEncoder + mp4-muxer, rendering every frame OFFLINE at t = i / fps.
 * Frames are a pure function of t, so the output is deterministic and never drops frames no
 * matter how slow the machine is. H.264 first (plays everywhere, imports into every editor);
 * VP9-in-MP4 if the browser cannot encode H.264 (still offline and exact).
 * Fallback: MediaRecorder on a 2D copy canvas, paced in real time (WebM, or MP4 if supported).
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { avcCandidates, codecFamily, RECORDER_MIME_TYPES, vp9Candidates } from './codecs';
import { copyFrame, createCanvas, ExportAbortError, nextTask, throwIfAborted } from './canvas';
import { safeEnd } from './png';
import { evenSize, frameCount, frameTime, frameTimestampUs, keyframeInterval, videoBitrate } from './presets';
import type { ExportSize, ExportTarget } from './registry';

export type VideoMethod = 'webcodecs' | 'mediarecorder';
export type VideoContainer = 'mp4' | 'webm';
/** Test hook (DEV only, see ExportDialog): skip better tiers. */
export type VideoForce = 'auto' | 'vp9' | 'recorder';

export interface VideoPlan {
  method: VideoMethod;
  container: VideoContainer;
  /** 'H.264' | 'VP9' | recorder codec description. */
  codecName: string;
  /** WebCodecs configs to try in order (webcodecs only). */
  configs: VideoEncoderConfig[];
  /** MediaRecorder mime type (mediarecorder only). */
  mimeType?: string;
  /** True if the first config prefers hardware acceleration. */
  hardware: boolean;
}

export interface VideoProgress {
  phase: 'prepare' | 'render' | 'finalize';
  done: number;
  total: number;
}

export interface VideoExportOptions {
  size: ExportSize;
  fps: number;
  signal?: AbortSignal;
  force?: VideoForce;
  onProgress?: (p: VideoProgress) => void;
  /** Called once the encoding method is chosen. */
  onPlan?: (plan: VideoPlan) => void;
  /** Called synchronously with each rendered frame (e.g. to draw a live preview). */
  onFrame?: (canvas: HTMLCanvasElement, index: number) => void;
}

export interface VideoResult {
  blob: Blob;
  fileName: string;
  plan: VideoPlan;
  size: ExportSize;
  fps: number;
  frames: number;
  /** Seconds of video. */
  duration: number;
}

const HW_ORDER: HardwareAcceleration[] = ['prefer-hardware', 'no-preference'];

function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof VideoEncoder.isConfigSupported === 'function';
}

async function supportedConfigs(codecs: string[], size: ExportSize, fps: number): Promise<VideoEncoderConfig[]> {
  const out: VideoEncoderConfig[] = [];
  const bitrate = videoBitrate(size, fps);
  for (const hw of HW_ORDER) {
    for (const codec of codecs) {
      const config: VideoEncoderConfig = {
        codec,
        width: size.width,
        height: size.height,
        bitrate,
        framerate: fps,
        hardwareAcceleration: hw,
        latencyMode: 'quality',
        ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
      };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) out.push(config);
      } catch {
        // Invalid combination for this browser: skip.
      }
      // Two working codecs per hardware mode are enough fallbacks; keeps probing cheap.
      if (out.filter((c) => c.hardwareAcceleration === hw).length >= 2) break;
    }
  }
  return out;
}

function recorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  for (const t of RECORDER_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Decide how a video of this size / fps will be produced. Null = video export impossible. */
export async function planVideo(sizeIn: ExportSize, fps: number, force: VideoForce = 'auto'): Promise<VideoPlan | null> {
  const size = evenSize(sizeIn);
  if (hasWebCodecs() && force !== 'recorder') {
    if (force === 'auto') {
      const avc = await supportedConfigs(avcCandidates(size, fps), size, fps);
      if (avc.length) return { method: 'webcodecs', container: 'mp4', codecName: 'H.264', configs: avc, hardware: avc[0].hardwareAcceleration === 'prefer-hardware' };
    }
    const vp9 = await supportedConfigs(vp9Candidates(size, fps), size, fps);
    if (vp9.length) return { method: 'webcodecs', container: 'mp4', codecName: 'VP9', configs: vp9, hardware: vp9[0].hardwareAcceleration === 'prefer-hardware' };
  }
  const mime = recorderMime();
  if (mime) {
    const container: VideoContainer = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const codecName = /avc1/.test(mime) ? 'H.264' : /vp9/.test(mime) ? 'VP9' : /vp8/.test(mime) ? 'VP8' : container.toUpperCase();
    return { method: 'mediarecorder', container, codecName, configs: [], mimeType: mime, hardware: false };
  }
  return null;
}

export function videoFileName(target: ExportTarget, size: ExportSize, fps: number, container: VideoContainer): string {
  return `${target.fileName()}_${size.width}x${size.height}_${fps}fps.${container}`;
}

/**
 * Encode one black frame with `config` to verify the encoder really works (isConfigSupported can
 * report hardware support that then fails at configure time on some drivers).
 */
async function probeConfig(config: VideoEncoderConfig): Promise<boolean> {
  let ok = false;
  let failed = false;
  const enc = new VideoEncoder({
    output: () => {
      ok = true;
    },
    error: () => {
      failed = true;
    },
  });
  try {
    enc.configure(config);
    const c = createCanvas({ width: config.width, height: config.height });
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    const frame = new VideoFrame(c, { timestamp: 0 });
    enc.encode(frame, { keyFrame: true });
    frame.close();
    await enc.flush();
  } catch {
    failed = true;
  } finally {
    try {
      if (enc.state !== 'closed') enc.close();
    } catch {
      /* ignore */
    }
  }
  return ok && !failed;
}

async function waitForQueue(encoder: VideoEncoder, max: number) {
  while (encoder.state === 'configured' && encoder.encodeQueueSize > max) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        encoder.removeEventListener('dequeue', done);
        resolve();
      };
      const timer = setTimeout(done, 50);
      encoder.addEventListener('dequeue', done);
    });
  }
}

/** Render + encode the target's animation. Always calls target.end() (also on error / cancel). */
export async function exportVideo(target: ExportTarget, opts: VideoExportOptions): Promise<VideoResult> {
  const anim = target.animation();
  if (!anim) throw new Error('This view has no animation');
  const size = evenSize(opts.size);
  const fps = opts.fps;
  const total = frameCount(anim.duration, fps);
  opts.onProgress?.({ phase: 'prepare', done: 0, total });

  const plan = await planVideo(size, fps, opts.force);
  if (!plan) throw new Error('Video encoding is not supported in this browser');
  throwIfAborted(opts.signal);
  opts.onPlan?.(plan);

  const blob = plan.method === 'webcodecs' ? await encodeWebCodecs(target, plan, size, fps, anim.duration, total, opts) : await encodeRecorder(target, plan, size, fps, anim.duration, total, opts);
  return { blob, fileName: videoFileName(target, size, fps, plan.container), plan, size, fps, frames: total, duration: total / fps };
}

async function encodeWebCodecs(
  target: ExportTarget,
  plan: VideoPlan,
  size: ExportSize,
  fps: number,
  duration: number,
  total: number,
  opts: VideoExportOptions,
): Promise<Blob> {
  // Find a config that actually encodes.
  let config: VideoEncoderConfig | null = null;
  for (const c of plan.configs) {
    throwIfAborted(opts.signal);
    if (await probeConfig(c)) {
      config = c;
      break;
    }
  }
  if (!config) throw new Error(`No working ${plan.codecName} encoder`);
  plan.hardware = config.hardwareAcceleration === 'prefer-hardware';

  const muxTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxTarget,
    video: { codec: codecFamily(config.codec), width: size.width, height: size.height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });
  const copy = createCanvas(size);
  const kf = keyframeInterval(fps);
  let lastYield = performance.now();
  try {
    encoder.configure(config);
    await target.begin(size);
    for (let i = 0; i < total; i++) {
      throwIfAborted(opts.signal);
      if (encodeError) throw encodeError;
      const canvas = await target.renderFrame(frameTime(i, fps, duration));
      // Synchronously after rendering: the WebGL drawing buffer is still valid here.
      let src = canvas;
      if (canvas.width !== size.width || canvas.height !== size.height) {
        copyFrame(canvas, copy);
        src = copy;
      }
      const ts = frameTimestampUs(i, fps);
      const frame = new VideoFrame(src, { timestamp: ts, duration: frameTimestampUs(i + 1, fps) - ts });
      opts.onFrame?.(src, i);
      try {
        encoder.encode(frame, { keyFrame: i % kf === 0 });
      } finally {
        frame.close();
      }
      opts.onProgress?.({ phase: 'render', done: i + 1, total });
      await waitForQueue(encoder, 3);
      if (performance.now() - lastYield > 32) {
        await nextTask();
        lastYield = performance.now();
      }
    }
    opts.onProgress?.({ phase: 'finalize', done: total, total });
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([muxTarget.buffer], { type: 'video/mp4' });
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      /* ignore */
    }
    safeEnd(target);
  }
}

async function encodeRecorder(
  target: ExportTarget,
  plan: VideoPlan,
  size: ExportSize,
  fps: number,
  duration: number,
  total: number,
  opts: VideoExportOptions,
): Promise<Blob> {
  const mimeType = plan.mimeType!;
  const copy = createCanvas(size);
  const stream = copy.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(size, fps) });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) parts.push(e.data);
  };
  let recError: Error | null = null;
  recorder.onerror = (e) => {
    recError = new Error(String((e as unknown as { error?: unknown }).error ?? 'MediaRecorder error'));
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const stop = async () => {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
  };
  try {
    await target.begin(size);
    // Frame 0 is on the canvas before recording starts.
    copyFrame(await target.renderFrame(frameTime(0, fps, duration)), copy);
    opts.onFrame?.(copy, 0);
    const started = new Promise<void>((resolve) => {
      recorder.onstart = () => resolve();
    });
    recorder.start(1000);
    // Frames requested before the recorder has really started are lost (the video would miss
    // its beginning), so wait for the start event and give the encoder a moment to spin up.
    await Promise.race([started, new Promise((r) => setTimeout(r, 2000))]);
    track.requestFrame();
    opts.onProgress?.({ phase: 'render', done: 1, total });
    // MediaRecorder timestamps frames by wall clock, so the animation must run in real time:
    // each step renders the frame due *now*. A slow machine drops frames instead of producing
    // a slowed-down video; the duration stays correct.
    const t0 = performance.now();
    let last = 0;
    while (last < total - 1) {
      const due = t0 + ((last + 1) * 1000) / fps;
      const wait = due - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      throwIfAborted(opts.signal);
      if (recError) throw recError;
      const i = Math.min(total - 1, Math.max(last + 1, Math.floor(((performance.now() - t0) * fps) / 1000)));
      copyFrame(await target.renderFrame(frameTime(i, fps, duration)), copy);
      track.requestFrame();
      opts.onFrame?.(copy, i);
      opts.onProgress?.({ phase: 'render', done: i + 1, total });
      last = i;
    }
    // Hold the last frame for its full period so the video lasts total / fps seconds.
    const endWait = t0 + (total * 1000) / fps - performance.now();
    await new Promise((r) => setTimeout(r, Math.max(1000 / fps, endWait)));
    // Give the recorder's encoder a moment to drain queued frames before stopping.
    await new Promise((r) => setTimeout(r, 300));
    opts.onProgress?.({ phase: 'finalize', done: total, total });
    await stop();
    if (recError) throw recError;
    const type = (recorder.mimeType || mimeType).split(';')[0];
    return new Blob(parts, { type });
  } catch (e) {
    await stop().catch(() => undefined);
    throw e;
  } finally {
    stream.getTracks().forEach((tr) => tr.stop());
    safeEnd(target);
  }
}

export { ExportAbortError };
