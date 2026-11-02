/**
 * Small shared helpers for the database pipeline (no dependencies).
 *
 * Every generated JSON file is written with writeJson so regenerating from the same inputs gives
 * byte-identical output (2-space indent, LF, trailing newline). check.mjs relies on that to tell
 * a stale generated file from a fresh one.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Repository root (the directory that holds package.json). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonText(value));
}

/** Run git read-only in `dir`; returns stdout as a Buffer. */
export function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/** Exact blob bytes of `file` at `rev` (no checkout, no smudge filters). */
export const gitBlob = (dir, rev, file) => git(dir, ['cat-file', 'blob', `${rev}:${file}`]);

export const gitCommit = (dir, rev) => git(dir, ['rev-parse', '--verify', `${rev}^{commit}`]).toString().trim();

export const gitCommitDate = (dir, rev) => git(dir, ['log', '-1', '--format=%cI', rev]).toString().trim();

/** Parses `--name value` / `--flag` style arguments. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

/** First existing directory among candidates (absolute, or relative to the repo root). */
export function firstDir(candidates, root = REPO_ROOT) {
  for (const c of candidates.filter(Boolean)) {
    const p = path.resolve(root, c);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

/** Forward-slash path of `file` relative to `root`. */
export const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
