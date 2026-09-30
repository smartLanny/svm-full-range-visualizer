import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Box,
  ChartSpline,
  Clapperboard,
  Columns3,
  Diff,
  Download,
  Film,
  Grid3x3,
  Image as ImageIcon,
  LineChart,
  Monitor,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { useLang, useT } from '../i18n';
import { Button, Dialog, Segmented, cn } from '../ui';
import { animationOf, defaultContent, listContents, parseRemembered, type RememberedContents } from './contents';
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
  type ExportQuality,
} from './presets';
import { pngFileName } from './png';
import { CURRENT_CONTENT, type ExportContent, type ExportContentIcon, type ExportSize, type ExportTarget } from './registry';
import { runImageExport, runVideoExport } from './session';
import { currentViewSize } from './useExportTarget';
import { planVideo, videoFileName, type VideoForce, type VideoPlan } from './video';

interface Prefs {
  aspect: ExportAspect;
  quality: ExportQuality;
  fps: ExportFps;
  /** Last exported content per view (docs/adr/0010 addendum), used while that view still offers it. */
  content: RememberedContents;
}

const PREFS_KEY = 'svm-export-prefs.v1';
const DEFAULT_PREFS: Prefs = { aspect: '16:9', quality: '1080', fps: 60, content: {} };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      aspect: ASPECTS.includes(p.aspect as ExportAspect) ? (p.aspect as ExportAspect) : DEFAULT_PREFS.aspect,
      quality: QUALITIES.includes(p.quality as ExportQuality) ? (p.quality as ExportQuality) : DEFAULT_PREFS.quality,
      fps: p.fps === 30 ? 30 : 60,
      content: parseRemembered(p.content),
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

const CONTENT_ICON: Record<ExportContentIcon, LucideIcon> = {
  screen: Monitor,
  top: Grid3x3,
  perspective: Box,
  sideBySide: Columns3,
  diff: Diff,
  intro: Clapperboard,
  slice: ChartSpline,
  sweep: Film,
  table: Table2,
  chart: BarChart3,
};

const VIEW_ICON: Record<ExportTarget['id'], LucideIcon> = { scene3d: Box, chart2d: LineChart, stats: BarChart3 };

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
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {hint && <span className="truncate text-2xs text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** "图片" / "视频 · 0:13" chip of a content option. */
function KindChip({ content }: { content: ExportContent }) {
  const t = useT();
  const video = content.kind === 'video';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset',
        video ? 'bg-accent/10 text-accent-hover ring-accent/30' : 'bg-surface-1 text-ink-3 ring-line',
      )}
    >
      {video ? <Film size={11} /> : <ImageIcon size={11} />}
      {video ? t('export.content.video') : t('export.content.image')}
      {video && content.duration !== undefined && <span className="font-mono tabular-nums">· {formatDuration(content.duration)}</span>}
    </span>
  );
}

/** The view's export contents as a single-choice list (label, one-line detail, kind / duration). */
function ContentList({ contents, selected, onSelect }: { contents: ExportContent[]; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('export.content.label')} className="flex flex-col gap-1.5" data-testid="export-contents">
      {contents.map((c) => {
        const sel = c.id === selected;
        const Icon = CONTENT_ICON[c.icon ?? (c.kind === 'video' ? 'sweep' : 'screen')] ?? Monitor;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={sel}
            data-testid={`export-content-${c.id}`}
            data-kind={c.kind}
            title={c.detail ? `${c.label}\n${c.detail}` : c.label}
            onClick={() => onSelect(c.id)}
            className={cn(
              'group flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left ring-1 ring-inset transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
              sel ? 'bg-accent-muted ring-accent/60' : 'bg-surface-3 ring-line hover:bg-surface-4',
            )}
          >
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
                sel ? 'bg-accent/25 text-accent-hover' : 'bg-surface-1 text-ink-3 group-hover:text-ink-2',
              )}
            >
              <Icon size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn('truncate text-sm font-medium', sel ? 'text-ink-1' : 'text-ink-2 group-hover:text-ink-1')}>{c.label}</span>
                {c.current && c.id !== CURRENT_CONTENT && (
                  <span
                    title={t('export.content.onScreenTitle')}
                    className="shrink-0 rounded bg-surface-1 px-1 text-[10px] font-medium leading-4 text-ink-2 ring-1 ring-inset ring-line-strong"
                  >
                    {t('export.content.onScreen')}
                  </span>
                )}
              </span>
              {c.detail && <span className="truncate text-2xs leading-snug text-ink-3">{c.detail}</span>}
            </span>
            <KindChip content={c} />
          </button>
        );
      })}
    </div>
  );
}

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  target: ExportTarget;
}

/**
 * Export dialog (docs/adr/0010): first WHAT to export — the active view's contents (the frame on
 * screen, other renderings of the same data, animations) — then size / aspect (and fps for videos).
 */
export default function ExportDialog({ open, onClose, target }: ExportDialogProps) {
  const t = useT();
  const lang = useLang();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [windowSize, setWindowSize] = useState<ExportSize>(() => currentViewSize(target));
  const [encoder, setEncoder] = useState<EncoderStatus>({ state: 'checking' });
  const [contents, setContents] = useState<ExportContent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const labels = () => ({ current: t('export.content.current'), currentDetail: t('export.content.currentDetail') });

  // Each time the dialog opens: the "current view" size and the view's contents (they follow the
  // view's state), selecting the content remembered for this view, else the one on screen.
  useEffect(() => {
    if (!open) return;
    setWindowSize(currentViewSize(target));
    const list = listContents(target, labels());
    setContents(list);
    setSelectedId(defaultContent(list, prefs.content[target.id])?.id ?? null);
  }, [open, target]); // eslint-disable-line react-hooks/exhaustive-deps

  // Language switched while open: relabel, keep the selection.
  useEffect(() => {
    if (!open) return;
    const list = listContents(target, labels());
    setContents(list);
    setSelectedId((id) => (id && list.some((c) => c.id === id) ? id : (defaultContent(list)?.id ?? null)));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const content = contents.find((c) => c.id === selectedId) ?? null;
  const isVideo = content?.kind === 'video';
  const anim = open && content && isVideo ? animationOf(target, content.id) : null;

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
    if (!open || !content) return '';
    try {
      if (!isVideo) return pngFileName(target, size, content.id);
      const container = encoder.state === 'ready' ? encoder.plan.container : 'mp4';
      return videoFileName(target, size, prefs.fps, container, content.id);
    } catch (e) {
      console.warn('Export file name failed:', e);
      return '';
    }
  }, [open, content, isVideo, target, size.width, size.height, prefs.fps, encoder]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const frames = anim ? frameCount(anim.duration, prefs.fps) : 0;
  const canStart = !!content && (!isVideo || (!!anim && encoder.state === 'ready'));

  const start = () => {
    if (!content) return;
    // Remember the choice for this view (offered first next time while the view still has it).
    patch({ content: { ...prefs.content, [target.id]: content.id } });
    onClose();
    if (isVideo) void runVideoExport(target, size, prefs.fps, devForce(), content.id);
    else void runImageExport(target, size, content.id);
  };

  const qualityDims = (q: ExportQuality) => {
    const s = resolveSize(prefs.aspect, q, windowSize);
    return isVideo ? evenSize(s) : s;
  };
  const qualityName = (q: ExportQuality) =>
    q === 'window' ? t('export.quality.window') : q === '1080' ? t('export.quality.p1080') : q === '1440' ? t('export.quality.p1440') : t('export.quality.p2160');
  const aspectName = (a: ExportAspect) => (a === '16:9' ? t('export.aspect.landscape') : a === '9:16' ? t('export.aspect.portrait') : t('export.aspect.square'));

  const ViewIcon = VIEW_ICON[target.id] ?? Monitor;

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
      widthClass="max-w-[820px]"
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
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
        {/* 1. What to export */}
        <Row
          label={
            <span className="flex items-center gap-1.5">
              <ViewIcon size={13} className="text-accent-hover" />
              {t('export.content.label')}
            </span>
          }
          hint={t('export.content.hint', { view: t(`export.view.${target.id}`), n: contents.length })}
        >
          <ContentList contents={contents} selected={selectedId} onSelect={setSelectedId} />
        </Row>

        {/* 2. Size / aspect / frame rate */}
        <div className="flex min-w-0 flex-col gap-4">
          <Row label={t('export.quality.label')}>
            <div role="radiogroup" aria-label={t('export.quality.label')} className="grid grid-cols-4 gap-2">
              {QUALITIES.map((q) => {
                const d = qualityDims(q);
                return (
                  <Tile key={q} selected={prefs.quality === q} onClick={() => patch({ quality: q })} testId={`export-quality-${q}`}>
                    <span className="max-w-full truncate text-xs font-semibold">{qualityName(q)}</span>
                    <span className="max-w-full truncate font-mono text-2xs tabular-nums text-ink-3">
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
                      <span className="max-w-full truncate text-2xs text-ink-3">{aspectName(a)}</span>
                    </span>
                  </Tile>
                );
              })}
            </div>
          </Row>

          {isVideo && anim && (
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
          )}

          {/* The chosen content in full (the list truncates its detail) and what the file will be. */}
          {content && (
            <div className="flex flex-col gap-2 rounded-lg bg-surface-1 px-3 py-2.5 text-2xs ring-1 ring-inset ring-line" data-testid="export-summary">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-medium text-ink-1">{content.label}</span>
                {content.detail && <span className="leading-snug text-ink-3">{content.detail}</span>}
              </div>
              {isVideo && anim ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-ink-3">{t('export.animation')}</span>
                    <span className="font-mono tabular-nums text-ink-1">{t('export.durationFrames', { duration: formatDuration(frames / prefs.fps), frames })}</span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-ink-3">{t('export.estimate')}</span>
                    <span className="font-mono tabular-nums text-ink-1">≈ {formatBytes(estimateVideoBytes(size, prefs.fps, anim.duration))}</span>
                  </div>
                  <div className="col-span-2 flex flex-col gap-0.5 border-t border-line pt-2">
                    <span className="text-ink-3">{t('export.encoder.label')}</span>
                    <span data-testid="export-encoder">{encoderLine}</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                  <span className="text-ink-3">{t('export.format')}</span>
                  <span className="font-mono tabular-nums text-ink-1">
                    PNG · {size.width}×{size.height}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
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
