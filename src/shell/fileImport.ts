import type { SvmRecord } from '../types';
import { generateId, guessDeviceMode, toDatasetJson, toRecord, validateDataset } from '../data/records';
import { parseRawData } from '../data/parse';
import { safeFileName } from '../export/registry';
import { useAppStore } from '../store/appStore';
import type { TFunction } from '../i18n';
import { toast } from '../ui';

export interface FileResult {
  fileName: string;
  ok: boolean;
  record?: SvmRecord;
  /** Error code (key under shell.importer.errors) or raw message. */
  error?: string;
}

const KNOWN_ERRORS = ['TOO_FEW_LINES', 'NO_HEADER', 'NO_ROWS', 'INVALID_JSON', 'INVALID_MATRIX', 'PARSE', 'UNSUPPORTED', 'READ'];

/** Translate a parse / validation error code. */
export function errorText(t: TFunction, code: string | undefined): string {
  if (!code) return '';
  if (KNOWN_ERRORS.includes(code)) return t(`shell.importer.errors.${code}`);
  return t('shell.importer.errors.unknown', { msg: code });
}

export const isImportableFile = (name: string) => /\.(json|tsv|txt)$/i.test(name);

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/** Turn a parsed JSON value into a user record (fresh id, so re-importing never collides). */
export function jsonToRecord(json: unknown): SvmRecord {
  const ds = validateDataset(json);
  return toRecord(ds, 'user', { id: generateId(), name: ds.name });
}

/** Read .json / .tsv / .txt files into user records. Never throws. */
export async function readRecordFiles(files: File[]): Promise<FileResult[]> {
  return Promise.all(
    files.map(async (file): Promise<FileResult> => {
      const fileName = file.name;
      let text: string;
      try {
        text = await file.text();
      } catch {
        return { fileName, ok: false, error: 'READ' };
      }
      const looksJson = /\.json$/i.test(fileName) || (!/\.(tsv|txt)$/i.test(fileName) && text.trimStart().startsWith('{'));
      if (looksJson) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return { fileName, ok: false, error: 'PARSE' };
        }
        try {
          return { fileName, ok: true, record: jsonToRecord(json) };
        } catch (e) {
          return { fileName, ok: false, error: (e as Error).message };
        }
      }
      if (/\.(tsv|txt)$/i.test(fileName) || !/\.[a-z0-9]+$/i.test(fileName)) {
        try {
          const name = baseName(fileName);
          const ds = parseRawData(text, name, 1);
          const { device, mode } = guessDeviceMode(ds.name);
          return {
            fileName,
            ok: true,
            record: toRecord(ds, 'user', { device, mode, name: ds.name }),
          };
        } catch (e) {
          return { fileName, ok: false, error: (e as Error).message };
        }
      }
      return { fileName, ok: false, error: 'UNSUPPORTED' };
    }),
  );
}

/** Read files and add every valid one to the store, reporting the outcome as toasts. */
export async function importFiles(files: File[], t: TFunction): Promise<FileResult[]> {
  const results = await readRecordFiles(files);
  addResults(results, t);
  return results;
}

export function addResults(results: FileResult[], t: TFunction) {
  const ok = results.filter((r) => r.ok && r.record).map((r) => r.record!);
  const failed = results.filter((r) => !r.ok);
  if (ok.length) {
    const store = useAppStore.getState();
    store.addRecords(ok);
    // Newly imported records become A so the user immediately sees them in 3D.
    store.setActive(ok[0].id);
    toast(ok.length === 1 ? t('shell.importer.imported', { name: ok[0].name }) : t('shell.importer.importedN', { n: ok.length }), 'success');
  }
  if (failed.length) {
    const first = failed[0];
    toast(
      failed.length === 1
        ? `${first.fileName}: ${errorText(t, first.error)}`
        : `${t('shell.importer.failedN', { n: failed.length })} — ${first.fileName}: ${errorText(t, first.error)}`,
      'error',
      5000,
    );
  }
}

/** Download a record as a v1-compatible JSON dataset. Returns the file name. */
export function downloadRecordJson(rec: SvmRecord): string {
  const fileName = `${safeFileName(rec.name)}.json`;
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
