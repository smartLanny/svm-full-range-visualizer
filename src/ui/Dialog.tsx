import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class, default max-w-xl. */
  widthClass?: string;
  closeLabel?: string;
  /** Paste anywhere in the dialog (e.g. route clipboard text into the main field). */
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: Esc / backdrop click closes, focus moves into the dialog (to an `autoFocus` /
 * `data-autofocus` field when there is one, else the dialog itself) and Tab stays inside it.
 */
export function Dialog({ open, onClose, title, icon, children, footer, widthClass = 'max-w-xl', closeLabel = 'Close', onPaste }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const box = ref.current;
      if (e.key !== 'Tab' || !box) return;
      // Focus trap: Tab / Shift+Tab cycle through the dialog's own controls.
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.activeElement as HTMLElement | null;
    // React has already focused an autoFocus field inside the dialog: keep it (paste works right away).
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) {
      const auto = box.querySelector<HTMLElement>('[data-autofocus]');
      (auto ?? box).focus();
    }
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onPaste={onPaste}
        className={cn('flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl bg-surface-2 shadow-panel ring-1 ring-line outline-none', widthClass)}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-1">
            {icon}
            {title}
          </h2>
          <button type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-4 hover:text-ink-1">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
