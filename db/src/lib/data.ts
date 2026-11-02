/**
 * Data loading. Every file is fetched once (promise cache) from ./data/ and ./datasets/ next to the
 * page (dev: served by vite.db.config.ts from the repository; build: copied into dist-db/). A file
 * that fails to load leaves its section in an explicit "加载失败" state; nothing is substituted.
 */
import { useEffect, useState } from 'react';
import type { AngleSummary, Catalog, Device } from '../../catalog/types';
import type { ManifestEntry } from '../../../src/data/bundled';
import type { SvmRecord } from '../../../src/types';
import type { ReflectanceIndex, SiteInfo, UniformityIndex } from './types';
import { recordFromJson } from './svm';

const cache = new Map<string, Promise<unknown>>();

function fetchJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export const loadCatalog = () => fetchJson<Catalog>('./data/devices.json');
export const loadUniformity = () => fetchJson<UniformityIndex>('./data/uniformity/index.json');
export const loadReflectance = () => fetchJson<ReflectanceIndex>('./data/reflectance/index.json');
export const loadAngle = () => fetchJson<AngleSummary>('./data/angle/summary.json');
export const loadSiteInfo = () => fetchJson<SiteInfo>('./data/site-info.json');
export const uniformityAsset = (asset: string) => `./data/uniformity/${asset}`;

const records = new Map<string, Promise<SvmRecord>>();

/** One SVM record (public/datasets file named in the catalog), parsed like the workbench does. */
export function loadSvmRecord(file: string): Promise<SvmRecord> {
  let p = records.get(file);
  if (!p) {
    p = Promise.all([fetchJson<ManifestEntry[]>('./datasets/manifest.json'), fetchJson<unknown>(`./datasets/${encodeURIComponent(file)}`)]).then(
      ([manifest, json]) => {
        const entry = manifest.find((m) => m.file === file);
        if (!entry) throw new Error(`${file}: not in manifest.json`);
        return recordFromJson(entry, json);
      },
    );
    p.catch(() => records.delete(file));
    records.set(file, p);
  }
  return p;
}

export type Async<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string };

/** Subscribe to a promise-returning loader; `key` changes restart it. */
export function useAsync<T>(load: () => Promise<T>, key: string): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    load().then(
      (data) => alive && setState({ status: 'ready', data }),
      (e: unknown) => alive && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export const readyOr = <T>(a: Async<T>, fallback: T): T => (a.status === 'ready' ? a.data : fallback);

export const findDevice = (c: Catalog, id: string): Device | undefined => c.devices.find((d) => d.id === id);
