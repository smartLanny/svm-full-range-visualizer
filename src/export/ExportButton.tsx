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
 * Header entry point for PNG / video export (docs/adr/0010). Exports the active tab's view;
 * disabled with a hint on the stats tab or while the view has not registered an ExportTarget.
 */
export default function ExportButton() {
  const t = useT();
  const tab = useAppStore((s) => s.tab);
  const target = useExportTarget(tab);
  const busy = useExportSession((s) => s.job !== null);
  const [open, setOpen] = useState(false);

  const reason = tab === 'stats' ? t('export.unavailableStats') : !target ? t('export.unavailableView') : null;

  // Close the dialog if its target disappears (tab switch, view unmount).
  useEffect(() => {
    if (open && !target) setOpen(false);
  }, [open, target]);

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
      <span title={reason ?? t('export.buttonTitle')} className="inline-flex">
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={14} />}
          disabled={!!reason || busy}
          onClick={() => setOpen(true)}
          data-testid="export-button"
        >
          {t('export.button')}
        </Button>
      </span>
      {target && <ExportDialog open={open && !busy} onClose={() => setOpen(false)} target={target} />}
      <ExportProgress />
    </>
  );
}
