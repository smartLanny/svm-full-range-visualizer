/**
 * Fingerprint of everything that goes into the offline single-file build (docs/adr/0008).
 *
 * scripts/finalize-standalone.mjs writes it into release/SVM-Visualizer.html as
 *   <meta name="svm-build-inputs" content="sha256:…">
 * and src/export/releaseFreshness.test.ts recomputes it, so `npm test` fails as soon as the
 * committed offline file no longer matches the sources ("run npm run build:standalone").
 *
 * Inputs: the files git tracks (or would track: new, not ignored) under src/ and public/ plus
 * index.html, vite.config.ts, the Tailwind / PostCSS configs and package-lock.json. Test files
 * (*.test.ts) and dotfiles are left out: they never reach the bundle. Without git (e.g. a
 * downloaded ZIP) the same set is found by walking the directories. Text files are hashed
 * with LF line endings, so a Windows checkout with core.autocrlf gives the same hash.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const BUILD_INPUTS_META = 'svm-build-inputs';

const DIRS = ['src', 'public'];
const FILES = ['index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js', 'package-lock.json'];
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|css|html|svg|md|txt|tsv|webmanifest)$/i;
const EXCLUDE = /(?:^|\/)\.|\.test\.tsx?$/;

function gitFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DIRS, ...FILES], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.toString('utf8').split('\0').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

function walkFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(root, d))) walk(d);
  for (const f of FILES) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out;
}

/** Sorted repo-relative (forward-slash) paths of the build inputs. */
export function buildInputFiles(root) {
  const files = gitFiles(root) ?? walkFiles(root);
  return [...new Set(files.map((f) => f.replace(/\\/g, '/')))]
    .filter((f) => !EXCLUDE.test(f) && fs.existsSync(path.join(root, f)))
    .sort();
}

/**
 * The part of package-lock.json that decides what gets bundled: the resolved packages. The root
 * entry (name, version, engines, dependency ranges) is left out, so `npm install` rewriting it
 * after a package.json metadata change does not mark the offline file stale.
 */
function lockfileDeps(buf) {
  try {
    const lock = JSON.parse(buf.toString('utf8'));
    const { '': _root, ...packages } = lock.packages ?? {};
    return JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages });
  } catch {
    return buf.toString('utf8').replace(/\r\n/g, '\n');
  }
}

/** "sha256:<hex>" over the build inputs (paths and contents). */
export function buildInputHash(root) {
  const h = crypto.createHash('sha256');
  for (const f of buildInputFiles(root)) {
    let buf = fs.readFileSync(path.join(root, f));
    if (f === 'package-lock.json') buf = Buffer.from(lockfileDeps(buf), 'utf8');
    else if (TEXT_EXT.test(f)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    h.update(f);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
  }
  return `sha256:${h.digest('hex')}`;
}

/** The fingerprint stored in a built HTML file, or null if it has none (built before the guard). */
export function readBuildInputHash(html) {
  const m = html.match(new RegExp(`<meta\\s+name="${BUILD_INPUTS_META}"\\s+content="([^"]+)"`, 'i'));
  return m ? m[1] : null;
}
