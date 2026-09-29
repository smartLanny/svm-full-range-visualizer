import React, { useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';
import { cn } from '../ui';
import { exitPresentation } from './presentation';

const IDLE_MS = 2500;

/** The exit button's window rect (left-4 top-4, 32 px) plus an 8 px gap: titles keep right of / below this. */
export const PRESENT_EXIT_RIGHT = 16 + 32 + 8;
export const PRESENT_EXIT_BOTTOM = 16 + 32 + 4;

/**
 * Presentation overlay chrome (contract C1): a key hint that fades after ~2.5 s, bottom-centre
 * just above the 96 px bottom safe zone the timelines use, and an exit button top-left that
 * appears while the pointer moves, so the views' own top-right toolbars are never covered. The cursor hides when idle so recordings stay clean.
 * Visibility is toggled through DOM classes (no React state per mouse move).
 */
export function PresentationChrome() {
  const t = useT();
  const presenting = useAppStore((s) => s.presenting);
  const [hintVisible, setHintVisible] = useState(false);
  const exitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!presenting) return;
    setHintVisible(true);
    const hintTimer = setTimeout(() => setHintVisible(false), IDLE_MS);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const root = document.documentElement;
    const setIdle = (idle: boolean) => {
      root.classList.toggle('shell-idle', idle);
      exitRef.current?.classList.toggle('is-visible', !idle);
    };
    const onMove = () => {
      setIdle(false);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    setIdle(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onMove);
    return () => {
      clearTimeout(hintTimer);
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      root.classList.remove('shell-idle');
    };
  }, [presenting]);

  if (!presenting) return null;
  return (
    <>
      <div
        aria-live="polite"
        data-testid="present-hint"
        className={cn(
          'pointer-events-none fixed bottom-[108px] left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-xs text-white/85 ring-1 ring-white/10 backdrop-blur transition-opacity duration-700',
          hintVisible ? 'opacity-100' : 'opacity-0',
        )}
      >
        {t('shell.present.hint')}
      </div>
      <button
        ref={exitRef}
        type="button"
        title={t('shell.present.exit')}
        aria-label={t('shell.present.exit')}
        data-testid="present-exit"
        onClick={exitPresentation}
        className="shell-present-exit fixed left-4 top-4 z-40 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur hover:bg-black/80 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <Minimize2 size={15} />
      </button>
    </>
  );
}
