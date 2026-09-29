import type { Dataset, DataPoint, Lang, RecordSource, SvmRecord } from '../types';

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

/** Structural validation for imported JSON. Throws on invalid input. */
export function validateDataset(json: unknown): Dataset {
  const ds = json as Dataset;
  if (!ds || typeof ds !== 'object') throw new Error('INVALID_JSON');
  const m = ds.matrix;
  if (!m || !Array.isArray(m.rows) || !Array.isArray(m.cols) || !Array.isArray(m.grid)) throw new Error('INVALID_MATRIX');
  if (m.grid.length !== m.rows.length) throw new Error('INVALID_MATRIX');
  for (const row of m.grid) {
    if (!Array.isArray(row) || row.length !== m.cols.length) throw new Error('INVALID_MATRIX');
  }
  if (!Array.isArray(m.headerNits) || m.headerNits.length !== m.cols.length) {
    // Rebuild level luminance from the max gray row.
    let maxIdx = 0;
    m.rows.forEach((g, i) => {
      if (g > m.rows[maxIdx]) maxIdx = i;
    });
    m.headerNits = m.cols.map((_, c) => m.grid[maxIdx][c]?.nits ?? 0);
  }
  const data: DataPoint[] = [];
  for (const row of m.grid) for (const p of row) if (p) data.push(p);
  return { ...ds, name: String(ds.name ?? '').trim() || 'Untitled', data };
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

/** Strip app-only fields for JSON export (keeps v1 compatibility, adds device/mode). */
export function toDatasetJson(rec: SvmRecord): Dataset {
  const { source: _s, deviceEn: _de, modeEn: _me, ...rest } = rec;
  return rest;
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
