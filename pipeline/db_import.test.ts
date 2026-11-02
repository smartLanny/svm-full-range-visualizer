/**
 * db:import end to end on temporary copies of the database: a batch with all four input types,
 * dry run, idempotence, the hash chain in db:check, and refusals that leave the copy untouched.
 *
 * Uniformity / reflectance numbers here are SYNTHETIC test values that only exist in the temporary
 * fixture; the SVM input is the committed iPhone Duo source CSV (test-fixtures/).
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog/build_catalog.mjs';
import { runCheck } from './check.mjs';
import { validateBatch, pathProblems, nextDataVersion } from './lib/batch.mjs';
import { makeFixture, type Fixture } from './testing/fixture';
import { ROOT } from './testing/python';

const CLI = path.join(ROOT, 'pipeline/db_import.mjs');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline/examples/duo-revision91.batch.json'), 'utf8'));
const rawSamples = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reflectance/raw/phone-samples.json'), 'utf8')).samples;
const DUO = ['iPhoneDuo_inner_120hz.json', 'iPhoneDuo_inner_smooth_120hz.json', 'iPhoneDuo_outer_120hz.json', 'iPhoneDuo_outer_smooth_120hz.json'];
const ID = '2026-11-05-test-batch';

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, NAS_ROOT: '', ...env }, maxBuffer: 64 * 1024 * 1024 });
  let summary: any = null;
  try { summary = JSON.parse(r.stdout.trim().split('\n').pop() ?? ''); } catch { /* none */ }
  return { status: r.status, summary, stderr: r.stderr };
}

/** sha256 of every file under data/ and public/datasets of `root`. */
function tree(root: string) {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const n of fs.readdirSync(path.join(root, rel))) {
      const r = `${rel}/${n}`;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r);
      else out[r] = sha(fs.readFileSync(path.join(root, r)));
    }
  };
  walk('data');
  walk('public/datasets');
  return out;
}

let fx: Fixture | null = null;
afterEach(() => { fx?.cleanup(); fx = null; });

/** A database copy without the four iPhone Duo SVM records (so the batch can add them back). */
function fixtureWithoutDuo() {
  fx = makeFixture();
  for (const f of DUO) fs.rmSync(fx.path(`public/datasets/${f}`));
  const manifest = fx.readJson('public/datasets/manifest.json').filter((m: { file: string }) => !DUO.includes(m.file));
  fs.writeFileSync(fx.path('public/datasets/manifest.json'), `[\n${manifest.map((e: object) => `  ${JSON.stringify(e).replace(/","/g, '", "').replace(/":"/g, '": "')}`).join(',\n')}\n]\n`);
  const catalog = buildCatalog(fx.root);
  fx.writeJson('data/devices.json', catalog);
  fx.edit('data/version.json', (v) => { v.counts = catalog.counts; });
  expect(runCheck({ root: fx.root }).errors).toEqual([]);
  return fx;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
function syntheticXml(extra: { id: string; name: string; scale: number }[]) {
  const rec = (s: any) => `<Standard ID="${s.recordId}" Name="${esc(s.expectedName)}" DateTime="${s.measuredAt}" IsTransmission="False" ${Object.entries(s.instrument).map(([k, v]) => `${k}="${v}"`).join(' ')}>${(['SCI', 'SCE'] as const).map((m) => `<${m} IsReflectance="True"><Reflectances MinWavelength="400" MaxWavelength="700" WavelengthStep="10">${s.spectra[m].reflectanceFractions.join(';')}</Reflectances></${m}>`).join('')}</Standard>`;
  const fakes = extra.map((e) => ({ ...rawSamples[0], recordId: e.id, expectedName: e.name, measuredAt: '2026-11-01 08:00:00Z', spectra: Object.fromEntries((['SCI', 'SCE'] as const).map((m) => [m, { ...rawSamples[0].spectra[m], reflectanceFractions: rawSamples[0].spectra[m].reflectanceFractions.map((v: number) => v * e.scale) }])) }));
  return `<?xml version="1.0" encoding="utf-8"?>\n<ThreeNHJob Version="0.3"><Standards>${[...rawSamples, ...fakes].map(rec).join('\n')}</Standards></ThreeNHJob>\n`;
}

/** Writes the inbox files and a batch with all four input types into the fixture; returns the batch path. */
function fullBatch(f: Fixture, edit: (b: any) => void = () => {}) {
  const inbox = (rel: string, content: Buffer | string) => {
    const p = f.path(`inbox/${ID}/files/${rel}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    const buf = fs.readFileSync(p);
    return { path: rel, sha256: sha(buf), bytes: buf.length };
  };
  const csv = fs.readFileSync(path.join(ROOT, 'test-fixtures/iphone_duo_inner_revision91.csv'));
  const metrics = JSON.stringify([
    { id: 'ip17pm', level: '300', kind: 'lum', cond: '', typ: 301.2, u9: 91.2, ua: 87.6, dev10: 0.1 },
    { id: 'ip17pm', level: '100', kind: 'lum', cond: '', typ: 0.3512, u9: 93.1, ua: 89.2, dev10: 0 },
  ]);
  const batch = {
    schemaVersion: 1,
    id: ID,
    date: '2026-11-05',
    title: '测试批次（合成数据）',
    notes: '只在临时目录里存在。',
    inputs: [
      { ...inbox('飞书导出/iPhone Duo 内屏.csv', csv), type: 'svm-feishu-csv', devices: ['iphone-duo'], options: example.inputs[0].options },
      { ...inbox('视频项目/data/uniformity_metrics.json', metrics), type: 'uniformity-metrics', devices: ['iphone-17-pro-max'], options: { devices: ['iphone-17-pro-max'] } },
      { type: 'uniformity-white', devices: ['xiaomi-17-ultra'], notes: '合成白场读数', options: { white: { 'xiaomi-17-ultra': { '100': { nits: 101.5, note: '合成测试值' } } } } },
      {
        ...inbox('反射率.xml', syntheticXml([{ id: '900', name: 'iPhone Duo 内屏（合成）', scale: 0.9 }])), type: 'reflectance-xml', devices: ['iphone-duo'],
        options: { add: [{ recordTag: 'Standard', recordId: '900', expectedName: 'iPhone Duo 内屏（合成）', phoneId: 'iphone-duo', conditionId: 'inner-display', conditionLabel: '内屏' }] },
      },
    ],
    expect: { svmRecords: 2, uniformityConditions: 2, reflectanceSamples: 1 },
  };
  edit(batch);
  const p = f.path(`inbox/${ID}/batch.json`);
  fs.writeFileSync(p, `${JSON.stringify(batch, null, 2)}\n`);
  return p;
}

describe('db:import', () => {
  it('the example batch (iPhone Duo, already in the repository) dry-runs to "no change" on the real data', () => {
    const before = tree(ROOT);
    const r = cli([path.join(ROOT, 'pipeline/examples/duo-revision91.batch.json'), '--nas-root', path.join(ROOT, 'test-fixtures'), '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary).toMatchObject({ status: 'unchanged', changes: [] });
    expect(r.stderr).toContain('无变化');
    expect(tree(ROOT)).toEqual(before);
  });

  it('dry run: prints every change, the changelog entry and the version, and writes nothing', () => {
    const f = fixtureWithoutDuo();
    const before = tree(f.root);
    const r = cli([fullBatch(f), '--root', f.root, '--dry-run', '--today', '2026-11-05']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary.status).toBe('dry-run');
    expect(r.summary.dataVersion).toBe('2026.11.05');
    expect(r.summary.changes.map((c: { path: string }) => c.path)).toEqual(expect.arrayContaining([
      'data/CHANGELOG.md', `data/batches/${ID}/audit.json`, `data/batches/${ID}/batch.json`, 'data/devices.json',
      'data/reflectance/index.json', 'data/reflectance/raw/phone-samples.json', 'data/reflectance/source-manifest.json',
      'data/uniformity/index.json', 'data/version.json', 'public/datasets/iPhoneDuo_inner_120hz.json', 'public/datasets/manifest.json',
    ]));
    expect(r.summary.requiresStandaloneRebuild).toBe(true);
    expect(r.stderr).toContain('npm run build:standalone');
    expect(r.stderr).toContain('--dry-run：仓库没有改动');
    expect(tree(f.root)).toEqual(before);
  });

  it('imports a batch with all four input types; db:check then passes and the hash chain is recorded', () => {
    const f = fixtureWithoutDuo();
    const r = cli([fullBatch(f), '--root', f.root, '--today', '2026-11-05']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary).toMatchObject({ status: 'imported', dataVersion: '2026.11.05', requiresStandaloneRebuild: true, release: 'not-applicable', finalCheck: { ok: true, errors: [] } });

    // SVM records are byte-identical to the committed ones
    for (const file of DUO.slice(0, 2)) expect(fs.readFileSync(f.path(`public/datasets/${file}`)).equals(fs.readFileSync(path.join(ROOT, 'public/datasets', file)))).toBe(true);
    const version = f.readJson('data/version.json');
    expect(version).toMatchObject({ dataVersion: '2026.11.05', date: '2026-11-05', batch: ID, batches: [ID] });
    expect(version.counts).toEqual(f.readJson('data/devices.json').counts);
    const changelog = fs.readFileSync(f.path('data/CHANGELOG.md'), 'utf8');
    expect(changelog.indexOf(`## 2026.11.05 · \`${ID}\``)).toBeLessThan(changelog.indexOf('## 2026.11.02 · 基线'));
    expect(changelog).toContain('频闪：新增 iPhone Duo 内屏 · 普通 120Hz（iPhoneDuo_inner_120hz.json，432 个实测格、0 个空格）');
    expect(changelog).toContain('均匀度：iPhone 17 Pro Max 新增仅指标数据（300 nits、100 nits，无热力图；源 id ip17pm）');
    expect(changelog).toContain('均匀度：小米 17 Ultra 徕卡 100 nits 档记录实测白场 101.5 nits');
    expect(changelog).toContain('反射率：新增 iPhone Duo · 内屏（XML 样品 900');
    expect(changelog).toMatch(/数量：频闪记录 17 → 19；均匀度档位 9 → 11；反射率样品 32 → 33/);

    const audit = f.readJson(`data/batches/${ID}/audit.json`);
    expect(audit.inputs.map((i: { foundIn: string }) => i.foundIn)).toEqual(['inbox', 'inbox', 'batch', 'inbox']);
    expect(JSON.stringify(audit)).not.toContain(f.root);
    const unifFile = audit.files.find((x: { path: string }) => x.path === 'data/uniformity/index.json');
    expect(unifFile.sha256Before).toBe(sha(fs.readFileSync(path.join(ROOT, 'data/uniformity/index.json'))));
    expect(unifFile.sha256After).toBe(sha(fs.readFileSync(f.path('data/uniformity/index.json'))));
    expect(fs.readFileSync(f.path(`data/batches/${ID}/sources/1-iPhone Duo 内屏.csv`)).equals(fs.readFileSync(path.join(ROOT, 'test-fixtures/iphone_duo_inner_revision91.csv')))).toBe(true);
    expect(fs.readFileSync(f.path(`data/batches/${ID}/batch.json`)).equals(fs.readFileSync(f.path(`inbox/${ID}/batch.json`)))).toBe(true);

    const catalog = f.readJson('data/devices.json');
    const dev = (id: string) => catalog.devices.find((d: { id: string }) => d.id === id);
    expect(dev('iphone-17-pro-max').availability.uniformity.status).toBe('metrics-only');
    expect(dev('iphone-duo').availability.reflectance.status).toBe('complete');
    const check = runCheck({ root: f.root });
    expect(check.errors).toEqual([]);
    expect(check.sections.find((s: { title: string }) => s.title.startsWith('来源与哈希'))!.info[0]).toMatch(/批次导入的 \d+ 个文件哈希一致/);

    // importing the same batch again changes nothing
    const before = tree(f.root);
    const again = cli([f.path(`data/batches/${ID}/batch.json`), '--root', f.root, '--inbox', f.path(`inbox/${ID}/files`), '--today', '2026-11-06']);
    expect(again.status, again.stderr).toBe(0);
    expect(again.summary).toMatchObject({ status: 'unchanged', alreadyImported: true });
    expect(tree(f.root)).toEqual(before);

    // a later hand edit of imported data breaks the chain
    f.edit('data/uniformity/index.json', (j) => { j.metricsOnly[0].conditions[0].metrics.luminance.typical = 300; });
    expect(runCheck({ root: f.root }).errors).toEqual(expect.arrayContaining([expect.stringMatching(/data\/uniformity\/index\.json 与批次 2026-11-05-test-batch 导入后记录的 sha256 不一致/)]));
  });

  it('a second batch on the same day gets version .2 and chains on the first', () => {
    const f = fixtureWithoutDuo();
    expect(cli([fullBatch(f), '--root', f.root, '--today', '2026-11-05']).status).toBe(0);
    const p = f.path('inbox/2026-11-05-white-only/batch.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      schemaVersion: 1, id: '2026-11-05-white-only', date: '2026-11-05', title: '白场补测（合成）',
      inputs: [{ type: 'uniformity-white', devices: ['xiaomi-18-pro-max'], notes: '合成', options: { white: { 'xiaomi-18-pro-max': { '10': { nits: 10.1, note: '合成测试值' } } } } }],
    }));
    const r = cli([p, '--root', f.root, '--today', '2026-11-05']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary.dataVersion).toBe('2026.11.05.2');
    expect(f.readJson('data/version.json').batches).toEqual([ID, '2026-11-05-white-only']);
    expect(runCheck({ root: f.root }).errors).toEqual([]);
  });

  it('refuses a batch whose input file changed after it was registered, and changes nothing', () => {
    const f = fixtureWithoutDuo();
    const p = fullBatch(f);
    fs.appendFileSync(f.path(`inbox/${ID}/files/视频项目/data/uniformity_metrics.json`), ' ');
    const before = tree(f.root);
    const r = cli([p, '--root', f.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/视频项目\/data\/uniformity_metrics\.json」（来自 inbox）的大小或 sha256 与批次记录不符/);
    expect(tree(f.root)).toEqual(before);
  });

  it('a failing importer leaves the repository untouched (no partial batch)', () => {
    const f = fixtureWithoutDuo();
    const p = fullBatch(f, (b) => { b.inputs[3].options.add[0].expectedName = '名字不对'; });
    const before = tree(f.root);
    const r = cli([p, '--root', f.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/reflectance_xml\.py 失败/);
    expect(r.stderr).toMatch(/XML 里的名称是「iPhone Duo 内屏（合成）」/);
    expect(tree(f.root)).toEqual(before);
  });

  it('refuses declared counts that do not match what happened', () => {
    const f = fixtureWithoutDuo();
    const r = cli([fullBatch(f, (b) => { b.expect.svmRecords = 4; }), '--root', f.root]);
    expect(r.status).toBe(1);
    expect(r.summary.details).toEqual(['expect.svmRecords = 4，实际 2']);
  });

  it('--record: a version and changelog entry for a change made outside a batch', () => {
    fx = makeFixture();
    const r = cli(['--record', '可视角同步到独立项目新提交（测试）', '--root', fx.root, '--today', '2026-11-07']);
    expect(r.status, r.stderr).toBe(0);
    expect(fx.readJson('data/version.json')).toMatchObject({ dataVersion: '2026.11.07', batch: null, batches: [] });
    expect(fs.readFileSync(fx.path('data/CHANGELOG.md'), 'utf8')).toContain('## 2026.11.07 · 记录\n\n可视角同步到独立项目新提交（测试）');
    expect(runCheck({ root: fx.root }).errors).toEqual([]);
  });
});

describe('batch validation', () => {
  const ids = new Set(['iphone-duo', 'iphone-17-pro-max']);
  const base = () => JSON.parse(JSON.stringify(example));

  it('the example batch is valid', () => {
    expect(validateBatch(base(), { deviceIds: new Set(['iphone-duo']) })).toEqual([]);
  });

  it('NAS paths must be relative, without .. or a mount point / home folder', () => {
    expect(pathProblems('手机数据整理/01单机数据/iPhone 17 Pro Max/均匀性/300nits.txt')).toEqual([]);
    expect(pathProblems('/Volumes/dav/某人/反射率.xml')[0]).toMatch(/绝对路径/);
    expect(pathProblems('Volumes/dav/反射率.xml')[0]).toMatch(/像是挂载点或用户目录/);
    expect(pathProblems('Users/someone/x.csv')[0]).toMatch(/像是挂载点或用户目录/);
    expect(pathProblems('a/../b.csv')[0]).toMatch(/\.\./);
    expect(pathProblems('C:\\data\\x.csv').join()).toMatch(/绝对路径/);
    expect(pathProblems('~/x.csv')[0]).toMatch(/绝对路径/);
    expect(pathProblems('张三的文件/x.csv', ['张三'])[0]).toMatch(/私人字样/);
  });

  it('absolute paths or private words anywhere in the batch, unknown devices and mismatched device lists are reported', () => {
    const b = base();
    b.notes = '原文件在 /Volumes/dav/某人/飞书 下';
    b.inputs[0].devices = ['iphone-duo', 'iphone-17-pro-max'];
    b.inputs[1].devices = ['nokia-1'];
    b.expect = { svmRecords: '+4' };
    const p = validateBatch(b, { deviceIds: ids, words: ['revision 91'] });
    expect(p).toEqual(expect.arrayContaining([
      '$.notes 含绝对路径',
      'inputs[0]: 一个飞书表 CSV 只属于一台机型，devices 应只有一个 id',
      'inputs[1]: 机型 nokia-1 不在 data/catalog-overrides.json 中（新机型先加到那里）',
      'expect.svmRecords 应为整数（本批带来的增量）',
      '$.title 含私人字样',
    ]));
  });

  it('id, date, sha256 and manual readings', () => {
    const b = base();
    b.id = '2026-10-25-Duo';
    b.date = '2026-10-26';
    b.inputs[0].sha256 = 'abc';
    b.inputs.push({ type: 'uniformity-white', path: 'x.txt', devices: ['iphone-duo'], options: { white: { 'iphone-duo': {} } } });
    const p = validateBatch(b, { deviceIds: ids });
    expect(p).toEqual(expect.arrayContaining([
      'id「2026-10-25-Duo」应为 YYYY-MM-DD-小写短名（如 2026-11-05-ip17pm-unif）',
      'inputs[0].sha256 应为 64 位小写十六进制',
      'inputs[2]: uniformity-white 是手工读数，不带文件（path / sha256 应省略）',
      'inputs[2]: 手工读数必须在 notes 里写明怎么测的',
    ]));
  });

  it('data versions: one per day, then .2, .3', () => {
    expect(nextDataVersion('2026.11.02', '2026-11-05')).toBe('2026.11.05');
    expect(nextDataVersion('2026.11.05', '2026-11-05')).toBe('2026.11.05.2');
    expect(nextDataVersion('2026.11.05.2', '2026-11-05')).toBe('2026.11.05.3');
  });
});
