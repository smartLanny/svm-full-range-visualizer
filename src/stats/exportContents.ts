/**
 * Export contents of the stats page (docs/adr/0010, addendum "stats page"): the cards grid and
 * the table of the visible records, images only. Pure, unit-tested.
 */
import { translate } from '../i18n';
import { CURRENT_CONTENT, safeFileName, type ExportContent } from '../export/registry';
import type { Lang } from '../types';
import type { StatsContentId } from './exportRender';

export interface StatsExportState {
  lang: Lang;
  /** View on screen (cards / table). */
  mode: StatsContentId;
  /** Visible records. */
  count: number;
}

/**
 * The content a request means: 'cards' / 'table'; the frame on screen (CURRENT_CONTENT, or
 * undefined from legacy callers) = the view on screen.
 */
export function statsContentOf(id: string | undefined, mode: StatsContentId): StatsContentId {
  return id === 'cards' || id === 'table' ? id : mode;
}

export function statsContents(st: StatsExportState): ExportContent[] {
  const t = (k: string, v?: Record<string, string | number>) => translate(st.lang, `stats.export.${k}`, v);
  return [
    { id: 'cards', kind: 'image', label: t('cards'), detail: t('cardsDetail', { n: st.count }), current: st.mode === 'cards', icon: 'chart' },
    { id: 'table', kind: 'image', label: t('table'), detail: t('tableDetail', { n: st.count }), current: st.mode === 'table', icon: 'table' },
  ];
}

/** Base file name: SVM_统计摘要_16条 / SVM_统计表格_16条 (SVM_summary_stats_16_records / SVM_stats_table_16_records). */
export function statsFileName(lang: Lang, content: string | undefined, mode: StatsContentId, count: number): string {
  const id = statsContentOf(content === CURRENT_CONTENT ? undefined : content, mode);
  return safeFileName(translate(lang, id === 'cards' ? 'stats.export.fileCards' : 'stats.export.fileTable', { n: count }));
}
