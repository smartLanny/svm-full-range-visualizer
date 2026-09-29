import type { Dataset, DataPoint, Lang, RecordSource, SvmRecord } from '../types';

let idCounter = 0;
export const generateId = () =>
  `u${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Guess device / mode from a free-form record name: "华为Mate70Air 60Hz" -> device "华为Mate70Air",
 * mode "60Hz". Without whitespace the whole name is the device and the mode is empty.
 */
export function guessDeviceMode(name: string): { device: string; mode: string } {
  const clean = name.replace(/\s+/g, ' ').trim();
  const idx = clean.indexOf(' ');
  if (idx <= 0) return { device: clean, mode: '' };
  return { device: clean.slice(0, idx), mode: clean.slice(idx + 1) };
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
