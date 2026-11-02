/**
 * Is the workbench's offline release (release/SVM-Visualizer.html) built from the current sources?
 * Same test as src/export/releaseFreshness.test.ts: the fingerprint stamped into the file must equal
 * the fingerprint of src/, public/ (including public/datasets) and the build configs.
 */
import fs from 'fs';
import path from 'path';
import { buildInputHash, readBuildInputHash } from '../../scripts/build-inputs.mjs';

export const RELEASE_FILE = 'release/SVM-Visualizer.html';

/** { applicable: false } when `root` is not a full checkout (e.g. a db:import staging copy). */
export function releaseState(root) {
  const file = path.join(root, RELEASE_FILE);
  if (!fs.existsSync(file) || !fs.existsSync(path.join(root, 'src')) || !fs.existsSync(path.join(root, 'package-lock.json'))) {
    return { applicable: false };
  }
  const stamped = readBuildInputHash(fs.readFileSync(file, 'utf8'));
  const current = buildInputHash(root);
  return { applicable: true, fresh: stamped === current, stamped, current };
}
