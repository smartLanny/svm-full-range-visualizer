import { describe, expect, it } from 'vitest';
import type { SvmRecord } from '../types';
import { comparePanelCount, scene3dContents, sceneForContent, type Scene3DExportState } from './exportContents';
import { INTRO_DURATION } from './engine/intro';

const rec = (id: string, device: string, mode: string, modeEn: string) => ({ id, device, mode, modeEn }) as unknown as SvmRecord;
const A = rec('a', 'iPhone 17 Pro Max', '标准', 'Standard');
const B = rec('b', 'iPhone 17 Pro Max', '平滑脉冲', 'Smooth pulse');

function state(p: Partial<Scene3DExportState> = {}): Scene3DExportState {
  return {
    lang: 'zh',
    layout: 'single',
    view: 'perspective',
    representation: 'surface',
    a: A,
    b: B,
    extras: 0,
    renders: true,
    canRender: () => true,
    introTime: null,
    adjusted: false,
    ...p,
  };
}

const ids = (st: Scene3DExportState) => scene3dContents(st).map((c) => c.id);

describe('3D export contents (docs/adr/0010 addendum)', () => {
  it('single layout with a comparison: screen, top, 3D, side by side, difference, intro', () => {
    const list = scene3dContents(state({ extras: 2 }));
    expect(list.map((c) => c.id)).toEqual(['current', 'top', 'perspective', 'sideBySide', 'diff', 'intro']);
    expect(list.map((c) => c.kind)).toEqual(['image', 'image', 'image', 'image', 'image', 'video']);
    expect(list[0].label).toBe('当前画面');
    expect(list.find((c) => c.id === 'sideBySide')?.label).toBe('并排对比 4 条（俯视）');
    expect(list.find((c) => c.id === 'sideBySide')?.detail).toBe('面板 A–D 并排，共用色标');
    expect(list.find((c) => c.id === 'diff')?.label).toBe('差值图 A−B（俯视）');
    expect(list.find((c) => c.id === 'intro')?.duration).toBe(INTRO_DURATION);
  });

  it('never offers the layout on screen twice; other layouts only when they render', () => {
    expect(ids(state({ layout: 'sideBySide', extras: 4 }))).toEqual(['current', 'top', 'perspective', 'diff', 'intro']);
    expect(ids(state({ layout: 'diff' }))).toEqual(['current', 'top', 'perspective', 'sideBySide', 'intro']);
    expect(ids(state({ b: null }))).toEqual(['current', 'top', 'perspective', 'intro']);
    expect(ids(state({ canRender: (l) => l !== 'diff' }))).toEqual(['current', 'top', 'perspective', 'sideBySide', 'intro']);
    // The layout on screen does not render (e.g. no data): the frame on screen and the intro only.
    expect(ids(state({ renders: false, b: null }))).toEqual(['current', 'intro']);
    expect(ids(state({ a: null, b: null, renders: false }))).toEqual(['current']);
  });

  it('marks the preset on screen (default pose, no intro) and describes the frame on screen', () => {
    const top = scene3dContents(state({ view: 'top' }));
    expect(top.filter((c) => c.current).map((c) => c.id)).toEqual(['current', 'top']);
    expect(top[0].detail).toBe('单条记录 · 曲面 · 俯视');
    const zoomed = scene3dContents(state({ view: 'top', adjusted: true }));
    expect(zoomed.filter((c) => c.current).map((c) => c.id)).toEqual(['current']);
    expect(zoomed[0].detail).toContain('缩放');
    const intro = scene3dContents(state({ introTime: 5 }));
    expect(intro.filter((c) => c.current).map((c) => c.id)).toEqual(['current']);
    expect(intro[0].detail).toBe('开场动画 5.0 秒处的画面');
  });

  it('says that the intro shows record A only outside the single layout; English strings', () => {
    expect(scene3dContents(state({ layout: 'sideBySide' })).find((c) => c.id === 'intro')?.detail).toBe('只演示记录 A：iPhone 17 Pro Max · 标准');
    const en = scene3dContents(state({ lang: 'en', extras: 1 }));
    expect(en.map((c) => c.label)).toEqual(['Current view', 'Top-view heatmap', '3D view', 'Side by side, 3 records (top view)', 'Difference A−B (top view)', 'Intro animation video']);
    for (const c of en) expect(`${c.label} ${c.detail ?? ''}`).not.toMatch(/[一-鿿]|\{\w+\}/);
  });

  it('maps contents to offscreen scenes (never the store)', () => {
    expect(sceneForContent('current')).toBeNull();
    expect(sceneForContent(undefined)).toBeNull();
    expect(sceneForContent('intro')).toBeNull();
    expect(sceneForContent('top')).toEqual({ view: 'top' });
    expect(sceneForContent('perspective')).toEqual({ view: 'perspective' });
    expect(sceneForContent('sideBySide')).toEqual({ layout: 'sideBySide', view: 'top' });
    expect(sceneForContent('diff')).toEqual({ layout: 'diff', view: 'top' });
    expect(comparePanelCount(0)).toBe(2);
    expect(comparePanelCount(4)).toBe(6);
    expect(comparePanelCount(9)).toBe(6);
  });
});
