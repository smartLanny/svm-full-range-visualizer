import { useCallback } from 'react';
import type { Lang } from '../types';
import { getAppState, useAppStore } from '../store/appStore';
import common from './strings/common';
import shell from './strings/shell';
import scene3d from './strings/scene3d';
import chart2d from './strings/chart2d';
import stats from './strings/stats';
import exporter from './strings/export';

/**
 * i18n (docs/adr/0005). Each module owns one strings file exporting `{ zh, en }` nested
 * objects; keys are addressed as "<namespace>.<path>", e.g. t('shell.tabs.scene3d').
 * Interpolation: t('stats.count', { n: 3 }) replaces "{n}".
 * Missing keys fall back to zh, then to the key itself (and warn once in dev).
 */
type Nested = { [k: string]: string | Nested };
export interface StringsModule {
  zh: Nested;
  en: Nested;
}

const NAMESPACES: Record<string, StringsModule> = { common, shell, scene3d, chart2d, stats, export: exporter };

function flatten(obj: Nested, prefix: string, out: Record<string, string>) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
}

const dicts: Record<Lang, Record<string, string>> = { zh: {}, en: {} };
for (const [ns, mod] of Object.entries(NAMESPACES)) {
  flatten(mod.zh, ns, dicts.zh);
  flatten(mod.en, ns, dicts.en);
}

const warned = new Set<string>();

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = dicts[lang][key] ?? dicts.zh[key];
  if (s === undefined) {
    if (import.meta.env.DEV && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    s = key;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  return s;
}

/** React hook: t() bound to the current language (re-renders on language change). */
export function useT(): TFunction {
  const lang = useAppStore((s) => s.lang);
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}

/** Non-React: t() for the current language at call time (canvas drawing, render loops). */
export function getT(): TFunction {
  const lang = getAppState().lang;
  return (key, vars) => translate(lang, key, vars);
}

export function useLang(): Lang {
  return useAppStore((s) => s.lang);
}
