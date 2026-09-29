import { useSyncExternalStore } from 'react';
import type { MainTab } from '../types';
import { getExportTarget, subscribeExportTargets, type ExportSize, type ExportTarget } from './registry';

/** The ExportTarget registered for `tab` (re-renders when targets register / unregister). */
export function useExportTarget(tab: MainTab): ExportTarget | undefined {
  return useSyncExternalStore(
    subscribeExportTargets,
    () => getExportTarget(tab),
    () => getExportTarget(tab),
  );
}

/** Size used for the "current window" preset. */
export function currentViewSize(target: ExportTarget): ExportSize {
  try {
    const s = target.viewSize?.();
    if (s && s.width > 0 && s.height > 0) return { width: Math.round(s.width), height: Math.round(s.height) };
  } catch {
    /* fall through */
  }
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.round(window.innerWidth * dpr), height: Math.round(window.innerHeight * dpr) };
}
