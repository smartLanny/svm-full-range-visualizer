#!/usr/bin/env node
/**
 * Generates data/devices.json — one catalog of devices across all data types — from:
 *
 *   public/datasets/manifest.json     flicker (SVM) records (the workbench's source of truth)
 *   data/angle/summary.json           standalone view-angle profiles (pipeline/angle/summarise.mjs)
 *   data/uniformity/index.json        uniformity heatmaps / metrics (migrated from the atlas)
 *   data/reflectance/index.json       reflectance samples (migrated from the atlas)
 *   data/catalog-overrides.json       hand-maintained names, aliases, displays, units, mappings
 *
 *   node pipeline/catalog/build_catalog.mjs           write data/devices.json
 *   node pipeline/catalog/build_catalog.mjs --check   exit 1 if data/devices.json is stale
 *
 * Output is deterministic (no timestamps), so the same inputs always give the same bytes. A
 * source record that does not map to a device in the overrides is an error, not a guess: add the
 * device (or the source-name mapping) to data/catalog-overrides.json first.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { REPO_ROOT, jsonText, parseArgs, readJson, sha256 } from '../lib/util.mjs';
import { AVAILABILITY, DATA_TYPES, DATA_TYPE_LABELS, DISPLAYS, STATES, STATE_BASIS } from './vocabulary.mjs';

export const INPUTS = {
  manifest: 'public/datasets/manifest.json',
  angle: 'data/angle/summary.json',
  uniformity: 'data/uniformity/index.json',
  reflectance: 'data/reflectance/index.json',
  overrides: 'data/catalog-overrides.json',
};
export const OUTPUT = 'data/devices.json';

export class CatalogError extends Error {
  constructor(problems) {
    super(`机型目录生成失败：\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

/** 「外屏」/「防窥膜」/「外屏 · 防窥膜」: the display and state names, without repeating one that equals the other. */
const variantLabel = (e) => [...new Set([DISPLAYS[e.display]?.zh, STATES[e.state]?.zh].filter(Boolean))].join(' · ');

const dateOf = (measuredAt) => (typeof measuredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(measuredAt) ? measuredAt.slice(0, 10) : null);

export function buildCatalog(root = REPO_ROOT) {
  const problems = [];
  const raw = Object.fromEntries(Object.entries(INPUTS).map(([k, f]) => [k, fs.readFileSync(path.join(root, f))]));
  const parse = (k) => JSON.parse(raw[k].toString('utf8'));
  const manifest = parse('manifest');
  const angle = parse('angle');
  const unif = parse('uniformity');
  const refl = parse('reflectance');
  const ov = parse('overrides');

  // ---- devices from the overrides -------------------------------------------------------
  const devices = new Map();
  for (const d of ov.devices) {
    if (devices.has(d.id)) problems.push(`catalog-overrides.json 中机型 id ${d.id} 重复`);
    devices.set(d.id, {
      id: d.id,
      name: { zh: d.name.zh, en: d.name.en },
      brand: d.brand,
      aliases: [...(d.aliases ?? [])],
      displays: [...(d.displays ?? ['main'])],
      units: (d.units ?? []).map((u) => ({ id: u.id, panel: u.panel ?? null, label: u.label ?? null, ...(u.note ? { note: u.note } : {}) })),
      availability: {},
      svm: [],
      angle: [],
      uniformity: [],
      reflectance: [],
    });
  }
  const byName = new Map([...devices.values()].map((d) => [d.name.zh, d]));
  const multi = (d) => d.displays.length > 1;
  const unitOk = (d, unit, where) => {
    if (unit != null && !d.units.some((u) => u.id === unit)) problems.push(`${where}: 机型 ${d.id} 没有样机 ${unit}`);
    return unit ?? null;
  };
  const svmNotes = ov.notes?.svm ?? {};

  // ---- SVM: every manifest record ------------------------------------------------------
  for (const rec of manifest) {
    const map = ov.sourceNames?.svm?.[rec.device];
    const d = map ? devices.get(map.device) : byName.get(rec.device);
    if (!d) { problems.push(`频闪记录 ${rec.file}：manifest 机型名「${rec.device}」对应不到目录里的机型（在 catalog-overrides.json 的 devices 或 sourceNames.svm 中补上）`); continue; }
    const display = map?.display ?? (multi(d) ? null : 'main');
    if (!display) { problems.push(`频闪记录 ${rec.file}：${d.id} 有多块屏幕，需在 sourceNames.svm 里写明「${rec.device}」是哪块屏幕`); continue; }
    d.svm.push({
      record: rec.file,
      manifestDevice: rec.device,
      mode: rec.mode,
      ...(rec.modeEn ? { modeEn: rec.modeEn } : {}),
      display,
      state: display === 'main' ? 'default' : display,
      stateBasis: display === 'main' ? 'convention' : 'source',
      unit: unitOk(d, map?.unit, `频闪记录 ${rec.file}`),
      ...(svmNotes[rec.file] ? { note: svmNotes[rec.file] } : {}),
    });
  }
  for (const f of Object.keys(svmNotes)) if (!manifest.some((r) => r.file === f)) problems.push(`notes.svm 里的 ${f} 不在 manifest.json 中`);

  // ---- angle: every standalone profile ---------------------------------------------------
  for (const p of angle.profiles) {
    const map = ov.sourceNames?.angle?.[p.device];
    const d = map ? devices.get(map.device) : byName.get(p.device);
    if (!d) { problems.push(`可视角 profile ${p.id}：独立项目机型名「${p.device}」对应不到目录里的机型`); continue; }
    let state, display;
    if (p.surface) { state = p.surface; display = p.surface; }
    else if (!p.privacy) { state = 'default'; display = 'main'; }
    else if (p.privacyKind === 'mode') { state = 'privacy'; display = 'main'; }
    else if (p.privacyKind === 'film') { state = 'privacy-film'; display = 'main'; }
    else { problems.push(`可视角 profile ${p.id}：未知的防窥类型 ${p.privacyKind}`); continue; }
    if (!d.displays.includes(display)) { problems.push(`可视角 profile ${p.id}：${d.id} 没有屏幕 ${display}`); continue; }
    d.angle.push({
      profile: p.id,
      standaloneDevice: p.device,
      display,
      state,
      stateBasis: 'source',
      measured: !!p.measured,
      unit: unitOk(d, map?.unit, `可视角 profile ${p.id}`),
      ...(p.measured ? {} : { status: 'not-measured', ...(p.substituteOf ? { substituteOf: p.substituteOf } : {}), note: p.note }),
    });
  }

  // ---- uniformity ------------------------------------------------------------------------
  const unifStatus = new Map();
  for (const phone of unif.phones ?? []) {
    const d = devices.get(phone.id);
    if (!d) { problems.push(`均匀度 ${phone.id} 不在目录中`); continue; }
    for (const c of phone.conditions) {
      d.uniformity.push({
        condition: c.id,
        label: c.label,
        pattern: c.pattern,
        referenceNits: c.referenceNits,
        display: 'main',
        state: 'default',
        stateBasis: 'convention',
        unit: null,
        maps: Object.entries(c.maps ?? {}).map(([kind, m]) => ({ kind, asset: m.asset, sourceKey: m.sourceKey })),
        metrics: Object.keys(c.metrics ?? {}),
      });
    }
    unifStatus.set(d.id, { status: d.uniformity.some((e) => e.maps.length) ? 'complete' : 'metrics-only' });
  }
  for (const m of unif.metricsOnly ?? []) {
    const d = devices.get(m.id);
    if (!d) { problems.push(`均匀度（仅指标）${m.id} 不在目录中`); continue; }
    for (const c of m.conditions ?? []) {
      d.uniformity.push({
        condition: c.id, label: c.label, pattern: c.pattern ?? null, referenceNits: c.referenceNits ?? null,
        display: 'main', state: 'default', stateBasis: 'convention', unit: null, maps: [], metrics: Object.keys(c.metrics ?? {}),
      });
    }
    unifStatus.set(d.id, (m.conditions ?? []).length
      ? { status: 'metrics-only', sourceId: m.metricSourceId }
      : { status: 'pending-import', sourceId: m.metricSourceId, note: `atlas 标为「仅指标」（视频项目中的 id：${m.metricSourceId}），但指标数值没有导出，本库暂无数据。` });
  }
  for (const m of unif.notRecorded ?? []) {
    const d = devices.get(m.id);
    if (!d) { problems.push(`均匀度（未记录）${m.id} 不在目录中`); continue; }
    unifStatus.set(d.id, { status: 'not-measured', note: 'atlas 记为未测量（notRecorded）。' });
  }

  // ---- reflectance -----------------------------------------------------------------------
  const condMap = ov.reflectanceConditions ?? {};
  for (const phone of refl.phones ?? []) {
    const d = devices.get(phone.id);
    if (!d) { problems.push(`反射率 ${phone.id} 不在目录中`); continue; }
    for (const c of phone.conditions) {
      const base = c.id.replace(/-\d{8}$/, '');
      const rule = condMap[base];
      if (!rule) { problems.push(`反射率 ${phone.id} / ${c.id}：未知的条件「${base}」（在 catalog-overrides.json 的 reflectanceConditions 中补上）`); continue; }
      const display = 'display' in rule ? rule.display : (multi(d) ? null : 'main');
      if (display !== null && !d.displays.includes(display)) { problems.push(`反射率 ${phone.id} / ${c.id}：${d.id} 没有屏幕 ${display}`); continue; }
      d.reflectance.push({
        condition: c.id,
        label: c.label,
        display,
        state: rule.state,
        stateBasis: 'source',
        unit: null,
        ...(phone.panel ? { panel: phone.panel } : {}),
        date: dateOf(c.measuredAt),
        measuredAt: c.measuredAt,
        rawSampleId: String(c.rawSampleId),
        sourceName: c.sourceName,
      });
    }
  }

  // ---- availability ------------------------------------------------------------------------
  for (const d of devices.values()) {
    d.availability.svm = { status: d.svm.length ? 'complete' : 'not-measured' };
    const measured = d.angle.filter((e) => e.measured);
    const unmeasured = d.angle.filter((e) => !e.measured);
    d.availability.angle = !measured.length
      ? { status: 'not-measured', ...(unmeasured.length ? { note: unmeasured.map((e) => e.note).join(' ') } : {}) }
      : unmeasured.length
        ? { status: 'partial', note: unmeasured.map((e) => `${variantLabel(e)}未测：${e.note}`).join(' ') }
        : { status: 'complete' };
    d.availability.uniformity = unifStatus.get(d.id) ?? { status: 'not-measured' };
    d.availability.reflectance = { status: d.reflectance.length ? 'complete' : 'not-measured' };
    if (DATA_TYPES.every((t) => d.availability[t].status === 'not-measured')) problems.push(`机型 ${d.id} 在任何数据类型里都没有记录`);
  }

  if (problems.length) throw new CatalogError(problems);

  const list = [...devices.values()];
  return {
    schemaVersion: 1,
    generatedBy: 'pipeline/catalog/build_catalog.mjs',
    note: '由脚本生成，不要手改。改 data/catalog-overrides.json 或源数据后运行 npm run db:catalog，再运行 npm run db:check。',
    inputs: Object.fromEntries(Object.entries(INPUTS).map(([k, f]) => [f, sha256(raw[k])])),
    vocabulary: {
      dataTypes: DATA_TYPE_LABELS,
      states: STATES,
      stateBasis: STATE_BASIS,
      displays: DISPLAYS,
      availability: AVAILABILITY,
    },
    brands: ov.brands,
    counts: {
      devices: list.length,
      svmRecords: list.reduce((n, d) => n + d.svm.length, 0),
      angleProfiles: list.reduce((n, d) => n + d.angle.length, 0),
      angleProfilesMeasured: list.reduce((n, d) => n + d.angle.filter((e) => e.measured).length, 0),
      uniformityConditions: list.reduce((n, d) => n + d.uniformity.length, 0),
      uniformityMaps: list.reduce((n, d) => n + d.uniformity.reduce((m, e) => m + e.maps.length, 0), 0),
      reflectanceSamples: list.reduce((n, d) => n + d.reflectance.length, 0),
      devicesWith: Object.fromEntries(DATA_TYPES.map((t) => [t, list.filter((d) => ['complete', 'partial', 'metrics-only'].includes(d.availability[t].status)).length])),
    },
    devices: list,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root ?? REPO_ROOT);
  let catalog;
  try { catalog = buildCatalog(root); } catch (e) {
    console.error(e instanceof CatalogError ? e.message : e);
    process.exit(1);
  }
  const out = path.join(root, OUTPUT);
  const text = jsonText(catalog);
  if (args.check) {
    if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
      console.error(`${OUTPUT} 已过期：运行 npm run db:catalog 重新生成。`);
      process.exit(1);
    }
    console.log(`${OUTPUT} 是最新的。`);
    return;
  }
  fs.writeFileSync(out, text);
  const c = catalog.counts;
  console.log(`已生成 ${OUTPUT}：${c.devices} 台机型；频闪 ${c.svmRecords} 条记录（${c.devicesWith.svm} 台）、可视角 ${c.angleProfiles} 个 profile（实测 ${c.angleProfilesMeasured}，${c.devicesWith.angle} 台）、均匀度 ${c.uniformityConditions} 档 / ${c.uniformityMaps} 张热力图（${c.devicesWith.uniformity} 台）、反射率 ${c.reflectanceSamples} 个样品（${c.devicesWith.reflectance} 台）。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
