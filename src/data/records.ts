import type { Dataset, DataPoint, ExcludedPoint, Lang, RecordSource, SvmRecord } from '../types';

let idCounter = 0;
export const generateId = () =>
  `u${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const CJK = /[\u3400-\u9fff]/;
/** Tokens that start the mode part of a name: refresh rates, dimming schemes, common mode words. */
const MODE_WORD = /^(\d+(\.\d+)?\s*hz|dc|pwm|ltpo|ltps|hdr|sdr|standard|smooth|low|flicker|adaptive|auto|eco|normal|vivid|natural|night|eye|comfort|mode|on|off)$/i;

/**
 * Guess device / mode from a free-form record name. The device is the first word plus the
 * model-like words after it (digits / Latin, e.g. "18 Pro Max"); the mode starts at the first
 * word that contains CJK, is a refresh rate ("60Hz") or a mode keyword ("DC", "LTPO").
 *   "小米 18 Pro Max 自适应刷新 Pro 关" -> 小米 18 Pro Max | 自适应刷新 Pro 关
 *   "华为Mate70Air 60Hz" -> 华为Mate70Air | 60Hz     "iPhone 17 Pro Max" -> iPhone 17 Pro Max | ''
 */
export function guessDeviceMode(name: string): { device: string; mode: string } {
  const tokens = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return { device: '', mode: '' };
  let k = 1;
  while (k < tokens.length && !CJK.test(tokens[k]) && !MODE_WORD.test(tokens[k])) k++;
  return { device: tokens.slice(0, k).join(' '), mode: tokens.slice(k).join(' ') };
}

/** A number, or a numeric string ("500", " 0.2 ") as written by Excel / CSV → JSON converters; else NaN. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim().replace(/%$/, ''));
  return NaN;
}

/**
 * Structural validation + normalisation for imported / stored JSON. Throws an error code on
 * invalid input: INVALID_JSON, INVALID_MATRIX (shape), NO_VALID_CELLS (no cell with a finite
 * nits and SVM). Numeric strings are converted; cells that are not objects with finite nits and
 * SVM become null (missing, never 0); `excluded` keeps only well-formed points.
 */
export function validateDataset(json: unknown): Dataset {
  const ds = json as Dataset;
  if (!ds || typeof ds !== 'object' || Array.isArray(ds)) throw new Error('INVALID_JSON');
  const m = ds.matrix as Dataset['matrix'] | undefined;
  if (!m || typeof m !== 'object' || !Array.isArray(m.rows) || !Array.isArray(m.cols) || !Array.isArray(m.grid)) throw new Error('INVALID_MATRIX');
  if (m.grid.length !== m.rows.length) throw new Error('INVALID_MATRIX');
  const rows = m.rows.map(num);
  const cols = m.cols.map(num);
  if (!rows.every(Number.isFinite) || !cols.every(Number.isFinite)) throw new Error('INVALID_MATRIX');
  for (const row of m.grid) {
    if (!Array.isArray(row) || row.length !== cols.length) throw new Error('INVALID_MATRIX');
  }
  const grid: (DataPoint | null)[][] = m.grid.map((row, r) =>
    row.map((cell: unknown, c: number) => {
      if (!cell || typeof cell !== 'object') return null;
      const p = cell as Partial<Record<keyof DataPoint, unknown>>;
      const nits = num(p.nits);
      const svm = num(p.svm);
      if (!Number.isFinite(nits) || !Number.isFinite(svm)) return null;
      const gray = num(p.gray);
      const pct = num(p.brightnessPercent);
      return { gray: Number.isFinite(gray) ? gray : rows[r], brightnessPercent: Number.isFinite(pct) ? pct : cols[c], nits, svm };
    }),
  );
  const data: DataPoint[] = [];
  for (const row of grid) for (const p of row) if (p) data.push(p);
  if (!data.length) throw new Error('NO_VALID_CELLS');

  let headerNits = Array.isArray(m.headerNits) ? m.headerNits.map(num) : [];
  if (headerNits.length !== cols.length || !headerNits.every(Number.isFinite)) {
    // Rebuild level luminance from the max gray row.
    let maxIdx = 0;
    rows.forEach((g, i) => {
      if (g > rows[maxIdx]) maxIdx = i;
    });
    headerNits = cols.map((_, c) => grid[maxIdx][c]?.nits ?? 0);
  }

  const out: Dataset = { ...ds, name: String(ds.name ?? '').trim() || 'Untitled', data, matrix: { ...m, rows, cols, headerNits, grid } };
  if (ds.excluded !== undefined) {
    out.excluded = (Array.isArray(ds.excluded) ? ds.excluded : [])
      .filter((x): x is ExcludedPoint => !!x && typeof x === 'object')
      .map((x) => ({ ...x, gray: num(x.gray), brightnessPercent: num(x.brightnessPercent), nits: num(x.nits), svm: num(x.svm), reason: String(x.reason ?? '') }))
      .filter((x) => Number.isFinite(x.gray) && Number.isFinite(x.brightnessPercent) && Number.isFinite(x.nits) && Number.isFinite(x.svm));
  }
  return out;
}

/** Wrap a Dataset as an app record. */
export function toRecord(
  ds: Dataset,
  source: RecordSource,
  meta?: Partial<Pick<SvmRecord, 'device' | 'mode' | 'deviceEn' | 'modeEn' | 'id' | 'name'>>,
): SvmRecord {
  const guess = guessDeviceMode(ds.name);
  const device = meta?.device ?? ds.device ?? guess.device;
  const mode = meta?.mode ?? ds.mode ?? guess.mode;
  return {
    ...ds,
    id: meta?.id ?? ds.id ?? generateId(),
    name: meta?.name ?? (mode ? `${device} ${mode}` : device),
    source,
    device,
    mode,
    deviceEn: meta?.deviceEn,
    modeEn: meta?.modeEn,
  };
}

/** Exported JSON: a v1-compatible Dataset plus the optional English display names (v1 readers ignore them). */
export type DatasetJson = Dataset & Partial<Pick<SvmRecord, 'deviceEn' | 'modeEn'>>;

/** Strip app-only fields for JSON export (keeps v1 compatibility, adds device/mode and their English aliases). */
export function toDatasetJson(rec: SvmRecord): DatasetJson {
  const { source: _s, deviceEn, modeEn, ...rest } = rec;
  const out: DatasetJson = { ...rest };
  if (deviceEn) out.deviceEn = deviceEn;
  if (modeEn) out.modeEn = modeEn;
  return out;
}

/** English aliases carried by an exported JSON (strings only). */
export function englishAliases(json: unknown): Partial<Pick<SvmRecord, 'deviceEn' | 'modeEn'>> {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const out: Partial<Pick<SvmRecord, 'deviceEn' | 'modeEn'>> = {};
  if (typeof j.deviceEn === 'string' && j.deviceEn.trim()) out.deviceEn = j.deviceEn.trim();
  if (typeof j.modeEn === 'string' && j.modeEn.trim()) out.modeEn = j.modeEn.trim();
  return out;
}

export function deviceLabel(rec: Pick<SvmRecord, 'device' | 'deviceEn'>, lang: Lang): string {
  return lang === 'en' && rec.deviceEn ? rec.deviceEn : rec.device;
}

export function modeLabel(rec: Pick<SvmRecord, 'mode' | 'modeEn'>, lang: Lang): string {
  return lang === 'en' && rec.modeEn ? rec.modeEn : rec.mode;
}

/** Full display label, e.g. "华为 Mate 70 Air · 低频闪". */
export function recordLabel(rec: Pick<SvmRecord, 'device' | 'deviceEn' | 'mode' | 'modeEn'>, lang: Lang): string {
  const d = deviceLabel(rec, lang);
  const m = modeLabel(rec, lang);
  return m ? `${d} · ${m}` : d;
}
