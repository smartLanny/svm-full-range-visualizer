import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseRawData, splitTables } from './parse';
import { validateDataset } from './records';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/datasets/manifest.json'), 'utf8')) as { file: string; device: string; mode: string }[];
const cases = [
  ['inner', 0, 'iPhoneDuo_inner_120hz.json', 'iPhone Duo 内屏', '普通 120Hz', 432],
  ['inner', 1, 'iPhoneDuo_inner_smooth_120hz.json', 'iPhone Duo 内屏', '脉冲平滑 120Hz', 432],
  ['outer', 0, 'iPhoneDuo_outer_120hz.json', 'iPhone Duo 外屏', '普通 120Hz', 431],
  ['outer', 1, 'iPhoneDuo_outer_smooth_120hz.json', 'iPhone Duo 外屏', '脉冲平滑 120Hz', 432],
] as const;

describe('iPhone Duo revision 91 bundled measurements', () => {
  it.each(cases)('%s block %i retains every source measurement in %s', (screen, block, file, device, mode, cells) => {
    // The archived source cells contain no quoted commas; preserve empty cells when converting to the app's TSV importer.
    const source = fs.readFileSync(path.join(root, `test-fixtures/iphone_duo_${screen}_revision91.csv`), 'utf8');
    const tsv = source.trimEnd().split('\n').map(line => line.split(',').join('\t')).join('\n');
    const tables = splitTables(tsv);
    expect(tables).toHaveLength(2);
    const parsed = parseRawData(tables[block].text, tables[block].title);
    const saved = validateDataset(JSON.parse(fs.readFileSync(path.join(root, 'public/datasets', file), 'utf8')));
    expect(saved.matrix).toEqual(parsed.matrix);
    expect(saved.data).toEqual(parsed.data);
    expect(saved.data).toHaveLength(cells);
    expect(saved.matrix.rows).toHaveLength(24);
    expect(saved.matrix.cols).toHaveLength(18);
    expect(saved.device).toBe(device);
    expect(saved.mode).toBe(mode);
    expect(manifest.filter(entry => entry.file === file)).toEqual([expect.objectContaining({ file, device, mode })]);
  });
});
