#!/usr/bin/env node
/**
 * db:check — validates the screen database (data/ + public/datasets) without any dependency.
 *
 *   node pipeline/check.mjs [--root <dir>] [--json]
 *
 * Checks the catalog schema (hand-written, see data/README.md), that every reference resolves
 * (SVM records in the manifest, angle profiles in data/angle/summary.json, uniformity heatmaps on
 * disk with their recorded sha256, reflectance curves = 31 points 400–700 nm and equal to the raw
 * instrument readings), units / states / displays, availability statuses, that migrated files
 * still match data/provenance.json, and that data/devices.json is what the generator produces.
 * Prints a readable summary and exits 1 when there is any error.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { REPO_ROOT, jsonText, parseArgs, rel, sha256 } from './lib/util.mjs';
import { compareReflectanceToRaw, curveGridProblems, uniformityAssets } from './lib/sources.mjs';
import { CatalogError, OUTPUT as CATALOG_FILE, buildCatalog } from './catalog/build_catalog.mjs';
import { AVAILABILITY, DATA_TYPES, DISPLAYS, ID_RE, STATES, STATE_BASIS } from './catalog/vocabulary.mjs';
import { DIRECTIONS, THETAS } from './angle/summarise.mjs';

const UNIFORMITY_CONDITIONS = ['300', '100', '10'];
const UNIFORMITY_KINDS = ['luminance', 'colorTemperature'];
const MEASURED = ['complete', 'partial', 'metrics-only'];

const ENTRY_KEYS = {
  svm: { required: ['record', 'manifestDevice', 'mode', 'display', 'state', 'stateBasis', 'unit'], optional: ['modeEn', 'note'] },
  angle: { required: ['profile', 'standaloneDevice', 'display', 'state', 'stateBasis', 'measured', 'unit'], optional: ['status', 'substituteOf', 'note'] },
  uniformity: { required: ['condition', 'label', 'pattern', 'referenceNits', 'display', 'state', 'stateBasis', 'unit', 'maps', 'metrics'], optional: ['whiteMeasuredNits'] },
  reflectance: { required: ['condition', 'label', 'display', 'state', 'stateBasis', 'unit', 'date', 'measuredAt', 'rawSampleId', 'sourceName'], optional: ['panel'] },
};
const DEVICE_KEYS = ['id', 'name', 'brand', 'aliases', 'displays', 'units', 'availability', ...DATA_TYPES];

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function keyProblems(obj, required, optional) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['不是对象'];
  const out = [];
  for (const k of required) if (!(k in obj)) out.push(`缺少字段 ${k}`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) out.push(`未知字段 ${k}`);
  return out;
}

export function runCheck({ root = REPO_ROOT } = {}) {
  const sections = [];
  const section = (title) => {
    const s = { title, errors: [], warnings: [], info: [] };
    sections.push(s);
    return { err: (m) => s.errors.push(m), warn: (m) => s.warnings.push(m), info: (m) => s.info.push(m), s };
  };
  const file = (f) => path.join(root, f);
  const load = (sec, f) => {
    try { return JSON.parse(fs.readFileSync(file(f), 'utf8')); } catch (e) {
      sec.err(`${f} 无法读取或不是合法 JSON：${e.message}`);
      return null;
    }
  };

  // ======================================================================================
  const cat = section('机型目录（data/devices.json）');
  const catalog = load(cat, CATALOG_FILE);
  const devices = Array.isArray(catalog?.devices) ? catalog.devices : [];
  if (catalog) {
    if (catalog.schemaVersion !== 1) cat.err(`schemaVersion 应为 1，实际 ${catalog.schemaVersion}`);
    if (!Array.isArray(catalog.devices)) cat.err('devices 不是数组');
    const voc = catalog.vocabulary ?? {};
    const same = (a, b) => JSON.stringify(Object.keys(a ?? {})) === JSON.stringify(Object.keys(b));
    if (!same(voc.states, STATES)) cat.err('vocabulary.states 与 pipeline/catalog/vocabulary.mjs 不一致');
    if (!same(voc.availability, AVAILABILITY)) cat.err('vocabulary.availability 与 pipeline/catalog/vocabulary.mjs 不一致');
    if (!same(voc.displays, DISPLAYS)) cat.err('vocabulary.displays 与 pipeline/catalog/vocabulary.mjs 不一致');
    if (!same(voc.stateBasis, STATE_BASIS)) cat.err('vocabulary.stateBasis 与 pipeline/catalog/vocabulary.mjs 不一致');
  }
  const brands = catalog?.brands ?? {};
  const ids = new Set();
  const names = new Map(); // normalised id / name / alias → device id
  const panels = new Set();
  for (const d of devices) for (const u of d.units ?? []) if (isStr(u?.panel)) panels.add(norm(u.panel));

  for (const d of devices) {
    const where = `机型 ${d?.id ?? '(无 id)'}`;
    for (const p of keyProblems(d, DEVICE_KEYS, [])) cat.err(`${where}: ${p}`);
    if (!d || typeof d !== 'object') continue;
    if (!isStr(d.id) || !ID_RE.test(d.id)) cat.err(`${where}: id 必须是小写字母、数字和连字符（如 xiaomi-18-pro-max）`);
    if (ids.has(d.id)) cat.err(`${where}: id 重复`);
    ids.add(d.id);
    if (!isStr(d.name?.zh) || !isStr(d.name?.en)) cat.err(`${where}: name.zh 和 name.en 都必须是非空字符串`);
    if (!(d.brand in brands)) cat.err(`${where}: 品牌 ${d.brand} 不在 brands 中`);
    if (!Array.isArray(d.aliases) || d.aliases.some((a) => !isStr(a))) cat.err(`${where}: aliases 必须是非空字符串数组`);
    if (!Array.isArray(d.displays) || !d.displays.length || d.displays.some((x) => !(x in DISPLAYS)) || new Set(d.displays).size !== d.displays.length) {
      cat.err(`${where}: displays 必须是 ${Object.keys(DISPLAYS).join(' / ')} 中不重复的值`);
    }
    const unitIds = new Set();
    for (const u of Array.isArray(d.units) ? d.units : (cat.err(`${where}: units 不是数组`), [])) {
      for (const p of keyProblems(u, ['id', 'panel', 'label'], ['note'])) cat.err(`${where} 样机: ${p}`);
      if (!isStr(u?.id) || !ID_RE.test(u.id)) cat.err(`${where}: 样机 id「${u?.id}」格式不对`);
      if (unitIds.has(u?.id)) cat.err(`${where}: 样机 id ${u?.id} 重复`);
      unitIds.add(u?.id);
      if (u?.panel !== null && !isStr(u?.panel)) cat.err(`${where}: 样机 ${u?.id} 的 panel 必须是字符串或 null`);
    }
    // search keys: unique across devices; panel codes are searched separately and stay off aliases
    const keys = [d.id, d.name?.zh, d.name?.en, ...(Array.isArray(d.aliases) ? d.aliases : [])].filter(isStr);
    for (const k of new Set(keys.map(norm))) {
      const other = names.get(k);
      if (other && other !== d.id) cat.err(`${where}: 名称或别名「${k}」与机型 ${other} 冲突`);
      names.set(k, d.id);
    }
    for (const a of Array.isArray(d.aliases) ? d.aliases : []) {
      if (panels.has(norm(a))) cat.err(`${where}: 别名「${a}」是面板码，面板码只写在 units[].panel 上`);
    }

    // availability
    const av = d.availability;
    for (const p of keyProblems(av, DATA_TYPES, [])) cat.err(`${where} availability: ${p}`);
    for (const t of DATA_TYPES) {
      const a = av?.[t];
      if (!a) continue;
      for (const p of keyProblems(a, ['status'], ['note', 'sourceId'])) cat.err(`${where} availability.${t}: ${p}`);
      if (!(a.status in AVAILABILITY)) { cat.err(`${where} availability.${t}: 未知状态 ${a.status}`); continue; }
      const entries = Array.isArray(d[t]) ? d[t] : [];
      const measured = t === 'angle' ? entries.filter((e) => e.measured) : entries;
      const unmeasured = t === 'angle' ? entries.filter((e) => !e.measured) : [];
      const bad = (why) => cat.err(`${where} availability.${t} = ${a.status}，但${why}`);
      if (a.status === 'complete' && (!measured.length || unmeasured.length)) bad(measured.length ? '有未测条目（应为 partial）' : '没有实测条目');
      if (a.status === 'partial' && (!measured.length || !unmeasured.length)) bad('partial 需要同时有实测和未测条目');
      if (a.status === 'metrics-only' && (t !== 'uniformity' || !entries.length || entries.some((e) => e.maps?.length))) bad('仅指标只用于均匀度、且条目不带热力图');
      if (['pending-import', 'not-measured'].includes(a.status) && measured.length) bad(`有 ${measured.length} 个实测条目`);
      if (a.status === 'complete' && t === 'uniformity' && !entries.some((e) => e.maps?.length)) bad('没有热力图');
    }

    // entries
    for (const t of DATA_TYPES) {
      if (!Array.isArray(d[t])) { cat.err(`${where}: ${t} 不是数组`); continue; }
      d[t].forEach((e, i) => {
        const w = `${where} ${t}[${i}]`;
        for (const p of keyProblems(e, ENTRY_KEYS[t].required, ENTRY_KEYS[t].optional)) cat.err(`${w}: ${p}`);
        if (!e || typeof e !== 'object') return;
        if (!(e.state in STATES)) cat.err(`${w}: 未知状态 ${e.state}（可用：${Object.keys(STATES).join('、')}）`);
        if (!(e.stateBasis in STATE_BASIS)) cat.err(`${w}: 未知 stateBasis ${e.stateBasis}`);
        const displayOk = e.display === null ? t === 'reflectance' && d.displays?.length > 1 : d.displays?.includes(e.display);
        if (!displayOk) cat.err(`${w}: 屏幕 ${e.display} 不是该机型的屏幕（${(d.displays ?? []).join(' / ')}）`);
        if (e.unit !== null && !unitIds.has(e.unit)) cat.err(`${w}: 样机 ${e.unit} 不在该机型的 units 中`);
        if (e.state === 'unspecified' && e.stateBasis !== 'source') cat.err(`${w}: 状态未注明只能来自源数据`);
        if (t === 'angle') {
          if (typeof e.measured !== 'boolean') cat.err(`${w}: measured 必须是 true / false`);
          if (e.measured === false && (e.status !== 'not-measured' || !isStr(e.note))) cat.err(`${w}: 未测的 profile 需要 status = not-measured 和说明 note`);
          if (e.measured === true && ('status' in e || 'substituteOf' in e)) cat.err(`${w}: 实测 profile 不应带 status / substituteOf`);
        }
        if (t === 'uniformity') {
          if (!UNIFORMITY_CONDITIONS.includes(e.condition)) cat.err(`${w}: 均匀度条件 ${e.condition} 不是 ${UNIFORMITY_CONDITIONS.join(' / ')}`);
          if (!Array.isArray(e.maps) || e.maps.some((m) => !UNIFORMITY_KINDS.includes(m?.kind) || !isStr(m?.asset))) cat.err(`${w}: maps 条目格式不对`);
          if (!Array.isArray(e.metrics) || e.metrics.some((m) => !UNIFORMITY_KINDS.includes(m))) cat.err(`${w}: metrics 只能是 ${UNIFORMITY_KINDS.join(' / ')}`);
        }
        if (t === 'reflectance') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? '') || !String(e.measuredAt).startsWith(e.date)) cat.err(`${w}: date ${e.date} 应为 measuredAt（${e.measuredAt}）的日期`);
        }
      });
    }
  }
  if (catalog?.counts) {
    const c = catalog.counts;
    const sum = (f) => devices.reduce((n, d) => n + f(d), 0);
    const expect = {
      devices: devices.length,
      svmRecords: sum((d) => d.svm?.length ?? 0),
      angleProfiles: sum((d) => d.angle?.length ?? 0),
      angleProfilesMeasured: sum((d) => (d.angle ?? []).filter((e) => e.measured).length),
      uniformityConditions: sum((d) => d.uniformity?.length ?? 0),
      uniformityMaps: sum((d) => (d.uniformity ?? []).reduce((m, e) => m + (e.maps?.length ?? 0), 0)),
      reflectanceSamples: sum((d) => d.reflectance?.length ?? 0),
    };
    for (const [k, v] of Object.entries(expect)) if (c[k] !== v) cat.err(`counts.${k} 为 ${c[k]}，实际 ${v}`);
  }
  if (catalog) cat.info(`${devices.length} 台机型，${ids.size} 个 id、${names.size} 个名称 / 别名互不冲突`);
  const entriesOf = (t) => devices.flatMap((d) => (Array.isArray(d?.[t]) ? d[t].map((e) => ({ d, e })) : []));

  // ======================================================================================
  const svm = section('频闪（public/datasets）');
  const manifest = load(svm, 'public/datasets/manifest.json') ?? [];
  const svmEntries = entriesOf('svm');
  const svmByRecord = new Map();
  for (const { d, e } of svmEntries) {
    if (svmByRecord.has(e.record)) svm.err(`记录 ${e.record} 同时属于 ${svmByRecord.get(e.record).d.id} 和 ${d.id}`);
    svmByRecord.set(e.record, { d, e });
  }
  for (const m of manifest) {
    const p = file(`public/datasets/${m.file}`);
    if (!fs.existsSync(p)) svm.err(`manifest 里的 ${m.file} 不存在`);
    else {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(j?.matrix?.grid)) svm.err(`${m.file} 没有 matrix.grid`);
      } catch (e) { svm.err(`${m.file} 不是合法 JSON：${e.message}`); }
    }
    const hit = svmByRecord.get(m.file);
    if (!hit) { svm.err(`manifest 记录 ${m.file}（${m.device} · ${m.mode}）不属于目录里的任何机型`); continue; }
    if (hit.e.mode !== m.mode) svm.err(`${m.file}: 目录里的模式名「${hit.e.mode}」与 manifest「${m.mode}」不同（模式名要保持原文）`);
    if ((hit.e.modeEn ?? null) !== (m.modeEn ?? null)) svm.err(`${m.file}: modeEn 与 manifest 不同`);
    if (hit.e.manifestDevice !== m.device) svm.err(`${m.file}: manifestDevice 与 manifest 的 device 不同`);
  }
  const manifestFiles = new Set(manifest.map((m) => m.file));
  for (const r of svmByRecord.keys()) if (!manifestFiles.has(r)) svm.err(`目录引用的频闪记录 ${r} 不在 manifest.json 中`);
  svm.info(`${manifest.length} 条记录，全部归属 ${new Set(svmEntries.map((x) => x.d.id)).size} 台机型`);

  // ======================================================================================
  const ang = section('可视角（data/angle/summary.json）');
  const summary = load(ang, 'data/angle/summary.json');
  const profiles = new Map();
  if (summary) {
    if (summary.schemaVersion !== 1) ang.err(`schemaVersion 应为 1`);
    if (!/^[0-9a-f]{40}$/.test(summary.standalone?.commit ?? '')) ang.err('没有记录独立项目的完整提交号 standalone.commit');
    for (const p of summary.profiles ?? []) {
      if (profiles.has(p.id)) ang.err(`profile ${p.id} 重复`);
      profiles.set(p.id, p);
      if (p.measured) {
        for (const [axis, dirs] of Object.entries(DIRECTIONS)) {
          for (const dir of Object.keys(dirs)) {
            const m = p.metrics?.[axis]?.[dir];
            const w = `${p.id} ${axis}.${dir}`;
            if (!m) { ang.err(`${w}: 缺少数据`); continue; }
            for (const t of THETAS) {
              const v = m.atTheta?.[t];
              if (!v || !isNum(v.luminancePct) || !isNum(v.duv) || !isNum(v.jncd)) { ang.err(`${w} θ=${t}°: 数值缺失`); continue; }
              if (v.luminancePct < 0 || v.luminancePct > 150) ang.err(`${w} θ=${t}°: 相对亮度 ${v.luminancePct} % 不合理`);
              if (v.duv < 0 || v.duv > 0.2) ang.err(`${w} θ=${t}°: Δu′v′ ${v.duv} 不合理`);
              if (Math.abs(v.jncd - v.duv / 0.004) > 0.02) ang.err(`${w} θ=${t}°: JNCD ${v.jncd} 与 Δu′v′/0.004 不符`);
            }
            if (m.halfLuminanceDeg === null ? !isNum(m.halfLuminanceBeyondDeg) : !(m.halfLuminanceDeg > 0 && m.halfLuminanceDeg <= p.thetaMaxDeg)) {
              ang.err(`${w}: 半亮度角 ${m.halfLuminanceDeg} 不合理`);
            }
          }
        }
      } else if (p.metrics !== null) ang.err(`${p.id} 未测，却带有数值`);
    }
  }
  const angSeen = new Map();
  for (const { d, e } of entriesOf('angle')) {
    if (angSeen.has(e.profile)) ang.err(`profile ${e.profile} 同时属于 ${angSeen.get(e.profile)} 和 ${d.id}`);
    angSeen.set(e.profile, d.id);
    const p = profiles.get(e.profile);
    if (!p) { ang.err(`${d.id}: profile ${e.profile} 不在独立项目快照中`); continue; }
    if (p.measured !== e.measured) ang.err(`${d.id} / ${e.profile}: measured 与摘要不一致`);
    if (p.device !== e.standaloneDevice) ang.err(`${d.id} / ${e.profile}: 独立项目机型名应为「${p.device}」`);
  }
  for (const id of profiles.keys()) if (!angSeen.has(id)) ang.err(`独立项目的 profile ${id} 不属于目录里的任何机型`);
  if (summary) {
    const measured = [...profiles.values()].filter((p) => p.measured).length;
    ang.info(`独立项目 ${summary.standalone?.commit?.slice(0, 7)}：${profiles.size} 个 profile，实测 ${measured} 个`);
  }

  // ======================================================================================
  const uni = section('均匀度（data/uniformity）');
  const unif = load(uni, 'data/uniformity/index.json');
  let mapCount = 0;
  if (unif) {
    const assets = uniformityAssets(unif);
    const seenAssets = new Set();
    for (const a of assets) {
      const p = file(`data/uniformity/${a.asset}`);
      if (seenAssets.has(a.asset)) uni.err(`热力图 ${a.asset} 被引用了两次`);
      seenAssets.add(a.asset);
      if (!fs.existsSync(p)) uni.err(`热力图 ${a.asset} 不存在`);
      else if (sha256(fs.readFileSync(p)) !== a.assetSha256) uni.err(`热力图 ${a.asset} 的 sha256 与 index.json 记录不一致`);
      else mapCount++;
    }
    const mapsDir = file('data/uniformity/maps');
    for (const f of fs.existsSync(mapsDir) ? fs.readdirSync(mapsDir) : []) {
      if (!seenAssets.has(`maps/${f}`)) uni.err(`data/uniformity/maps/${f} 没有被 index.json 引用`);
    }
    for (const phone of [...(unif.phones ?? []), ...(unif.metricsOnly ?? [])]) {
      for (const c of phone.conditions ?? []) {
        const w = `${phone.id} / ${c.id}`;
        if (!c.metrics?.luminance) uni.err(`${w}: 缺少亮度指标`);
        if ('whiteMeasuredNits' in c) {
          if (!isNum(c.whiteMeasuredNits) || !(c.whiteMeasuredNits > 0)) uni.err(`${w}: 实测白场 whiteMeasuredNits = ${c.whiteMeasuredNits} 应为正数`);
          if (!isStr(c.whiteMeasuredSource?.note)) uni.err(`${w}: 实测白场缺少来源说明 whiteMeasuredSource.note`);
        }
        const lum = c.metrics?.luminance;
        if (lum) {
          if (!(lum.typical > 0)) uni.err(`${w}: 典型亮度应大于 0`);
          for (const k of ['ninePointUniformityPct', 'areaUniformityPct', 'deviation10PctArea']) {
            if (!isNum(lum[k]) || lum[k] < 0 || lum[k] > 100) uni.err(`${w}: ${k} = ${lum[k]} 不在 0–100 %`);
          }
        }
        const cct = c.metrics?.colorTemperature;
        if (cct && (!(cct.typical > 1000 && cct.typical < 20000) || !(cct.ninePointSpreadK >= 0) || !(cct.areaSpreadK >= 0))) uni.err(`${w}: 色温指标不合理`);
      }
    }
    // catalog ↔ index
    const idx = new Map();
    for (const phone of unif.phones ?? []) for (const c of phone.conditions ?? []) idx.set(`${phone.id}/${c.id}`, c);
    for (const m of unif.metricsOnly ?? []) for (const c of m.conditions ?? []) idx.set(`${m.id}/${c.id}`, c);
    const used = new Set();
    for (const { d, e } of entriesOf('uniformity')) {
      const k = `${d.id}/${e.condition}`;
      const c = idx.get(k);
      if (!c) { uni.err(`${d.id}: 均匀度条件 ${e.condition} 不在 index.json 中`); continue; }
      if (used.has(k)) uni.err(`${k} 在目录中出现两次`);
      used.add(k);
      const want = Object.entries(c.maps ?? {}).map(([kind, m]) => `${kind}:${m.asset}`).sort().join(',');
      const got = (e.maps ?? []).map((m) => `${m.kind}:${m.asset}`).sort().join(',');
      if (want !== got) uni.err(`${k}: 热力图列表与 index.json 不一致`);
      if (e.label !== c.label || e.referenceNits !== c.referenceNits) uni.err(`${k}: 标签或设定亮度与 index.json 不一致`);
      if ((e.whiteMeasuredNits ?? null) !== (c.whiteMeasuredNits ?? null)) uni.err(`${k}: 实测白场与 index.json 不一致`);
    }
    for (const k of idx.keys()) if (!used.has(k)) uni.err(`index.json 的 ${k} 不属于目录里的任何机型`);
    const status = (id) => devices.find((d) => d.id === id)?.availability?.uniformity?.status;
    for (const m of unif.metricsOnly ?? []) {
      const s = status(m.id);
      if (s !== ((m.conditions ?? []).length ? 'metrics-only' : 'pending-import')) uni.err(`${m.id}: atlas 标为仅指标，目录状态却是 ${s}`);
    }
    for (const m of unif.notRecorded ?? []) if (status(m.id) !== 'not-measured') uni.err(`${m.id}: atlas 记为未测，目录状态却是 ${status(m.id)}`);
    uni.info(`${(unif.phones ?? []).length} 台有热力图，${mapCount}/${assets.length} 张热力图哈希一致；atlas 标为仅指标 ${(unif.metricsOnly ?? []).length} 台（指标未导出的记为已测待导入），记为未测 ${(unif.notRecorded ?? []).length} 台`);
  }

  // ======================================================================================
  const ref = section('反射率（data/reflectance）');
  const refl = load(ref, 'data/reflectance/index.json');
  const raw = load(ref, 'data/reflectance/raw/phone-samples.json');
  if (refl && raw) {
    let curves = 0;
    const conds = new Map();
    for (const phone of refl.phones ?? []) {
      for (const c of phone.conditions ?? []) {
        conds.set(`${phone.id}/${c.id}`, c);
        for (const key of ['total', 'diffuse']) {
          const curve = c.curves?.[key];
          if (!curve) continue; // reported by compareReflectanceToRaw
          curves++;
          for (const p of curveGridProblems(curve.samples)) ref.err(`${phone.id} / ${c.id} ${curve.method ?? key}: ${p}`);
        }
      }
    }
    for (const p of compareReflectanceToRaw(refl, raw).problems) ref.err(p);
    if (refl.rawSourceSha256 !== raw.sourceSha256) ref.err('index.json 的 rawSourceSha256 与 raw/phone-samples.json 的 sourceSha256 不一致');
    const referencedRaw = new Set([...conds.values()].map((c) => String(c.rawSampleId)));
    for (const s of raw.samples ?? []) if (!referencedRaw.has(String(s.recordId))) ref.warn(`原始样品 ${s.recordId}（${s.expectedName}）没有被 index.json 使用`);
    const used = new Set();
    for (const { d, e } of entriesOf('reflectance')) {
      const k = `${d.id}/${e.condition}`;
      const c = conds.get(k);
      if (!c) { ref.err(`${d.id}: 反射率条件 ${e.condition} 不在 index.json 中`); continue; }
      if (used.has(k)) ref.err(`${k} 在目录中出现两次`);
      used.add(k);
      if (String(c.rawSampleId) !== e.rawSampleId || c.measuredAt !== e.measuredAt || c.label !== e.label || c.sourceName !== e.sourceName) {
        ref.err(`${k}: 样品号 / 时间 / 标签 / 源名称与 index.json 不一致`);
      }
    }
    for (const k of conds.keys()) if (!used.has(k)) ref.err(`index.json 的 ${k} 不属于目录里的任何机型`);
    ref.info(`${(refl.phones ?? []).length} 台、${conds.size} 个样品、${curves} 条曲线（SCI + SCE，400–700 nm / 10 nm）`);
  }

  // ======================================================================================
  const prov = section('来源与哈希（data/provenance.json）');
  const provenance = load(prov, 'data/provenance.json');
  if (provenance) {
    const files = provenance.atlas?.files ?? [];
    let ok = 0;
    for (const f of files) {
      const p = file(f.path);
      if (!fs.existsSync(p)) prov.err(`${f.path} 不存在`);
      else if (sha256(fs.readFileSync(p)) !== f.sha256) prov.err(`${f.path} 与 provenance.json 记录的 sha256 不一致：迁移来的原始数据不能手改`);
      else ok++;
    }
    const listed = new Set(files.map((f) => f.path));
    const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return fs.statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
    for (const p of [...walk(file('data/uniformity')), ...walk(file('data/reflectance'))]) {
      const r = rel(root, p);
      if (!listed.has(r)) prov.err(`${r} 没有在 provenance.json 中登记来源`);
    }
    if (provenance.svmCrossCheck?.differences?.length) {
      for (const d of provenance.svmCrossCheck.differences) prov.warn(`atlas 频闪快照差异：${d}`);
    }
    prov.info(`atlas ${String(provenance.atlas?.commit).slice(0, 7)} 迁移的 ${ok}/${files.length} 个文件哈希一致`);
  }
  const attrs = fs.existsSync(file('.gitattributes')) ? fs.readFileSync(file('.gitattributes'), 'utf8') : '';
  if (!/^data\/uniformity\/maps\/\*\* export-ignore$/m.test(attrs)) prov.warn('.gitattributes 缺少 data/uniformity/maps/** export-ignore');

  // ======================================================================================
  const gen = section('生成文件是否最新');
  try {
    const fresh = jsonText(buildCatalog(root));
    const cur = fs.existsSync(file(CATALOG_FILE)) ? fs.readFileSync(file(CATALOG_FILE), 'utf8') : null;
    if (cur !== fresh) gen.err(`${CATALOG_FILE} 不是由当前源数据生成的：运行 npm run db:catalog`);
    else gen.info(`${CATALOG_FILE} 与生成器输出一致`);
  } catch (e) {
    if (e instanceof CatalogError) for (const p of e.problems) gen.err(`生成器：${p}`);
    else gen.err(`生成器出错：${e.message}`);
  }

  const errors = sections.flatMap((s) => s.errors.map((m) => `[${s.title}] ${m}`));
  const warnings = sections.flatMap((s) => s.warnings.map((m) => `[${s.title}] ${m}`));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sections: sections.map(({ title, errors: e, warnings: w, info }) => ({ title, errors: e, warnings: w, info })),
    summary: {
      devices: devices.length,
      byType: Object.fromEntries(DATA_TYPES.map((t) => [t, devices.filter((d) => MEASURED.includes(d?.availability?.[t]?.status)).length])),
      svmRecords: manifest.length,
      angleProfiles: profiles.size,
      angleProfilesMeasured: [...profiles.values()].filter((p) => p.measured).length,
      uniformityMaps: mapCount,
      reflectanceSamples: entriesOf('reflectance').length,
      standaloneCommit: summary?.standalone?.commit ?? null,
      atlasCommit: provenance?.atlas?.commit ?? null,
    },
  };
}

export function formatReport(r) {
  const s = r.summary;
  const lines = [
    '屏幕数据库校验（db:check）',
    `  机型 ${s.devices} 台：频闪 ${s.byType.svm} 台 · 可视角 ${s.byType.angle} 台 · 均匀度 ${s.byType.uniformity} 台 · 反射率 ${s.byType.reflectance} 台`,
    `  频闪 ${s.svmRecords} 条记录 · 可视角 ${s.angleProfiles} 个 profile（实测 ${s.angleProfilesMeasured}）· 均匀度热力图 ${s.uniformityMaps} 张 · 反射率样品 ${s.reflectanceSamples} 个`,
    `  可视角来自独立项目 ${s.standaloneCommit?.slice(0, 7) ?? '?'}；均匀度、反射率迁移自 atlas ${s.atlasCommit?.slice(0, 7) ?? '?'}`,
    '',
  ];
  for (const sec of r.sections) {
    const mark = sec.errors.length ? '✗' : sec.warnings.length ? '!' : '✓';
    const tail = sec.errors.length ? `（${sec.errors.length} 个错误）` : sec.info.length ? `：${sec.info.join('；')}` : '';
    lines.push(`  ${mark} ${sec.title}${tail}`);
    for (const e of sec.errors.slice(0, 50)) lines.push(`      ✗ ${e}`);
    if (sec.errors.length > 50) lines.push(`      … 另有 ${sec.errors.length - 50} 个错误`);
    for (const w of sec.warnings) lines.push(`      ! ${w}`);
  }
  lines.push('', r.ok ? `结果：通过${r.warnings.length ? `（${r.warnings.length} 个警告）` : ''}` : `结果：失败，${r.errors.length} 个错误${r.warnings.length ? `、${r.warnings.length} 个警告` : ''}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const r = runCheck({ root: path.resolve(args.root ?? REPO_ROOT) });
  console.log(args.json ? JSON.stringify(r, null, 2) : formatReport(r));
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
