/**
 * Export job orchestration: one job at a time, progress state for the progress modal, toasts,
 * and the guarantee that the view always returns to interactive mode (target.end()).
 */
import { create } from 'zustand';
import { getT } from '../i18n';
import { getActiveTimeline } from '../timeline/timeline';
import { toast } from '../ui';
import { downloadBlob, isAbort } from './canvas';
import { exportPng } from './png';
import { formatBytes } from './presets';
import type { ExportSize, ExportTarget } from './registry';
import { exportVideo, type VideoForce, type VideoProgress } from './video';

export type JobKind = 'image' | 'video';

export interface ExportJob {
  id: number;
  kind: JobKind;
  phase: VideoProgress['phase'];
  done: number;
  total: number;
  /** performance.now() at start. */
  startedAt: number;
  size: ExportSize;
  fps: number;
  /** Real-time MediaRecorder fallback in use. */
  realtime: boolean;
  cancelling: boolean;
}

interface SessionState {
  job: ExportJob | null;
}

export const useExportSession = create<SessionState>(() => ({ job: null }));

let controller: AbortController | null = null;
let nextId = 1;
/** Live preview canvas registered by the progress modal (drawn imperatively, never via React state). */
let preview: HTMLCanvasElement | null = null;
let lastPreview = 0;

export function setPreviewCanvas(c: HTMLCanvasElement | null) {
  preview = c;
  lastPreview = 0;
}

function drawPreview(src: HTMLCanvasElement, force = false) {
  if (!preview) return;
  const now = performance.now();
  if (!force && now - lastPreview < 120) return;
  lastPreview = now;
  const ctx = preview.getContext('2d');
  if (!ctx) return;
  const W = preview.width;
  const H = preview.height;
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, W, H);
  const k = Math.min(W / src.width, H / src.height);
  const w = src.width * k;
  const h = src.height * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

export function isExporting(): boolean {
  return useExportSession.getState().job !== null;
}

export function cancelExport() {
  const job = useExportSession.getState().job;
  if (!job || !controller) return;
  controller.abort();
  useExportSession.setState({ job: { ...job, cancelling: true } });
}

function update(patch: Partial<ExportJob>) {
  const job = useExportSession.getState().job;
  if (job) useExportSession.setState({ job: { ...job, ...patch } });
}

/** Pause the on-screen animation while exporting; resume afterwards if it was playing. */
function holdTimeline(): () => void {
  const tl = getActiveTimeline();
  if (!tl || !tl.playing) return () => undefined;
  tl.pause();
  return () => {
    if (!tl.playing) tl.play();
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export async function runImageExport(target: ExportTarget, size: ExportSize): Promise<boolean> {
  const t = getT();
  if (isExporting()) {
    toast(t('export.error.busy'), 'info');
    return false;
  }
  const id = nextId++;
  useExportSession.setState({
    job: { id, kind: 'image', phase: 'render', done: 0, total: 1, startedAt: performance.now(), size, fps: 0, realtime: false, cancelling: false },
  });
  const release = holdTimeline();
  try {
    const res = await exportPng(target, size);
    downloadBlob(res.blob, res.fileName);
    toast(getT()('export.done.image', { file: res.fileName }), 'success', 5000);
    return true;
  } catch (e) {
    console.error('PNG export failed:', e);
    toast(getT()('export.error.failed', { message: errorMessage(e) }), 'error', 8000);
    return false;
  } finally {
    release();
    useExportSession.setState({ job: null });
  }
}

export async function runVideoExport(target: ExportTarget, size: ExportSize, fps: number, force: VideoForce = 'auto'): Promise<boolean> {
  const t = getT();
  if (isExporting()) {
    toast(t('export.error.busy'), 'info');
    return false;
  }
  const id = nextId++;
  controller = new AbortController();
  const signal = controller.signal;
  useExportSession.setState({
    job: { id, kind: 'video', phase: 'prepare', done: 0, total: 1, startedAt: performance.now(), size, fps, realtime: false, cancelling: false },
  });
  const release = holdTimeline();
  let lastUpdate = 0;
  try {
    const res = await exportVideo(target, {
      size,
      fps,
      signal,
      force,
      onProgress: (p) => {
        const now = performance.now();
        const job = useExportSession.getState().job;
        // Throttle React updates (~12 Hz), but never skip phase changes or the final frame.
        if (job && (p.phase !== job.phase || p.done === p.total || now - lastUpdate > 80)) {
          lastUpdate = now;
          update({ phase: p.phase, done: p.done, total: p.total });
        }
      },
      onPlan: (plan) => update({ realtime: plan.method === 'mediarecorder' }),
      onFrame: (canvas, i) => drawPreview(canvas, i === 0),
    });
    downloadBlob(res.blob, res.fileName);
    const tt = getT();
    const fmt = res.plan.container.toUpperCase();
    if (res.plan.method === 'mediarecorder' || res.plan.codecName !== 'H.264') {
      const method = res.plan.method === 'mediarecorder' ? tt('export.done.methodRecorder') : tt('export.done.methodVp9');
      toast(tt('export.done.fallback', { format: fmt, file: res.fileName, method }), 'info', 9000);
    } else {
      toast(tt('export.done.video', { file: res.fileName, codec: `${fmt} · ${res.plan.codecName}`, size: formatBytes(res.blob.size) }), 'success', 6000);
    }
    return true;
  } catch (e) {
    if (isAbort(e) || signal.aborted) {
      toast(getT()('export.done.cancelled'), 'info');
    } else {
      console.error('Video export failed:', e);
      toast(getT()('export.error.failed', { message: errorMessage(e) }), 'error', 8000);
    }
    return false;
  } finally {
    release();
    controller = null;
    useExportSession.setState({ job: null });
  }
}
