import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { getActiveTimeline } from '../timeline/timeline';
import { getT } from '../i18n';
import { toast } from '../ui';
import type { MainTab } from '../types';
import { exitPresentation, togglePresentation } from './presentation';
import { shellUi } from './uiStore';

/** Input types that take typed text: shortcuts must not fire while one has focus. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'password', 'tel', 'date', 'datetime-local', 'month', 'time', 'week']);

/** True while the user is typing somewhere (shortcuts must not fire). Sliders, swatches, checkboxes are not typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const h = el as HTMLElement;
  const tag = h.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(((h as HTMLInputElement).type || 'text').toLowerCase());
  return h.isContentEditable;
}

/** Keys a focused slider handles itself (moving the thumb). */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const isSlider = (el: EventTarget | null) => !!el && (el as HTMLElement).tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';

const TABS: MainTab[] = ['scene3d', 'chart2d', 'stats'];

let savedLabels: { title: boolean; colorbar: boolean } | null = null;

/** H: hide / restore the in-picture title and color bar (clean frames for recording). */
export function toggleLabels() {
  const s = useAppStore.getState();
  const t = getT();
  if (s.overlays.title || s.overlays.colorbar) {
    savedLabels = { title: s.overlays.title, colorbar: s.overlays.colorbar };
    s.patch({ overlays: { ...s.overlays, title: false, colorbar: false } });
    toast(t('shell.toast.labelsHidden'));
  } else {
    const back = savedLabels ?? { title: true, colorbar: true };
    savedLabels = null;
    s.patch({ overlays: { ...s.overlays, ...back } });
    toast(t('shell.toast.labelsShown'));
  }
}

/** Play/pause the active animation, or start the current view's animation. */
export function playPause() {
  const tl = getActiveTimeline();
  if (tl) {
    tl.toggle();
    return;
  }
  const { tab, requestPlay } = useAppStore.getState();
  if (tab !== 'stats') requestPlay(tab);
}

/**
 * Global keyboard shortcuts, owned by the shell (views never bind global keys).
 * Ignored while typing, with Ctrl/Cmd/Alt held, and while a modal dialog is open.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // A focused slider keeps its own arrow keys; Space / letters / digits still work.
      if (isSlider(e.target) && SLIDER_KEYS.has(e.key)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const s = useAppStore.getState();
      const tl = getActiveTimeline();
      const key = e.key;
      // Nothing to play or present without records.
      const empty = s.ready && s.records.length === 0;

      if (key === 'Escape') {
        if (s.presenting) {
          e.preventDefault();
          exitPresentation();
        }
        return;
      }
      if (e.code === 'Space' || key === ' ') {
        e.preventDefault();
        if (!empty) playPause();
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (!tl) return;
        e.preventDefault();
        const step = (e.shiftKey ? 2 : 0.5) * (key === 'ArrowLeft' ? -1 : 1);
        tl.seek(tl.time + step);
        return;
      }
      if (key === '?' || (e.shiftKey && e.code === 'Slash')) {
        e.preventDefault();
        shellUi.toggleShortcuts();
        return;
      }
      if (e.shiftKey) return;
      switch (key.toLowerCase()) {
        case 'r':
          e.preventDefault();
          if (tl) tl.restart();
          else if (s.tab !== 'stats' && !empty) s.requestPlay(s.tab);
          return;
        case 'f':
          e.preventDefault();
          if (!empty || s.presenting) togglePresentation();
          return;
        case '1':
        case '2':
        case '3':
          e.preventDefault();
          s.set('tab', TABS[Number(key) - 1]);
          return;
        case 't':
          e.preventDefault();
          s.set('view', s.view === 'top' ? 'perspective' : 'top');
          return;
        case 'h':
          e.preventDefault();
          toggleLabels();
          return;
      }
    };
    // Space is play/pause everywhere outside text fields: keep a focused button from also
    // being "clicked" by the same key (buttons activate on keyup).
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.code === 'Space' || e.key === ' ') && !isTypingTarget(e.target) && !document.querySelector('[role="dialog"][aria-modal="true"]'))
        e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);
}
