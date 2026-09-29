import React, { forwardRef } from 'react';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import { colormapCss, divergingCss } from '../colormaps';
import { fmtNits, fmtSvm } from '../data/grid';
import type { SceneLayout } from '../types';
import type { HoverInfo } from './engine/engine';

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
            {row(t('scene3d.tooltip.levelLuminance'), `${fmtNits(info.levelNits)} nits`)}
            {info.nits !== null && row(t('scene3d.tooltip.measured'), `${fmtNits(info.nits)} nits`)}
          </div>
          <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
            {info.kind === 'diff' ? (
              <>
                {row(t('scene3d.tooltip.a'), info.a !== null && info.a !== undefined ? fmtSvm(info.a) : '—')}
                {row(t('scene3d.tooltip.b'), info.b !== null && info.b !== undefined ? fmtSvm(info.b) : '—')}
                <div className="flex items-center justify-between gap-4">
                  <span className="text-ink-3">{t('scene3d.tooltip.delta')}</span>
                  <span className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-ink-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-white/20" style={{ background: swatch(info.value, true, info.range) }} />
                    {sgn(info.value)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <span className="text-ink-3">{t('scene3d.tooltip.svm')}</span>
                <span className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-ink-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-white/20" style={{ background: swatch(info.value, false) }} />
                  {fmtSvm(info.value)}
                </span>
              </div>
            )}
            {info.capped && <div className="text-right text-2xs text-ink-3">{t('scene3d.tooltip.capped')}</div>}
          </div>
        </>
      )}
    </div>
  );
});
