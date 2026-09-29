import React, { useEffect, useMemo, useState } from 'react';
import { Box, Clapperboard, Download, Film, Image as ImageIcon, Info, LineChart } from 'lucide-react';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Button, Dialog, Segmented, cn } from '../ui';
import {
  ASPECTS,
  estimateVideoBytes,
  evenSize,
  formatBytes,
  formatDuration,
  frameCount,
  FPS_OPTIONS,
  QUALITIES,
  resolveSize,
  type ExportAspect,
  type ExportFps,
  type ExportKind,
  type ExportQuality,
} from './presets';
import { pngFileName } from './png';
import type { ExportSize, ExportTarget } from './registry';
import { runImageExport, runVideoExport } from './session';
import { currentViewSize } from './useExportTarget';
import { planVideo, videoFileName, type VideoForce, type VideoPlan } from './video';

interface Prefs {
  kind: ExportKind;
  aspect: ExportAspect;
  quality: ExportQuality;
  fps: ExportFps;
}

const PREFS_KEY = 'svm-export-prefs.v1';
const DEFAULT_PREFS: Prefs = { kind: 'image', aspect: '16:9', quality: '1080', fps: 60 };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      kind: p.kind === 'video' ? 'video' : 'image',
      aspect: ASPECTS.includes(p.aspect as ExportAspect) ? (p.aspect as ExportAspect) : DEFAULT_PREFS.aspect,
      quality: QUALITIES.includes(p.quality as ExportQuality) ? (p.quality as ExportQuality) : DEFAULT_PREFS.quality,
      fps: p.fps === 30 ? 30 : 60,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences are a convenience only */
  }
}

/** DEV-only test hook: ?exportForce=vp9|recorder skips better encoders. */
function devForce(): VideoForce {
  if (!import.meta.env.DEV) return 'auto';
  const f = new URLSearchParams(location.search).get('exportForce');
  return f === 'vp9' || f === 'recorder' ? f : 'auto';
}

type EncoderStatus = { state: 'checking' } | { state: 'ready'; plan: VideoPlan } | { state: 'none' };

const ASPECT_GLYPH: Record<ExportAspect, { w: number; h: number }> = {
  '16:9': { w: 22, h: 12 },
  '9:16': { w: 12, h: 21 },
  '1:1': { w: 16, h: 16 },
};

function Tile({
  selected,
  disabled,
  onClick,
  children,
  testId,
  row,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
  /** Horizontal content (icon + text). */
  row?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-center justify-center rounded-lg px-2 py-2 text-center ring-1 ring-inset transition-colors',
        row ? 'flex-row gap-2.5' : 'flex-col gap-0.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-35',
        selected ? 'bg-accent-muted text-ink-1 ring-accent/60' : 'bg-surface-3 text-ink-2 ring-line hover:bg-surface-4 hover:text-ink-1',
      )}
    >
      {children}
    </button>
  );
}

function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {hint && <span className="truncate text-2xs text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  target: ExportTarget;
}

export default function ExportDialog({ open, onClose, target }: ExportDialogProps) {
  const t = useT();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [windowSize, setWindowSize] = useState<ExportSize>(() => currentViewSize(target));
  const [encoder, setEncoder] = useState<EncoderStatus>({ state: 'checking' });
  // The 3D intro always plays record A alone (docs/adr/0010, contract C6).
  const layout = useAppStore((s) => s.layout);

  const anim = open ? target.animation() : null;
  const kind: ExportKind = anim ? prefs.kind : 'image';
  const isVideo = kind === 'video';

  // Refresh the "current view" size each time the dialog opens.
  useEffect(() => {
    if (open) setWindowSize(currentViewSize(target));
  }, [open, target]);

  const patch = (p: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      savePrefs(next);
      return next;
    });

  const rawSize = resolveSize(prefs.aspect, prefs.quality, windowSize);
  const size = isVideo ? evenSize(rawSize) : rawSize;

  // Detect how the video will be encoded for this size / fps.
  useEffect(() => {
    if (!open || !isVideo) return;
    let alive = true;
    setEncoder({ state: 'checking' });
    planVideo(size, prefs.fps, devForce())
      .then((plan) => alive && setEncoder(plan ? { state: 'ready', plan } : { state: 'none' }))
      .catch(() => alive && setEncoder({ state: 'none' }));
    return () => {
      alive = false;
    };
  }, [open, isVideo, size.width, size.height, prefs.fps]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileName = useMemo(() => {
    if (!open) return '';
    if (!isVideo) return pngFileName(target, size);
    const container = encoder.state === 'ready' ? encoder.plan.container : 'mp4';
    return videoFileName(target, size, prefs.fps, container);
  }, [open, isVideo, target, size.width, size.height, prefs.fps, encoder]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const frames = anim ? frameCount(anim.duration, prefs.fps) : 0;
  const canStart = !isVideo || encoder.state === 'ready';

  const start = () => {
    onClose();
    if (isVideo) void runVideoExport(target, size, prefs.fps, devForce());
    else void runImageExport(target, size);
  };

  const qualityDims = (q: ExportQuality) => {
    const s = resolveSize(prefs.aspect, q, windowSize);
    return isVideo ? evenSize(s) : s;
  };
  const qualityName = (q: ExportQuality) =>
    q === 'window' ? t('export.quality.window') : q === '1080' ? t('export.quality.p1080') : q === '1440' ? t('export.quality.p1440') : t('export.quality.p2160');
  const aspectName = (a: ExportAspect) => (a === '16:9' ? t('export.aspect.landscape') : a === '9:16' ? t('export.aspect.portrait') : t('export.aspect.square'));

  const ViewIcon = target.id === 'scene3d' ? Box : LineChart;
  const introLayoutNote = target.id === 'scene3d' && anim && layout !== 'single' ? t('export.layoutNote') : null;

  let encoderLine: React.ReactNode = null;
  if (isVideo) {
    if (encoder.state === 'checking') encoderLine = <StatusLine tone="muted">{t('export.encoder.checking')}</StatusLine>;
    else if (encoder.state === 'none') encoderLine = <StatusLine tone="bad">{t('export.encoder.none')}</StatusLine>;
    else {
      const p = encoder.plan;
      if (p.method === 'mediarecorder') encoderLine = <StatusLine tone="warn">{t('export.encoder.recorder', { format: p.container.toUpperCase() })}</StatusLine>;
      else if (p.codecName === 'H.264') encoderLine = <StatusLine tone="good">{p.hardware ? t('export.encoder.h264Hw') : t('export.encoder.h264')}</StatusLine>;
      else encoderLine = <StatusLine tone="warn">{t('export.encoder.vp9')}</StatusLine>;
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('export.title')}
      icon={<Download size={15} className="text-accent-hover" />}
      widthClass="max-w-[540px]"
      closeLabel={t('common.close')}
      footer={
        <>
          <div className="mr-auto min-w-0 flex-1">
            <div className="text-2xs uppercase tracking-[0.08em] text-ink-4">{t('export.output')}</div>
            <div className="truncate font-mono text-2xs text-ink-2" title={fileName} data-testid="export-filename">
              {fileName}
            </div>
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Download size={14} />} disabled={!canStart} onClick={start} data-testid="export-start">
            {isVideo ? t('export.start.video') : t('export.start.image')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* What is being exported */}
        <div className="flex items-center gap-3 rounded-lg bg-surface-1 px-3 py-2.5 ring-1 ring-inset ring-line">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent-hover">
            <ViewIcon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-1">{t(`export.view.${target.id}`)}</div>
            <div className="truncate text-2xs text-ink-3">
              {anim ? (
                <>
                  <Clapperboard size={11} className="-mt-px mr-1 inline" />
                  {anim.label} · {formatDuration(anim.duration)}
                </>
              ) : (
                t('export.kind.noAnimation')
              )}
            </div>
          </div>
        </div>
        {introLayoutNote && (
          <p className="-mt-2 flex items-start gap-1.5 px-1 text-2xs leading-snug text-ink-3" data-testid="export-layout-note">
            <Info size={12} className="mt-px shrink-0 text-accent-hover" />
            <span>{introLayoutNote}</span>
          </p>
        )}

        <Row label={t('export.kind.label')}>
          <Segmented<ExportKind>
            fullWidth
            size="md"
            value={kind}
            onChange={(v) => patch({ kind: v })}
            aria-label={t('export.kind.label')}
            options={[
              { value: 'image', label: t('export.kind.image'), icon: <ImageIcon size={14} /> },
              { value: 'video', label: t('export.kind.video'), icon: <Film size={14} />, disabled: !anim, title: anim ? undefined : t('export.kind.noAnimation') },
            ]}
          />
        </Row>

        <Row label={t('export.quality.label')}>
          <div role="radiogroup" aria-label={t('export.quality.label')} className="grid grid-cols-4 gap-2">
            {QUALITIES.map((q) => {
              const d = qualityDims(q);
              return (
                <Tile key={q} selected={prefs.quality === q} onClick={() => patch({ quality: q })} testId={`export-quality-${q}`}>
                  <span className="truncate text-xs font-semibold">{qualityName(q)}</span>
                  <span className="font-mono text-2xs tabular-nums text-ink-3">
                    {d.width}×{d.height}
                  </span>
                </Tile>
              );
            })}
          </div>
        </Row>

        <Row label={t('export.aspect.label')} hint={prefs.quality === 'window' ? t('export.aspect.windowHint') : undefined}>
          <div role="radiogroup" aria-label={t('export.aspect.label')} className="grid grid-cols-3 gap-2">
            {ASPECTS.map((a) => {
              const g = ASPECT_GLYPH[a];
              const selected = prefs.quality !== 'window' && prefs.aspect === a;
              return (
                <Tile key={a} selected={selected} disabled={prefs.quality === 'window'} onClick={() => patch({ aspect: a })} testId={`export-aspect-${a}`} row>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                    <span
                      className={cn('block rounded-[3px] border-[1.5px]', selected ? 'border-accent-hover bg-accent/20' : 'border-ink-3')}
                      style={{ width: g.w, height: g.h }}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col items-start leading-tight">
                    <span className="text-xs font-semibold">{a}</span>
                    <span className="truncate text-2xs text-ink-3">{aspectName(a)}</span>
                  </span>
                </Tile>
              );
            })}
          </div>
        </Row>

        {isVideo && anim && (
          <>
            <Row label={t('export.fps.label')} hint={t('export.fps.hint')}>
              <Segmented<string>
                fullWidth
                size="md"
                value={String(prefs.fps)}
                onChange={(v) => patch({ fps: Number(v) as ExportFps })}
                aria-label={t('export.fps.label')}
                options={FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` }))}
              />
            </Row>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-surface-1 px-3 py-2.5 text-2xs ring-1 ring-inset ring-line">
              <div className="flex flex-col gap-0.5">
                <span className="text-ink-3">{t('export.animation')}</span>
                <span className="font-mono tabular-nums text-ink-1">{t('export.durationFrames', { duration: formatDuration(frames / prefs.fps), frames })}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-ink-3">{t('export.estimate')}</span>
                <span className="font-mono tabular-nums text-ink-1">≈ {formatBytes(estimateVideoBytes(size, prefs.fps, anim.duration))}</span>
              </div>
              <div className="col-span-2 flex flex-col gap-0.5 border-t border-line pt-2">
                <span className="text-ink-3">{t('export.encoder.label')}</span>
                <span data-testid="export-encoder">{encoderLine}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function StatusLine({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  const dot = tone === 'good' ? 'bg-safe' : tone === 'warn' ? 'bg-amber-400' : tone === 'bad' ? 'bg-critical' : 'bg-ink-4 animate-pulse';
  return (
    <span className="flex items-start gap-2 leading-snug text-ink-2">
      <span className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span>{children}</span>
    </span>
  );
}
