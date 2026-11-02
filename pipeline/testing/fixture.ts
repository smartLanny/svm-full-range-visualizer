/**
 * Throw-away copies of the database for tests that corrupt data on purpose.
 *
 * makeFixture() builds a temporary root with copies of data/ (heatmap PNGs are symlinked unless
 * `copyMaps` is set), public/datasets (manifest copied, records symlinked) and .gitattributes,
 * so pipeline/check.mjs and the catalog generator run on it exactly as on the repository.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ROOT = path.resolve(__dirname, '../..');

export interface Fixture {
  root: string;
  path: (rel: string) => string;
  readJson: <T = any>(rel: string) => T;
  writeJson: (rel: string, value: unknown) => void;
  edit: <T = any>(rel: string, fn: (value: T) => void) => void;
  cleanup: () => void;
}

function copyTree(from: string, to: string, link: (rel: string) => boolean, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name), dst = path.join(to, name), r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(src).isDirectory()) copyTree(src, dst, link, r);
    else if (link(r)) fs.symlinkSync(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

export function makeFixture({ copyMaps = false } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screendb-check-'));
  copyTree(path.join(ROOT, 'data'), path.join(root, 'data'), (r) => !copyMaps && r.startsWith('uniformity/maps/'));
  copyTree(path.join(ROOT, 'public/datasets'), path.join(root, 'public/datasets'), (r) => r !== 'manifest.json');
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(root, '.gitattributes'));
  const p = (rel: string) => path.join(root, rel);
  const readJson = (rel: string) => JSON.parse(fs.readFileSync(p(rel), 'utf8'));
  const writeJson = (rel: string, value: unknown) => {
    fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
    fs.writeFileSync(p(rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    root,
    path: p,
    readJson,
    writeJson,
    edit: (rel, fn) => { const v = readJson(rel); fn(v); writeJson(rel, v); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
