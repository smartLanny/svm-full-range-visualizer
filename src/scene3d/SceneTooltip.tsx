import React, { forwardRef } from 'react';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import { colormapCss, divergingCss } from '../colormaps';
import { fmtNits, fmtSvm } from '../data/grid';
import type { SceneLayout } from '../types';
import { levelNoteText, noteLines } from '../data/denoiseText';
import { cn } from '../ui/cn';
import type { DenoiseAction } from '../data/denoise';
import type { HoverInfo, HoverNote } from './engine/engine';

/** Swatch of the "no data" floor (same hatch as the 3D view and its legend chip). */
const NO_DATA_SWATCH: React.CSSProperties = {
  background: 'repeating-linear-gradient(45deg, #5b6576 0 1px, #0d1117 1px 4px)',
};

/** Calm tones of the denoise actions: filled (sky), no data (neutral), luminance estimated (amber). */
const ACTION_TONE: Record<DenoiseAction, string> = {
  interpolated: 'text-sky-300',
  noData: 'text-ink-1',
  lumEstimated: 'text-amber-200/90',
};

/** Cursor-following DOM tooltip (not part of exports). Positioned by the parent via style.transform. */
export const SceneTooltip = forwardRef<HTMLDivElement, { info: HoverInfo | null; layout: SceneLayout }>(function SceneTooltip({ info, layout }, ref) {
  const t = useT();
  const colormap = useAppStore((s) => s.colormap);
  const colorMax = useAppStore((s) => s.colorMax);
  const swatch = (v: number, diff: boolean, range = 1) => (diff ? divergingCss(Math.max(-1, Math.min(1, v / range))) : colormapCss(colormap, v, colorMax));
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-ink-3">{k}</span>
      <span className="font-mono tabular-nums text-ink-1">{v}</span>
    </div>
  );
  const sgn = (v: number) => (v > 0 ? `+${fmtSvm(v)}` : v < 0 ? `−${fmtSvm(-v)}` : fmtSvm(0));
  const valueRow = (label: string, text: string, style: React.CSSProperties) => (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-ink-1">
        <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-white/20" style={style} />
        {text}
      </span>
    </div>
  );
  /** What the denoise did (docs/adr/0012 addendum): action, reason, source, raw reading. */
  const noteBlock = (h: HoverNote, i: number) => {
    const l = noteLines(h.note, t);
    return (
      <div key={i} className="space-y-0.5 text-2xs leading-snug" data-testid="scene3d-tooltip-note">
        <div className={cn('font-medium', ACTION_TONE[h.note.action])}>
          {h.who ? `${h.who} · ` : ''}
          {l.action}
        </div>
        <div className="text-ink-2">{l.reason}</div>
        {l.also && <div className="text-ink-2">{l.also}</div>}
        {l.source && <div className="text-ink-3">{l.source}</div>}
        <div className="font-mono tabular-nums text-ink-3">{l.raw}</div>
      </div>
    );
  };
  const estimated = (info: HoverInfo) => {
    const own = info.notes?.find((n) => n.who !== 'B')?.note;
    return !!own && (own.action === 'lumEstimated' || (own.action === 'interpolated' && own.value?.nits !== own.raw.nits));
  };
  const missingText = (m: NonNullable<HoverInfo['missing']>) => (m.who ? `${m.who}: ${t('common.noValidData')}` : t('common.noValidData'));
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-0 top-0 z-20 min-w-[184px] rounded-lg bg-surface-2/95 px-3 py-2 text-xs shadow-panel ring-1 ring-line-strong backdrop-blur-md transition-opacity duration-100"
      style={{ opacity: info ? 1 : 0 }}
    >
      {info && (
        <>
          {layout !== 'single' && (
            <div className="mb-1.5 truncate text-2xs font-medium text-ink-2">
              {info.kind === 'diff' ? t('scene3d.title.diff') : `${info.panel} · ${info.label}`}
            </div>
          )}
          <div className="space-y-0.5">
            {row(t('scene3d.tooltip.gray'), `G${Math.round(info.gray)}`)}
            {row(t('scene3d.tooltip.brightness'), `${Math.round(info.percent * 10) / 10}%`)}
            {row(t('scene3d.tooltip.levelLuminance'), `${fmtNits(info.levelNits)} nits${info.level ? ` (${t('common.denoise.estimated')})` : ''}`)}
            {info.nits !== null && row(t('scene3d.tooltip.measured'), `${fmtNits(info.nits)} nits${estimated(info) ? ` (${t('common.denoise.estimated')})` : ''}`)}
          </div>
          <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
            {info.kind === 'diff' && (
              <>
                {row(t('scene3d.tooltip.a'), info.a !== null && info.a !== undefined ? fmtSvm(info.a) : '—')}
                {row(t('scene3d.tooltip.b'), info.b !== null && info.b !== undefined ? fmtSvm(info.b) : '—')}
              </>
            )}
            {info.value === null ? (
              <>
                {valueRow(info.kind === 'diff' ? t('scene3d.tooltip.delta') : t('scene3d.tooltip.svm'), '—', NO_DATA_SWATCH)}
                {(info.missing || !info.notes?.length) && <div className="text-right text-2xs text-ink-2">{missingText(info.missing ?? {})}</div>}
              </>
            ) : info.kind === 'diff' ? (
              <>
                {valueRow(t('scene3d.tooltip.delta'), sgn(info.value), { background: swatch(info.value, true, info.range) })}
                {Math.abs(info.value) > info.range + 1e-9 && <div className="text-right text-2xs text-ink-3">{t('scene3d.tooltip.beyondScale')}</div>}
              </>
            ) : (
              valueRow(t('scene3d.tooltip.svm'), fmtSvm(info.value), { background: swatch(info.value, false) })
            )}
            {info.capped && <div className="text-right text-2xs text-ink-3">{t('scene3d.tooltip.capped')}</div>}
          </div>
          {(info.notes?.length || info.level) && (
            <div className="mt-1.5 max-w-[280px] space-y-1.5 border-t border-line pt-1.5">
              {info.notes?.map(noteBlock)}
              {info.level && (
                <div className="text-2xs leading-snug text-ink-2" data-testid="scene3d-tooltip-level">
                  {levelNoteText(info.level, t)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});
