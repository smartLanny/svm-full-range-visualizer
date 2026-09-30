import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Button } from '../ui';
import ExportDialog from './ExportDialog';
import ExportProgress from './ExportProgress';
import { cancelExport, useExportSession } from './session';
import { useExportTarget } from './useExportTarget';

// DEV-only mock targets for testing the exporter (?mockExport). Removed from production builds.
if (import.meta.env.DEV) {
  void import('./dev/mockTarget').then((m) => m.maybeRegisterMockTargets());
}

/**
 * Header entry point for PNG / video export (docs/adr/0010). Opens the dialog for the active tab's
 * view, which offers that view's export contents (the frame on screen, other renderings, videos).
 * Every view registers one (3D terrain, 2D chart, stats page); the button is disabled with a hint
 * when there are no records or while the active view has not registered its ExportTarget yet.
 */
export default function ExportButton() {
  const t = useT();
  const tab = useAppStore((s) => s.tab);
  const target = useExportTarget(tab);
  const busy = useExportSession((s) => s.job !== null);
  const empty = useAppStore((s) => s.records.length === 0);
  const [open, setOpen] = useState(false);

  const reason = empty ? t('export.unavailableEmpty') : !target ? t('export.unavailableView') : null;
  // The tooltip says what the dialog offers for this view (it lists the view's export contents).
  const title = reason ?? t(`export.buttonTitleView.${tab}`);

  // Close the dialog if its target disappears (tab switch, view unmount) or the last record goes.
  useEffect(() => {
    if (open && (!target || empty)) setOpen(false);
  }, [open, target, empty]);

  // While exporting, swallow keyboard input so global shortcuts (Space, ←/→, R) cannot drive
  // the view mid-export. Esc cancels.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type === 'keydown' && e.key === 'Escape') cancelExport();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [busy]);

  return (
    <>
      {/* Wrapper carries the tooltip: disabled buttons do not receive pointer events. */}
      <span title={title} className="inline-flex">
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={14} />}
          disabled={!!reason || busy}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          data-testid="export-button"
        >
          {t('export.button')}
        </Button>
      </span>
      {target && <ExportDialog open={open && !busy && !empty} onClose={() => setOpen(false)} target={target} />}
      <ExportProgress />
    </>
  );
}
