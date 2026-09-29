import React from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from './cn';

export type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let nextId = 1;

/** Show a transient notification (bottom-center). */
export function toast(message: string, kind: ToastKind = 'info', ms = 3200) {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items, { id, kind, message }] }));
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle };

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2">
      {items.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-center gap-2.5 rounded-lg bg-surface-3 px-3.5 py-2.5 text-xs text-ink-1 shadow-panel ring-1',
              t.kind === 'error' ? 'ring-critical/40' : t.kind === 'success' ? 'ring-safe/30' : 'ring-line',
            )}
          >
            <Icon size={15} className={t.kind === 'error' ? 'text-red-400' : t.kind === 'success' ? 'text-green-400' : 'text-accent-hover'} />
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-ink-3 hover:text-ink-1">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
