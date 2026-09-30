/**
 * The denoise as the views see it (docs/adr/0012 addendum): notes found from the displayed record
 * (displayNotes), the plain-language texts of every note of every bundled record, and the cell
 * notes of the 3D tooltip.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SvmRecord } from '../types';
import { validateDataset } from './records';
import { displayNotes, processRecord, rawDataset } from './denoise';
import { countParts, kindParts, levelNoteText, noteLines, noteText, summaryText } from './denoiseText';
import { computeRecordStats } from './stats';
import { translate, type TFunction } from '../i18n';
import { buildModel } from '../scene3d/engine/model';
import { cellNotes } from '../scene3d/engine/cellNotes';

const dir = path.resolve(__dirname, '../../public/datasets');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { file: string; device: string; mode: string }[];
const rec = (f: string): SvmRecord => {
  const m = manifest.find((x) => x.file === f)!;
  return rawDataset({ ...validateDataset(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))), id: f, device: m.device, mode: m.mode, source: 'bundled' as const });
};
const ALL = manifest.map((m) => rec(m.file));
const tr = (lang: 'zh' | 'en'): TFunction => (k, v) => translate(lang, k, v);
const CJK = /[　-〿一-鿿＀-￯]/;

describe('displayNotes: notes found from the record a view draws', () => {
  it('none for raw records (denoise off) and for untouched records', () => {
    for (const r of ALL) {
      expect(displayNotes(r)).toBeNull();
      const off = processRecord(r, { denoise: false }).record;
      expect(displayNotes(off)).toBeNull();
    }
  });
  it('the processed record carries exactly its notes; a renamed copy shares them', () => {
    for (const r of ALL) {
      const pr = processRecord(r, { denoise: true });
      const dn = displayNotes(pr.record);
      if (!pr.notes.length && !pr.levelNotes.length) {
        expect(dn).toBeNull();
        continue;
      }
      expect(dn!.notes).toBe(pr.notes);
      expect(dn!.summary).toBe(pr.summary);
      for (const n of pr.notes) expect(dn!.noteAt(n.gray, n.brightnessPercent)).toBe(n);
      const renamed = processRecord({ ...r, name: 'x' }, { denoise: true }).record;
      expect(displayNotes(renamed)).toBe(dn);
    }
  });
  it('level notes by brightness % (Mate 70 Air 低频闪 60Hz: 27 % level 28.3 → ~36 nits)', () => {
    const dn = displayNotes(processRecord(rec('huawei_mate70air_low_frequency_60hz.json'), { denoise: true }).record)!;
    const l = dn.levelNoteAt(27)!;
    expect(l.raw).toBeCloseTo(28.31, 2);
    expect(l.value).toBeGreaterThan(35);
    expect(l.value).toBeLessThan(37);
    expect(dn.levelNoteAt(30)).toBeNull();
  });
});

describe('plain-language texts (zh + en) of every note of every bundled record', () => {
  it('every note has an action, a reason with its numbers filled, and the raw reading; English has no CJK', () => {
    const bad: string[] = [];
    for (const r of ALL) {
      const pr = processRecord(r, { denoise: true });
      for (const lang of ['zh', 'en'] as const) {
        const t = tr(lang);
        for (const n of pr.notes) {
          const txt = noteText(n, t);
          const l = noteLines(n, t);
          if (/\{\w+\}/.test(txt) || txt.includes('common.denoise') || !l.reason || !l.raw.includes(l.raw.match(/\d/)?.[0] ?? '#')) bad.push(`${lang} ${r.id} G${n.gray}/${n.brightnessPercent}: ${txt}`);
          if (lang === 'en' && CJK.test(txt)) bad.push(`en CJK ${r.id}: ${txt}`);
          if (n.action === 'interpolated' && !l.source) bad.push(`no source ${r.id} G${n.gray}/${n.brightnessPercent}`);
        }
        for (const lv of pr.levelNotes) if (/\{\w+\}/.test(levelNoteText(lv, t))) bad.push(`level ${lang} ${r.id}`);
        const sum = summaryText(pr.summary, t);
        if (/\{\w+\}/.test(sum) || (lang === 'en' && CJK.test(sum))) bad.push(`summary ${lang} ${r.id}: ${sum}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
  it('luminance reading not updated (iPhone 18 Pro Max 标准 G51 / 90 %): SVM kept, luminance estimated, raw reading shown', () => {
    const pr = processRecord(rec('iPhone18ProMax.json'), { denoise: true });
    const n = pr.noteAt(51, 90)!;
    const zh = noteLines(n, tr('zh'));
    expect(zh.action).toBe('亮度为估算值');
    expect(zh.reason).toContain('亮度读数疑似未更新');
    expect(zh.reason).toContain('SVM 正常，保留');
    expect(zh.raw).toBe('原始读数：27.4 nits · SVM 0.66');
    expect(zh.source).toBe('亮度按本列上下灰阶估算');
    expect(noteLines(n, tr('en')).action).toBe('Luminance estimated');
  });
  it('an interpolated repeated reading names its sources (Mate 80 RS 标准 G96 / 27 %)', () => {
    const n = processRecord(rec('huawei_mate80rs.json'), { denoise: true }).noteAt(96, 27)!;
    const l = noteLines(n, tr('zh'));
    expect(l.action).toBe('插值补全');
    expect(l.reason).toContain('读数疑似未更新');
    expect(l.source).toMatch(/^由 \S+ 与 \S+ 的读数插值$/);
  });
  it('counts and kinds in plain words, zero counts left out', () => {
    const t = tr('zh');
    expect(countParts({ interpolated: 0, noData: 39, lumEstimated: 7, levelsEstimated: 0 }, t)).toEqual(['无有效数据 39 格', '亮度为估算值 7 格']);
    expect(kindParts({ svmSpike: 2, blackLevel: 35 }, t)).toEqual(['接近全黑、测不准 35', 'SVM 尖峰 2']);
    expect(countParts({ interpolated: 2, noData: 0, lumEstimated: 0 }, tr('en'))).toEqual(['2 interpolated']);
  });
});

describe('stats on the displayed records', () => {
  it('iPhone 18 Pro Max 标准: SVM @ 2 / 10 nits read off a continuous G127 curve with the denoise on', () => {
    const on = computeRecordStats(processRecord(rec('iPhone18ProMax.json'), { denoise: true }).record, { clipLowGray: true, maxNits: 500, sliceGray: 127 });
    expect(on.svmAt[0].svm).not.toBeNull();
    expect(on.svmAt[1].svm).not.toBeNull();
    expect(on.svmAt[1].svm!).toBeGreaterThan(0.5);
    expect(on.svmAt[1].svm!).toBeLessThan(2);
  });
});

describe('3D cell notes (tooltip)', () => {
  const top = (a: SvmRecord, b: SvmRecord | null = null, layout: 'single' | 'diff' = 'single') => {
    const res = buildModel({ layout, a, b, clipLowGray: true, maxNits: null, colorMax: 4, heightCap: 6 });
    if (!res.ok) throw new Error(res.reason);
    return res.model.panels[0];
  };
  const idx = (pm: ReturnType<typeof top>, gray: number, pct: number) => ({ r: pm.view.grays.indexOf(gray), c: pm.view.percents.indexOf(pct) });

  it('the cell’s own note: interpolated (Mate 80 RS 标准 G96 / 27 %), luminance estimated (iPhone 18 G51 / 90 %), no data (Xiaomi 17 Ultra DC G21 / 0 %)', () => {
    let pm = top(processRecord(rec('huawei_mate80rs.json'), { denoise: true }).record);
    let { r, c } = idx(pm, 96, 27);
    expect(cellNotes(pm, r, c).notes![0].note.action).toBe('interpolated');
    expect(cellNotes(pm, r, c).notes![0].who).toBeUndefined();
    pm = top(processRecord(rec('iPhone18ProMax.json'), { denoise: true }).record);
    ({ r, c } = idx(pm, 51, 90));
    expect(cellNotes(pm, r, c).notes![0].note.action).toBe('lumEstimated');
    expect(pm.values[r][c]).toBeCloseTo(0.656, 3);
    pm = top(processRecord(rec('xiaomi17ultra_leica_dc_120hz.json'), { denoise: true }).record);
    ({ r, c } = idx(pm, 21, 0));
    const cn = cellNotes(pm, r, c);
    expect(pm.values[r][c]).toBeNull();
    expect(cn.notes![0].note.action).toBe('noData');
    expect(cn.missing).toBeUndefined();
  });
  it('the re-estimated level of the column (Mate 70 Air 低频闪 60Hz 27 %)', () => {
    const pm = top(processRecord(rec('huawei_mate70air_low_frequency_60hz.json'), { denoise: true }).record);
    const { r, c } = idx(pm, pm.view.grays[5], 27);
    expect(pm.view.levelNits[c]).toBeGreaterThan(35);
    expect(cellNotes(pm, r, c).level!.raw).toBeCloseTo(28.31, 2);
  });
  it('nothing for raw records; difference map: A’s cell and the B cells its resampling uses', () => {
    const rawPm = top(rec('huawei_mate80rs.json'));
    const { r, c } = idx(rawPm, 96, 27);
    expect(cellNotes(rawPm, r, c)).toEqual({});
    const a = processRecord(rec('huawei_mate80rs.json'), { denoise: true }).record;
    const b = processRecord(rec('huawei_mate80rs_60hz.json'), { denoise: true }).record;
    const pm = top(a, b, 'diff');
    const p = idx(pm, 96, 27);
    const cn = cellNotes(pm, p.r, p.c);
    expect(cn.notes![0]).toMatchObject({ who: 'A' });
    // B = A itself: B's notes at the same cells are reported too
    const same = top(a, a, 'diff');
    const q = idx(same, 96, 27);
    expect(cellNotes(same, q.r, q.c).notes!.map((n) => n.who)).toEqual(['A', 'B']);
  });
});
