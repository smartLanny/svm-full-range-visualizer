import { beforeEach, describe, expect, it } from 'vitest';
import type { SvmRecord } from '../types';
import { ColormapType } from '../types';
import { cleanExtras, DEFAULT_SETTINGS, displayOf, fillPanelIds, nextPanelCandidate, processedOf, selectComparePanelIds, selectComparePanels, useAppStore } from './appStore';
import { sanitizePrefs, sanitizeSettings, sanitizeUserRecords } from './bootstrap';
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
  });
  it('adopts the adaptive 2D axis default once for saves older than rev 2', () => {
    expect(DEFAULT_SETTINGS.axisMode).toBe('adaptive');
    expect(sanitizeSettings({ axisMode: 'standard' }).axisMode).toBeUndefined();
    expect(sanitizeSettings({ axisMode: 'free' }).axisMode).toBe('free');
    expect(sanitizeSettings({ rev: 2, axisMode: 'standard' }).axisMode).toBe('standard');
    expect(sanitizeSettings('x')).toEqual({});
  });
});

describe('sanitizeSettings — scenario reference (docs/adr/0009 addendum)', () => {
  const S = DEFAULT_SETTINGS.scenarios;
  it('defaults: 夜间 2–20 nits × G15–100 30 %, 室内 50–250 × G15–255 50 %, 户外 400–500 × G128–255 20 %; overlay off', () => {
    expect(S).toEqual({
      night: { nitsMin: 2, nitsMax: 20, grayMin: 15, grayMax: 100, weight: 30 },
      indoor: { nitsMin: 50, nitsMax: 250, grayMin: 15, grayMax: 255, weight: 50 },
      outdoor: { nitsMin: 400, nitsMax: 500, grayMin: 128, grayMax: 255, weight: 20 },
    });
    expect(DEFAULT_SETTINGS.overlays.scenarios).toBe(false);
  });
  it('a save without the key keeps the defaults (no revision bump needed)', () => {
    expect(sanitizeSettings({ rev: 2, lang: 'en' })).toEqual({ lang: 'en' });
    expect(sanitizeSettings({ overlays: { title: false } }).overlays?.scenarios).toBe(false);
    expect(sanitizeSettings({ overlays: { scenarios: true } }).overlays?.scenarios).toBe(true);
  });
  it('keeps valid scenarios, replaces each invalid one by its default', () => {
    const night = { nitsMin: 1, nitsMax: 30, grayMin: 20, grayMax: 90, weight: 40 };
    const out = sanitizeSettings({
      rev: 2,
      scenarios: {
        night,
        indoor: { nitsMin: 250, nitsMax: 50, grayMin: 15, grayMax: 255, weight: 50 }, // min > max
        outdoor: { nitsMin: 400, nitsMax: 900, grayMin: 128, grayMax: 255, weight: 20 }, // over the 500-nit cap
      },
    });
    expect(out.scenarios).toEqual({ night, indoor: S.indoor, outdoor: S.outdoor });
    const bad = { ...S, indoor: { ...S.indoor, grayMax: 256 }, outdoor: { ...S.outdoor, weight: -3 } };
    expect(sanitizeSettings({ scenarios: bad }).scenarios).toEqual(S);
    expect(sanitizeSettings({ scenarios: { night: { ...S.night, nitsMin: 0 } } }).scenarios).toEqual(S);
    // all weights 0 -> default weights
    const zero = { night: { ...S.night, weight: 0 }, indoor: { ...S.indoor, weight: 0 }, outdoor: { ...S.outdoor, weight: 0 } };
    expect(sanitizeSettings({ scenarios: zero }).scenarios).toEqual(S);
    // not an object: the key is dropped (defaults apply)
    expect(sanitizeSettings({ scenarios: 'x' }).scenarios).toBeUndefined();
    expect(sanitizeSettings({ scenarios: [S.night] }).scenarios).toBeUndefined();
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
  beforeEach(() => useAppStore.setState({ records: [], activeId: null, compareId: null, compareExtraIds: [], hiddenIds: [], layout: 'single' }));

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

describe('side-by-side panels (A, B + extras C–F)', () => {
  const ids = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  const st = () => useAppStore.getState();
  beforeEach(() => {
    useAppStore.setState({ records: [], activeId: null, compareId: null, compareExtraIds: [], hiddenIds: [], layout: 'single' });
    st().setRecords(ids.map((id) => rec(id)));
  });

  /** Every invariant of the panel list; returns the violations (empty = fine). */
  const violations = () => {
    const s = st();
    const known = new Set(s.records.map((r) => r.id));
    const out: string[] = [];
    const panels = selectComparePanelIds(s);
    if (s.compareExtraIds.length > 4) out.push('more than 4 extras');
    if (new Set(s.compareExtraIds).size !== s.compareExtraIds.length) out.push('duplicate extra');
    if (s.compareExtraIds.some((x) => x === s.activeId || x === s.compareId)) out.push('extra equals A or B');
    if (s.compareExtraIds.some((x) => !known.has(x))) out.push('unknown extra');
    if (s.activeId !== null && s.activeId === s.compareId) out.push('A equals B');
    if (s.records.length >= 2 && (panels.length < 2 || panels.length > 6)) out.push(`panel count ${panels.length}`);
    return out;
  };

  it('adds up to four extra panels (six in all), each record once, never A or B', () => {
    st().addComparePanel('r0'); // A
    st().addComparePanel('r1'); // B
    for (const id of ids.slice(2)) st().addComparePanel(id);
    st().addComparePanel('r2'); // already a panel
    expect(selectComparePanelIds(st())).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    expect(selectComparePanels(st()).map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    expect(violations()).toEqual([]);
  });

  it('promoting an extra to A / B swaps it with the record it replaces (the compared set stays)', () => {
    st().setComparePanels(['r0', 'r1', 'r2', 'r3']);
    st().setActive('r3');
    expect(selectComparePanelIds(st())).toEqual(['r3', 'r1', 'r2', 'r0']);
    st().setCompare('r2');
    expect(selectComparePanelIds(st())).toEqual(['r3', 'r2', 'r1', 'r0']);
    // A record outside the comparison replaces A (the old A leaves), as before.
    st().setActive('r7');
    expect(selectComparePanelIds(st())).toEqual(['r7', 'r2', 'r1', 'r0']);
    expect(violations()).toEqual([]);
  });

  it('setComparePanel puts a record in a panel; a record already shown swaps panels', () => {
    st().setComparePanels(['r0', 'r1', 'r2']);
    st().setComparePanel(3, 'r5'); // appends D
    st().setComparePanel(2, 'r5'); // D -> C: C and D swap
    expect(selectComparePanelIds(st())).toEqual(['r0', 'r1', 'r5', 'r2']);
    st().setComparePanel(2, 'r0'); // A -> C: A and C swap
    expect(selectComparePanelIds(st())).toEqual(['r5', 'r1', 'r0', 'r2']);
    st().setComparePanel(6, 'r6'); // beyond F: ignored
    st().setComparePanel(5, 'r6'); // gap after D: ignored
    expect(selectComparePanelIds(st())).toEqual(['r5', 'r1', 'r0', 'r2']);
  });

  it('removing panels: extras close, A / B are replaced by the next panel, never below two', () => {
    st().setComparePanels(['r0', 'r1', 'r2', 'r3']);
    st().removeComparePanel('r2');
    expect(selectComparePanelIds(st())).toEqual(['r0', 'r1', 'r3']);
    st().removeComparePanel('r0');
    expect(selectComparePanelIds(st())).toEqual(['r1', 'r3']);
    st().removeComparePanel('r1');
    expect(selectComparePanelIds(st())).toEqual(['r1', 'r3']);
  });

  it('deleting a record drops it from the panels; undo puts it back in its panel', () => {
    st().setComparePanels(['r0', 'r1', 'r2', 'r3', 'r4']);
    const r3 = st().records[3];
    st().removeRecord('r3');
    expect(selectComparePanelIds(st())).toEqual(['r0', 'r1', 'r2', 'r4']);
    st().insertRecord(r3, 3, { extra: 1 });
    expect(selectComparePanelIds(st())).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    // Deleting A: the new A (first record other than B) leaves the extras.
    st().removeRecord('r0');
    expect(violations()).toEqual([]);
    expect(st().activeId).toBe('r2');
    expect(st().compareExtraIds).toEqual(['r3', 'r4']);
  });

  it('keeps every invariant through a random sequence of operations', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const bad: string[] = [];
    const all = ids.map((id) => rec(id));
    for (let step = 0; step < 600; step++) {
      const id = ids[rnd(ids.length)];
      const op = rnd(8);
      const s = st();
      if (op === 0) s.addComparePanel(id);
      else if (op === 1) s.removeComparePanel(id);
      else if (op === 2) s.setComparePanel(rnd(7), id);
      else if (op === 3) s.setActive(id);
      else if (op === 4) s.setCompare(id);
      else if (op === 5) s.setComparePanels([...ids].sort(() => rnd(3) - 1).slice(0, rnd(9)));
      else if (op === 6 && s.records.length > 2) s.removeRecord(id);
      else if (op === 7 && !s.records.some((r) => r.id === id)) s.insertRecord(all.find((r) => r.id === id)!, rnd(s.records.length + 1), { extra: rnd(4) });
      for (const v of violations()) bad.push(`step ${step} op ${op}: ${v}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('fill from the visible records keeps the visible panels first, then list order, six at most', () => {
    expect(fillPanelIds(['r3', 'r1'], ids)).toEqual(['r3', 'r1', 'r0', 'r2', 'r4', 'r5']);
    expect(fillPanelIds(['r3', 'r1', 'r6'], ['r1', 'r2'])).toEqual(['r1', 'r2']);
    expect(fillPanelIds(['r3', 'r1'], ['r5'])).toEqual(['r3', 'r1']);
    st().setHidden(['r2'], true);
    expect(nextPanelCandidate(st(), ['r0', 'r1'])).toBe('r3');
    expect(nextPanelCandidate(st(), ids.filter((x) => x !== 'r2'))).toBe('r2');
    expect(nextPanelCandidate(st(), ids)).toBeNull();
  });

  it('cleanExtras / sanitizePrefs: unknown, duplicate, A / B and excess ids are dropped', () => {
    const known = new Set(ids);
    expect(cleanExtras(['r2', 'x', 'r2', 'r0', 'r3', 'r4', 'r5', 'r6'], known, 'r0', 'r1')).toEqual(['r2', 'r3', 'r4', 'r5']);
    const same = ['r2', 'r3'];
    expect(cleanExtras(same, known, 'r0', 'r1')).toBe(same);
    expect(sanitizePrefs({ activeId: 'r0', compareId: 'r1', compareExtraIds: ['r1', 'r2', 7, 'gone', 'r2', 'r3'] }, known).compareExtraIds).toEqual(['r2', 'r3']);
    expect(sanitizePrefs({ compareExtraIds: 'r2' }, known).compareExtraIds).toEqual([]);
  });
});

describe('denoise setting (docs/adr/0012 addendum)', () => {
  /** 3 × 3 panel whose centre SVM is a spike; the rest is smooth. */
  const spiky = (id: string): SvmRecord => {
    const rows = [255, 128, 64];
    const cols = [100, 50, 20];
    const lv = [500, 100, 20];
    const grid = rows.map((g) => cols.map((pct, c) => ({ gray: g, brightnessPercent: pct, nits: lv[c] * Math.pow(g / 255, 2.2), svm: 0.2 + c * 0.1 + (255 - g) / 500 })));
    grid[1][1] = { ...grid[1][1], svm: 9 };
    return rec(id, { data: grid.flat(), matrix: { rows, cols, headerNits: lv, grid } });
  };

  it('defaults to on; saves keep a boolean, anything else (or a missing key) falls back to the default', () => {
    expect(DEFAULT_SETTINGS.denoise).toBe(true);
    expect(sanitizeSettings({ denoise: false }).denoise).toBe(false);
    expect(sanitizeSettings({ rev: 2, denoise: true }).denoise).toBe(true);
    expect('denoise' in sanitizeSettings({ denoise: 'off' })).toBe(false);
    expect('denoise' in sanitizeSettings({ rev: 2, clipLowGray: false })).toBe(false);
  });

  it('processedOf / displayOf follow the setting; records themselves stay raw', () => {
    const r = spiky('d1');
    useAppStore.setState({ denoise: true });
    expect(processedOf(r).notes.map((n) => [n.gray, n.brightnessPercent, n.kind])).toEqual([[128, 50, 'svmSpike']]);
    expect(displayOf(r).matrix.grid[1][1]!.svm).toBeLessThan(1);
    expect(r.matrix.grid[1][1]!.svm).toBe(9);
    useAppStore.setState({ denoise: false });
    expect(displayOf(r)).toBe(r);
    expect(processedOf(r).notes).toEqual([]);
    expect(displayOf(r, { denoise: true })).toBe(processedOf(r, { denoise: true }).record);
    useAppStore.setState({ denoise: DEFAULT_SETTINGS.denoise });
  });

  it('stored records that carry `excluded` (former destructive exclusion) are loaded raw', () => {
    const p = { gray: 128, brightnessPercent: 50, nits: 20, svm: 0.3 };
    const cleaned = rec('u9', {
      data: [{ gray: 255, brightnessPercent: 100, nits: 500, svm: 0.1 }],
      matrix: { rows: [255, 128], cols: [100, 50], headerNits: [500, 100], grid: [[{ gray: 255, brightnessPercent: 100, nits: 500, svm: 0.1 }, null], [null, null]] },
      excluded: [{ ...p, reason: 'svmSpike', detail: 'x' }],
    });
    const { records } = sanitizeUserRecords([cleaned]);
    expect(records[0].excluded).toBeUndefined();
    expect(records[0].matrix.grid[1][1]).toEqual(p);
    expect(records[0].data).toHaveLength(2);
  });
});
