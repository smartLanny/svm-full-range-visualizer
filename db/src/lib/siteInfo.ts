/**
 * Data version line of the page footer / home hero, from data/site-info.json
 * (pipeline/site/files.mjs → siteInfo()).
 *
 * `version` is data/version.json verbatim, written by `npm run db:import` (pipeline/README.md):
 * { dataVersion: "2026.11.02[.n]", date, batch, batches, counts }. When it is there the page shows
 * the data version; without it (older checkouts) the last commit that touched a served data file.
 */
import type { SiteInfo } from './types';
import { isoDate } from './format';

export interface DataVersionLine {
  /** "数据版本 2026.11.02" or "数据更新于 2026-11-02". */
  text: string;
  /** Short commit hash shown next to a commit-based line (null with a data version). */
  commit: string | null;
}

export function dataVersionLine(info: SiteInfo): DataVersionLine | null {
  const v = info.version;
  if (v && typeof v.dataVersion === 'string' && v.dataVersion) return { text: `数据版本 ${v.dataVersion}`, commit: null };
  const date = v?.date ?? isoDate(info.dataCommitDate);
  if (!date) return null;
  return { text: `数据更新于 ${date}`, commit: info.dataCommit };
}
