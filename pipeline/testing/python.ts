/**
 * Runs the pipeline's Python importers the way db:import does (python3 -I, standard library only)
 * and parses the one JSON result object they print on stdout.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ROOT = path.resolve(__dirname, '../..');

export interface PyRun<T = any> {
  status: number | null;
  result: T;
  stdout: string;
  stderr: string;
}

export function runPython<T = any>(script: string, args: string[], env: NodeJS.ProcessEnv = {}): PyRun<T> {
  const r = spawnSync('python3', ['-I', path.join(ROOT, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  let result: any = null;
  try { result = JSON.parse(last); } catch { result = null; }
  return { status: r.status, result, stdout: r.stdout, stderr: r.stderr };
}

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const writeJsonFile = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
