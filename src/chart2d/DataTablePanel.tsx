import React, { useMemo } from 'react';
import { Copy, X } from 'lucide-react';
import { useT } from '../i18n';
import { Button, IconButton, cn, toast } from '../ui';
import { SVM_CRITICAL, SVM_SAFE } from '../types';
import type { Scene } from './scene';
import { exclusionText, titleText } from './scene';
import { buildTable, columnLabel, tableToTsv } from './table';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // file:// or denied permission: legacy fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function DashSample({ color, dash }: { color: string; dash: number[] }) {
  return (
    <svg width="18" height="6" aria-hidden="true" className="shrink-0">
      <line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="2.5" strokeDasharray={dash.length ? dash.map((d) => d * 0.6).join(' ') : undefined} />
    </svg>
  );
}

/** Slice values per visible record (columns = x samples), with "copy TSV". */
export function DataTablePanel({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const t = useT();
  const model = useMemo(() => buildTable(scene), [scene]);
  const exclusions = useMemo(() => new Map(scene.series.map((se) => [se.id, se.exclusion])), [scene]);
  const heading = titleText(scene.lang, scene.mode, scene.param);

  const onCopy = async () => {
    const ok = await copyText(tableToTsv(model, { record: t('chart2d.table.record'), unit: t('common.nits') }));
    toast(ok ? t('chart2d.table.copied') : t('chart2d.table.copyFailed'), ok ? 'success' : 'error');
  };

  return (
    <div className="absolute inset-x-3 bottom-3 z-30 flex max-h-[48%] flex-col overflow-hidden rounded-xl bg-surface-2/95 shadow-panel ring-1 ring-line backdrop-blur-md">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold text-ink-1">{t('chart2d.table.title')}</span>
        <span className="truncate text-2xs text-ink-3">{heading}</span>
        <span className="flex-1" />
        <Button size="xs" variant="secondary" icon={<Copy size={12} />} onClick={onCopy} disabled={model.rows.length === 0}>
          {t('chart2d.table.copyTsv')}
        </Button>
        <IconButton size="xs" label={t('common.close')} icon={<X size={13} />} onClick={onClose} />
      </div>
      {model.rows.length === 0 || model.xs.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-ink-3">{t('chart2d.table.empty')}</div>
      ) : (
        <div className="min-h-0 overflow-auto">
          <table className="w-max border-separate border-spacing-0 text-2xs">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r border-line bg-surface-2 px-3 py-1.5 text-left font-medium text-ink-3">
                  {t('chart2d.table.record')}
                </th>
                {model.xs.map((x) => (
                  <th key={x} className="sticky top-0 z-10 border-b border-line bg-surface-2 px-2.5 py-1.5 text-right font-medium tabular-nums text-ink-3">
                    {columnLabel(model.mode, x)}
                    {model.mode === 'gray' && <span className="ml-1 font-normal text-ink-4">nits</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-3/60">
                  <th scope="row" className="sticky left-0 z-10 border-r border-line bg-surface-2 px-3 py-1 text-left font-medium text-ink-2">
                    <span className="flex items-center gap-2 whitespace-nowrap" title={exclusions.get(r.id) ? exclusionText(scene.lang, exclusions.get(r.id)!) : undefined}>
                      <DashSample color={r.color} dash={r.dash} />
                      {r.label}
                      {r.excluded > 0 && <span className="-ml-1 font-semibold text-amber-300">*</span>}
                    </span>
                  </th>
                  {r.values.map((v, i) => (
                    <td
                      key={i}
                      className={cn(
                        'px-2.5 py-1 text-right tabular-nums',
                        v === null ? 'text-ink-4' : v >= SVM_CRITICAL ? 'text-red-300' : v < SVM_SAFE ? 'text-ink-2' : 'text-ink-1',
                      )}
                    >
                      {v === null ? '' : v.toFixed(3)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-line px-3 py-1.5 text-2xs text-ink-4">
        {t('chart2d.table.note')}
        {model.rows.some((r) => r.excluded > 0) && <div className="mt-0.5 text-amber-300/80">{t('chart2d.table.excludedNote')}</div>}
      </div>
    </div>
  );
}
