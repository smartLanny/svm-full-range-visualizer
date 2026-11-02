/**
 * pipeline/import/svm_feishu_csv.py — regression against the committed records, idempotence, and
 * refusals. Every run writes into a temporary root, never into public/datasets.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, runPython, tempDir, writeJsonFile, type PyRun } from '../testing/python';

const SCRIPT = 'pipeline/import/svm_feishu_csv.py';
const DATASETS = path.join(ROOT, 'public/datasets');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline/examples/duo-revision91.batch.json'), 'utf8'));
const manifest: Record<string, string>[] = JSON.parse(fs.readFileSync(path.join(DATASETS, 'manifest.json'), 'utf8'));
const DUO = manifest.filter((m) => m.file.startsWith('iPhoneDuo_')).map((m) => m.file);
const manifestText = (entries: unknown[]) => `[\n${entries.map((e) => `  ${JSON.stringify(e).replace(/","/g, '", "').replace(/":"/g, '": "')}`).join(',\n')}\n]\n`;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

/** A temporary repo root whose manifest holds `entries` (the committed format). */
function makeRoot(entries: unknown[]) {
  const t = tempDir('svm-import-');
  cleanup = t.cleanup;
  fs.mkdirSync(path.join(t.dir, 'public/datasets'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'public/datasets/manifest.json'), manifestText(entries));
  return t.dir;
}

function importDuo(root: string, extra: string[] = []): PyRun[] {
  return example.inputs.map((input: { path: string; options: unknown }, i: number) => {
    const spec = path.join(root, `spec-${i}.json`);
    writeJsonFile(spec, input.options);
    return runPython(SCRIPT, ['--root', root, '--csv', path.join(ROOT, 'test-fixtures', input.path), '--spec', spec, '--audit', path.join(root, `audit-${i}.json`), ...extra]);
  });
}

describe('svm_feishu_csv.py', () => {
  it('the manifest helper reproduces the committed manifest format', () => {
    expect(manifestText(manifest)).toBe(fs.readFileSync(path.join(DATASETS, 'manifest.json'), 'utf8'));
  });

  it('reproduces the four committed iPhone Duo records and manifest byte for byte', () => {
    const root = makeRoot(manifest.filter((m) => !DUO.includes(m.file)));
    const runs = importDuo(root);
    for (const r of runs) expect(r.status, r.stderr).toBe(0);
    for (const f of [...DUO, 'manifest.json']) {
      expect(fs.readFileSync(path.join(root, 'public/datasets', f)).equals(fs.readFileSync(path.join(DATASETS, f))), f).toBe(true);
    }
    expect(runs.flatMap((r) => r.result.records.map((x: { status: string }) => x.status))).toEqual(['created', 'created', 'created', 'created']);
    expect(runs.every((r) => r.result.requiresStandaloneRebuild)).toBe(true);
    expect(runs[0].stderr).toContain('npm run build:standalone');
    // same totals as docs/data-imports/iphone-duo-svm-revision91.json
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data-imports/iphone-duo-svm-revision91.json'), 'utf8'));
    const audits = [0, 1].flatMap((i) => JSON.parse(fs.readFileSync(path.join(root, `audit-${i}.json`), 'utf8')).records);
    for (const key of ['numericValuesCompared', 'matchedMeasurements', 'matchedBlankPairs', 'blankSourceCells', 'zeroNitsCellsPreserved', 'maximumRawSvm', 'g255HeaderNits']) {
      expect(audits.map((a: Record<string, unknown>) => a[key]), key).toEqual(committed.records.map((a: Record<string, unknown>) => a[key]));
    }
    for (const key of ['blockRange', 'measurementRange', 'tableTitle']) {
      expect(audits.map((a: Record<string, unknown>) => a[key]), key).toEqual(committed.records.map((a: { source: Record<string, unknown> }) => a.source[key]));
    }
  });

  it('is idempotent: a second run changes nothing and needs no release rebuild', () => {
    const root = makeRoot(manifest.filter((m) => !DUO.includes(m.file)));
    importDuo(root);
    const before = fs.readdirSync(path.join(root, 'public/datasets')).map((f) => fs.readFileSync(path.join(root, 'public/datasets', f), 'utf8'));
    const again = importDuo(root);
    for (const r of again) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.result.changedFiles).toEqual([]);
      expect(r.result.requiresStandaloneRebuild).toBe(false);
      expect(r.stderr).not.toContain('build:standalone');
    }
    const after = fs.readdirSync(path.join(root, 'public/datasets')).map((f) => fs.readFileSync(path.join(root, 'public/datasets', f), 'utf8'));
    expect(after).toEqual(before);
  });

  it('dry run reports the plan and writes nothing', () => {
    const root = makeRoot(manifest.filter((m) => !DUO.includes(m.file)));
    const [r] = importDuo(root, ['--dry-run']).slice(0, 1);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.dryRun).toBe(true);
    expect(r.result.changedFiles).toEqual(['public/datasets/iPhoneDuo_inner_120hz.json', 'public/datasets/iPhoneDuo_inner_smooth_120hz.json', 'public/datasets/manifest.json']);
    expect(fs.readdirSync(path.join(root, 'public/datasets'))).toEqual(['manifest.json']);
    expect(fs.existsSync(path.join(root, 'audit-0.json'))).toBe(false);
  });

  it('reproduces the committed Mate 90 record from a sheet with blanks and an empty template block', () => {
    // Rebuild a CSV export from the committed record (the original export is not in the repository).
    const committed = JSON.parse(fs.readFileSync(path.join(DATASETS, 'huawei_mate90promax.json'), 'utf8'));
    const device = '华为 Mate 90 Pro Max 典藏版';
    const { rows, cols, grid } = committed.matrix;
    const block = (title: string, cells: (null | { nits: number; svm: number })[][]) => [
      [title, ...Array(36).fill('')],
      ['亮度条百分比', ...cols.flatMap((c: number) => [String(c), ''])],
      ['灰阶 (Gray)', ...cols.flatMap(() => ['亮度', 'SVM'])],
      ...rows.map((g: number, r: number) => [String(g), ...cells[r].flatMap((p) => (p ? [String(p.nits), String(p.svm)] : ['', '']))]),
    ];
    const csv = [...block(device, grid), ...block(`${device} 屏幕低频闪`, rows.map(() => cols.map(() => null)))].map((r) => r.join(',')).join('\n') + '\n';
    const root = makeRoot(manifest.slice(0, 16));
    fs.writeFileSync(path.join(root, 'mate90.csv'), csv);
    writeJsonFile(path.join(root, 'spec.json'), {
      blocks: [
        { startRow: 1, title: device, file: 'huawei_mate90promax.json', id: 'huawei_mate90promax_20261008', name: device, recordStyle: 'name-only', device, mode: '默认', modeEn: 'Default' },
        { startRow: 28, title: `${device} 屏幕低频闪`, skip: 'empty', reason: '未使用的模板块；该机没有独立的屏幕低频闪模式。' },
      ],
    });
    const r = runPython(SCRIPT, ['--root', root, '--csv', path.join(root, 'mate90.csv'), '--spec', path.join(root, 'spec.json')]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'public/datasets/huawei_mate90promax.json')).equals(fs.readFileSync(path.join(DATASETS, 'huawei_mate90promax.json')))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'public/datasets/manifest.json'), 'utf8'))).toEqual(manifest.slice(0, 17));
    expect(r.result.records).toEqual([{ file: 'huawei_mate90promax.json', status: 'created', measured: 72, blanks: 360 }]);
    expect(r.result.omittedBlocks).toEqual(['A28:AK54']);
  });

  describe('refuses instead of guessing', () => {
    const duoCsv = () => fs.readFileSync(path.join(ROOT, 'test-fixtures/iphone_duo_inner_revision91.csv'), 'utf8').split('\n');
    const run = (root: string, lines: string[], spec: unknown = example.inputs[0].options) => {
      fs.writeFileSync(path.join(root, 'in.csv'), lines.join('\n'));
      writeJsonFile(path.join(root, 'spec.json'), spec);
      return runPython(SCRIPT, ['--root', root, '--csv', path.join(root, 'in.csv'), '--spec', path.join(root, 'spec.json')]);
    };

    it('a nits cell without its SVM cell', () => {
      const root = makeRoot([]);
      const lines = duoCsv();
      const cells = lines[9].split(',');
      cells[2] = '';
      lines[9] = cells.join(',');
      const r = run(root, lines);
      expect(r.status).toBe(1);
      expect(r.result.ok).toBe(false);
      expect(r.stderr).toMatch(/B10:C10: 亮度与 SVM 只有一个是空白/);
      expect(fs.readdirSync(path.join(root, 'public/datasets'))).toEqual(['manifest.json']);
    });

    it('an existing record with different values (raw data is never overwritten)', () => {
      const root = makeRoot([]);
      expect(run(root, duoCsv()).status).toBe(0);
      const lines = duoCsv();
      lines[3] = lines[3].replace('747.27', '747.28');
      const r = run(root, lines);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/iPhoneDuo_inner_120hz\.json 已存在且内容不同/);
    });

    it('non-blank cells outside every declared block', () => {
      const root = makeRoot([]);
      const r = run(root, [...duoCsv().slice(0, 54), '备注：另一台样机,,'], example.inputs[0].options);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/A55「备注：另一台样机」/);
    });

    it('a block title that does not match the spec', () => {
      const root = makeRoot([]);
      const spec = JSON.parse(JSON.stringify(example.inputs[0].options));
      spec.blocks[1].title = 'iPhone Duo 内屏 低频闪';
      const r = run(root, duoCsv(), spec);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/A28: 块标题应为「iPhone Duo 内屏 低频闪」/);
    });

    it('a manifest entry that would change', () => {
      const entry = manifest.find((m) => m.file === 'iPhoneDuo_inner_120hz.json')!;
      const root = makeRoot([{ ...entry, mode: '标准' }]);
      const r = run(root, duoCsv());
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/manifest 只追加，不改已有条目/);
    });
  });
});
