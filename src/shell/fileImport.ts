import type { Lang, SvmRecord } from '../types';
import { englishAliases, generateId, guessDeviceMode, recordLabel, toDatasetJson, toRecord, validateDataset } from '../data/records';
import { parseRawData, splitTables } from '../data/parse';
import { safeFileName } from '../export/registry';
import { useAppStore } from '../store/appStore';
import type { TFunction } from '../i18n';
import { toast } from '../ui';
import { screenDataset, type Screening } from './screening';
import { rawDataset } from '../data/denoise';
import { shellUi } from './uiStore';

export interface FileResult {
  fileName: string;
  /** 1-based table number and table count when one .tsv / .txt file holds several tables. */
  table?: number;
  tables?: number;
  ok: boolean;
  /** Parsed record, raw (points an older export stored in `excluded` put back). */
  record?: SvmRecord;
  /** What the denoise will do with it (preview, docs/adr/0012 addendum). */
  screening?: Screening | null;
  /** Error code (key under shell.importer.errors) or raw message. */
  error?: string;
}

const KNOWN_ERRORS = ['TOO_FEW_LINES', 'NO_HEADER', 'NO_ROWS', 'NO_VALID_CELLS', 'DUPLICATE_GRAY', 'INVALID_JSON', 'INVALID_MATRIX', 'PARSE', 'UNSUPPORTED', 'READ'];

/** Translate a parse / validation error code. */
export function errorText(t: TFunction, code: string | undefined): string {
  if (!code) return '';
  if (KNOWN_ERRORS.includes(code)) return t(`shell.importer.errors.${code}`);
  return t('shell.importer.errors.unknown', { msg: code });
}

export const isImportableFile = (name: string) => /\.(json|tsv|txt)$/i.test(name);
export const isTableFile = (name: string) => /\.(tsv|txt)$/i.test(name);

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * Turn a parsed JSON value into a user record (fresh id, so re-importing never collides). Always
 * raw: points a former version removed destructively (`excluded`) go back into the grid.
 */
export function jsonToRecord(json: unknown): SvmRecord {
  const ds = validateDataset(json);
  return rawDataset(toRecord(ds, 'user', { id: generateId(), name: ds.name, ...englishAliases(json) }));
}

/**
 * Parse a pasted / dropped table text into records, one per table (stacked tables are split
 * by their title / header rows). The record is named after the table's title line, or
 * `fallbackName` (+ " #i" when there are several untitled tables).
 */
export function tableTextToResults(text: string, fileName: string, fallbackName: string, factor = 1): FileResult[] {
  const tables = splitTables(text);
  return tables.map((tb, i): FileResult => {
    const extra = tables.length > 1 ? { table: i + 1, tables: tables.length } : {};
    try {
      const title = tb.title || (tables.length > 1 ? `${fallbackName} #${i + 1}` : fallbackName);
      const ds = parseRawData(tb.text, title, factor);
      const { device, mode } = guessDeviceMode(ds.name);
      const record = toRecord(ds, 'user', { device: device || ds.name, mode, name: ds.name });
      return { fileName, ...extra, ok: true, record, screening: screenDataset(record) };
    } catch (e) {
      return { fileName, ...extra, ok: false, error: (e as Error).message };
    }
  });
}

/** Read .json / .tsv / .txt files into user records (every table of a table file). Never throws. */
export async function readRecordFiles(files: File[]): Promise<FileResult[]> {
  const perFile = await Promise.all(
    files.map(async (file): Promise<FileResult[]> => {
      const fileName = file.name;
      let text: string;
      try {
        text = await file.text();
      } catch {
        return [{ fileName, ok: false, error: 'READ' }];
      }
      const looksJson = /\.json$/i.test(fileName) || (!isTableFile(fileName) && text.trimStart().startsWith('{'));
      if (looksJson) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return [{ fileName, ok: false, error: 'PARSE' }];
        }
        try {
          const record = jsonToRecord(json);
          return [{ fileName, ok: true, record, screening: screenDataset(record) }];
        } catch (e) {
          return [{ fileName, ok: false, error: (e as Error).message }];
        }
      }
      if (isTableFile(fileName) || !/\.[a-z0-9]+$/i.test(fileName)) return tableTextToResults(text, fileName, baseName(fileName));
      return [{ fileName, ok: false, error: 'UNSUPPORTED' }];
    }),
  );
  return perFile.flat();
}

/** Display name of a result: "raw.tsv · 表 2" for one of several tables. */
export function resultFileLabel(t: TFunction, r: FileResult): string {
  return r.table ? `${r.fileName} · ${t('shell.importer.untitled', { i: r.table })}` : r.fileName;
}

/**
 * Window drop / "Open JSON": a single table file opens the paste tab with its text (preview,
 * device / mode, correction factor and the denoise preview before anything is imported). Other
 * files are read and imported right away (raw; there is nothing to decide).
 */
export async function importFiles(files: File[], t: TFunction): Promise<FileResult[]> {
  if (files.length === 1 && isTableFile(files[0].name)) {
    let text: string | null = null;
    try {
      text = await files[0].text();
    } catch {
      text = null;
    }
    if (text !== null) {
      shellUi.openImporter('paste', { text, name: baseName(files[0].name) });
      return [];
    }
  }
  const results = await readRecordFiles(files);
  addResults(results, t);
  return results;
}

/** Add every valid result to the store (raw records), reporting the outcome as toasts. */
export function addResults(results: FileResult[], t: TFunction) {
  const ok = results.filter((r) => r.ok && r.record).map((r) => r.record!);
  const failed = results.filter((r) => !r.ok);
  if (ok.length) {
    const store = useAppStore.getState();
    store.addRecords(ok);
    // Newly imported records become A so the user immediately sees them in 3D.
    store.setActive(ok[0].id);
    const lang = store.lang;
    const msg = ok.length === 1 ? t('shell.importer.imported', { name: recordLabel(ok[0], lang) }) : t('shell.importer.importedN', { n: ok.length });
    toast(msg, 'success', 3200);
  }
  if (failed.length) {
    const first = failed[0];
    const label = resultFileLabel(t, first);
    toast(
      failed.length === 1
        ? `${label}: ${errorText(t, first.error)}`
        : `${t('shell.importer.failedN', { n: failed.length })} — ${label}: ${errorText(t, first.error)}`,
      'error',
      5000,
    );
  }
}

/** Download a record as a v1-compatible JSON dataset, named after its label in `lang`. Returns the file name. */
export function downloadRecordJson(rec: SvmRecord, lang: Lang = useAppStore.getState().lang): string {
  const fileName = `${safeFileName(recordLabel(rec, lang).replace(/ · /g, ' '))}.json`;
  const blob = new Blob([JSON.stringify(toDatasetJson(rec), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

/** Open the native file picker. Resolves with the chosen files (empty if cancelled). */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : []);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export const JSON_ACCEPT = '.json,application/json';

/** "Open JSON": pick record files and import them right away. */
export async function openJsonFiles(t: TFunction): Promise<void> {
  const files = await pickFiles(JSON_ACCEPT);
  if (files.length) await importFiles(files, t);
}
