import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ColormapType, type Dataset } from '../types';
import { toRecord } from '../data/records';
import { recordStyles } from '../data/colors';
import { DEFAULT_SCENARIOS } from '../data/scenarios';
import { translate } from '../i18n';
import type { Measure } from './exportLayout';
import { cardHeight, tableCols, tableSplit, type StatsExportInput } from './exportRender';
import { thumbExtent } from './heatmap';
import { buildRows, rankRows, sortRows } from './model';
import { processRecord, rawDataset } from '../data/denoise';

const CJK = /[⺀-鿿＀-￯]/;
const measure: Measure = (text, size) => Array.from(text).reduce((a, ch) => a + (CJK.test(ch) ? size : 0.55 * size), 0);

describe('stats export — scenario reference (docs/adr/0009 addendum)', () => {
  it('the table ends with the 场景参考 group: 综合 / 夜间 / 室内 / 户外, weight shares as sub-headers, second band in portrait', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v);
    const cols = tableCols(t, DEFAULT_SCENARIOS);
    const last = cols.slice(-4);
    expect(last.map((c) => c.key)).toEqual(['scenario', 'scNight', 'scIndoor', 'scOutdoor']);
    expect(last.map((c) => c.label)).toEqual(['综合', '夜间', '室内', '户外']);
    expect(last.map((c) => c.sub)).toEqual(['参考', '30%', '50%', '20%']);
    expect(last.every((c) => c.group === 'scenario')).toBe(true);
    const [a, b] = tableSplit(cols);
    for (let i = cols.length - 4; i < cols.length; i++) {
      expect(b).toContain(i);
      expect(a).not.toContain(i);
    }
    const custom = tableCols(t, { ...DEFAULT_SCENARIOS, outdoor: { ...DEFAULT_SCENARIOS.outdoor, weight: 0 } });
    expect(custom.slice(-3).map((c) => c.sub)).toEqual(['38%', '63%', '0%']);
  });

  it('every card carries the fixed-height scenario block, also when its scope is empty', () => {
    const dir = path.resolve(__dirname, '../../public/datasets');
    const f = fs.readdirSync(dir).find((x) => x.startsWith('iPhone17ProMax'))!;
    const rec = processRecord(rawDataset(toRecord(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Dataset, 'bundled', { id: 'r0' })), { denoise: true }).record;
    const input = (maxNits: number): StatsExportInput => {
      const opts = { clipLowGray: true, maxNits, sliceGray: 127 };
      const rows = sortRows(buildRows([rec], opts), 'order', 'asc', 'zh');
      return {
        lang: 'zh',
        rows,
        styles: recordStyles([rec]),
        rank: rankRows(rows),
        extent: thumbExtent([rec], opts),
        clipLowGray: true,
        maxNits,
        sliceGray: 127,
        colormap: ColormapType.RD_YL_BU_ENHANCED,
        colorMax: 4,
        sortKey: 'order',
        sortDir: 'asc',
        scope: 'x',
      };
    };
    const full = input(500);
    expect(full.rows[0].stats.scenario.composite).not.toBeNull();
    // an empty scope (cap below every column): the dashed box + the scenario block (8 + 44 + 16)
    const empty = input(0.01);
    expect(empty.rows[0].stats.cellCount).toBe(0);
    expect(empty.rows[0].stats.scenario).toBe(full.rows[0].stats.scenario);
    const header = cardHeight(empty, 0, 318, measure) - (40 + 16 + 4 + 14 + 40) - (8 + 44 + 16);
    expect(header).toBeGreaterThan(40);
    expect(header).toBeLessThan(90);
  });
});
