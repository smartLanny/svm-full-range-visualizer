/**
 * Staleness guard for the committed offline file (docs/adr/0008).
 *
 * release/SVM-Visualizer.html is what README and every launcher open. It is a build artefact, so
 * it silently goes stale when src/ changes without `npm run build:standalone`. The build stamps
 * a fingerprint of its inputs into the file (scripts/finalize-standalone.mjs); this test
 * recomputes the fingerprint from the working tree and fails when they differ.
 *
 * SVM_RELEASE_FILE=<path> checks another build (e.g. finalize-standalone --out <path>).
 * SVM_SKIP_RELEASE_CHECK=1 skips the check (intermediate commits that rebuild the file later).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildInputHash, readBuildInputHash } from '../../scripts/build-inputs.mjs';

const root = path.resolve(__dirname, '../..');
const releaseFile = path.resolve(root, process.env.SVM_RELEASE_FILE || 'release/SVM-Visualizer.html');
const rel = path.relative(root, releaseFile) || releaseFile;
const FIX = 'run `npm run build:standalone` and commit release/SVM-Visualizer.html';

describe.skipIf(!!process.env.SVM_SKIP_RELEASE_CHECK)('offline release file', () => {
  it('exists', () => {
    expect(fs.existsSync(releaseFile), `${rel} is missing: ${FIX}`).toBe(true);
  });

  it('was built from the current sources', () => {
    const html = fs.readFileSync(releaseFile, 'utf8');
    const stamped = readBuildInputHash(html);
    expect(stamped, `${rel} has no build fingerprint (built before the staleness guard): ${FIX}`).not.toBeNull();
    expect(stamped, `${rel} is stale (sources changed since it was built): ${FIX}`).toBe(buildInputHash(root));
  });

  it('embeds every bundled dataset', () => {
    const html = fs.readFileSync(releaseFile, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/datasets/manifest.json'), 'utf8')) as { file: string }[];
    const missing = manifest.filter((e) => !html.includes(e.file)).map((e) => e.file);
    expect(missing, `${rel} lacks bundled datasets: ${FIX}`).toEqual([]);
  });
});
