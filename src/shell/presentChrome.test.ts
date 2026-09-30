import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_TSV } from '../data/exampleTsv';
import { useAppStore } from '../store/appStore';
import { TOAST_BOTTOM, toastBottom } from '../ui/Toast';
import { tableTextToResults } from './fileImport';
import { HINT_MARGIN, HINT_TITLE_HALF, hintPlacement } from './presentLayout';
import { datasetRanges } from './screening';
import { processRecord } from '../data/denoise';
import { toggleLabels } from './useGlobalShortcuts';
import type { StageRect } from './uiStore';

/** The stage rect Shell's CSS gives an aspect in a window (fit fills it; boxed = centred, contained). */
function stageFor(w: number, h: number, aspect: 'fit' | '16:9' | '9:16' | '1:1'): StageRect {
  if (aspect === 'fit') return { x: 0, y: 0, w, h };
  const ratio = aspect === '16:9' ? 16 / 9 : aspect === '9:16' ? 9 / 16 : 1;
  const sw = Math.min(w, h * ratio);
  const sh = Math.min(h, w / ratio);
  return { x: Math.round((w - sw) / 2), y: Math.round((h - sh) / 2), w: Math.round(sw), h: Math.round(sh) };
}

describe('presentation key hint placement (N07)', () => {
  const windows = [
    [1280, 720],
    [1600, 900],
  ] as const;
  it('letterboxed 9:16 / 1:1 on a landscape screen: inside the right-hand black bar, never over the stage', () => {
    const bad: string[] = [];
    for (const [w, h] of windows) {
      for (const aspect of ['9:16', '1:1'] as const) {
        const st = stageFor(w, h, aspect);
        const p = hintPlacement({ w, h }, st);
        const left = p.style.left! - p.style.maxWidth / 2;
        const right = p.style.left! + p.style.maxWidth / 2;
        if (p.where !== 'sideBar' || left < st.x + st.w + HINT_MARGIN - 1 || right > w - HINT_MARGIN + 1 || p.style.top !== HINT_MARGIN)
          bad.push(`${w}x${h} ${aspect}: ${JSON.stringify(p)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('stage fills the screen (fit, 16:9 on 16:9): top-right of the title band, clear of a centred title, one line wide', () => {
    const bad: string[] = [];
    for (const [w, h] of windows) {
      for (const aspect of ['fit', '16:9'] as const) {
        const st = stageFor(w, h, aspect);
        const p = hintPlacement({ w, h }, st);
        const leftmost = w - p.style.right! - p.style.maxWidth;
        // the English hint is ~330 px on one line; its left edge stays right of the centre title
        if (p.where !== 'titleBand' || p.style.top !== HINT_MARGIN || p.style.right !== HINT_MARGIN || p.style.maxWidth < 340 || leftmost < w / 2 + HINT_TITLE_HALF)
          bad.push(`${w}x${h} ${aspect}: ${JSON.stringify(p)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('a wide stage on a tall screen uses the bottom bar', () => {
    const st = stageFor(1024, 1366, '16:9');
    const p = hintPlacement({ w: 1024, h: 1366 }, st);
    expect(p.where).toBe('bottomBar');
    expect(p.style.bottom).toBe(Math.round((1366 - st.y - st.h) / 2));
  });
});

describe('toast stack placement (N22)', () => {
  const win = { w: 1600, h: 900 };
  it('bottom-centre when nothing is marked', () => {
    expect(toastBottom(win, [])).toBe(TOAST_BOTTOM);
  });
  it('lifts above a timeline bar plus the axis labels it keeps clear', () => {
    // 3D intro bar, 44 px tall at 16 px from the bottom, 64 px of axis labels above it
    const bar = { top: 840, bottom: 884, left: 440, right: 1160, extra: 64 };
    expect(toastBottom(win, [bar])).toBe(900 - (840 - 64) + 12);
  });
  it('the 2D band and a bar inside it: the higher clearance wins', () => {
    const band = { top: 840, bottom: 900, left: 272, right: 1300, extra: 78 };
    const bar = { top: 848, bottom: 892, left: 430, right: 1150, extra: 64 };
    expect(toastBottom(win, [band, bar])).toBe(900 - (840 - 78) + 12);
  });
  it('ignores chrome off the centred column, in the upper half, or empty; never lifts past mid-screen', () => {
    expect(toastBottom(win, [{ top: 860, bottom: 890, left: 1300, right: 1580, extra: 0 }])).toBe(TOAST_BOTTOM);
    expect(toastBottom(win, [{ top: 10, bottom: 60, left: 600, right: 1000, extra: 0 }])).toBe(TOAST_BOTTOM);
    expect(toastBottom(win, [{ top: 850, bottom: 850, left: 600, right: 1000, extra: 0 }])).toBe(TOAST_BOTTOM);
    expect(toastBottom(win, [{ top: 460, bottom: 900, left: 600, right: 1000, extra: 200 }])).toBe(450);
  });
});

describe('importer preview ranges with the denoise (N13)', () => {
  const [r] = tableTextToResults(EXAMPLE_TSV, 'a.tsv', 'a');
  const raw = r.record!;
  const clean = processRecord(raw, { denoise: true }).record;
  it('ranges describe the valid cells of the dataset as it will be shown', () => {
    const a = datasetRanges(raw);
    const b = datasetRanges(clean);
    expect(a.points).toBe(raw.data.length);
    expect(b.points).toBe(clean.data.length);
    const svm = (ds: typeof raw) => ds.data.map((p) => p.svm);
    expect(b.svm).toEqual([Math.min(...svm(clean)), Math.max(...svm(clean))]);
    expect(a.svm).toEqual([Math.min(...svm(raw)), Math.max(...svm(raw))]);
    // the denoise never widens the shown range
    expect(b.svm![0]).toBeGreaterThanOrEqual(a.svm![0]);
    expect(b.svm![1]).toBeLessThanOrEqual(a.svm![1]);
  });
  it('rows / columns left without any valid cell drop out of the gray / level ranges', () => {
    const m = raw.matrix;
    const grid = m.grid.map((row, i) => (i === m.rows.indexOf(Math.min(...m.rows)) ? row.map(() => null) : row));
    const out = datasetRanges({ matrix: { ...m, grid } });
    const rest = m.rows.filter((g) => g !== Math.min(...m.rows));
    expect(out.gray).toEqual([Math.min(...rest), Math.max(...rest)]);
    expect(datasetRanges({ matrix: { ...m, grid: m.grid.map((row) => row.map(() => null)) } })).toEqual({ gray: null, level: null, svm: null, points: 0 });
  });
});

describe('H on the stats tab (N09)', () => {
  const initial = useAppStore.getState();
  afterEach(() => useAppStore.setState({ tab: initial.tab, presenting: false, overlays: initial.overlays }));
  it('workbench: a no-op (the 3D / 2D flags are not flipped)', () => {
    useAppStore.setState({ tab: 'stats', presenting: false, overlays: { ...initial.overlays, title: true, colorbar: true } });
    toggleLabels();
    expect(useAppStore.getState().overlays.title).toBe(true);
    expect(useAppStore.getState().overlays.colorbar).toBe(true);
  });
  it('presentation: hides and restores the header (title flag), with the colour bar alongside', () => {
    useAppStore.setState({ tab: 'stats', presenting: true, overlays: { ...initial.overlays, title: true, colorbar: true } });
    toggleLabels();
    expect(useAppStore.getState().overlays.title).toBe(false);
    toggleLabels();
    expect(useAppStore.getState().overlays.title).toBe(true);
    expect(useAppStore.getState().overlays.colorbar).toBe(true);
  });
  it('presentation: with the header already hidden (only the colour bar on), H shows it rather than hiding the unseen colour bar', () => {
    useAppStore.setState({ tab: 'stats', presenting: true, overlays: { ...initial.overlays, title: false, colorbar: true } });
    toggleLabels();
    expect(useAppStore.getState().overlays.title).toBe(true);
  });
});
