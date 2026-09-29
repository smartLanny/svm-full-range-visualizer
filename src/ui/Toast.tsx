import React, { useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from './cn';

export type ToastKind = 'info' | 'success' | 'error';
export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let nextId = 1;

/**
 * Bottom chrome the toast stack must never cover (finding N22): a view marks it with
 * `data-toast-avoid` (TimelineBar does so itself; the 2D workbench marks its transport band). The
 * attribute's value is extra space above the element to keep clear too — the axis labels a view
 * draws right above its transport (the 2D x-axis tick labels and title, the 3D luminance axis).
 */
export const TOAST_AVOID_ATTR = 'data-toast-avoid';
/** Default gap to the window bottom, and between the stack and whatever it avoids. */
export const TOAST_BOTTOM = 24;
const TOAST_GAP = 12;
/** Half width of the centred column the stack occupies (toasts are at most ~440 px wide). */
export const TOAST_HALF_W = 240;

export interface AvoidRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Extra px above `top` to keep clear. */
  extra: number;
}

/**
 * Bottom offset (CSS px from the window bottom) for the centred toast stack: above every marked
 * element in the lower half of the window that overlaps the stack's column, plus its extra band.
 */
export function toastBottom(win: { w: number; h: number }, avoid: AvoidRect[]): number {
  const x0 = win.w / 2 - TOAST_HALF_W;
  const x1 = win.w / 2 + TOAST_HALF_W;
  let bottom = TOAST_BOTTOM;
  for (const r of avoid) {
    if (r.right <= r.left || r.bottom <= r.top) continue;
    if (r.right < x0 || r.left > x1) continue;
    if (r.bottom < win.h / 2) continue;
    bottom = Math.max(bottom, Math.round(win.h - (r.top - Math.max(0, r.extra)) + TOAST_GAP));
  }
  return Math.min(bottom, Math.round(win.h / 2));
}

/** The visible marked elements (inactive views are aria-hidden / visibility:hidden and do not count). */
function measureAvoid(): AvoidRect[] {
  const out: AvoidRect[] = [];
  document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID_ATTR}]`).forEach((el) => {
    if (el.closest('[aria-hidden="true"]') || getComputedStyle(el).visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, extra: Number(el.getAttribute(TOAST_AVOID_ATTR)) || 0 });
  });
  return out;
}

/** Show a transient notification (bottom-center, lifted above timelines), optionally with one action button (e.g. Undo). */
export function toast(message: string, kind: ToastKind = 'info', ms = 3200, action?: ToastAction) {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items, { id, kind, message, action }] }));
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle };

export function Toaster({ closeLabel = 'Dismiss' }: { closeLabel?: string }) {
  const items = useToasts((s) => s.items);
  const [bottom, setBottom] = useState(TOAST_BOTTOM);
  const showing = items.length > 0;
  // Lifted over the picture (a timeline is up): one toast at a time, the newest, so the stack never
  // grows up into the axis labels / picture above the protected band; older ones wait behind it
  // (their timers keep running).
  const shown = bottom > TOAST_BOTTOM ? items.slice(-1) : items;
  // Only while toasts are up: re-measure on resize and a few times a second (a timeline can open
  // or close under a toast).
  useLayoutEffect(() => {
    if (!showing) return;
    const update = () => setBottom(toastBottom({ w: window.innerWidth, h: window.innerHeight }, measureAvoid()));
    update();
    const timer = setInterval(update, 250);
    window.addEventListener('resize', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', update);
    };
  }, [showing]);
  return (
    <div className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2" style={{ bottom }} data-testid="toaster">
      {shown.map((t) => {
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
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onClick();
                }}
                className="-my-1 rounded px-1.5 py-1 font-medium text-accent-hover hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label={closeLabel} title={closeLabel} onClick={() => dismiss(t.id)} className="text-ink-3 hover:text-ink-1">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
