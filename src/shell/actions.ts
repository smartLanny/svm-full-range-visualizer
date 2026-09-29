import { loadBundledRecords } from '../data/bundled';
import { useAppStore } from '../store/appStore';
import { clearPersisted } from '../store/persistence';
import type { TFunction } from '../i18n';
import { toast } from '../ui';

/**
 * Re-add bundled records that were deleted. Order: bundled records in manifest order
 * (existing ones keep their local edits), then any other records in their current order.
 */
export async function restoreBundled(t: TFunction): Promise<void> {
  let bundled;
  try {
    bundled = await loadBundledRecords();
  } catch {
    toast(t('shell.settings.restoreFail'), 'error');
    return;
  }
  if (!bundled.length) {
    toast(t('shell.settings.restoreFail'), 'error');
    return;
  }
  const s = useAppStore.getState();
  const present = new Map(s.records.map((r) => [r.id, r]));
  const missing = bundled.filter((b) => !present.has(b.id));
  if (!missing.length) {
    toast(t('shell.settings.restoreNone'));
    return;
  }
  const bundledIds = new Set(bundled.map((b) => b.id));
  const next = [...bundled.map((b) => present.get(b.id) ?? b), ...s.records.filter((r) => !bundledIds.has(r.id))];
  s.setRecords(next);
  toast(t('shell.settings.restoreDone', { n: missing.length }), 'success');
}

/** Wipe local persistence and reload. Waits out the autosave debounce so nothing is re-written. */
export async function clearLocalDataAndReload(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
  try {
    localStorage.removeItem('svm.shell.ui.v1');
  } catch {
    /* ignore */
  }
  try {
    await clearPersisted();
  } finally {
    location.reload();
  }
}
