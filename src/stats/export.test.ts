import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ColormapType, type Dataset } from '../types';
import { toRecord } from '../data/records';
import { recordStyles } from '../data/colors';
import { CARD_MAX_W, CARD_MIN_W, chooseCardGrid, ellipsize, fitTable, pageFrame, wrapText, type Measure } from './exportLayout';
import { statsContentOf, statsContents, statsFileName } from './exportContents';
import { cardHeight, type StatsExportInput } from './exportRender';
import { thumbExtent, thumbHeight } from './heatmap';
import { buildRows, rankRows, sortRows } from './model';
import { denoisedInScope } from './parts';
import { processRecord, rawDataset } from '../data/denoise';

/** Fake text measure: CJK = 1 em, everything else 0.55 em. */
const CJK = /[⺀-鿿＀-￯]/;
const measure: Measure = (text, size) => Array.from(text).reduce((a, ch) => a + (CJK.test(ch) ? size : 0.55 * size), 0);

describe('text wrapping (break-words + line-clamp)', () => {
  it('keeps text that fits, ellipsizes what does not', () => {
    expect(ellipsize('iPhone', 100, 10, 400, measure)).toBe('iPhone');
    const cut = ellipsize('Adaptive refresh Pro on', 50, 10, 400, measure);
    expect(cut.endsWith('…')).toBe(true);
    expect(measure(cut, 10)).toBeLessThanOrEqual(50);
  });
  it('breaks between words and CJK characters, at most maxLines, last line ellipsized', () => {
    expect(wrapText('Xiaomi 18 Pro Max', 60, 2, 10, 400, measure)).toEqual(['Xiaomi 18', 'Pro Max']);
    const zh = wrapText('小米十八专业版最大号', 45, 2, 10, 400, measure);
    expect(zh).toEqual(['小米十八', '专业版…']);
    // a single word wider than the line is broken inside
    expect(wrapText('Supercalifragilistic', 40, 3, 10, 400, measure).every((l) => measure(l, 10) <= 40)).toBe(true);
    for (const l of wrapText('A very long device name that needs more than two lines', 80, 2, 10, 400, measure)) expect(measure(l, 10)).toBeLessThanOrEqual(80);
  });
});

describe('card grid for the export size (docs/adr/0010, stats page)', () => {
  const H = () => 560;
  const body = (w: number, h: number) => pageFrame(w, h, 1).body;
  const fits = (g: ReturnType<typeof chooseCardGrid>, b: { w: number; h: number }) => g.width <= b.w + 1e-6 && g.height <= b.h + 1e-6;

  it('picks columns by aspect and record count and fills the box', () => {
    const land = body(1920, 1080);
    const g16 = chooseCardGrid(16, land, H);
    expect([g16.cols, g16.rows]).toEqual([8, 2]);
    expect(fits(g16, land)).toBe(true);
    const port = body(1080, 1920);
    const p16 = chooseCardGrid(16, port, H);
    expect([p16.cols, p16.rows]).toEqual([4, 4]);
    expect(fits(p16, port)).toBe(true);
    const sq = body(1080, 1080);
    expect(chooseCardGrid(16, sq, H).cols).toBe(6);
    expect(chooseCardGrid(3, land, H).cols).toBe(3);
    expect(chooseCardGrid(3, port, H).cols).toBeLessThanOrEqual(2);
    expect(chooseCardGrid(6, body(3840, 2160), H)).toMatchObject({ cols: 6, rows: 1 });
  });

  it('keeps the card width within the design range and fills one side', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [2160, 2160],
      [1280, 900],
    ]) {
      const b = body(w, h);
      for (const n of [1, 2, 3, 5, 9, 16]) {
        const g = chooseCardGrid(n, b, H);
        expect(g.cardW).toBeGreaterThanOrEqual(CARD_MIN_W);
        expect(g.cardW).toBeLessThanOrEqual(CARD_MAX_W);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
        expect(fits(g, b)).toBe(true);
        // width or height is used up (or the card is at its widest)
        expect(g.width > b.w - 2 || g.height > b.h - 2 || g.cardW === CARD_MAX_W).toBe(true);
      }
    }
  });

  it('caps the scale (few cards on a large export stay readable, not huge)', () => {
    expect(chooseCardGrid(1, body(3840, 2160), H, 2).scale).toBe(2);
  });
});

describe('table fit', () => {
  const natural = [220, 96, 90, 90, 90, 110, 100, 90, 70, 70, 70, 70, 110];
  const split: [number[], number[]] = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [0, 8, 9, 10, 11, 12],
  ];
  const bandH = (rows: number) => (cols: number[]) => 68 + rows * 51 + cols.length * 0;

  it('one band in landscape, columns stretched to the full width', () => {
    const f = fitTable(natural, { w: 1872, h: 900 }, bandH(16), split);
    expect(f.bands).toHaveLength(1);
    const w = f.widths[0].reduce((a, v) => a + v, 0);
    expect(w * f.scale).toBeCloseTo(1872, 3);
    expect(f.bandH[0] * f.scale).toBeLessThanOrEqual(900 + 1e-6);
  });

  it('two stacked bands in portrait when that gives clearly larger text', () => {
    const f = fitTable(natural, { w: 1032, h: 1700 }, bandH(16), split);
    expect(f.bands).toEqual(split);
    expect(f.bands.every((b) => b[0] === 0)).toBe(true);
    const one = fitTable(natural, { w: 1032, h: 1700 }, bandH(16), [natural.map((_, i) => i), natural.map((_, i) => i)]);
    expect(f.scale).toBeGreaterThan(one.scale * 1.12);
    // square with many rows: splitting would shrink the text, one band stays
    expect(fitTable(natural, { w: 1032, h: 900 }, bandH(16), split).bands).toHaveLength(1);
  });
});

// ---- real records --------------------------------------------------------------------------

const dir = path.resolve(__dirname, '../../public/datasets');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
// As the stats page shows them: raw records processed by the denoise (docs/adr/0012 addendum).
const records = files.map((f, i) => processRecord(rawDataset(toRecord(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Dataset, 'bundled', { id: `r${i}` })), { denoise: true }).record);
const opts = { clipLowGray: true, maxNits: 500, sliceGray: 127 };
const rows = sortRows(buildRows(records, opts), 'order', 'asc', 'zh');
const input = (p: Partial<StatsExportInput> = {}): StatsExportInput => ({
  lang: 'zh',
  rows,
  styles: recordStyles(records),
  rank: rankRows(rows),
  extent: thumbExtent(records, opts),
  clipLowGray: true,
  maxNits: 500,
  sliceGray: 127,
  colormap: ColormapType.RD_YL_BU_ENHANCED,
  colorMax: 4,
  sortKey: 'order',
  sortDir: 'asc',
  scope: 'G ≥ 15',
  ...p,
});

describe('stats card layout (single pass: measure = draw)', () => {
  it('is taller when narrow (legend wraps) and with a denoise badge that does not fit the mode line', () => {
    const inp = input();
    const plain = rows.findIndex((r) => denoisedInScope(r.stats) === 0);
    expect(plain).toBeGreaterThanOrEqual(0);
    expect(rows.some((r) => denoisedInScope(r.stats) > 0)).toBe(true);
    const narrow = cardHeight(inp, plain, CARD_MIN_W, measure);
    const wide = cardHeight(inp, plain, CARD_MAX_W, measure);
    // The heatmap keeps the plate aspect (its height follows the card width, card − 32 − 36 px);
    // everything else is at least as tall in a narrow card.
    const heat = (cw: number) => thumbHeight(cw - 32 - 36);
    expect(narrow - heat(CARD_MIN_W)).toBeGreaterThanOrEqual(wide - heat(CARD_MAX_W));
    expect(wide).toBeGreaterThan(narrow);
    for (let i = 0; i < rows.length; i++) {
      const h = cardHeight(inp, i, 318, measure);
      if (rows[i].stats.cellCount === 0) {
        expect(h).toBeLessThan(450); // no thumbnail is drawn when the selected luminance range has no valid cells
        continue;
      }
      expect(h).toBeGreaterThan(450);
      expect(h).toBeLessThan(700);
    }
    // without thumbnails (no extent) the card is shorter by the heatmap block
    expect(cardHeight(input({ extent: null }), plain, 318, measure)).toBeLessThan(cardHeight(inp, plain, 318, measure) - heat(318));
  });

  it('a two-line device name adds one line', () => {
    const long = { ...rows[0], rec: { ...rows[0].rec, device: 'An extremely long device name for wrapping' } };
    const inp = input({ rows: [rows[0], long] });
    expect(cardHeight(inp, 1, 318, measure) - cardHeight(inp, 0, 318, measure)).toBe(20);
  });
});

describe('stats export contents and file names', () => {
  it('offers the cards and the table (images), the one on screen marked', () => {
    const list = statsContents({ lang: 'zh', mode: 'cards', count: 16 });
    expect(list.map((c) => [c.id, c.kind, !!c.current])).toEqual([
      ['cards', 'image', true],
      ['table', 'image', false],
    ]);
    expect(list.map((c) => c.label)).toEqual(['统计卡片', '统计表格']);
    expect(list[0].detail).toContain('16 条记录');
    expect(statsContents({ lang: 'zh', mode: 'table', count: 3 }).filter((c) => c.current).map((c) => c.id)).toEqual(['table']);
    const en = statsContents({ lang: 'en', mode: 'cards', count: 2 });
    expect(en.map((c) => c.label)).toEqual(['Stats cards', 'Stats table']);
    for (const c of en) expect(`${c.label} ${c.detail ?? ''}`).not.toMatch(/[一-鿿]|\{\w+\}/);
  });

  it('names the file after the content and the record count', () => {
    expect(statsFileName('zh', 'cards', 'table', 16)).toBe('SVM_统计摘要_16条');
    expect(statsFileName('zh', 'table', 'cards', 3)).toBe('SVM_统计表格_3条');
    expect(statsFileName('en', 'cards', 'cards', 1)).toBe('SVM_summary_stats_1_records');
    expect(statsFileName('en', 'table', 'cards', 16)).toBe('SVM_stats_table_16_records');
    // legacy / "current": the view on screen
    expect(statsFileName('zh', undefined, 'table', 5)).toBe('SVM_统计表格_5条');
    expect(statsFileName('zh', 'current', 'cards', 5)).toBe('SVM_统计摘要_5条');
    expect(statsContentOf('current', 'table')).toBe('table');
    expect(statsContentOf(undefined, 'cards')).toBe('cards');
    expect(statsContentOf('table', 'cards')).toBe('table');
  });
});
