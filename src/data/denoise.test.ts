import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Dataset, DataPoint } from '../types';
import { validateDataset } from './records';
import { restoreExcluded } from './anomalies';
import { analyseMatrix, blackLevel, displayRecord, MAX_GAP, noteParams, processRecord, rawDataset, type CellNote } from './denoise';

const dir = path.resolve(__dirname, '../../public/datasets');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { file: string }[];
const FILES = manifest.map((m) => m.file);
const load = (f: string) => validateDataset(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

/**
 * Synthetic separable panel: nits = level · (gray/255)^2.2 read to 0.01 nits (0 below half a
 * step), SVM rising smoothly towards the dark end and saturating (as real panels do).
 */
const GRAYS = [255, 224, 192, 160, 128, 96, 64, 48, 32, 24, 16, 8, 2, 1];
const LEVELS = [500, 400, 300, 200, 120, 80, 50, 30, 20, 10];
function panel(tweak?: (g: number, lv: number, p: DataPoint) => DataPoint | null, grays = GRAYS, levels = LEVELS): Dataset {
  const grid = grays.map((g) =>
    levels.map((lv, c) => {
      const raw = lv * Math.pow(g / 255, 2.2);
      const nits = raw < 0.005 ? 0 : Math.round(raw * 100) / 100;
      const p: DataPoint = { gray: g, brightnessPercent: 100 - c * 10, nits, svm: 4 / (1 + 4 * Math.sqrt(raw)) };
      return tweak ? tweak(g, lv, p) : p;
    }),
  );
  const data = grid.flat().filter((p): p is DataPoint => !!p);
  return { id: 's', name: 's', data, matrix: { rows: grays, cols: levels.map((_, c) => 100 - c * 10), headerNits: grid[0].map((p, c) => p?.nits ?? levels[c]), grid } };
}
const at = (ds: Dataset, g: number, pct: number) => ({ r: ds.matrix.rows.indexOf(g), c: ds.matrix.cols.indexOf(pct) });
const set = (ds: Dataset, g: number, pct: number, patch: Partial<DataPoint>) => {
  const { r, c } = at(ds, g, pct);
  ds.matrix.grid[r][c] = { ...ds.matrix.grid[r][c]!, ...patch };
};

describe('black level (dark readings only, robust)', () => {
  it('ignores the real signal of bright columns at G ≤ 2 and gives 0 for quantised all-zero readings', () => {
    // G2 at 500 nits reads 0.01–0.02 (real signal); the dim columns read exactly 0.
    const bl = blackLevel(panel().matrix);
    expect(bl.median).toBe(0);
    expect(bl.ceiling).toBe(0);
    expect(bl.count).toBe(2 * LEVELS.filter((l) => l <= 100).length);
  });
  it('estimates an offset instrument robustly (outliers do not inflate it)', () => {
    const noise = [-0.1, -0.2, -0.1, -0.09, -0.21, -0.1, -0.11, -0.19, 0.02, -0.1];
    let i = 0;
    const ds = panel((g, _lv, p) => (g <= 2 ? { ...p, nits: noise[i++ % noise.length] } : p));
    const bl = blackLevel(ds.matrix);
    expect(bl.median).toBeCloseTo(-0.1, 6);
    expect(bl.ceiling).toBeGreaterThan(0.05);
    expect(bl.ceiling).toBeLessThan(0.2);
    // One wild dark reading barely moves it.
    const wild = panel((g, lv, p) => (g <= 2 ? { ...p, nits: g === 1 && lv === 10 ? 3 : noise[i++ % noise.length] } : p));
    expect(Math.abs(blackLevel(wild.matrix).ceiling - bl.ceiling)).toBeLessThan(0.05);
  });
  it('without dark rows only readings ≤ 0 count as black', () => {
    const ds = panel(undefined, [255, 128, 64, 32]);
    expect(blackLevel(ds.matrix)).toMatchObject({ count: 0, median: null, ceiling: 0 });
  });
});

describe('processRecord (synthetic)', () => {
  it('a clean panel: only the black cells are touched, everything else is the raw object', () => {
    const ds = panel();
    const pr = processRecord(ds, { denoise: true });
    expect(pr.notes.every((n) => n.kind === 'blackLevel' && n.raw.nits <= 0)).toBe(true);
    ds.matrix.grid.forEach((row, r) => row.forEach((p, c) => pr.noteGrid[r][c] || expect(pr.record.matrix.grid[r][c]).toBe(p)));
    expect(pr.record.matrix.headerNits).toEqual(ds.matrix.headerNits);
  });
  it('denoise off returns the raw record itself', () => {
    const ds = panel((g, lv, p) => (g === 96 && lv === 50 ? { ...p, svm: 40 } : p));
    const off = processRecord(ds, { denoise: false });
    expect(off.record).toBe(ds);
    expect(off.notes).toEqual([]);
    expect(displayRecord(ds, { denoise: false })).toBe(ds);
  });
  it('fills an isolated black cell between credible neighbours (log SVM, geometric luminance)', () => {
    const ds = panel();
    set(ds, 96, 50, { nits: 0, svm: 9 });
    const pr = processRecord(ds, { denoise: true });
    const n = pr.noteAt(96, 50)!;
    expect(n).toMatchObject({ kind: 'blackLevel', reason: 'nonPositive', action: 'interpolated', via: 'gray' });
    const up = ds.matrix.grid[at(ds, 128, 50).r][at(ds, 128, 50).c]!;
    const dn = ds.matrix.grid[at(ds, 64, 50).r][at(ds, 64, 50).c]!;
    const t = (96 - 64) / (128 - 64);
    expect(n.value!.svm).toBeCloseTo(Math.exp(Math.log(dn.svm) + (Math.log(up.svm) - Math.log(dn.svm)) * t), 9);
    expect(n.value!.nits).toBeCloseTo(Math.exp(Math.log(dn.nits) + (Math.log(up.nits) - Math.log(dn.nits)) * t), 9);
    expect(n.from).toEqual([
      { gray: 64, brightnessPercent: 50 },
      { gray: 128, brightnessPercent: 50 },
    ]);
  });
  it('bridges at most two cells, then falls back to the row, else no data (never extrapolated)', () => {
    const three = panel();
    for (const g of [128, 96, 64]) set(three, g, 50, { nits: 0, svm: 9 });
    const pr = processRecord(three, { denoise: true });
    // Along gray the gap is 3 long; along level each cell sits between two credible columns.
    expect([128, 96, 64].map((g) => pr.noteAt(g, 50)!.via)).toEqual(['level', 'level', 'level']);

    const corner = panel();
    set(corner, 255, 100, { nits: 0, svm: 9 });
    const pc = processRecord(corner, { denoise: true });
    expect(pc.noteAt(255, 100)).toMatchObject({ action: 'noData', value: null });
    expect(pc.record.matrix.grid[0][0]).toBeNull();
    expect(MAX_GAP).toBe(2);
  });
  it('flags an SVM spike judged against only two credible neighbours (corner)', () => {
    const ds = panel(undefined, [255, 128, 64, 32], [500, 100, 20, 10]);
    const grid = ds.matrix.grid;
    grid[3][2] = null; // G32 / 80 %: the corner G32 / 70 % keeps two neighbours (G64 / 70 %, G64 / 80 %)
    grid[3][3] = { ...grid[3][3]!, svm: grid[3][3]!.svm * 8 };
    const a = analyseMatrix(ds.matrix);
    expect(a.flags[3][3]?.svm).toMatchObject({ kind: 'svmSpike' });
    expect(a.flags.flat().filter((f) => f?.svm).length).toBe(1);
  });
  it('a luminance copied from the row above keeps its SVM; the luminance is estimated', () => {
    const ds = panel();
    const { r, c } = at(ds, 128, 70);
    const truth = ds.matrix.grid[r][c]!;
    set(ds, 128, 70, { nits: ds.matrix.grid[at(ds, 160, 70).r][c]!.nits * 1.004 });
    const n = processRecord(ds, { denoise: true }).noteAt(128, 70)!;
    expect(n).toMatchObject({ kind: 'lumNotUpdated', action: 'lumEstimated', lumVia: 'column', twin: { gray: 160, brightnessPercent: 70 } });
    expect(n.value!.svm).toBe(truth.svm);
    expect(Math.abs(Math.log(n.value!.nits / truth.nits))).toBeLessThan(0.05);
  });
  it('a whole reading repeated (luminance and SVM) is not kept', () => {
    const ds = panel();
    const src = ds.matrix.grid[at(ds, 160, 70).r][at(ds, 160, 70).c]!;
    set(ds, 128, 70, { nits: src.nits * 1.004, svm: src.svm * 1.002 });
    const n = processRecord(ds, { denoise: true }).noteAt(128, 70)!;
    expect(n).toMatchObject({ kind: 'readingNotUpdated', also: 'lumNotUpdated', action: 'interpolated' });
  });
  it('a non-positive SVM reading is unusable and says so', () => {
    const ds = panel();
    set(ds, 96, 50, { svm: 0 });
    const n = processRecord(ds, { denoise: true }).noteAt(96, 50)!;
    expect(n).toMatchObject({ kind: 'svmSpike', reason: 'svmInvalid', action: 'interpolated', via: 'gray' });
    expect(n.value!.svm).toBeGreaterThan(0);
  });
  it('a run of whole readings repeated down a column is caught cell by cell', () => {
    const ds = panel();
    const src = ds.matrix.grid[at(ds, 160, 70).r][at(ds, 160, 70).c]!;
    set(ds, 128, 70, { nits: src.nits * 1.004, svm: src.svm * 1.002 });
    set(ds, 96, 70, { nits: src.nits * 1.008, svm: src.svm * 1.004 });
    const pr = processRecord(ds, { denoise: true });
    expect([128, 96].map((g) => pr.noteAt(g, 70)?.kind)).toEqual(['readingNotUpdated', 'readingNotUpdated']);
    // Two-cell gap along gray: filled between G160 and G64.
    expect([128, 96].map((g) => pr.noteAt(g, 70)?.from?.map((f) => f.gray))).toEqual([
      [64, 160],
      [64, 160],
    ]);
  });
  it('re-estimates a level whose G255 reading is bad', () => {
    const ds = panel();
    const { c } = at(ds, 255, 60);
    const good = ds.matrix.headerNits[c];
    set(ds, 255, 60, { nits: good * 0.6 });
    ds.matrix.headerNits[c] = good * 0.6;
    const pr = processRecord(ds, { denoise: true });
    expect(pr.levelNotes).toHaveLength(1);
    expect(pr.levelNotes[0]).toMatchObject({ brightnessPercent: 60, cellKind: 'lumOffPattern' });
    expect(Math.abs(Math.log(pr.record.matrix.headerNits[c] / good))).toBeLessThan(0.05);
    // The G255 cell itself shows the re-estimated level and keeps its SVM.
    expect(pr.record.matrix.grid[0][c]!.nits).toBe(pr.record.matrix.headerNits[c]);
    expect(pr.record.matrix.grid[0][c]!.svm).toBe(ds.matrix.grid[0][c]!.svm);
  });
  it('the dimmer of two identical adjacent columns is no data', () => {
    const ds = panel();
    for (const row of ds.matrix.grid) row[5] = row[4] ? { ...row[4], brightnessPercent: 50 } : null;
    ds.matrix.headerNits[5] = ds.matrix.headerNits[4];
    const pr = processRecord(ds, { denoise: true });
    const col = pr.notes.filter((n) => n.brightnessPercent === 50);
    expect(col.length).toBe(ds.matrix.rows.length);
    expect(col.every((n) => n.kind === 'duplicateColumn' && n.action === 'noData' && n.twin?.brightnessPercent === 60)).toBe(true);
  });
  it('a record the denoise does not touch is displayed as the raw record itself', () => {
    const ds = panel(undefined, [255, 128, 64, 32]);
    const pr = processRecord(ds, { denoise: true });
    expect(pr.notes).toEqual([]);
    expect(pr.record).toBe(ds);
  });
  it('is memoised per record + options; a renamed record shares the processed matrix', () => {
    const ds = panel();
    const a = processRecord(ds, { denoise: true });
    expect(processRecord(ds, { denoise: true })).toBe(a);
    const renamed = { ...ds, name: 'x' };
    const b = processRecord(renamed, { denoise: true });
    expect(b).not.toBe(a);
    expect(b.record.matrix).toBe(a.record.matrix);
    expect(b.record.name).toBe('x');
  });
});

describe('rawDataset (stored exclusions go back into the grid)', () => {
  it('restores excluded points and drops the field; records without it are returned as is', () => {
    const f = 'xiaomi18promax_adaptive_pro_off.json';
    const stored = load(f);
    expect(stored.excluded!.length).toBeGreaterThan(0);
    const raw = rawDataset(stored);
    expect(raw.excluded).toBeUndefined();
    expect(raw.matrix.grid).toEqual(restoreExcluded(stored).matrix.grid);
    expect(raw.data.length).toBe(stored.data.length + stored.excluded!.length);
    expect(rawDataset(stored)).toBe(raw);
    expect(rawDataset(raw)).toBe(raw);
    // processRecord works from the raw data whether or not the record still carries `excluded`.
    expect(processRecord(stored, { denoise: true }).record.matrix.grid).toEqual(processRecord(raw, { denoise: true }).record.matrix.grid);
  });
});

describe('all bundled records', () => {
  for (const f of FILES) {
    const raw = rawDataset(load(f));
    const pr = processRecord(raw, { denoise: true });
    const a = pr.analysis;
    const g = raw.matrix.grid;

    it(`${f}: every cell without a note is the raw reading itself; levels change only where noted`, () => {
      g.forEach((row, r) =>
        row.forEach((p, c) => {
          if (!pr.noteGrid[r][c]) expect(pr.record.matrix.grid[r][c]).toBe(p);
        }),
      );
      const noted = new Set(pr.levelNotes.map((l) => l.c));
      raw.matrix.headerNits.forEach((h, c) => (noted.has(c) ? expect(pr.record.matrix.headerNits[c]).not.toBe(h) : expect(pr.record.matrix.headerNits[c]).toBe(h)));
      expect(pr.record.data.length).toBe(pr.summary.valid);
    });

    it(`${f}: luminance-only notes keep the measured SVM`, () => {
      for (const n of pr.notes.filter((x) => x.action === 'lumEstimated')) {
        expect(n.value!.svm).toBe(n.raw.svm);
        expect(n.value!.nits).toBeGreaterThan(0);
      }
    });

    it(`${f}: interpolation only between two credible measured cells that bracket the cell, across ≤ ${MAX_GAP} cells`, () => {
      const pos = (list: number[], v: number) => [...list].sort((x, y) => x - y).indexOf(v);
      for (const n of pr.notes.filter((x): x is CellNote & { from: NonNullable<CellNote['from']> } => x.action === 'interpolated')) {
        const src = n.from.map((s) => ({ ...s, r: raw.matrix.rows.indexOf(s.gray), c: raw.matrix.cols.indexOf(s.brightnessPercent) }));
        for (const s of src) {
          expect(a.flags[s.r][s.c]?.svm).toBeUndefined();
          expect(g[s.r][s.c]!.nits).toBeGreaterThan(a.blackLevel.ceiling);
        }
        const [s0, s1] = src.map((s) => g[s.r][s.c]!.svm);
        expect(n.value!.svm).toBeGreaterThanOrEqual(Math.min(s0, s1) - 1e-12);
        expect(n.value!.svm).toBeLessThanOrEqual(Math.max(s0, s1) + 1e-12);
        if (n.via === 'gray') {
          expect(src[0].gray < n.gray && n.gray < src[1].gray).toBe(true);
          expect(pos(raw.matrix.rows, src[1].gray) - pos(raw.matrix.rows, src[0].gray) - 1).toBeLessThanOrEqual(MAX_GAP);
        } else {
          const h = pr.record.matrix.headerNits;
          expect(h[src[0].c] < h[n.c] && h[n.c] < h[src[1].c]).toBe(true);
          expect(pos(raw.matrix.cols, src[1].brightnessPercent) - pos(raw.matrix.cols, src[0].brightnessPercent) - 1).toBeLessThanOrEqual(MAX_GAP);
        }
      }
    });

    it(`${f}: denoise off shows the raw values everywhere`, () => {
      const off = processRecord(raw, { denoise: false });
      expect(off.record).toBe(raw);
      expect(off.record.matrix.grid).toEqual(restoreExcluded(load(f)).matrix.grid);
    });

    it(`${f}: every note has a reason with its numbers`, () => {
      for (const n of pr.notes) {
        const p = noteParams(n);
        if (n.reason === 'blackLevel') expect(p.floor).toBeDefined();
        if (n.reason === 'svmSpike' && n.typical !== undefined) expect(p.typical).toBeDefined();
        if (n.reason === 'lumNotUpdated' || n.reason === 'readingNotUpdated' || n.reason.startsWith('duplicate')) expect(p.twinGray).toBeDefined();
        if (n.kind === 'lumNotUpdated' || n.kind === 'lumOffPattern') expect(p.expected).toBeDefined();
      }
    });
  }
});

describe('known cases in the bundled records', () => {
  const pr = (f: string) => processRecord(rawDataset(load(f)), { denoise: true });

  it('iPhone 17 Pro Max: black reads exactly 0, so every low-light reading above 0 stays', () => {
    for (const f of ['iPhone17ProMax.json', 'iPhone17ProMax_smooth.json']) {
      const p = pr(f);
      expect(p.analysis.blackLevel.ceiling).toBe(0);
      expect(p.notes.filter((n) => n.kind === 'blackLevel').every((n) => n.raw.nits <= 0)).toBe(true);
      // (the standard record's G255 / 0 % luminance 0.558 < G233's 0.711 is re-estimated; its SVM stays)
      const lowLight = p.raw.data.filter((d) => d.nits > 0 && d.nits < 1);
      const kept = lowLight.filter((d) => (p.noteAt(d.gray, d.brightnessPercent)?.action ?? 'lumEstimated') === 'lumEstimated');
      expect(kept.length).toBe(lowLight.length);
      expect(kept.length).toBeGreaterThan(140);
    }
  });

  it('Huawei Mate 80 RS 标准: the black level is not inflated by bright G2 readings; 0.01–0.06 nits readings stay', () => {
    const p = pr('huawei_mate80rs.json');
    expect(p.analysis.blackLevel.ceiling).toBeLessThan(0.01);
    const faint = p.raw.data.filter((d) => d.nits >= 0.01 && d.nits <= 0.06);
    expect(faint.length).toBeGreaterThan(40);
    expect(faint.filter((d) => p.noteAt(d.gray, d.brightnessPercent)?.kind === 'blackLevel')).toEqual([]);
  });

  it('Xiaomi 17 Ultra DC: the SVM 22.73 at G21 / 0 % (0.01 nits) is a spike and not shown', () => {
    const p = pr('xiaomi17ultra_leica_dc_120hz.json');
    const n = p.noteAt(21, 0)!;
    expect(n).toMatchObject({ kind: 'svmSpike', action: 'noData' });
    expect(n.raw.svm).toBeCloseTo(22.725, 3);
    expect(Math.max(...p.record.data.map((d) => d.svm))).toBeLessThan(6);
  });

  it('iPhone 18 Pro Max 标准: luminance not updated keeps the SVM (G51 / 90 %: 27.38 nits = G60, SVM 0.656)', () => {
    const p = pr('iPhone18ProMax.json');
    const n = p.noteAt(51, 90)!;
    expect(n).toMatchObject({ kind: 'lumNotUpdated', action: 'lumEstimated', twin: { gray: 60, brightnessPercent: 90 } });
    expect(n.value!.svm).toBe(0.656);
    // The smooth-pulse record measured this cell at 19.03 nits.
    expect(Math.abs(n.value!.nits / 19.03 - 1)).toBeLessThan(0.05);
    const lum = p.notes.filter((x) => x.kind === 'lumNotUpdated');
    expect(lum.length).toBeGreaterThan(20);
    expect(lum.every((x) => x.value!.svm === x.raw.svm)).toBe(true);
  });

  it('Huawei Mate 70 Air 低频闪 60Hz: the 27 % level (28.3 nits from a bad G255 reading) is re-estimated to ~36 nits', () => {
    const p = pr('huawei_mate70air_low_frequency_60hz.json');
    const c = p.raw.matrix.cols.indexOf(27);
    expect(p.raw.matrix.headerNits[c]).toBeCloseTo(28.314, 3);
    expect(p.levelNotes.map((l) => l.brightnessPercent)).toEqual([27]);
    expect(p.record.matrix.headerNits[c]).toBeGreaterThan(34);
    expect(p.record.matrix.headerNits[c]).toBeLessThan(38);
    // Siblings measured 35.7–36.5 nits at 27 %.
    const top = p.noteAt(255, 27)!;
    expect(top.value!.svm).toBeGreaterThan(0.1);
  });

  it('Xiaomi 18 Pro Max: SVM 62.80 at −0.05 nits (G51 / 16 %) is black-level junk and not shown', () => {
    const p = pr('xiaomi18promax_adaptive_pro_off.json');
    const n = p.noteAt(51, 16)!;
    expect(n).toMatchObject({ kind: 'blackLevel', reason: 'nonPositive', action: 'noData' });
    expect(n.raw.svm).toBeCloseTo(62.802, 3);
    expect(p.record.data.every((d) => d.nits > p.analysis.blackLevel.ceiling)).toBe(true);
  });

  it('Xiaomi 18 Pro Max 开: the 50 % column copied from 60 % is no data', () => {
    const p = pr('xiaomi18promax_adaptive_pro_on.json');
    expect(p.notes.filter((n) => n.kind === 'duplicateColumn').every((n) => n.brightnessPercent === 50 && n.action === 'noData')).toBe(true);
    expect(p.analysis.byKind.duplicateColumn).toBe(24);
  });
});
