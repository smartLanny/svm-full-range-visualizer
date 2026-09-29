import { describe, expect, it } from 'vitest';
import { pngFileName } from './png';
import type { ExportAnimation, ExportKindHint, ExportTarget } from './registry';
import { videoFileName } from './video';

function target(name: (kind?: ExportKindHint) => string, anim: ExportAnimation | null): ExportTarget {
  return {
    id: 'chart2d',
    fileName: name,
    animation: () => anim,
    begin: async () => undefined,
    renderFrame: async () => {
      throw new Error('not rendered in this test');
    },
    end: () => undefined,
  };
}

const size = { width: 1920, height: 1080 };

describe('export file names', () => {
  it('PNG uses the static view name', () => {
    const t = target(() => 'SVM_2D_G127', { duration: 10, label: 'sweep', fileName: 'SVM_2D_sweep_G255-G50' });
    expect(pngFileName(t, size)).toBe('SVM_2D_G127_1920x1080.png');
  });

  it("video prefers the animation's own name (2D sweep, 3D intro of record A)", () => {
    const t = target(() => 'SVM_2D_G127', { duration: 10, label: 'sweep', fileName: 'SVM_2D_sweep_G255-G50' });
    expect(videoFileName(t, size, 60, 'mp4')).toBe('SVM_2D_sweep_G255-G50_1920x1080_60fps.mp4');
    const sbs = target(() => 'A_vs_B', { duration: 13, label: 'intro', fileName: '小米 18 Pro Max · 自适应刷新 Pro 关' });
    expect(videoFileName(sbs, size, 30, 'webm')).toBe('小米_18_Pro_Max_·_自适应刷新_Pro_关_1920x1080_30fps.webm');
  });

  it('tells fileName() what is being exported when the animation has no name of its own', () => {
    const t = target((kind) => (kind === 'video' ? 'SVM_2D_sweep_500-2nits' : 'SVM_2D_100nits'), { duration: 10, label: 'sweep' });
    expect(videoFileName(t, size, 60, 'mp4')).toBe('SVM_2D_sweep_500-2nits_1920x1080_60fps.mp4');
    expect(pngFileName(t, size)).toBe('SVM_2D_100nits_1920x1080.png');
  });

  it('falls back to the view name for an empty or unsafe animation name', () => {
    const t = target(() => 'SVM_2D_G127', { duration: 10, label: 'sweep', fileName: '  ' });
    expect(videoFileName(t, size, 60, 'mp4')).toBe('SVM_2D_G127_1920x1080_60fps.mp4');
  });
});
