/**
 * Batch files (data/batches/<id>/batch.json): validation, the file-hash chain, the data version
 * and the changelog. Shared by pipeline/db_import.mjs and pipeline/check.mjs. No dependencies.
 *
 * A batch lists input files by path RELATIVE to NAS_ROOT (the user's NAS folder, set on the Mac),
 * never absolute paths, with their sha256. See pipeline/README.md.
 */
import fs from 'fs';
import path from 'path';

export const BATCH_DIR = 'data/batches';
export const VERSION_FILE = 'data/version.json';
export const CHANGELOG_FILE = 'data/CHANGELOG.md';
export const CHANGELOG_MARKER = '<!-- db:import 在这一行下面插入新条目，不要删除这一行 -->';
/** Files db:import regenerates itself; they are not part of the data hash chain. */
export const GENERATED = ['data/devices.json', VERSION_FILE, CHANGELOG_FILE];

export const BATCH_ID_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHA_RE = /^[0-9a-f]{64}$/;

/** Input types → importer. `file: false` = a manual reading typed into the batch (no file). */
export const INPUT_TYPES = {
  'svm-feishu-csv': { file: true, importer: 'pipeline/import/svm_feishu_csv.py', zh: '频闪（飞书表 CSV 导出）' },
  'uniformity-metrics': { file: true, importer: 'pipeline/import/uniformity_metrics.py', zh: '均匀度指标（视频项目 uniformity_metrics.json）' },
  'uniformity-maps': { file: true, importer: 'pipeline/import/uniformity_maps.py', zh: '均匀度热力图（make_maps.py 打包的 zip）' },
  'uniformity-white': { file: false, importer: 'pipeline/import/uniformity_metrics.py', zh: '均匀度实测白场（手工读数）' },
  'reflectance-xml': { file: true, importer: 'pipeline/import/reflectance_xml.py', zh: '反射率（ThreeNH 仪器 XML）' },
};

/** Count keys a batch may declare in "expect" (deltas of data/devices.json counts). */
export const EXPECT_KEYS = ['devices', 'svmRecords', 'angleProfiles', 'angleProfilesMeasured', 'uniformityConditions', 'uniformityMaps', 'reflectanceSamples'];

const MOUNT_SEGMENTS = new Set(['volumes', 'users', 'home', 'mnt', 'media', 'private', 'var', 'tmp', 'root']);
const ABSOLUTE_IN_TEXT = /(?:^|[\s"'(（「])(?:\/(?:Volumes|Users|home|mnt|media|private|root)\/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~\/)/;

/** Extra words that must never appear in a batch (e.g. a personal folder name), from the environment. */
export function privateWords(env = process.env) {
  return String(env.SCREENDB_PRIVATE_WORDS ?? '').split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
}

/**
 * Why `p` is not an acceptable NAS-relative path (empty array when it is).
 * @param {unknown} p
 * @param {string[]} [words]
 * @returns {string[]}
 */
export function pathProblems(p, words = []) {
  if (typeof p !== 'string' || !p.trim()) return ['路径为空'];
  const out = [];
  if (p.includes('\0')) out.push('含 NUL 字符');
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')) out.push('是绝对路径（只能写相对 NAS_ROOT 的路径）');
  if (p.includes('\\')) out.push('含反斜杠（用 / 分隔）');
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) out.push('含空段、. 或 ..');
  if (MOUNT_SEGMENTS.has(segs[0].toLowerCase())) out.push(`以「${segs[0]}」开头，像是挂载点或用户目录：NAS_ROOT 应设到更深一层`);
  for (const w of words) if (p.includes(w)) out.push('含有 SCREENDB_PRIVATE_WORDS 里的私人字样');
  return out;
}

function walkStrings(value, at, visit) {
  if (typeof value === 'string') visit(value, at);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${at}[${i}]`, visit));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, `${at}.${k}`, visit);
}

/**
 * Every string in `value` that looks like an absolute local path or holds a private word.
 * @param {unknown} value
 * @param {string[]} [words]
 * @returns {string[]}
 */
export function leaks(value, words = []) {
  const out = [];
  walkStrings(value, '$', (s, at) => {
    if (ABSOLUTE_IN_TEXT.test(s)) out.push(`${at} 含绝对路径`);
    for (const w of words) if (s.includes(w)) out.push(`${at} 含私人字样`);
  });
  return out;
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/**
 * Problems with a batch object (empty when valid). `deviceIds`: ids known to the catalog
 * (data/catalog-overrides.json). Does not touch input files; db:import checks their sha256.
 * @param {any} batch
 * @param {{ deviceIds?: Set<string> | null, words?: string[] }} [options]
 * @returns {string[]}
 */
export function validateBatch(batch, { deviceIds = null, words = [] } = {}) {
  const p = [];
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return ['批次文件不是 JSON 对象'];
  const allowed = ['schemaVersion', 'id', 'date', 'title', 'notes', 'inputs', 'expect'];
  for (const k of Object.keys(batch)) if (!allowed.includes(k)) p.push(`未知字段 ${k}`);
  if (batch.schemaVersion !== 1) p.push('schemaVersion 应为 1');
  const m = BATCH_ID_RE.exec(batch.id ?? '');
  if (!m) p.push(`id「${batch.id}」应为 YYYY-MM-DD-小写短名（如 2026-11-05-ip17pm-unif）`);
  if (!validDate(batch.date ?? '')) p.push(`date「${batch.date}」不是合法日期 YYYY-MM-DD`);
  else if (m && m[1] !== batch.date) p.push(`id 的日期 ${m[1]} 与 date ${batch.date} 不一致`);
  if (!isStr(batch.title)) p.push('title 不能为空（一句话说明这批数据）');
  if ('notes' in batch && typeof batch.notes !== 'string') p.push('notes 应为字符串');
  if (!Array.isArray(batch.inputs) || !batch.inputs.length) p.push('inputs 应为非空数组');
  const seen = new Set();
  (Array.isArray(batch.inputs) ? batch.inputs : []).forEach((input, i) => {
    const w = `inputs[${i}]`;
    if (!input || typeof input !== 'object') { p.push(`${w} 不是对象`); return; }
    for (const k of Object.keys(input)) if (!['path', 'sha256', 'bytes', 'type', 'devices', 'notes', 'options'].includes(k)) p.push(`${w}: 未知字段 ${k}`);
    const type = INPUT_TYPES[input.type];
    if (!type) { p.push(`${w}: type「${input.type}」应为 ${Object.keys(INPUT_TYPES).join(' / ')}`); return; }
    if (type.file) {
      for (const why of pathProblems(input.path, words)) p.push(`${w}.path「${input.path}」${why}`);
      if (!SHA_RE.test(input.sha256 ?? '')) p.push(`${w}.sha256 应为 64 位小写十六进制`);
      if (!Number.isInteger(input.bytes) || input.bytes < 0) p.push(`${w}.bytes 应为文件字节数`);
      const key = `${input.path}`;
      if (seen.has(key)) p.push(`${w}: 文件 ${input.path} 重复`);
      seen.add(key);
    } else {
      if (input.path != null || input.sha256 != null) p.push(`${w}: ${input.type} 是手工读数，不带文件（path / sha256 应省略）`);
      if (!isStr(input.notes)) p.push(`${w}: 手工读数必须在 notes 里写明怎么测的`);
    }
    if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) p.push(`${w}.options 应为对象（导入器的参数）`);
    if (!Array.isArray(input.devices) || input.devices.some((d) => !isStr(d))) p.push(`${w}.devices 应为机型 id 数组`);
    else {
      if (deviceIds) for (const d of input.devices) if (!deviceIds.has(d)) p.push(`${w}: 机型 ${d} 不在 data/catalog-overrides.json 中（新机型先加到那里）`);
      const declared = new Set(input.devices);
      const o = input.options ?? {};
      let implied = null;
      if (input.type === 'uniformity-metrics') implied = Array.isArray(o.devices) ? o.devices : Object.keys(o.devices ?? {});
      if (input.type === 'uniformity-metrics' || input.type === 'uniformity-white') implied = [...(implied ?? []), ...Object.keys(o.white ?? {})];
      if (input.type === 'reflectance-xml') implied = (o.add ?? []).map((a) => a?.phoneId);
      if (input.type === 'svm-feishu-csv' && input.devices.length !== 1) p.push(`${w}: 一个飞书表 CSV 只属于一台机型，devices 应只有一个 id`);
      if (implied && [...new Set(implied)].sort().join() !== [...declared].sort().join()) p.push(`${w}.devices（${[...declared].join('、') || '空'}）与 options 里涉及的机型（${[...new Set(implied)].join('、') || '空'}）不一致`);
    }
    if ('notes' in input && typeof input.notes !== 'string') p.push(`${w}.notes 应为字符串`);
  });
  if ('expect' in batch) {
    if (!batch.expect || typeof batch.expect !== 'object') p.push('expect 应为对象');
    else for (const [k, v] of Object.entries(batch.expect)) {
      if (!EXPECT_KEYS.includes(k)) p.push(`expect.${k} 不是可声明的数量（${EXPECT_KEYS.join('、')}）`);
      else if (!Number.isInteger(v)) p.push(`expect.${k} 应为整数（本批带来的增量）`);
    }
  }
  for (const l of leaks(batch, words)) p.push(l);
  return p;
}

/** Imported batches in data/batches (those with an audit.json), in the order version.json lists them. */
export function readBatches(root) {
  const dir = path.join(root, BATCH_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).sort().map((name) => {
    const read = (f) => {
      const p = path.join(dir, name, f);
      if (!fs.existsSync(p)) return { exists: false };
      try { return { exists: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (e) { return { exists: true, error: e.message }; }
    };
    return { name, batch: read('batch.json'), audit: read('audit.json') };
  });
}

/** Next data version for `today` (YYYY-MM-DD): YYYY.MM.DD, or YYYY.MM.DD.n when that day already has one. */
export function nextDataVersion(current, today) {
  const base = today.replace(/-/g, '.');
  if (!current || !current.startsWith(base)) return base;
  const n = current === base ? 1 : Number(current.slice(base.length + 1));
  return `${base}.${n + 1}`;
}

/** The changelog entry for one batch (Markdown). */
export function changelogEntry({ dataVersion, batch, lines, files, countsBefore, countsAfter, requiresStandaloneRebuild }) {
  const delta = EXPECT_KEYS.filter((k) => countsAfter[k] !== countsBefore[k]).map((k) => `${COUNT_LABELS[k]} ${countsBefore[k]} → ${countsAfter[k]}`);
  const out = [
    `## ${dataVersion} · \`${batch.id}\``,
    '',
    batch.title,
    '',
    ...lines.map((l) => `- ${l}`),
    `- 数量：${delta.length ? delta.join('；') : '不变（只更新了已有数据的来源或附加字段）'}`,
    `- 改动的数据文件：${files.length ? files.map((f) => `\`${f}\``).join('、') : '无'}`,
    `- 批次：\`${BATCH_DIR}/${batch.id}/\`（${batch.inputs.length} 个输入，批次日期 ${batch.date}；哈希与逐项核对见 audit.json）`,
  ];
  if (requiresStandaloneRebuild) out.push('- 频闪数据有变化：工作台离线版 `release/SVM-Visualizer.html` 需随本批次重建（`npm run build:standalone`）');
  if (batch.notes) out.push('', `> ${batch.notes.replace(/\n/g, '\n> ')}`);
  return `${out.join('\n')}\n`;
}

export const COUNT_LABELS = {
  devices: '机型',
  svmRecords: '频闪记录',
  angleProfiles: '可视角 profile',
  angleProfilesMeasured: '实测可视角 profile',
  uniformityConditions: '均匀度档位',
  uniformityMaps: '均匀度热力图',
  reflectanceSamples: '反射率样品',
};

/** Inserts `entry` under the marker line (newest first). */
export function insertChangelog(text, entry) {
  const i = text.indexOf(CHANGELOG_MARKER);
  if (i < 0) throw new Error(`${CHANGELOG_FILE} 缺少标记行：${CHANGELOG_MARKER}`);
  const at = i + CHANGELOG_MARKER.length;
  return `${text.slice(0, at)}\n\n${entry}${text.slice(at).replace(/^\n+/, '\n')}`;
}
