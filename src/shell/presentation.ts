import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';

/**
 * Presentation mode (docs/adr/0001): fullscreen + all panels hidden. Fullscreen is best
 * effort — if the browser refuses (iframe, permissions) the app still enters presentation.
 */
let fullscreenByUs = false;

export function enterPresentation() {
  const s = useAppStore.getState();
  if (s.presenting) return;
  s.setPresenting(true);
  const el = document.documentElement;
  if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
    try {
      el.requestFullscreen()
        .then(() => {
          fullscreenByUs = true;
        })
        .catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
}

export function exitPresentation() {
  useAppStore.getState().setPresenting(false);
  if (document.fullscreenElement && fullscreenByUs) {
    document.exitFullscreen().catch(() => undefined);
  }
  fullscreenByUs = false;
}

export function togglePresentation() {
  if (useAppStore.getState().presenting) exitPresentation();
  else enterPresentation();
}

/** Leaving fullscreen (browser Esc, F11, system UI) also leaves presentation mode. */
export function usePresentationLifecycle() {
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && fullscreenByUs) {
        fullscreenByUs = false;
        if (useAppStore.getState().presenting) useAppStore.getState().setPresenting(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
}
