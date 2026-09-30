import { describe, expect, it } from 'vitest';
import { EXAMPLE_TSV } from '../data/exampleTsv';
import { toDatasetJson } from '../data/records';
import { isTypingTarget } from './useGlobalShortcuts';
import { jsonToRecord, tableTextToResults } from './fileImport';
import { mergeSummaries } from './screening';
import { processRecord } from '../data/denoise';
import { countParts, kindParts } from '../data/denoiseText';
import { translate } from '../i18n';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

describe('isTypingTarget', () => {
  it('text entry fields block shortcuts', () => {
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'search' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });
  it('sliders, colour swatches, checkboxes and buttons do not', () => {
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'color' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('table files: every table, named from its title, screened', () => {
  const second = EXAMPLE_TSV.replace('标准120Hz', '示例机 60Hz');
  const text = `示例机 标准120Hz\n${EXAMPLE_TSV.split('\n').slice(1).join('\n')}\n\n${second}`;
  const results = tableTextToResults(text, 'raw.tsv', 'raw');
  it('one record per table (no duplicated gray rows)', () => {
    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => [r.table, r.tables])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(results.map((r) => r.record!.matrix.rows.length)).toEqual([24, 24]);
    expect(results.map((r) => [r.record!.device, r.record!.mode])).toEqual([
      ['示例机', '标准120Hz'],
      ['示例机', '60Hz'],
    ]);
  });
  it('untitled single table falls back to the file name', () => {
    const body = EXAMPLE_TSV.split('\n').slice(1).join('\n');
    const [r] = tableTextToResults(body, 'my device.tsv', 'my device');
    expect(r.record!.name).toBe('my device');
  });
  it('the importer previews what the denoise will do; the record itself stays raw', () => {
    const r = results[0];
    const s = r.screening!;
    expect(s.summary.touched).toBeGreaterThan(0);
    expect(s.summary.byKind.blackLevel).toBeGreaterThan(0);
    expect(s.summary).toEqual(processRecord(r.record!, { denoise: true }).summary);
    // nothing removed: every parsed cell is still in the record
    expect(r.record!.excluded).toBeUndefined();
    expect(r.record!.data.length).toBe(r.record!.matrix.grid.flat().filter((p) => p).length);
  });
  it('summary text of several previews (plain words)', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
    const m = mergeSummaries([results[0].screening, results[1].screening, null]);
    expect(m.touched).toBe(results[0].screening!.summary.touched + results[1].screening!.summary.touched);
    expect(countParts(m, t).join(' · ')).toMatch(/^(插值补全 \d+ 格 · )?无有效数据 \d+ 格/);
    expect(kindParts({ blackLevel: 3, svmSpike: 1 }, t).join(' · ')).toBe('接近全黑、测不准 3 · SVM 尖峰 1');
  });
});

describe('JSON round trip keeps the English aliases', () => {
  it('a JSON exported by the former destructive exclusion is imported raw', () => {
    const [r] = tableTextToResults(EXAMPLE_TSV, 'a.tsv', 'a');
    const rec = r.record!;
    const p = rec.matrix.grid[0][0]!;
    const grid = rec.matrix.grid.map((row, i) => row.map((q, j) => (i === 0 && j === 0 ? null : q)));
    const json = JSON.parse(JSON.stringify({ ...toDatasetJson(rec), matrix: { ...rec.matrix, grid }, excluded: [{ ...p, reason: 'svmSpike', detail: 'x' }] }));
    const back = jsonToRecord(json);
    expect(back.excluded).toBeUndefined();
    expect(back.matrix.grid[0][0]).toEqual(p);
  });
  it('export → import', () => {
    const [r] = tableTextToResults(EXAMPLE_TSV, 'a.tsv', 'a');
    const json = JSON.parse(JSON.stringify(toDatasetJson({ ...r.record!, deviceEn: 'Demo', modeEn: 'Standard 120Hz' })));
    const back = jsonToRecord(json);
    expect(back.deviceEn).toBe('Demo');
    expect(back.modeEn).toBe('Standard 120Hz');
    expect(back.id).not.toBe(r.record!.id);
  });
});

describe('side-by-side panel strings (zh + en)', () => {
  const keys = [
    'shell.inspector.scene3d.pickPanel',
    'shell.inspector.scene3d.removePanel',
    'shell.inspector.scene3d.addPanel',
    'shell.inspector.scene3d.panelsFull',
    'shell.inspector.scene3d.fillVisible',
    'shell.inspector.scene3d.fillVisibleHint',
    'shell.inspector.scene3d.panelsHint',
    'shell.sidebar.addToCompare',
    'shell.sidebar.removeFromCompare',
    'shell.sidebar.compareFull',
    'shell.sidebar.compareMin',
    'shell.sidebar.isPanel',
    'shell.sidebar.isPanelUnused',
    'scene3d.export.sideBySideN',
  ];
  it('exist in both languages, English without CJK, placeholders filled', () => {
    const bad: string[] = [];
    const vars = { p: 'C', n: 4, max: 6 };
    for (const k of keys)
      for (const lang of ['zh', 'en'] as const) {
        const s = translate(lang, k, vars);
        if (s === k || /\{\w+\}/.test(s) || (lang === 'en' && /[一-鿿]/.test(s))) bad.push(`${lang}:${k}`);
      }
    expect(bad).toEqual([]);
    expect(translate('zh', 'scene3d.export.sideBySideN', { n: 6 })).toBe('并排对比_6条');
  });
});
