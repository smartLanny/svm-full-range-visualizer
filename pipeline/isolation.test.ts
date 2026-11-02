/**
 * The SVM workbench (src/) and its offline release must not depend on the screen database.
 *
 * 1. Nothing under src/ imports from db/, data/ or pipeline/.
 * 2. None of those directories is an input of the offline release fingerprint
 *    (scripts/build-inputs.mjs), so database changes never mark release/SVM-Visualizer.html stale.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildInputFiles } from '../scripts/build-inputs.mjs';

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = ['db', 'data', 'pipeline'];
const SOURCE = /\.(?:[cm]?[jt]sx?|css|html)$/;

const PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g,
  /import\.meta\.glob(?:Eager)?\s*\(\s*\[?\s*['"]([^'"]+)['"]/g,
  /@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g,
];

/** Import specifiers in `code` that point into db/, data/ or pipeline/ (relative to `file`). */
export function forbiddenImports(code: string, file: string): string[] {
  const out: string[] = [];
  for (const re of PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[1];
      let target: string | null = null;
      if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
      else if (spec.startsWith('/')) target = path.join(ROOT, spec);
      if (!target) continue;
      const r = path.relative(ROOT, target).split(path.sep);
      if (r[0] !== '..' && FORBIDDEN.includes(r[0])) out.push(spec);
    }
  }
  return out;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : SOURCE.test(e.name) ? [p] : [];
  });
}

describe('workbench isolation', () => {
  it('the scanner catches each import form (self-test)', () => {
    const f = path.join(ROOT, 'src/x/y.ts');
    const code = [
      "import a from '../../db/catalog/types';",
      "import '../../data/devices.json';",
      "const b = await import('../../pipeline/check.mjs');",
      "const c = require('../../data/x.json');",
      "const u = new URL('../../data/uniformity/maps/a.png', import.meta.url);",
      "const g = import.meta.glob('/data/**/*.json');",
      "@import url('../../db/style.css');",
      "import ok from '../ui/Button'; import alsoOk from '@/data/grid'; import fine from '../../scripts/build-inputs.mjs';",
    ].join('\n');
    expect(forbiddenImports(code, f)).toEqual([
      '../../db/catalog/types',
      '../../data/devices.json',
      '../../pipeline/check.mjs',
      '../../data/x.json',
      '../../data/uniformity/maps/a.png',
      '/data/**/*.json',
      '../../db/style.css',
    ]);
  });

  it('nothing under src/ imports from db/, data/ or pipeline/', () => {
    const files = walk(path.join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((f) => forbiddenImports(fs.readFileSync(f, 'utf8'), f).map((s) => `${path.relative(ROOT, f)} → ${s}`));
    expect(hits).toEqual([]);
  });

  it('the offline release fingerprint has no database inputs', () => {
    const inputs = buildInputFiles(ROOT);
    expect(inputs.length).toBeGreaterThan(50);
    expect(inputs.filter((f) => FORBIDDEN.includes(f.split('/')[0]))).toEqual([]);
  });
});
