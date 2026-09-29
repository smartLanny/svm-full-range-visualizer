import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Film, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { useT } from '../i18n';
import { Button, cn } from '../ui';
import { formatDuration } from './presets';
import { cancelExport, setPreviewCanvas, useExportSession } from './session';

const PREVIEW_W = 400;
const PREVIEW_MAX_H = 225;

/** Modal progress for a running export: live preview, progress bar, frames, elapsed / ETA, cancel. */
export default function ExportProgress() {
  const t = useT();
  const job = useExportSession((s) => s.job);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setTick] = useState(0);

  // Keep elapsed / ETA ticking even when no frames arrive (prepare / finalize phases).
  useEffect(() => {
    if (!job) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!job || job.kind !== 'video') return;
    setPreviewCanvas(canvasRef.current);
    return () => setPreviewCanvas(null);
  }, [job?.id, job?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job) return null;

  const isVideo = job.kind === 'video';
  const aspect = job.size.width / job.size.height;
  let pw = PREVIEW_W;
  let ph = pw / aspect;
  if (ph > PREVIEW_MAX_H) {
    ph = PREVIEW_MAX_H;
    pw = ph * aspect;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const frac = job.total > 0 ? job.done / job.total : 0;
  const elapsed = (performance.now() - job.startedAt) / 1000;
  const eta = job.phase === 'render' && job.done > 2 ? (elapsed / job.done) * (job.total - job.done) : null;
  const indeterminate = !isVideo || job.phase !== 'render';
  const status = !isVideo
    ? `${job.size.width}×${job.size.height}`
    : job.phase === 'prepare'
      ? t('export.progress.prepare')
      : job.phase === 'finalize'
        ? t('export.progress.finalize')
        : t('export.progress.render', { done: job.done, total: job.total });

  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/75 p-4" data-testid="export-progress">
      <div role="dialog" aria-modal="true" aria-live="polite" className="w-full max-w-[448px] overflow-hidden rounded-xl bg-surface-2 shadow-panel ring-1 ring-line">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          {isVideo ? <Film size={15} className="text-accent-hover" /> : <ImageIcon size={15} className="text-accent-hover" />}
          <h2 className="flex-1 text-sm font-semibold text-ink-1">{isVideo ? t('export.progress.titleVideo') : t('export.progress.titleImage')}</h2>
          <span className="font-mono text-2xs tabular-nums text-ink-3">
            {job.size.width}×{job.size.height}
            {isVideo ? ` · ${job.fps} fps` : ''}
          </span>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          {isVideo && (
            <div className="relative flex items-center justify-center rounded-lg bg-canvas ring-1 ring-inset ring-line" style={{ height: Math.round(ph) + 16 }}>
              {/* Placeholder until the first frame is drawn (the canvas starts transparent). */}
              <Loader2 size={20} className="absolute animate-spin text-ink-4" />
              <canvas
                ref={canvasRef}
                width={Math.round(pw * dpr)}
                height={Math.round(ph * dpr)}
                style={{ width: Math.round(pw), height: Math.round(ph) }}
                className="relative rounded-[3px]"
              />
            </div>
          )}

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-4">
            {indeterminate ? (
              <div className="h-full w-1/3 animate-[svmExportIndeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            ) : (
              <div className="h-full rounded-full bg-accent" style={{ width: `${(frac * 100).toFixed(2)}%` }} />
            )}
          </div>

          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5 text-ink-2">
              <Loader2 size={13} className="animate-spin text-ink-3" />
              <span data-testid="export-status">{status}</span>
            </span>
            {isVideo && job.phase === 'render' && <span className="font-mono tabular-nums text-ink-1">{Math.floor(frac * 100)}%</span>}
          </div>

          {isVideo && (
            <div className="flex items-center justify-between text-2xs text-ink-3">
              <span className="tabular-nums">{t('export.progress.elapsed', { time: formatDuration(elapsed) })}</span>
              <span className="tabular-nums">{eta !== null ? t('export.progress.eta', { time: formatDuration(eta) }) : ''}</span>
            </div>
          )}

          {job.realtime && (
            <div className="flex items-start gap-2 rounded-md bg-amber-400/10 px-2.5 py-2 text-2xs leading-snug text-amber-200 ring-1 ring-inset ring-amber-400/25">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              {t('export.progress.realtime')}
            </div>
          )}
        </div>

        {isVideo && (
          <div className="flex justify-end border-t border-line px-5 py-3">
            <Button
              variant="danger"
              icon={job.cancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              disabled={job.cancelling}
              onClick={cancelExport}
              data-testid="export-cancel"
              className={cn(job.cancelling && 'opacity-60')}
            >
              {job.cancelling ? t('export.progress.cancelling') : t('export.progress.cancel')}
            </Button>
          </div>
        )}
      </div>
      <style>{'@keyframes svmExportIndeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    </div>,
    document.body,
  );
}
