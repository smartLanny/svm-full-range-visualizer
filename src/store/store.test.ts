import { beforeEach, describe, expect, it } from 'vitest';
import type { SvmRecord } from '../types';
import { ColormapType } from '../types';
import { DEFAULT_SETTINGS, useAppStore } from './appStore';
import { sanitizeSettings, sanitizeUserRecords } from './bootstrap';
import { applyBundledEdit, bundledEditsOf } from './persistence';

const rec = (id: string, extra: Partial<SvmRecord> = {}): SvmRecord => ({
  id,
  name: `${id} name`,
  device: `${id} device`,
  mode: 'm',
  source: 'user',
  data: [{ gray: 255, brightnessPercent: 100, nits: 500, svm: 0.1 }],
  matrix: { rows: [255], cols: [100], headerNits: [500], grid: [[{ gray: 255, brightnessPercent: 100, nits: 500, svm: 0.1 }]] },
  ...extra,
});

describe('sanitizeSettings (persisted settings are checked key by key)', () => {
  it('keeps valid values and drops unknown enum values', () => {
    const out = sanitizeSettings({ lang: 'fr', view: 'iso', tab: 'chart2d', colormap: ColormapType.TURBO, layout: 'diff', maxNits: null, heightScale: 'big', extra: 1 });
    expect(out).toEqual({ tab: 'chart2d', colormap: ColormapType.TURBO, layout: 'diff', maxNits: null });
  });
  it('merges overlays over the defaults, booleans only', () => {
    expect(sanitizeSettings({ overlays: { title: false, axes: 'no' } }).overlays).toEqual({ ...DEFAULT_SETTINGS.overlays, title: false });
  });
  it('tolerates garbage', () => {
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings('x')).toEqual({});
  });
});

describe('sanitizeUserRecords (a bad stored record never blanks the app)', () => {
  it('drops invalid records and keeps the rest', () => {
    const good = rec('u1');
    const noHeader = rec('u2');
    delete (noHeader.matrix as Partial<SvmRecord['matrix']>).headerNits; // rebuilt, still valid
    const broken = { ...rec('u3'), matrix: { rows: [255], cols: [100] } };
    const empty = { ...rec('u4'), matrix: { rows: [255], cols: [100], grid: [[null]] } };
    const { records, dropped } = sanitizeUserRecords([good, noHeader, broken, empty, null, { ...rec('u1') }]);
    expect(records.map((r) => r.id)).toEqual(['u1', 'u2']);
    expect(records[1].matrix.headerNits).toEqual([500]);
    expect(records.every((r) => r.source === 'user')).toBe(true);
    expect(dropped).toBe(4);
  });
  it('non-arrays give nothing', () => {
    expect(sanitizeUserRecords({})).toEqual({ records: [], dropped: 0 });
  });
});

describe('bundled edits', () => {
  const manifest = new Map([['bundled:a', { name: 'A 标准', device: 'A', mode: '标准' }]]);
  const bundled = (patch: Partial<SvmRecord> = {}) => rec('bundled:a', { source: 'bundled', name: 'A 标准', device: 'A', mode: '标准', deviceEn: 'A-en', modeEn: 'Std', ...patch });
  it('saves only records that differ from the manifest', () => {
    expect(bundledEditsOf([bundled()], manifest)).toEqual({});
    expect(bundledEditsOf([bundled({ mode: '60Hz', name: 'A 60Hz' })], manifest)).toEqual({
      'bundled:a': { name: 'A 60Hz', device: 'A', mode: '60Hz', orig: { name: 'A 标准', device: 'A', mode: '标准' } },
    });
  });
  it('applies edited fields only; unedited fields follow manifest fixes; aliases survive', () => {
    // Old saves wrote every bundled record unchanged: a no-op, the English aliases stay.
    expect(applyBundledEdit(bundled(), { name: 'A 标准', device: 'A', mode: '标准' })).toEqual(bundled());
    // Manifest renamed the device since the edit; the user only changed the mode.
    const fixed = bundled({ device: 'A Pro', name: 'A Pro 标准' });
    const next = applyBundledEdit(fixed, { name: 'A 标准', device: 'A', mode: '60Hz', orig: { name: 'A 标准', device: 'A', mode: '标准' } });
    expect(next.device).toBe('A Pro');
    expect(next.deviceEn).toBe('A-en');
    expect(next.mode).toBe('60Hz');
    expect(next.modeEn).toBeUndefined();
  });
});

describe('appStore records', () => {
  beforeEach(() => useAppStore.setState({ records: [], activeId: null, compareId: null, hiddenIds: [], layout: 'single' }));

  it('importing into an empty app fills A and B', () => {
    useAppStore.getState().addRecords([rec('x'), rec('y')]);
    expect(useAppStore.getState().activeId).toBe('x');
    expect(useAppStore.getState().compareId).toBe('y');
  });
  it('a single record leaves B empty; the next import fills it', () => {
    useAppStore.getState().addRecords([rec('x')]);
    expect(useAppStore.getState().compareId).toBeNull();
    useAppStore.getState().addRecords([rec('y')]);
    expect(useAppStore.getState().compareId).toBe('y');
  });
  it('deleting down to one record falls back to the single layout', () => {
    useAppStore.getState().setRecords([rec('x'), rec('y')]);
    useAppStore.getState().set('layout', 'sideBySide');
    useAppStore.getState().removeRecord('y');
    expect(useAppStore.getState().layout).toBe('single');
    expect(useAppStore.getState().compareId).toBeNull();
  });
  it('insertRecord undoes a delete (index, A role, hidden)', () => {
    const recs = [rec('x'), rec('y'), rec('z')];
    useAppStore.getState().setRecords(recs);
    useAppStore.getState().setHidden(['y'], true);
    useAppStore.getState().setCompare('y');
    useAppStore.getState().removeRecord('y');
    expect(useAppStore.getState().compareId).not.toBe('y');
    useAppStore.getState().insertRecord(recs[1], 1, { b: true, hidden: true });
    const s = useAppStore.getState();
    expect(s.records.map((r) => r.id)).toEqual(['x', 'y', 'z']);
    expect(s.compareId).toBe('y');
    expect(s.hiddenIds).toContain('y');
  });
});
