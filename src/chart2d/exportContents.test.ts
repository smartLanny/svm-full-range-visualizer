import { describe, expect, it } from 'vitest';
import { chart2dContents, contentSliceMode, isSliceContent, isSweepContent, sliceFileName, sweepAnimation, sweepFileName, type Chart2DExportState } from './exportContents';
import { SWEEP_DURATION } from './slices';

function state(p: Partial<Chart2DExportState> = {}): Chart2DExportState {
  return { lang: 'zh', sliceMode: 'gray', sliceGray: 127, sliceNits: 100, axisMode: 'standard', animatedParam: null, ...p };
}

describe('2D export contents (docs/adr/0010 addendum)', () => {
  it('offers the frame on screen, both slices at their current values and both sweeps', () => {
    const list = chart2dContents(state());
    expect(list.map((c) => [c.id, c.kind])).toEqual([
      ['current', 'image'],
      ['graySlice', 'image'],
      ['levelSlice', 'image'],
      ['graySweep', 'video'],
      ['levelSweep', 'video'],
    ]);
    expect(list.map((c) => c.label)).toEqual(['当前画面', '灰阶截面 G127', '亮度截面 100 nits', '灰阶扫描 G255→G50', '档位亮度扫描 500→2 nits']);
    expect(list.filter((c) => c.kind === 'video').every((c) => c.duration === SWEEP_DURATION)).toBe(true);
    expect(list[0].detail).toBe('灰阶截面 G127 · 标准坐标');
  });

  it('marks the static slice on screen; a sweep frame on screen is only the current frame', () => {
    expect(chart2dContents(state()).filter((c) => c.current).map((c) => c.id)).toEqual(['current', 'graySlice']);
    expect(chart2dContents(state({ sliceMode: 'brightness', sliceNits: 7.5 })).filter((c) => c.current).map((c) => c.id)).toEqual(['current', 'levelSlice']);
    const sweep = chart2dContents(state({ animatedParam: 180.4 }));
    expect(sweep.filter((c) => c.current).map((c) => c.id)).toEqual(['current']);
    expect(sweep[0].detail).toBe('扫描动画当前帧 · 灰阶截面 G180');
    expect(chart2dContents(state({ axisMode: 'free' }))[1].detail).toContain('自由坐标');
  });

  it('English labels', () => {
    const en = chart2dContents(state({ lang: 'en', sliceNits: 7.5 }));
    expect(en.map((c) => c.label)).toEqual(['Current view', 'Gray slice G127', 'Brightness slice 7.5 nits', 'Gray sweep G255→G50', 'Level sweep 500→2 nits']);
    for (const c of en) expect(`${c.label} ${c.detail ?? ''}`).not.toMatch(/[一-鿿]|\{\w+\}/);
  });

  it('content → slice mode override, kind helpers and file names', () => {
    expect(contentSliceMode('graySlice')).toBe('gray');
    expect(contentSliceMode('graySweep')).toBe('gray');
    expect(contentSliceMode('levelSlice')).toBe('brightness');
    expect(contentSliceMode('levelSweep')).toBe('brightness');
    expect(contentSliceMode('current')).toBeNull();
    expect(contentSliceMode(undefined)).toBeNull();
    expect(isSweepContent('levelSweep') && !isSweepContent('levelSlice')).toBe(true);
    expect(isSliceContent('graySlice') && !isSliceContent('current')).toBe(true);
    expect(sliceFileName('gray', 127.4)).toBe('SVM_2D_G127');
    expect(sliceFileName('brightness', 7.5)).toBe('SVM_2D_7.5nits');
    expect(sweepFileName('gray')).toBe('SVM_2D_sweep_G255-G50');
    expect(sweepFileName('brightness')).toBe('SVM_2D_sweep_500-2nits');
    expect(sweepAnimation('en', 'brightness')).toEqual({ duration: SWEEP_DURATION, label: 'Level sweep 500→2 nits', fileName: 'SVM_2D_sweep_500-2nits' });
  });
});
