import type { StageRect } from './uiStore';

/**
 * Where the presentation key hint goes (contract C1, finding N07). It must never cover a title,
 * axis label, legend or data in any view, so it only uses space the pictures leave free:
 *
 * 1. letterboxed with side bars (9:16 / 1:1 on a landscape screen): centred in the right-hand bar,
 *    level with the exit button in the left-hand bar (wrapping inside the bar when it is narrow);
 * 2. letterboxed with a bottom bar (a wide stage on a tall screen): centred in that bar;
 * 3. the stage fills the screen (fit, or 16:9 on a 16:9 screen): the right end of the stage's top
 *    title band. Every view keeps that band free: the 3D title is left-aligned and the plot keeps a
 *    top inset, the 2D title is centred (the width cap keeps the pill clear of the title's half
 *    width) and its plot / legend / toolbar start below the band, and the stats header's right
 *    side only holds the controls, which are hidden in presentation.
 */
export interface HintPlacement {
  where: 'sideBar' | 'bottomBar' | 'titleBand';
  style: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    maxWidth: number;
    transform?: string;
  };
}

/** Gap to the window / stage edges; the exit button uses the same 16 px. */
export const HINT_MARGIN = 16;
/** A letterbox bar narrower than this is not used (the pill would wrap into a tall column). */
export const HINT_MIN_BAR = 160;
/** Single-line pill height (px-4 py-1.5 text-xs) — a bottom bar must fit it with margins. */
export const HINT_H = 28;
/** Half width kept free around the stage's centre line in the title band (2D title, centred). */
export const HINT_TITLE_HALF = 170;
/** Narrowest pill before it would rather wrap onto more lines. */
const HINT_MIN_W = 140;

export function hintPlacement(win: { w: number; h: number }, stage: StageRect): HintPlacement {
  const rightBar = win.w - (stage.x + stage.w);
  if (rightBar >= HINT_MIN_BAR) {
    return {
      where: 'sideBar',
      style: { left: Math.round(stage.x + stage.w + rightBar / 2), top: HINT_MARGIN, maxWidth: Math.floor(rightBar - 2 * HINT_MARGIN), transform: 'translateX(-50%)' },
    };
  }
  const bottomBar = win.h - (stage.y + stage.h);
  if (bottomBar >= HINT_H + HINT_MARGIN) {
    return {
      where: 'bottomBar',
      style: {
        left: Math.round(stage.x + stage.w / 2),
        bottom: Math.round(bottomBar / 2),
        maxWidth: Math.floor(stage.w - 2 * HINT_MARGIN),
        transform: 'translate(-50%, 50%)',
      },
    };
  }
  return {
    where: 'titleBand',
    style: {
      right: Math.round(rightBar + HINT_MARGIN),
      top: Math.round(stage.y + HINT_MARGIN),
      maxWidth: Math.floor(Math.max(HINT_MIN_W, stage.w / 2 - HINT_TITLE_HALF - HINT_MARGIN)),
    },
  };
}
