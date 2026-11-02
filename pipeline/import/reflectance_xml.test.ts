/**
 * pipeline/import/reflectance_xml.py — the XML-only index generator against the committed index,
 * and the XML import on SYNTHETIC ThreeNH files (no real instrument file is available yet: the XML
 * is rebuilt from data/reflectance/raw/phone-samples.json, plus clearly fake extra records). Every
 * write goes to a temporary copy of the database.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog/build_catalog.mjs';
import { runCheck } from '../check.mjs';
import { makeFixture, type Fixture } from '../testing/fixture';
import { ROOT, runPython, writeJsonFile } from '../testing/python';

const SCRIPT = 'pipeline/import/reflectance_xml.py';
const RAW = 'data/reflectance/raw/phone-samples.json';
const INDEX = 'data/reflectance/index.json';
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, RAW), 'utf8'));

interface Sample {
  recordTag: string; recordId: string; expectedName: string; measuredAt: string;
  instrument: Record<string, string>;
  spectra: Record<'SCI' | 'SCE', { rangeNm: number[]; sampleStepNm: number; reflectanceFractions: number[] }>;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const record = (s: Sample) => {
  const attrs = Object.entries(s.instrument).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const spectra = (['SCI', 'SCE'] as const).map((m) => {
    const sp = s.spectra[m];
    return `      <${m} IsReflectance="True"><Reflectances MinWavelength="${sp.rangeNm[0]}" MaxWavelength="${sp.rangeNm[1]}" WavelengthStep="${sp.sampleStepNm}">${sp.reflectanceFractions.map(String).join(';')}</Reflectances></${m}>`;
  }).join('\n');
  return `    <${s.recordTag} ID="${s.recordId}" Name="${esc(s.expectedName)}" DateTime="${s.measuredAt}" IsTransmission="False" ${attrs}>\n${spectra}\n    </${s.recordTag}>`;
};
/** A ThreeNH job holding `samples` (and anything in `extra`). */
const xmlOf = (samples: Sample[], extra: Sample[] = []) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<ThreeNHJob Version="0.3">\n  <Standards>\n${[...samples, ...extra].map(record).join('\n')}\n  </Standards>\n</ThreeNHJob>\n`;
const fake = (id: string, name: string, scale = 1): Sample => ({
  ...raw.samples[0],
  recordId: id,
  expectedName: name,
  measuredAt: '2026-11-01 08:00:00Z',
  spectra: {
    SCI: { ...raw.samples[0].spectra.SCI, reflectanceFractions: raw.samples[0].spectra.SCI.reflectanceFractions.map((v: number) => v * scale) },
    SCE: { ...raw.samples[0].spectra.SCE, reflectanceFractions: raw.samples[0].spectra.SCE.reflectanceFractions.map((v: number) => v * scale) },
  },
});
const IPAD = fake('950', 'iPad Pro 11 M4（合成，不在白名单）');

let fx: Fixture | null = null;
afterEach(() => { fx?.cleanup(); fx = null; });

function importXml(xml: string, options: unknown = {}) {
  fx ??= makeFixture();
  fs.writeFileSync(fx.path('反射率.xml'), xml);
  writeJsonFile(fx.path('opts.json'), options);
  return runPython(SCRIPT, ['import', '--root', fx.root, '--xml', fx.path('反射率.xml'), '--options', fx.path('opts.json'), '--source-name', '反射率.xml', '--audit', fx.path('audit.json')]);
}
const nonProvenance = (root: string) => runCheck({ root }).errors.filter((e: string) => !e.startsWith('[来源与哈希'));

describe('reflectance_xml.py index (XML-only generator)', () => {
  it('regenerating from raw/phone-samples.json over the current index changes nothing (byte-identical)', () => {
    fx = makeFixture();
    const r = runPython(SCRIPT, ['index', '--root', fx.root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.changedFiles).toEqual([]);
    expect(fs.readFileSync(fx.path(INDEX)).equals(fs.readFileSync(path.join(ROOT, INDEX)))).toBe(true);
  });

  it('regression: built from the raw readings alone, only PNG/digitisation fields differ from the committed index', () => {
    const r = runPython(SCRIPT, ['index', '--pure', '--compare', path.join(ROOT, INDEX), '--root', ROOT]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.differences.other).toEqual([]);
    const fields = new Set(r.result.differences.pngRelated.map((p: string) => p.split('.').pop()));
    expect([...fields].sort()).toEqual(['corroboratingPngSourceId', 'corroboration', 'legendLabelPercent', 'reflectanceRangePercent', 'sourceManifest', 'sourcePlotBounds']);
    // 40 curves carried a PNG legend value (20 conditions); the 24 others never had PNG evidence
    expect(r.result.differences.pngRelated.filter((p: string) => p.endsWith('.legendLabelPercent'))).toHaveLength(40);
  });
});

describe('reflectance_xml.py import (synthetic ThreeNH XML)', () => {
  it('re-reads the 32 approved samples identically and ignores records outside the whitelist', () => {
    const r = importXml(xmlOf(raw.samples, [IPAD]));
    expect(r.status, r.stderr).toBe(0);
    const out = fx!.readJson(RAW);
    expect(out.samples).toEqual(raw.samples);
    expect(out.samples.some((s: Sample) => s.recordId === '950')).toBe(false);
    // the synthetic file is a different file: its hash is recorded everywhere the old one was
    expect(out.sourceSha256).not.toBe(raw.sourceSha256);
    expect(fx!.readJson(INDEX).rawSourceSha256).toBe(out.sourceSha256);
    expect(fx!.readJson('data/reflectance/source-manifest.json').rawSource).toMatchObject({ sourceSha256: out.sourceSha256, sampleCount: 32, phoneCount: 24 });
    expect(r.result.changelog.join('\n')).toContain('已核准的 32 个样品读数逐点不变');
    fx!.writeJson('data/devices.json', buildCatalog(fx!.root));
    expect(nonProvenance(fx!.root)).toEqual([]);
    const v = runPython(SCRIPT, ['verify', '--root', fx!.root, '--xml', fx!.path('反射率.xml')]);
    expect(v.status, v.stderr).toBe(0);
    expect(v.result.points).toBe(32 * 2 * 31);
    // idempotent
    const again = importXml(xmlOf(raw.samples, [IPAD]));
    expect(again.result.changedFiles).toEqual([]);
  });

  it('adds a newly approved sample; the catalog then lists it', () => {
    const duo = fake('900', 'iPhone Duo 内屏（合成）', 0.9);
    const r = importXml(xmlOf(raw.samples, [duo, IPAD]), {
      add: [{ recordTag: 'Standard', recordId: '900', expectedName: 'iPhone Duo 内屏（合成）', phoneId: 'iphone-duo', conditionId: 'inner-display', conditionLabel: '内屏' }],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.audit.added).toEqual([{ recordId: '900', expectedName: 'iPhone Duo 内屏（合成）', phoneId: 'iphone-duo', conditionId: 'inner-display', measuredAt: '2026-11-01 08:00:00Z' }]);
    const sample = fx!.readJson(RAW).samples.at(-1);
    expect(sample.phoneName).toBe('iPhone Duo'); // defaulted from the catalog name
    const phone = fx!.readJson(INDEX).phones.at(-1);
    expect(phone.id).toBe('iphone-duo');
    expect(phone.conditions[0].curves.total.samples[0]).toEqual([400, duo.spectra.SCI.reflectanceFractions[0] * 100]);
    fx!.writeJson('data/devices.json', buildCatalog(fx!.root));
    const dev = fx!.readJson('data/devices.json').devices.find((d: { id: string }) => d.id === 'iphone-duo');
    expect(dev.availability.reflectance.status).toBe('complete');
    expect(dev.reflectance[0]).toMatchObject({ condition: 'inner-display', display: 'inner', state: 'inner', rawSampleId: '900' });
    expect(nonProvenance(fx!.root)).toEqual([]);
  });

  it('refuses entity declarations, changed approved samples and bad whitelist entries', () => {
    expect(importXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><ThreeNHJob/>`).stderr).toMatch(/DOCTYPE \/ ENTITY/);

    const renamed = raw.samples.map((s: Sample, i: number) => (i === 3 ? { ...s, expectedName: '一加 13' } : s));
    expect(importXml(xmlOf(renamed)).stderr).toMatch(/ID=21（一加 13 Pro）: XML 里的名称是「一加 13」/);

    const edited = JSON.parse(JSON.stringify(raw.samples));
    edited[5].spectra.SCE.reflectanceFractions[7] += 1e-6;
    const r = importXml(xmlOf(edited));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/已核准样品的内容变了，不覆盖原始读数：23（iQOO 13）：spectra/);
    expect(fs.readFileSync(fx!.path(RAW)).equals(fs.readFileSync(path.join(ROOT, RAW)))).toBe(true);

    const xml = xmlOf(raw.samples, [fake('900', 'X')]);
    const add = (o: Record<string, string>) => importXml(xml, { add: [{ recordTag: 'Standard', recordId: '900', expectedName: 'X', phoneId: 'iphone-duo', conditionId: 'inner-display', conditionLabel: '内屏', ...o }] }).stderr;
    expect(add({ phoneId: 'nokia-1' })).toMatch(/nokia-1 不在 data\/catalog-overrides\.json 中/);
    expect(add({ conditionId: 'glossy' })).toMatch(/条件「glossy」不在 catalog-overrides\.json 的 reflectanceConditions 中/);
    expect(add({ recordId: '3', expectedName: 'iPhone 15 Pro Max' })).toMatch(/样品 3 已在白名单里/);
    expect(add({ phoneId: 'xiaomi-15', conditionId: 'as-measured' })).toMatch(/xiaomi-15 已有条件 as-measured/);
    expect(add({ expectedName: 'Y' })).toMatch(/ID=900（Y）: XML 里的名称是「X」/);
  });

  it('refuses a wavelength grid the database does not hold', () => {
    const odd = JSON.parse(JSON.stringify(raw.samples));
    odd[0].spectra.SCI = { rangeNm: [360, 740], sampleStepNm: 10, reflectanceFractions: Array(39).fill(0.04) };
    expect(importXml(xmlOf(odd)).stderr).toMatch(/SCI 波长 360–740 nm \/ 10 nm；数据库目前只收 400–700 nm \/ 10 nm/);
  });
});
