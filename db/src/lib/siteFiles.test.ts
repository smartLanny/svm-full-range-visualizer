import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { siteFiles, siteInfo } from '../../../pipeline/site/files.mjs';

const ROOT = path.resolve(__dirname, '../../..');

describe('files served with the database page', () => {
  const files = siteFiles(ROOT) as Map<string, string>;

  it('lists only existing files from data/ and public/datasets/', () => {
    for (const [served, from] of files) {
      expect(fs.existsSync(path.join(ROOT, from)), from).toBe(true);
      expect(from.startsWith('data/') || from.startsWith('public/datasets/'), from).toBe(true);
      expect(served.startsWith('data/') || served.startsWith('datasets/'), served).toBe(true);
    }
  });

  it('includes every heatmap and SVM record of the catalog, but no raw instrument data', () => {
    const served = [...files.keys()];
    expect(served.filter((f) => f.startsWith('data/uniformity/maps/'))).toHaveLength(15);
    expect(served.filter((f) => f.startsWith('datasets/') && f !== 'datasets/manifest.json')).toHaveLength(21);
    expect(served).toContain('data/devices.json');
    expect(served.some((f) => f.includes('raw/') || f.includes('provenance') || f.includes('overrides'))).toBe(false);
  });

  it('reports the data version from git when available', () => {
    const info = siteInfo(ROOT);
    expect(info.schemaVersion).toBe(1);
    if (info.dataCommit !== null) expect(info.dataCommitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
