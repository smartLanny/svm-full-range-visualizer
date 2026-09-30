/**
 * Plain-language texts of the denoise (docs/adr/0012 addendum) for tooltips, badges, the importer
 * preview and exports: what was done to a cell, the raw reading and why — the same wording in the
 * 3D, 2D, table and stats views. Keys: common.denoise.* (CONTEXT.md: 降噪, 插值补全, 无有效数据,
 * 亮度读数未更新, 黑场噪声). `t` is passed in, so this module stays free of the store / React.
 */
import type { TFunction } from '../i18n';
import { DENOISE_KINDS, noteParams, type CellNote, type DenoiseKind, type DenoiseSummary, type LevelNote } from './denoise';
import { fmtNits } from './grid';

export interface NoteLines {
  /** What was done: 插值补全 / 无有效数据 / 亮度为估算值. */
  action: string;
  /** Why, with the numbers. */
  reason: string;
  /** A second problem of the same cell (an SVM spike whose luminance is unreliable too). */
  also?: string;
  /** The raw reading: “原始读数：0.01 nits · SVM 22.73”. */
  raw: string;
  /** How the shown value was obtained (interpolation sources, luminance estimate). */
  source?: string;
}

/** Texts of one processed cell. */
export function noteLines(n: CellNote, t: TFunction): NoteLines {
  const p = noteParams(n);
  const out: NoteLines = {
    action: t(`common.denoise.action.${n.action}`),
    reason: t(`common.denoise.reason.${n.reason}`, p),
    raw: t('common.denoise.raw', { nits: p.nits, svm: p.svm }),
  };
  if (n.also && p.dev) out.also = t('common.denoise.also', { dev: p.dev });
  const src: string[] = [];
  if (n.action === 'interpolated' && p.from0 && p.from1) src.push(t('common.denoise.from', { from0: p.from0, from1: p.from1 }));
  if (n.lumVia) src.push(t(`common.denoise.lumVia.${n.lumVia}`));
  if (src.length) out.source = src.join(' · ');
  return out;
}

/** One line per text (tooltips that are plain strings, e.g. native `title`). */
export function noteText(n: CellNote, t: TFunction): string {
  const l = noteLines(n, t);
  return [l.action, l.reason, l.also, l.source, l.raw].filter(Boolean).join('\n');
}

/** Re-estimated level luminance of a column. */
export function levelNoteText(l: LevelNote, t: TFunction): string {
  return t('common.denoise.level', { raw: fmtNits(l.raw), value: fmtNits(l.value) });
}

type Counts = Pick<DenoiseSummary, 'interpolated' | 'noData' | 'lumEstimated'> & Partial<Pick<DenoiseSummary, 'levelsEstimated'>>;

/** Non-zero counts in plain words: ["插值补全 2 格", "无有效数据 39 格", …]. */
export function countParts(c: Counts, t: TFunction): string[] {
  const out: string[] = [];
  if (c.interpolated) out.push(t('common.denoise.count.interpolated', { n: c.interpolated }));
  if (c.noData) out.push(t('common.denoise.count.noData', { n: c.noData }));
  if (c.lumEstimated) out.push(t('common.denoise.count.lumEstimated', { n: c.lumEstimated }));
  if (c.levelsEstimated) out.push(t('common.denoise.count.levels', { n: c.levelsEstimated }));
  return out;
}

/** Non-zero problems by kind: ["接近全黑、测不准 35", "SVM 尖峰 2", …] (DENOISE_KINDS order). */
export function kindParts(byKind: Partial<Record<DenoiseKind, number>>, t: TFunction): string[] {
  return DENOISE_KINDS.filter((k) => byKind[k]).map((k) => `${t(`common.denoise.kind.${k}`)} ${byKind[k]}`);
}

/** Multi-line breakdown of what the denoise did to a record (records badge / legend / stats). */
export function summaryText(sum: DenoiseSummary, t: TFunction): string {
  return [
    t('common.denoise.badgeTitle', { n: sum.touched }),
    countParts(sum, t).join(' · '),
    kindParts(sum.byKind, t).join(' · '),
    t('common.denoise.coverage', { valid: sum.valid, nominal: sum.nominal }),
  ]
    .filter(Boolean)
    .join('\n');
}
