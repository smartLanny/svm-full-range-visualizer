import { describe, expect, it } from 'vitest';
import { logNits } from '../data/grid';
import { THUMB_HEIGHT, thumbGrayLabels, thumbTicks, type ThumbExtent } from './heatmap';

const extent: ThumbExtent = { x0: logNits(0.5), x1: logNits(600), g0: 10, g1: 255, grayMin: 15, grayMax: 255 };

describe('thumbnail ticks and gray labels (shared by the card on screen and the export)', () => {
  it('ticks are inside the extent, left to right, at least 30 px apart', () => {
    const ticks = thumbTicks(250, extent);
    expect(ticks.length).toBeGreaterThan(3);
    for (let i = 0; i < ticks.length; i++) {
      expect(ticks[i].px).toBeGreaterThanOrEqual(0);
      expect(ticks[i].px).toBeLessThanOrEqual(250);
      if (i) expect(ticks[i].px - ticks[i - 1].px).toBeGreaterThanOrEqual(30);
    }
    // a wider heatmap never has fewer ticks
    expect(thumbTicks(500, extent).length).toBeGreaterThanOrEqual(ticks.length);
    expect(thumbTicks(0, extent)).toEqual([]);
  });

  it('gray labels: top / bottom gray and the slice (accent), clamped inside the heatmap', () => {
    const labels = thumbGrayLabels(extent, 127);
    expect(labels.map((l) => [l.g, !!l.accent])).toEqual([
      [255, false],
      [15, false],
      [127, true],
    ]);
    for (const l of labels) {
      expect(l.top).toBeGreaterThanOrEqual(-1);
      expect(l.top).toBeLessThanOrEqual(THUMB_HEIGHT - 12);
    }
    // the slice hides a neighbour closer than 14 px
    expect(thumbGrayLabels(extent, 250).map((l) => l.g)).toEqual([15, 250]);
    // no slice in range: only top / bottom
    expect(thumbGrayLabels(extent, null).map((l) => l.g)).toEqual([255, 15]);
  });
});
