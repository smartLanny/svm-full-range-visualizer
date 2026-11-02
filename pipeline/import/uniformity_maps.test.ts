/**
 * pipeline/import/uniformity_maps.py — heatmap packages from pipeline/uniformity/make_maps.py.
 * Every package here is SYNTHETIC (tiny solid-colour PNGs, made-up numbers for iPhone 16 Pro Max);
 * it only exists inside the temporary fixture.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog/build_catalog.mjs';
import { runCheck } from '../check.mjs';
import { makeFixture, type Fixture } from '../testing/fixture';
import { runPython, writeJsonFile } from '../testing/python';

const SCRIPT = 'pipeline/import/uniformity_maps.py';
const INDEX = 'data/uniformity/index.json';

type MapSpec = { sid: string; level: string; kind: 'lum' | 'cct'; metrics: Record<string, number> };

/** Writes a package zip (manifest + portrait RGBA PNGs of size w×h) with python's standard library. */
function makePackage(file: string, maps: MapSpec[], { stops, w = 4, h = 9, tamper = false }: { stops: unknown; w?: number; h?: number; tamper?: boolean }) {
  const code = `
import hashlib, json, struct, sys, zipfile, zlib
out, spec = sys.argv[1], json.loads(sys.argv[2])
def png(w, h):
    raw = b"".join(b"\\x00" + b"\\x10\\x80\\xf0\\xff" * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
maps, files = {}, {}
for m in spec["maps"]:
    key = f"{m['level']}_{m['kind']}_{m['sid']}"
    data = png(spec["w"], spec["h"])
    files[f"maps/{key}.png"] = data + (b"x" if spec["tamper"] else b"")
    scale = {"minPercentOfTypical": 60.0, "maxPercentOfTypical": 115.0} if m["kind"] == "lum" else {"minOffsetFromTypicalK": -1090.0, "maxOffsetFromTypicalK": 510.0}
    maps[key] = {"sourceId": m["sid"], "name": "合成", "level": m["level"], "kind": m["kind"], "metrics": m["metrics"], "scale": scale,
                 "asset": f"maps/{key}.png", "sourceSha256": "0" * 64, "assetSha256": hashlib.sha256(data).hexdigest(),
                 "sourceResolution": [spec["h"], spec["w"]], "displayResolution": [spec["w"], spec["h"]], "sourceMaskBounds": [0, 0, spec["h"], spec["w"]],
                 "sourceMaskCoverage": 1.0, "measurementSource": f"合成/{key}.txt", "measurementSourceSha256": "1" * 64, "measurementResolution": [2448, 1632]}
with zipfile.ZipFile(out, "w") as z:
    z.writestr("manifest.json", json.dumps({"schemaVersion": 1, "tool": "test", "colorStops": spec["stops"], "maps": maps}, ensure_ascii=False))
    for name, data in files.items(): z.writestr(name, data)
`;
  const r = spawnSync('python3', ['-I', '-c', code, file, JSON.stringify({ maps, stops, w, h, tamper })], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

const SYNTH: MapSpec[] = [
  { sid: 'ip16pm', level: '300', kind: 'lum', metrics: { typ: 301.2345678, u9: 91.23456, ua: 87.65432, dev10: 0.12345 } },
  { sid: 'ip16pm', level: '300', kind: 'cct', metrics: { typ: 6612.34567, d9: 120.1234, da: 250.9876 } },
  { sid: 'ip16pm', level: '100', kind: 'lum', metrics: { typ: 0.3512, u9: 93.1, ua: 89.2, dev10: 0 } },
];

/** Package entries equal to a metrics-only device's stored numbers. */
function fromMetricsOnly(entry: any, sid: string): MapSpec[] {
  return entry.conditions.flatMap((c: any) => {
    const l = c.metrics.luminance, t = c.metrics.colorTemperature;
    return [
      { sid, level: c.id, kind: 'lum', metrics: { typ: l.typical, u9: l.ninePointUniformityPct, ua: l.areaUniformityPct, dev10: l.deviation10PctArea } },
      ...(t ? [{ sid, level: c.id, kind: 'cct', metrics: { typ: t.typical, d9: t.ninePointSpreadK, da: t.areaSpreadK } }] : []),
    ];
  });
}

let fx: Fixture | null = null;

/** Turns a heatmap device of the fixture back into a metrics-only one (maps removed), as before its maps were imported. */
function demote(id: string, sid: string) {
  fx!.edit(INDEX, (i) => {
    const p = i.phones.find((x: { id: string }) => x.id === id);
    i.phones = i.phones.filter((x: { id: string }) => x !== p);
    for (const c of p.conditions) for (const m of Object.values(c.maps) as { asset: string }[]) fs.rmSync(fx!.path(`data/uniformity/${m.asset}`));
    i.metricsOnly.push({ id, name: p.name, metricSourceId: sid, ...(p.display ? { display: p.display } : {}),
      conditions: p.conditions.map(({ maps, ...c }: { maps: unknown }) => c) });
  });
  return fx!.readJson(INDEX).metricsOnly.find((m: { id: string }) => m.id === id);
}
afterEach(() => { fx?.cleanup(); fx = null; });

function run(maps: MapSpec[], options: unknown, pkg: { stops?: unknown; w?: number; h?: number; tamper?: boolean } = {}) {
  if (!fx) fx = makeFixture();
  makePackage(fx.path('pkg.zip'), maps, { stops: pkg.stops ?? fx.readJson(INDEX).colorStops, ...pkg });
  writeJsonFile(fx.path('opts.json'), options);
  return runPython(SCRIPT, ['--root', fx.root, '--package', fx.path('pkg.zip'), '--options', fx.path('opts.json'), '--batch', '2026-11-05-test', '--source-name', 'uniformity_maps.zip']);
}

const index = () => fx!.readJson(INDEX);
const IP16 = { devices: { 'iphone-16-pro-max': { sourceId: 'ip16pm' } } };

describe('uniformity_maps.py', () => {
  it('adds a device with heatmaps; the catalog shows it as complete, a rerun changes nothing', () => {
    const r = run(SYNTH, IP16);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result.changedFiles).toEqual(['data/uniformity/maps/100_lum_ip16pm.png', 'data/uniformity/maps/300_cct_ip16pm.png', 'data/uniformity/maps/300_lum_ip16pm.png', INDEX]);
    const phone = index().phones.find((p: { id: string }) => p.id === 'iphone-16-pro-max');
    expect(phone.heatmapStatus).toBe('has-maps');
    expect(phone.mapsSource).toMatchObject({ file: 'uniformity_maps.zip', batch: '2026-11-05-test' });
    expect(phone.conditions.map((c: { id: string }) => c.id)).toEqual(['300', '100']);
    expect(phone.conditions[0].metrics.luminance).toEqual({ typical: 301.234568, unit: 'nit', ninePointUniformityPct: 91.2346, areaUniformityPct: 87.6543, deviation10PctArea: 0.1235 });
    expect(phone.conditions[0].maps.luminance).toMatchObject({ asset: 'maps/300_lum_ip16pm.png', sourceKey: '300_lum_ip16pm', displayResolution: [4, 9], measurementResolution: [2448, 1632] });
    expect(r.result.changelog[0]).toContain('iPhone 16 Pro Max 新增热力图 3 张');

    const before = fs.readFileSync(fx!.path(INDEX));
    const again = run(SYNTH, IP16);
    expect(again.result.changedFiles).toEqual([]);
    expect(fs.readFileSync(fx!.path(INDEX)).equals(before)).toBe(true);

    fx!.writeJson('data/devices.json', buildCatalog(fx!.root));
    const d = fx!.readJson('data/devices.json').devices.find((x: { id: string }) => x.id === 'iphone-16-pro-max');
    expect(d.availability.uniformity.status).toBe('complete');
    expect(d.uniformity.map((e: { condition: string; maps: unknown[] }) => [e.condition, e.maps.length])).toEqual([['300', 2], ['100', 1]]);
    const errors = runCheck({ root: fx!.root }).errors;
    expect(errors.filter((e: string) => !e.startsWith('[来源与哈希') && !e.startsWith('[批次与数据版本'))).toEqual([]);
  });

  it('promotes a metrics-only device when the numbers are the stored ones, keeping its display', () => {
    fx = makeFixture();
    const honor = demote('honor-magic-v5', 'mv5');
    expect(honor.display).toBe('outer');
    const r = run(fromMetricsOnly(honor, 'mv5'), { devices: { 'honor-magic-v5': { sourceId: 'mv5' } } });
    expect(r.status, r.stderr).toBe(0);
    expect(index().metricsOnly.some((m: { id: string }) => m.id === 'honor-magic-v5')).toBe(false);
    const phone = index().phones.find((p: { id: string }) => p.id === 'honor-magic-v5');
    expect(phone.display).toBe('outer');
    expect(phone.conditions.map((c: any) => c.metrics)).toEqual(honor.conditions.map((c: any) => c.metrics));
    expect(r.result.audit.devices[0].status).toBe('promoted');
    fx.writeJson('data/devices.json', buildCatalog(fx.root));
    const d = fx.readJson('data/devices.json').devices.find((x: { id: string }) => x.id === 'honor-magic-v5');
    expect(d.uniformity.every((e: { display: string }) => e.display === 'outer')).toBe(true);
  });

  it('refuses heatmaps whose numbers differ from the stored metrics-only numbers', () => {
    fx = makeFixture();
    const ip17 = demote('iphone-17-pro-max', 'ip17pm');
    const maps = fromMetricsOnly(ip17, 'ip17pm');
    maps[0].metrics.ua += 1;
    const r = run(maps, { devices: { 'iphone-17-pro-max': { sourceId: 'ip17pm' } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/热力图包的指标与库里的不同.*areaUniformityPct/);
    expect(index().metricsOnly.some((m: { id: string }) => m.id === 'iphone-17-pro-max')).toBe(true);
  });

  it('refuses a tampered PNG, a landscape PNG, other colour stops and maps for unlisted devices', () => {
    expect(run(SYNTH, IP16, { tamper: true }).stderr).toMatch(/sha256 与 manifest 不符/);
    expect(run(SYNTH, IP16, { w: 9, h: 4 }).stderr).toMatch(/不是竖图/);
    expect(run(SYNTH, IP16, { stops: [[0, [0, 0, 0]]] }).stderr).toMatch(/色条/);
    const extra = [...SYNTH, { sid: 'zz', level: '300', kind: 'lum' as const, metrics: { typ: 300, u9: 90, ua: 90, dev10: 0 } }];
    expect(run(extra, IP16).stderr).toMatch(/没指定机型的图：\['300_lum_zz'\]/);
    expect(fs.existsSync(fx!.path('data/uniformity/maps/300_lum_ip16pm.png'))).toBe(false);
  });
});
