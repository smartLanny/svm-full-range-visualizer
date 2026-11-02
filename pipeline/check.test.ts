/**
 * db:check on the real data, and on deliberately corrupted copies: each corruption must fail
 * with an error that names what is wrong and where.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatReport, runCheck } from './check.mjs';
import { ROOT, makeFixture, type Fixture } from './testing/fixture';

const CLI = path.join(ROOT, 'pipeline/check.mjs');
const runCli = (root: string) => spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });

describe('db:check on the repository data', () => {
  it('passes with no errors', () => {
    const r = runCheck({ root: ROOT });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    // every section ran
    expect(r.sections.map((s: { title: string }) => s.title)).toHaveLength(7);
  });

  it('reports the database size it checked', () => {
    const r = runCheck({ root: ROOT });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/datasets/manifest.json'), 'utf8'));
    expect(r.summary.svmRecords).toBe(manifest.length);
    expect(r.summary.devices).toBeGreaterThanOrEqual(25);
    expect(r.summary.uniformityMaps).toBeGreaterThanOrEqual(15);
    expect(r.summary.reflectanceSamples).toBeGreaterThanOrEqual(32);
    expect(r.summary.standaloneCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(formatReport(r)).toContain('结果：通过');
  });

  it('the npm script exits 0', () => {
    const out = execFileSync(process.execPath, [CLI], { encoding: 'utf8' });
    expect(out).toContain('屏幕数据库校验');
  });
});

describe('db:check on corrupted data', () => {
  let fx: Fixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  const failsWith = (root: string, ...patterns: RegExp[]) => {
    const r = runCheck({ root });
    expect(r.ok).toBe(false);
    for (const p of patterns) expect(r.errors.some((e: string) => p.test(e)), `no error matching ${p}:\n${r.errors.join('\n')}`).toBe(true);
    const cli = runCli(root);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain('结果：失败');
    return r;
  };

  it('an untouched copy passes (the fixture itself is sound)', () => {
    fx = makeFixture();
    expect(runCheck({ root: fx.root }).errors).toEqual([]);
  });

  it('a reflectance curve with a missing point fails clearly', () => {
    fx = makeFixture();
    fx.edit('data/reflectance/index.json', (j) => { j.phones[0].conditions[0].curves.total.samples.pop(); });
    failsWith(fx.root, /\[反射率.*xiaomi-18-pro-max \/ as-measured SCI: 应有 31 个点，实际 30 个/, /provenance\.json 记录的 sha256 不一致/);
  });

  it('a reflectance value that differs from the raw instrument reading fails', () => {
    fx = makeFixture();
    fx.edit('data/reflectance/index.json', (j) => { j.phones[1].conditions[0].curves.diffuse.samples[5][1] += 0.01; });
    failsWith(fx.root, /iphone-18-pro-max \/ as-measured SCE: 450 nm .*原始读数/);
  });

  it('a wavelength off the 400–700 nm / 10 nm grid fails', () => {
    fx = makeFixture();
    fx.edit('data/reflectance/index.json', (j) => { j.phones[2].conditions[0].curves.total.samples[3][0] = 435; });
    failsWith(fx.root, /第 4 个点波长 435 nm，应为 430 nm/);
  });

  it('a heatmap whose bytes no longer match its recorded sha256 fails', () => {
    fx = makeFixture({ copyMaps: true });
    const png = fx.path('data/uniformity/maps/100_lum_mi17u.png');
    const buf = fs.readFileSync(png);
    buf[buf.length - 20] ^= 0xff;
    fs.writeFileSync(png, buf);
    failsWith(fx.root, /热力图 maps\/100_lum_mi17u\.png 的 sha256 与 index\.json 记录不一致/);
  });

  it('a missing heatmap and an unregistered extra file fail', () => {
    fx = makeFixture({ copyMaps: true });
    fs.renameSync(fx.path('data/uniformity/maps/10_lum_ip18pm.png'), fx.path('data/uniformity/maps/extra.png'));
    failsWith(fx.root, /热力图 maps\/10_lum_ip18pm\.png 不存在/, /maps\/extra\.png 没有被 index\.json 引用/, /extra\.png 没有在 provenance\.json 中登记/);
  });

  it('an unknown state, a foreign unit and an alias collision in the catalog fail', () => {
    fx = makeFixture();
    fx.edit('data/devices.json', (j) => {
      const ip18 = j.devices.find((d: { id: string }) => d.id === 'iphone-18-pro-max');
      ip18.svm[0].state = 'bare-screen';
      ip18.angle[0].unit = 'gv3';
      ip18.aliases.push('mi18pm');
    });
    failsWith(fx.root, /svm\[0\]: 未知状态 bare-screen/, /angle\[0\]: 样机 gv3 不在该机型的 units 中/, /「mi18pm」与机型 xiaomi-18-pro-max 冲突/, /data\/devices\.json 不是由当前源数据生成的/);
  });

  it('a panel code used as an alias fails', () => {
    fx = makeFixture();
    fx.edit('data/devices.json', (j) => { j.devices.find((d: { id: string }) => d.id === 'iphone-18-pro-max').aliases.push('GH3'); });
    failsWith(fx.root, /别名「GH3」是面板码/);
  });

  it('a manifest record that no device owns fails, in the catalog and the generator', () => {
    fx = makeFixture();
    fx.edit('public/datasets/manifest.json', (m) => { m.push({ file: 'iPhone18ProMax.json', device: '某新机', mode: '标准' }); });
    // the same file twice is not the point here; use a new name that also does not exist on disk
    fx.edit('public/datasets/manifest.json', (m) => { m[m.length - 1].file = 'new_phone.json'; });
    failsWith(fx.root, /manifest 记录 new_phone\.json（某新机 · 标准）不属于目录里的任何机型/, /manifest 里的 new_phone\.json 不存在/, /生成器：频闪记录 new_phone\.json：manifest 机型名「某新机」对应不到/);
  });

  it('an angle profile missing from the standalone snapshot fails', () => {
    fx = makeFixture();
    fx.edit('data/angle/summary.json', (s) => { s.profiles = s.profiles.filter((p: { id: string }) => p.id !== 'p3'); });
    failsWith(fx.root, /xiaomi-18-pro-max: profile p3 不在独立项目快照中/);
  });

  it('numbers for an unmeasured angle profile fail', () => {
    fx = makeFixture();
    fx.edit('data/angle/summary.json', (s) => {
      const outer = s.profiles.find((p: { id: string }) => p.id === 'duo-outer');
      outer.metrics = s.profiles.find((p: { id: string }) => p.id === 'p0').metrics;
    });
    failsWith(fx.root, /duo-outer 未测，却带有数值/);
  });

  it('an availability status that contradicts the entries fails', () => {
    fx = makeFixture();
    fx.edit('data/devices.json', (j) => { j.devices.find((d: { id: string }) => d.id === 'iphone-duo').availability.angle = { status: 'complete' }; });
    failsWith(fx.root, /iphone-duo availability\.angle = complete，但有未测条目/);
  });
});
