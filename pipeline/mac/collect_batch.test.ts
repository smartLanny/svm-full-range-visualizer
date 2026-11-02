/**
 * pipeline/mac/collect_batch.py on a temporary "NAS": copies with sha256, a draft batch.json that
 * db:import accepts once filled in, and refusals that keep absolute / private paths out.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateBatch } from '../lib/batch.mjs';
import { ROOT, runPython, tempDir } from '../testing/python';

const SCRIPT = 'pipeline/mac/collect_batch.py';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const ID = '2026-11-05-ip17pm-unif';

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

function setup() {
  const t = tempDir('collect-');
  cleanup = t.cleanup;
  const nas = path.join(t.dir, 'nas');
  const put = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(nas, rel)), { recursive: true });
    fs.writeFileSync(path.join(nas, rel), content);
  };
  put('手机数据整理/01单机数据/iPhone 17 Pro Max/均匀性/uniformity_metrics.json', '[]');
  put('手机数据整理/01单机数据/iPhone 17 Pro Max/均匀性/300nits 亮度.txt', 'radiant');
  put('反射率.xml', '<ThreeNHJob/>');
  put('飞书/a.csv', 'a,b\n');
  put('飞书/b.csv', 'c,d\n');
  return { dir: t.dir, nas, inbox: path.join(t.dir, 'inbox') };
}

const run = (s: { nas: string; inbox: string }, args: string[], env: NodeJS.ProcessEnv = {}) =>
  runPython(SCRIPT, ['--nas-root', s.nas, '--inbox-root', s.inbox, '--batch', ID, '--json', ...args], { SCREENDB_PRIVATE_WORDS: '', ...env });

describe('collect_batch.py', () => {
  it('copies matching files with their sha256 and writes a draft batch with relative paths only', () => {
    const s = setup();
    const r = run(s, ['手机数据整理/01单机数据/*/均匀性/*', '反射率.xml', '飞书/*.csv']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.files.map((f: { path: string; type: string }) => [f.path, f.type])).toEqual([
      ['手机数据整理/01单机数据/iPhone 17 Pro Max/均匀性/300nits 亮度.txt', 'radiant-txt'],
      ['手机数据整理/01单机数据/iPhone 17 Pro Max/均匀性/uniformity_metrics.json', 'uniformity-metrics'],
      ['反射率.xml', 'reflectance-xml'],
      ['飞书/a.csv', 'svm-feishu-csv'],
      ['飞书/b.csv', 'svm-feishu-csv'],
    ]);
    expect(r.stdout).toMatch(/5 个文件，共 \d+ B/);
    expect(r.stdout).toContain('Radiant TXT 的降采样还没实现');
    const draft = JSON.parse(fs.readFileSync(path.join(s.inbox, ID, 'batch.json'), 'utf8'));
    expect(draft).toMatchObject({ schemaVersion: 1, id: ID, date: '2026-11-05' });
    for (const input of draft.inputs) {
      const copy = fs.readFileSync(path.join(s.inbox, ID, 'files', input.path));
      expect(input.sha256).toBe(sha(fs.readFileSync(path.join(s.nas, input.path))));
      expect(sha(copy)).toBe(input.sha256);
      expect(input.bytes).toBe(copy.length);
    }
    expect(JSON.stringify(draft)).not.toContain(s.dir);

    // the draft is refused by db:import until it is filled in …
    expect(validateBatch(draft).join('\n')).toMatch(/title|type「radiant-txt」/);
    // … and accepted once it is
    draft.title = 'iPhone 17 Pro Max 均匀度指标';
    draft.inputs = draft.inputs.filter((i: { type: string }) => i.type === 'uniformity-metrics');
    Object.assign(draft.inputs[0], { devices: ['iphone-17-pro-max'], options: { devices: ['iphone-17-pro-max'] } });
    expect(validateBatch(draft, { deviceIds: new Set(['iphone-17-pro-max']) })).toEqual([]);
  });

  it('is idempotent and keeps what was filled in; a changed NAS file updates its hash', () => {
    const s = setup();
    expect(run(s, ['飞书/a.csv']).status).toBe(0);
    const p = path.join(s.inbox, ID, 'batch.json');
    const draft = JSON.parse(fs.readFileSync(p, 'utf8'));
    draft.title = '已填写的标题';
    draft.inputs[0].devices = ['iphone-duo'];
    fs.writeFileSync(p, JSON.stringify(draft));
    const again = run(s, ['飞书/a.csv', '飞书/b.csv']);
    expect(again.result.files.map((f: { status: string }) => f.status)).toEqual(['不变', '新增']);
    const merged = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(merged.title).toBe('已填写的标题');
    expect(merged.inputs[0].devices).toEqual(['iphone-duo']);
    expect(merged.inputs).toHaveLength(2);

    fs.writeFileSync(path.join(s.nas, '飞书/a.csv'), 'changed\n');
    const changed = run(s, ['飞书/a.csv']);
    expect(changed.status).toBe(2);
    expect(changed.stderr).toMatch(/inbox 里已有不同内容的「飞书\/a\.csv」/);
    const forced = run(s, ['飞书/a.csv', '--force']);
    expect(forced.result.files[0].status).toBe('已更新（文件变了）');
  });

  it('refuses absolute paths, .., mount points, links out of NAS_ROOT and private words — writing nothing', () => {
    const s = setup();
    const refused = (args: string[], re: RegExp, env: NodeJS.ProcessEnv = {}) => {
      const r = run(s, args, env);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(re);
      expect(fs.existsSync(path.join(s.inbox, ID))).toBe(false);
    };
    refused([path.join(s.nas, '反射率.xml')], /是绝对路径/);
    refused(['飞书/../反射率.xml'], /含空段、\. 或 \.\./);
    refused(['Volumes/dav/反射率.xml'], /像是挂载点或用户目录/);
    refused(['手机数据整理/**/*.json'], /私人字样/, { SCREENDB_PRIVATE_WORDS: '整理' });
    fs.symlinkSync(path.join(ROOT, 'package.json'), path.join(s.nas, 'escape.json'));
    refused(['escape.json'], /链接到 NAS_ROOT 以外/);
    refused(['不存在/*.csv'], /没有匹配/);
    const bad = runPython(SCRIPT, ['--nas-root', s.nas, '--inbox-root', s.inbox, '--batch', '20261105-x', 'a.csv']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/批次 id「20261105-x」应为 YYYY-MM-DD-小写短名/);
  });
});
