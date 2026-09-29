import React, { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useT, getT } from '../i18n';
import { importFiles } from './fileImport';
import { useShellUi } from './uiStore';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Window-wide drag & drop of .json / .tsv / .txt files with a full-window overlay. */
export function DropOverlay() {
  const t = useT();
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const blocked = () => useShellUi.getState().importer.open;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || blocked()) return;
      e.preventDefault();
      depth.current++;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = blocked() ? 'none' : 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (blocked()) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void importFiles(files, getT());
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-canvas/75 p-6 backdrop-blur-sm" data-testid="drop-overlay">
      <div className="flex h-full max-h-[420px] w-full max-w-[640px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-accent/70 bg-accent-muted text-center shadow-panel">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/20 text-accent-hover">
          <FileUp size={28} />
        </div>
        <div className="text-lg font-semibold text-ink-1">{t('shell.drop.title')}</div>
        <div className="text-xs text-ink-2">{t('shell.drop.hint')}</div>
      </div>
    </div>
  );
}
