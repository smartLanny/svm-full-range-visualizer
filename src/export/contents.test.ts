import { describe, expect, it } from 'vitest';
import { defaultContent, listContents, parseRemembered } from './contents';
import { pngFileName } from './png';
import { ANIMATION_CONTENT, CURRENT_CONTENT, type ExportAnimation, type ExportContent, type ExportKindHint, type ExportTarget } from './registry';
import { videoFileName } from './video';

const labels = { current: '当前画面', currentDetail: '与屏幕上看到的完全一致' };
const size = { width: 1920, height: 1080 };

function legacy(anim: ExportAnimation | null): ExportTarget {
  return {
    id: 'chart2d',
    fileName: (kind?: ExportKindHint) => (kind === 'video' ? 'legacy_video' : 'legacy_image'),
    animation: () => anim,
    begin: async () => undefined,
    renderFrame: async () => {
      throw new Error('not rendered in this test');
    },
    end: () => undefined,
  };
}

/** A target with contents: 'current', 'top' (image), 'intro' (video, 13 s), 'broken' (video without animation). */
function withContents(list: ExportContent[]): ExportTarget {
  return {
    id: 'scene3d',
    contents: () => list,
    fileName: (kind, content) => `name_${kind}_${content}`,
    animation: (content) => (content === 'intro' ? { duration: 13, label: 'intro', fileName: 'A_开场动画' } : null),
    begin: async () => undefined,
    renderFrame: async () => {
      throw new Error('not rendered in this test');
    },
    end: () => undefined,
  };
}

describe('export contents (docs/adr/0010 addendum)', () => {
  it('legacy targets offer the frame on screen and their one animation', () => {
    const list = listContents(legacy({ duration: 10, label: '灰阶扫描' }), labels);
    expect(list.map((c) => [c.id, c.kind, c.label])).toEqual([
      [CURRENT_CONTENT, 'image', '当前画面'],
      [ANIMATION_CONTENT, 'video', '灰阶扫描'],
    ]);
    expect(list[0].current).toBe(true);
    expect(list[1].duration).toBe(10);
    expect(listContents(legacy(null), labels).map((c) => c.id)).toEqual([CURRENT_CONTENT]);
  });

  it('uses the target list; drops duplicates, empty ids and videos without an animation; durations come from animation()', () => {
    const t = withContents([
      { id: 'current', kind: 'image', label: 'Current', current: true },
      { id: 'top', kind: 'image', label: 'Top' },
      { id: 'top', kind: 'image', label: 'Top again' },
      { id: '', kind: 'image', label: 'no id' },
      { id: 'intro', kind: 'video', label: 'Intro', duration: 99 },
      { id: 'broken', kind: 'video', label: 'Broken' },
    ]);
    const list = listContents(t, labels);
    expect(list.map((c) => c.id)).toEqual(['current', 'top', 'intro']);
    expect(list.find((c) => c.id === 'intro')?.duration).toBe(13);
  });

  it('falls back to the legacy list when contents() throws or is empty', () => {
    const t = withContents([]);
    expect(listContents(t, labels).map((c) => c.id)).toEqual([CURRENT_CONTENT]);
    const bad: ExportTarget = {
      ...withContents([]),
      contents: () => {
        throw new Error('boom');
      },
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(listContents(bad, labels).map((c) => c.id)).toEqual([CURRENT_CONTENT]);
    } finally {
      console.warn = warn;
    }
  });

  it('selects the remembered content while offered, else the one on screen, else the first', () => {
    const list: ExportContent[] = [
      { id: 'current', kind: 'image', label: 'Current', current: true },
      { id: 'top', kind: 'image', label: 'Top' },
      { id: 'diff', kind: 'image', label: 'Diff' },
    ];
    expect(defaultContent(list)?.id).toBe('current');
    expect(defaultContent(list, 'diff')?.id).toBe('diff');
    expect(defaultContent(list, 'sideBySide')?.id).toBe('current');
    expect(defaultContent(list.slice(1))?.id).toBe('top');
    expect(defaultContent([])).toBeNull();
  });

  it('parses remembered contents defensively', () => {
    expect(parseRemembered({ scene3d: 'top', chart2d: 'levelSweep', stats: 7, other: 'x' })).toEqual({ scene3d: 'top', chart2d: 'levelSweep' });
    expect(parseRemembered(null)).toEqual({});
    expect(parseRemembered('top')).toEqual({});
    expect(parseRemembered({ scene3d: '' })).toEqual({});
  });

  it('file names follow the chosen content', () => {
    const t = withContents([{ id: 'current', kind: 'image', label: 'Current' }]);
    expect(pngFileName(t, size, 'top')).toBe('name_image_top_1920x1080.png');
    // Videos: the animation's own name wins.
    expect(videoFileName(t, size, 30, 'mp4', 'intro')).toBe('A_开场动画_1920x1080_30fps.mp4');
    // Legacy callers pass no content.
    expect(pngFileName(legacy(null), size)).toBe('legacy_image_1920x1080.png');
    expect(videoFileName(legacy({ duration: 1, label: 'x' }), size, 60, 'mp4')).toBe('legacy_video_1920x1080_60fps.mp4');
  });
});
