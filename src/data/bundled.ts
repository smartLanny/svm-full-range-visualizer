import type { Dataset, SvmRecord } from '../types';
import { toRecord, validateDataset } from './records';
import { rawDataset } from './denoise';

export interface ManifestEntry {
  file: string;
  device: string;
  mode: string;
  deviceEn?: string;
  modeEn?: string;
}

const bundledId = (file: string) => `bundled:${file}`;

/** Records are kept RAW: points a bundled file stores in `excluded` go back into the grid (docs/adr/0012). */
function entryToRecord(entry: ManifestEntry, json: unknown): SvmRecord {
  const ds: Dataset = rawDataset(validateDataset(json));
  return toRecord(ds, 'bundled', {
    id: bundledId(entry.file),
    device: entry.device,
    mode: entry.mode,
    deviceEn: entry.deviceEn ?? entry.device,
    modeEn: entry.modeEn ?? entry.mode,
  });
}

/**
 * Load the bundled records in manifest order.
 *
 * - Standalone build (`VITE_STANDALONE`): the manifest and every dataset are embedded in the
 *   bundle via `import.meta.glob`, so the single HTML file works from file:// with no network.
 * - Web build / dev: fetched from `./datasets/` at runtime, so new files can be dropped into
 *   `public/datasets` + `manifest.json` without rebuilding.
 */
export async function loadBundledRecords(): Promise<SvmRecord[]> {
  if (import.meta.env.VITE_STANDALONE) {
    const { embeddedBundled } = await import('./bundledEmbedded');
    const { manifest, files } = embeddedBundled();
    const out: SvmRecord[] = [];
    for (const entry of manifest) {
      try {
        if (files[entry.file]) out.push(entryToRecord(entry, files[entry.file]));
      } catch (e) {
        console.warn('Bundled dataset invalid:', entry.file, e);
      }
    }
    return out;
  }

  let manifest: ManifestEntry[] = [];
  try {
    const res = await fetch('./datasets/manifest.json', { cache: 'no-store' });
    if (res.ok) manifest = (await res.json()) as ManifestEntry[];
  } catch (e) {
    console.warn('Dataset manifest failed to load:', e);
  }
  const results = await Promise.all(
    manifest.map(async (entry) => {
      try {
        const res = await fetch(`./datasets/${entry.file}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return entryToRecord(entry, await res.json());
      } catch (e) {
        console.warn('Bundled dataset failed to load:', entry.file, e);
        return null;
      }
    }),
  );
  return results.filter((r): r is SvmRecord => r !== null);
}
