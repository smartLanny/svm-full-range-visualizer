/**
 * Which repository files the screen database web page (db/) needs, and where they are served.
 *
 * vite.db.config.ts uses this list twice:
 * - `npm run db:dev`: only these files are served under /data/ and /datasets/ (an allow-list, so
 *   raw instrument data or provenance files are never exposed by accident);
 * - `npm run db:build`: exactly these files are copied into dist-db/.
 *
 * Everything is derived from data/devices.json, so a new batch needs no change here.
 * `site-info.json` is generated (data version / date for the page footer), never stored.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Served path → repository path, in a stable order. */
export function siteFiles(root) {
  const out = new Map();
  const add = (served, from) => out.set(served, from);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/devices.json'), 'utf8'));

  add('data/devices.json', 'data/devices.json');
  add('data/angle/summary.json', 'data/angle/summary.json');
  add('data/uniformity/index.json', 'data/uniformity/index.json');
  add('data/reflectance/index.json', 'data/reflectance/index.json');
  // Optional, written by future data batches (data version + change log).
  for (const f of ['data/version.json', 'data/CHANGELOG.md']) if (fs.existsSync(path.join(root, f))) add(f, f);

  add('datasets/manifest.json', 'public/datasets/manifest.json');
  for (const d of catalog.devices) {
    for (const u of d.uniformity) for (const m of u.maps) add(`data/uniformity/${m.asset}`, `data/uniformity/${m.asset}`);
    for (const s of d.svm) add(`datasets/${s.record}`, `public/datasets/${s.record}`);
  }
  return out;
}

/**
 * Data version shown on the page: data/version.json when a batch wrote one, plus the last git
 * commit that touched the data (data/ or public/datasets/). Without git (a downloaded ZIP) the
 * commit fields are null and the page simply leaves them out.
 */
export function siteInfo(root) {
  let commit = null;
  let date = null;
  try {
    const line = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h%x09%cI', '--', 'data', 'public/datasets'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (line) [commit, date] = line.split('\t');
  } catch {
    // no git: leave null
  }
  let version = null;
  const vf = path.join(root, 'data/version.json');
  if (fs.existsSync(vf)) {
    try {
      version = JSON.parse(fs.readFileSync(vf, 'utf8'));
    } catch {
      version = null;
    }
  }
  return { schemaVersion: 1, dataCommit: commit, dataCommitDate: date, version };
}
