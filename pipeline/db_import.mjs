#!/usr/bin/env node
/**
 * db:import — imports one batch of new measurements into the screen database.
 *
 *   npm run db:import -- <batch.json> [--dry-run] [--nas-root <dir>] [--inbox <dir>]
 *                        [--skip-release-build] [--today YYYY-MM-DD] [--json] [--root <repo>]
 *   npm run db:import -- --record "<说明>" [--dry-run]    record a change made outside a batch
 *                                                        (e.g. after npm run db:angle)
 *
 * Steps (pipeline/README.md has the Chinese guide):
 *   1. validate the batch file (relative NAS paths only, known devices, see pipeline/lib/batch.mjs);
 *   2. find every input file — in --inbox (default inbox/<batch id>/files/) or under --nas-root
 *      (default $NAS_ROOT) — and check its sha256 and size against the batch;
 *   3. copy data/ and public/datasets/ to a temporary staging root and run the importers there
 *      (python3 -I pipeline/import/*.py, one per input);
 *   4. rebuild data/devices.json, write data/batches/<id>/audit.json (hash of every changed file
 *      before and after), bump data/version.json, add the data/CHANGELOG.md entry;
 *   5. run db:check on the staging root. Only when everything passes are the changed files copied
 *      into the repository (--dry-run stops before this and prints what would change);
 *   6. if public/datasets changed, the workbench's offline release is stale: run
 *      npm run build:standalone (required; --skip-release-build leaves it to you and exits 1),
 *      then db:check on the repository.
 * A failed step leaves the repository untouched. Importing the same batch again changes nothing.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { REPO_ROOT, jsonText, parseArgs, readJson, rel } from './lib/util.mjs';
import {
  BATCH_DIR, CHANGELOG_FILE, COUNT_LABELS, EXPECT_KEYS, GENERATED, INPUT_TYPES, VERSION_FILE,
  changelogEntry, insertChangelog, leaks, nextDataVersion, privateWords, validateBatch,
} from './lib/batch.mjs';
import { CatalogError, OUTPUT as CATALOG_FILE, buildCatalog } from './catalog/build_catalog.mjs';
import { formatReport, runCheck } from './check.mjs';
import { releaseState } from './lib/release.mjs';

const TRACKED = ['data', 'public/datasets'];

export class ImportFailure extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listFiles(root, dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${dir}/${ent.name}`;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

/** rel path → sha256 for every file under TRACKED. */
function snapshot(root) {
  const m = new Map();
  for (const d of TRACKED) for (const f of listFiles(root, d)) m.set(f, sha256(fs.readFileSync(path.join(root, f))));
  return m;
}

function diffSnapshots(before, after) {
  const out = [];
  for (const [f, h] of after) if (!before.has(f)) out.push({ path: f, status: 'added', before: null, after: h });
  else if (before.get(f) !== h) out.push({ path: f, status: 'modified', before: before.get(f), after: h });
  for (const [f, h] of before) if (!after.has(f)) out.push({ path: f, status: 'deleted', before: h, after: null });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const isDataFile = (f) => !GENERATED.includes(f) && !f.startsWith(`${BATCH_DIR}/`);

function runImporter(script, args) {
  const r = spawnSync('python3', ['-I', path.join(REPO_ROOT, script), ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new ImportFailure(`无法运行 python3：${r.error.message}（导入器需要 Python 3 标准库）`);
  let result = null;
  try { result = JSON.parse(r.stdout.trim().split('\n').pop() ?? ''); } catch { /* reported below */ }
  if (r.status !== 0 || !result?.ok) {
    throw new ImportFailure(`${script} 失败`, [r.stderr.trim() || result?.error || `退出码 ${r.status}`]);
  }
  return { result, stderr: r.stderr };
}

function importerArgs(input, i, ctx) {
  const opts = path.join(ctx.work, `options-${i + 1}.json`);
  fs.writeFileSync(opts, jsonText(input.options ?? {}));
  const s = ctx.stage;
  switch (input.type) {
    case 'svm-feishu-csv':
      return ['--root', s, '--csv', ctx.files[i].abs, '--spec', opts, '--source-name', input.path,
        '--source-copy', path.join(s, BATCH_DIR, ctx.batch.id, 'sources', `${i + 1}-${path.posix.basename(input.path)}`)];
    case 'uniformity-metrics':
      return ['--root', s, '--metrics', ctx.files[i].abs, '--options', opts, '--batch', ctx.batch.id, '--source-name', input.path];
    case 'uniformity-white':
      return ['--root', s, '--options', opts, '--batch', ctx.batch.id];
    case 'reflectance-xml':
      return ['import', '--root', s, '--xml', ctx.files[i].abs, '--options', opts, '--source-name', input.path, '--batch', ctx.batch.id];
    default:
      throw new ImportFailure(`未知的输入类型 ${input.type}`);
  }
}

function resolveInputs(batch, { root, inbox, nasRoot }) {
  const inboxDir = inbox ? path.resolve(inbox) : path.join(root, 'inbox', batch.id, 'files');
  const problems = [];
  const files = batch.inputs.map((input, i) => {
    if (!INPUT_TYPES[input.type].file) return { from: 'batch', abs: null };
    const candidates = [['inbox', path.join(inboxDir, ...input.path.split('/'))]];
    if (nasRoot) candidates.push(['NAS_ROOT', path.join(path.resolve(nasRoot), ...input.path.split('/'))]);
    const hit = candidates.find(([, p]) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!hit) {
      problems.push(`inputs[${i}]「${input.path}」找不到：既不在 inbox（${rel(root, inboxDir) || inboxDir}）里，${nasRoot ? '也不在 NAS_ROOT 下' : '也没有设置 NAS_ROOT / --nas-root'}`);
      return null;
    }
    const buf = fs.readFileSync(hit[1]);
    if (buf.length !== input.bytes || sha256(buf) !== input.sha256) {
      problems.push(`inputs[${i}]「${input.path}」（来自 ${hit[0]}）的大小或 sha256 与批次记录不符：文件在登记后变了，重新运行 collect_batch.py`);
      return null;
    }
    return { from: hit[0], abs: hit[1] };
  });
  if (problems.length) throw new ImportFailure('输入文件核对失败', problems);
  return files;
}

function copyInto(root, rels, from) {
  for (const r of rels) {
    const dst = path.join(root, r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { force: true }); // replaces a symlink instead of writing through it
    fs.writeFileSync(dst, fs.readFileSync(path.join(from, r)));
  }
}

function makeStage(root) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'screendb-import-'));
  const stage = path.join(work, 'stage');
  for (const d of TRACKED) {
    const src = path.join(root, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(stage, d), { recursive: true, dereference: true });
  }
  if (fs.existsSync(path.join(root, '.gitattributes'))) fs.copyFileSync(path.join(root, '.gitattributes'), path.join(stage, '.gitattributes'));
  return { work, stage };
}

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function countsLine(before, after) {
  const changed = EXPECT_KEYS.filter((k) => before[k] !== after[k]);
  return changed.length ? changed.map((k) => `${COUNT_LABELS[k]} ${before[k]} → ${after[k]}`).join('；') : '数量不变';
}

/**
 * Imports `batchFile` into `root`. Returns a summary object; throws ImportFailure on any problem
 * (the repository is then unchanged).
 */
export function importBatch({ root = REPO_ROOT, batchFile, nasRoot = process.env.NAS_ROOT, inbox, dryRun = false, date = today(), skipReleaseBuild = false, log = console.log }) {
  root = path.resolve(root);
  const batchPath = path.resolve(batchFile);
  const batchBytes = fs.readFileSync(batchPath);
  let batch;
  try { batch = JSON.parse(batchBytes.toString('utf8')); } catch (e) { throw new ImportFailure(`批次文件不是合法 JSON：${e.message}`); }
  const overrides = readJson(path.join(root, 'data/catalog-overrides.json'));
  const words = privateWords();
  const problems = validateBatch(batch, { deviceIds: new Set(overrides.devices.map((d) => d.id)), words });
  if (problems.length) throw new ImportFailure(`批次文件 ${rel(root, batchPath) || batchPath} 不合格`, problems);

  const batchDir = path.join(root, BATCH_DIR, batch.id);
  const committedBatch = path.join(batchDir, 'batch.json');
  if (fs.existsSync(committedBatch) && path.resolve(committedBatch) !== batchPath && !fs.readFileSync(committedBatch).equals(batchBytes)) {
    throw new ImportFailure(`批次 ${batch.id} 已存在（${rel(root, committedBatch)}），内容与 ${batchPath} 不同：换一个批次 id，或直接导入已登记的文件`);
  }
  const version = fs.existsSync(path.join(root, VERSION_FILE)) ? readJson(path.join(root, VERSION_FILE)) : null;
  if (!version) throw new ImportFailure(`${VERSION_FILE} 不存在`);
  const alreadyImported = (version.batches ?? []).includes(batch.id);

  log(`批次 ${batch.id}：${batch.title}`);
  const files = resolveInputs(batch, { root, inbox, nasRoot });
  batch.inputs.forEach((input, i) => log(`  输入 ${i + 1}：${INPUT_TYPES[input.type].zh} · ${input.path ?? '手工读数'}${files[i].abs ? `（sha256 ${input.sha256.slice(0, 12)}…，来自 ${files[i].from}）` : ''}`));

  const { work, stage } = makeStage(root);
  try {
    const before = snapshot(stage);
    const ctx = { batch, files, stage, work };
    const results = batch.inputs.map((input, i) => {
      const { result, stderr } = runImporter(INPUT_TYPES[input.type].importer, importerArgs(input, i, ctx));
      for (const line of stderr.trim().split('\n').filter(Boolean)) log(`    ${line.trim()}`);
      return result;
    });
    const dataChanges = diffSnapshots(before, snapshot(stage)).filter((c) => isDataFile(c.path));
    if (!dataChanges.length) {
      log(alreadyImported ? `批次 ${batch.id} 已导入过，重新导入数据无变化。` : '无变化：这个批次的数据都已在库中，不记录新版本。');
      return { status: 'unchanged', batch: batch.id, alreadyImported, changes: [] };
    }
    if (alreadyImported) {
      throw new ImportFailure(`批次 ${batch.id} 已导入过，但重新导入会改变数据（${dataChanges.map((c) => c.path).join('、')}）：新数据请用新的批次 id`);
    }
    if (dataChanges.some((c) => c.status === 'deleted')) throw new ImportFailure('导入器删除了文件，拒绝继续', dataChanges.filter((c) => c.status === 'deleted').map((c) => c.path));

    // batch file, catalog
    const stageBatchDir = path.join(stage, BATCH_DIR, batch.id);
    fs.mkdirSync(stageBatchDir, { recursive: true });
    fs.writeFileSync(path.join(stageBatchDir, 'batch.json'), batchBytes);
    let catalog;
    try { catalog = buildCatalog(stage); } catch (e) {
      throw new ImportFailure('机型目录生成失败', e instanceof CatalogError ? e.problems : [e.message]);
    }
    fs.writeFileSync(path.join(stage, CATALOG_FILE), jsonText(catalog));

    // every SVM record this batch wrote belongs to a device the batch names
    batch.inputs.forEach((input, i) => {
      if (input.type !== 'svm-feishu-csv') return;
      for (const r of results[i].records.filter((x) => x.status !== 'unchanged')) {
        const owner = catalog.devices.find((d) => d.svm.some((e) => e.record === r.file));
        if (!owner || !input.devices.includes(owner.id)) {
          throw new ImportFailure(`频闪记录 ${r.file} 在目录里属于 ${owner?.id ?? '（无）'}，不是批次写的 ${input.devices.join('、')}：检查 manifest 机型名与 catalog-overrides.json 的 sourceNames.svm`);
        }
      }
    });

    const countsBefore = readJson(path.join(root, CATALOG_FILE)).counts;
    const countsAfter = catalog.counts;
    const delta = Object.fromEntries(EXPECT_KEYS.map((k) => [k, countsAfter[k] - countsBefore[k]]));
    const expectProblems = Object.entries(batch.expect ?? {}).filter(([k, v]) => delta[k] !== v).map(([k, v]) => `expect.${k} = ${v}，实际 ${delta[k]}`);
    if (expectProblems.length) throw new ImportFailure('批次声明的数量变化与实际不符', expectProblems);

    const requiresStandaloneRebuild = dataChanges.some((c) => c.path.startsWith('public/datasets/'));
    const audit = {
      schemaVersion: 1,
      batch: batch.id,
      importedOn: date,
      tool: 'pipeline/db_import.mjs',
      inputs: batch.inputs.map((input, i) => ({
        type: input.type,
        path: input.path ?? null,
        sha256: input.sha256 ?? null,
        bytes: input.bytes ?? null,
        devices: input.devices,
        foundIn: files[i].from,
        importer: INPUT_TYPES[input.type].importer,
        changedFiles: results[i].changedFiles,
        warnings: results[i].warnings ?? [],
        details: results[i].audit,
      })),
      files: dataChanges.map((c) => ({ path: c.path, sha256Before: c.before, sha256After: c.after })),
      counts: { before: Object.fromEntries(EXPECT_KEYS.map((k) => [k, countsBefore[k]])), after: Object.fromEntries(EXPECT_KEYS.map((k) => [k, countsAfter[k]])), delta },
      requiresStandaloneRebuild,
    };
    const leaked = [...leaks(audit, words), ...JSON.stringify(audit).includes(work) ? ['审计里出现了临时目录路径'] : []];
    if (leaked.length) throw new ImportFailure('审计记录里有绝对路径或私人字样，拒绝写入', leaked);
    fs.writeFileSync(path.join(stageBatchDir, 'audit.json'), jsonText(audit));

    const dataVersion = nextDataVersion(version.dataVersion, date);
    const newVersion = { schemaVersion: 1, dataVersion, date, batch: batch.id, batches: [...(version.batches ?? []), batch.id], counts: countsAfter };
    fs.writeFileSync(path.join(stage, VERSION_FILE), jsonText(newVersion));
    const lines = results.flatMap((r) => r.changelog ?? []);
    const entry = changelogEntry({ dataVersion, batch, lines, files: dataChanges.map((c) => c.path), countsBefore, countsAfter, requiresStandaloneRebuild });
    const changelogPath = path.join(stage, CHANGELOG_FILE);
    fs.writeFileSync(changelogPath, insertChangelog(fs.readFileSync(changelogPath, 'utf8'), entry));

    const check = runCheck({ root: stage });
    if (!check.ok) throw new ImportFailure('导入后的数据没有通过 db:check（仓库未改动）', check.errors);

    const changes = diffSnapshots(snapshot(root), snapshot(stage));
    log('');
    log(`${dryRun ? '将会' : '已'}改动 ${changes.length} 个文件（数据版本 ${version.dataVersion} → ${dataVersion}；${countsLine(countsBefore, countsAfter)}）：`);
    for (const c of changes) log(`  ${c.status === 'added' ? '新增' : '修改'} ${c.path}`);
    log('', '更新记录：', entry);
    if (requiresStandaloneRebuild) log(`频闪数据（public/datasets）有变化：工作台离线版需要重建（npm run build:standalone）${dryRun ? '' : '，下一步自动执行'}。`);
    const summary = { status: dryRun ? 'dry-run' : 'imported', batch: batch.id, dataVersion, changes, countsBefore, countsAfter, requiresStandaloneRebuild, changelog: entry, warnings: results.flatMap((r) => r.warnings ?? []) };
    if (dryRun) {
      log('（--dry-run：仓库没有改动）');
      return summary;
    }
    copyInto(root, changes.map((c) => c.path), stage);
    summary.release = 'not-needed';
    if (requiresStandaloneRebuild) {
      const state = releaseState(root);
      if (!state.applicable) {
        summary.release = 'not-applicable';
        log('（这个目录不是完整的仓库，没有离线版可重建）');
      } else if (skipReleaseBuild) {
        summary.release = 'skipped';
      } else {
        log('运行 npm run build:standalone …');
        const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:standalone'], { cwd: root, stdio: 'inherit' });
        summary.release = b.status === 0 && releaseState(root).fresh ? 'rebuilt' : 'failed';
      }
    }
    const final = runCheck({ root });
    summary.finalCheck = { ok: final.ok, errors: final.errors };
    log('', formatReport(final));
    return summary;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** --record: a version + changelog entry for changes made outside a batch (e.g. db:angle). */
export function recordChange({ root = REPO_ROOT, note, dryRun = false, date = today(), log = console.log }) {
  root = path.resolve(root);
  if (typeof note !== 'string' || !note.trim()) throw new ImportFailure('--record 需要一句说明');
  const leaked = leaks(note, privateWords());
  if (leaked.length) throw new ImportFailure('说明里有绝对路径或私人字样', leaked);
  const catalog = readJson(path.join(root, CATALOG_FILE));
  let fresh;
  try { fresh = buildCatalog(root); } catch (e) { throw new ImportFailure('机型目录生成失败', e.problems ?? [e.message]); }
  if (jsonText(fresh) !== jsonText(catalog)) throw new ImportFailure(`${CATALOG_FILE} 不是最新的：先运行 npm run db:catalog`);
  const version = readJson(path.join(root, VERSION_FILE));
  const dataVersion = nextDataVersion(version.dataVersion, date);
  const newVersion = { ...version, dataVersion, date, batch: null, counts: catalog.counts };
  const entry = `## ${dataVersion} · 记录\n\n${note.trim()}\n\n- 数量：${countsLine(version.counts, catalog.counts)}\n- 不是批次导入（没有 data/batches 目录）；改动见同一提交\n`;
  log(`数据版本 ${version.dataVersion} → ${dataVersion}`, '', entry);
  if (dryRun) { log('（--dry-run：仓库没有改动）'); return { status: 'dry-run', dataVersion, changelog: entry }; }
  fs.writeFileSync(path.join(root, VERSION_FILE), jsonText(newVersion));
  const cl = path.join(root, CHANGELOG_FILE);
  fs.writeFileSync(cl, insertChangelog(fs.readFileSync(cl, 'utf8'), entry));
  const final = runCheck({ root });
  log(formatReport(final));
  return { status: 'recorded', dataVersion, changelog: entry, finalCheck: { ok: final.ok, errors: final.errors } };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const asJson = !!args.json;
  const log = asJson ? (...m) => console.error(...m) : (...m) => console.log(...m);
  const common = { root: args.root ?? REPO_ROOT, dryRun: !!args['dry-run'], date: typeof args.today === 'string' ? args.today : today(), log };
  try {
    let summary;
    if (args.record !== undefined) summary = recordChange({ ...common, note: args.record });
    else {
      if (!args._[0]) {
        console.error('用法：npm run db:import -- <batch.json> [--dry-run] [--nas-root <目录>] [--inbox <目录>] [--skip-release-build]\n      npm run db:import -- --record "<说明>"');
        process.exit(2);
      }
      summary = importBatch({ ...common, batchFile: args._[0], nasRoot: typeof args['nas-root'] === 'string' ? args['nas-root'] : process.env.NAS_ROOT, inbox: typeof args.inbox === 'string' ? args.inbox : undefined, skipReleaseBuild: !!args['skip-release-build'] });
    }
    if (asJson) console.log(JSON.stringify(summary));
    if (summary.release === 'skipped') {
      log('\n必须完成：public/datasets 已改变，运行 npm run build:standalone 并提交 release/SVM-Visualizer.html（否则 npm test 与 db:check 失败）。');
      process.exit(1);
    }
    if (summary.release === 'failed') {
      log('\n离线版重建失败：修好后运行 npm run build:standalone，再运行 npm run db:check。数据已写入。');
      process.exit(1);
    }
    if (summary.finalCheck && !summary.finalCheck.ok) process.exit(1);
  } catch (e) {
    if (!(e instanceof ImportFailure)) throw e;
    console.error(`\n导入失败：${e.message}`);
    for (const d of e.details.slice(0, 50)) console.error(`  ✗ ${d}`);
    if (asJson) console.log(JSON.stringify({ status: 'failed', error: e.message, details: e.details }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
