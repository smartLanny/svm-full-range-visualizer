#!/usr/bin/env node
/**
 * One-time migration of the phone-screen-atlas data into data/ (and the record of it in
 * data/provenance.json).
 *
 *   node pipeline/atlas/migrate.mjs [--atlas <dir>] [--commit 0c2846d]   copy + write provenance
 *   node pipeline/atlas/migrate.mjs --check                               compare only, exit 1 on drift
 *
 * Files are read from the atlas git objects at the pinned commit (`git cat-file blob`), never from
 * its working tree, and copied byte for byte. The atlas repository is only read.
 *
 * Copied: data/uniformity/index.json + maps/*.png, data/reflectance/index.json,
 * source-manifest.json, raw/phone-samples.json. Verified on the way: every heatmap's
 * assetSha256, the reflectance raw-source hash recorded in index.json, and every reflectance
 * curve against the raw instrument fractions.
 *
 * Not copied: atlas data/svm (public/datasets is the source of truth; it is cross-checked
 * instead) and data/reflectance/source/*.png (the retired PNG-digitising route).
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, firstDir, git, gitBlob, gitCommit, gitCommitDate, jsonText, parseArgs, readJson, sha256 } from '../lib/util.mjs';
import { compareReflectanceToRaw, uniformityAssets } from '../lib/sources.mjs';

const ATLAS_REPO = 'https://github.com/smartLanny/phone-screen-atlas';
const DEFAULT_COMMIT = '0c2846d';
const COPY = [
  'data/uniformity/index.json',
  'data/reflectance/index.json',
  'data/reflectance/source-manifest.json',
  'data/reflectance/raw/phone-samples.json',
];

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? REPO_ROOT);
const atlas = firstDir([args.atlas, process.env.ATLAS_DIR, '../phone-screen-atlas', '/home/user/phone-screen-atlas'], root);
if (!atlas) {
  console.error('找不到 phone-screen-atlas 仓库：用 --atlas <目录> 或环境变量 ATLAS_DIR 指定。');
  process.exit(2);
}
const commit = gitCommit(atlas, args.commit ?? DEFAULT_COMMIT);
const errors = [];

// ---- collect the blobs ------------------------------------------------------------------
const mapFiles = git(atlas, ['ls-tree', '-r', '--name-only', commit, '--', 'data/uniformity/maps']).toString()
  .split('\n').filter((f) => f.endsWith('.png')).sort();
const blobs = new Map([...COPY, ...mapFiles].map((f) => [f, gitBlob(atlas, commit, f)]));

// ---- verify: uniformity heatmaps --------------------------------------------------------
const unif = JSON.parse(blobs.get('data/uniformity/index.json').toString('utf8'));
const assets = uniformityAssets(unif);
let assetMatches = 0;
for (const a of assets) {
  const f = `data/uniformity/${a.asset}`;
  const buf = blobs.get(f);
  if (!buf) errors.push(`均匀度热力图 ${a.asset} 在 atlas ${commit.slice(0, 7)} 中不存在`);
  else if (sha256(buf) !== a.assetSha256) errors.push(`均匀度热力图 ${a.asset} 的 sha256 与 index.json 记录不一致`);
  else assetMatches++;
}
const referenced = new Set(assets.map((a) => `data/uniformity/${a.asset}`));
const unreferenced = mapFiles.filter((f) => !referenced.has(f));
if (unreferenced.length) errors.push(`atlas 里有未被 index.json 引用的热力图：${unreferenced.join(', ')}`);

// ---- verify: reflectance ----------------------------------------------------------------
const refl = JSON.parse(blobs.get('data/reflectance/index.json').toString('utf8'));
const raw = JSON.parse(blobs.get('data/reflectance/raw/phone-samples.json').toString('utf8'));
const rawHashConsistent = refl.rawSourceSha256 === raw.sourceSha256;
if (!rawHashConsistent) errors.push('反射率 index.json 的 rawSourceSha256 与 raw/phone-samples.json 的 sourceSha256 不一致');
if (!blobs.has(`data/reflectance/${refl.rawSource}`)) errors.push(`反射率 rawSource ${refl.rawSource} 不在迁移列表中`);
if (refl.sourceManifest !== 'source-manifest.json') errors.push(`反射率 sourceManifest 为 ${refl.sourceManifest}，迁移脚本只复制 source-manifest.json`);
const curveSourceHashes = new Set();
for (const p of refl.phones) for (const c of p.conditions) for (const cv of Object.values(c.curves)) curveSourceHashes.add(cv.sourceSha256);
const reflCmp = compareReflectanceToRaw(refl, raw);
errors.push(...reflCmp.problems);

// ---- cross-check: atlas data/svm vs public/datasets (not copied) -----------------------
const svm = (() => {
  const atlasIndex = JSON.parse(gitBlob(atlas, commit, 'data/svm/index.json').toString('utf8'));
  const atlasSource = JSON.parse(gitBlob(atlas, commit, 'data/svm/source.json').toString('utf8'));
  const atlasManifest = JSON.parse(gitBlob(atlas, commit, 'data/svm/manifest.original.json').toString('utf8'));
  const repoManifest = readJson(path.join(root, 'public/datasets/manifest.json'));
  const repoFiles = new Map(repoManifest.map((e) => [e.file, e]));
  const differences = [];
  const records = atlasIndex.records.map((r) => {
    const atlasRaw = gitBlob(atlas, commit, `data/svm/${r.rawFile}`);
    const repoPath = path.join(root, 'public/datasets', r.file);
    const repoSha = fs.existsSync(repoPath) ? sha256(fs.readFileSync(repoPath)) : null;
    const atlasSha = sha256(atlasRaw);
    const m = repoFiles.get(r.file);
    const sameLabels = !!m && m.device === r.device && m.mode === r.mode && (m.deviceEn ?? null) === (r.deviceEn ?? null) && (m.modeEn ?? null) === (r.modeEn ?? null);
    if (!repoSha) differences.push(`${r.file}: 仓库 public/datasets 中没有这条记录`);
    else if (repoSha !== atlasSha) differences.push(`${r.file}: atlas 原始文件与 public/datasets 不同`);
    if (atlasSha !== r.sourceSha256) differences.push(`${r.file}: atlas index.json 记录的 sourceSha256 与 atlas 自己的 raw 文件不一致`);
    if (m && !sameLabels) differences.push(`${r.file}: 机型 / 模式名与 manifest 不同（atlas：${r.device} · ${r.mode}）`);
    return { file: r.file, atlasRawSha256: atlasSha, atlasIndexSourceSha256: r.sourceSha256, repoSha256: repoSha, identical: repoSha === atlasSha && sameLabels };
  });
  const atlasFiles = new Set(atlasIndex.records.map((r) => r.file));
  const manifestPrefixIdentical = JSON.stringify(atlasManifest) === JSON.stringify(repoManifest.slice(0, atlasManifest.length));
  if (!manifestPrefixIdentical) differences.push('atlas manifest.original.json 不是仓库 manifest.json 的前缀');
  let snapshotIsAncestor = null;
  try { git(root, ['merge-base', '--is-ancestor', atlasSource.commit, 'HEAD']); snapshotIsAncestor = true; } catch { snapshotIsAncestor = false; }
  return {
    atlasSnapshotCommit: atlasSource.commit,
    atlasSnapshotCommitIsAncestorOfThisBranch: snapshotIsAncestor,
    atlasRecords: atlasIndex.records.length,
    repoRecords: repoManifest.length,
    identicalRecords: records.filter((r) => r.identical).length,
    manifestPrefixIdentical,
    missingFromAtlas: repoManifest.map((e) => e.file).filter((f) => !atlasFiles.has(f)),
    onlyInAtlas: [...atlasFiles].filter((f) => !repoFiles.has(f)),
    differences,
    records,
  };
})();

// ---- write or compare ---------------------------------------------------------------------
const files = [...blobs.keys()].sort().map((f) => ({ path: f, atlasPath: f, bytes: blobs.get(f).length, sha256: sha256(blobs.get(f)) }));
const provenance = {
  schemaVersion: 1,
  note: '本文件由 pipeline/atlas/migrate.mjs 生成。列出的文件从 atlas 仓库指定提交的 git 对象逐字节复制，之后不得手工修改；db:check 会逐个核对 sha256。',
  atlas: {
    repository: ATLAS_REPO,
    commit,
    commitDate: gitCommitDate(atlas, commit),
    script: 'pipeline/atlas/migrate.mjs',
    files,
    verification: {
      uniformityMaps: { referenced: assets.length, assetSha256Match: assetMatches, unreferencedFiles: unreferenced },
      reflectance: {
        phones: refl.phones.length,
        conditions: reflCmp.conditions,
        curves: reflCmp.curves,
        curvesMatchingRawFractions: reflCmp.matched,
        rawSourceSha256: refl.rawSourceSha256,
        rawSourceSha256ConsistentWithRawFile: rawHashConsistent,
        curveSourceSha256Values: [...curveSourceHashes],
        note: 'rawSourceSha256 是仪器导出文件「反射率.xml」的哈希；该 XML 不在仓库中，这里只能核对各处记录的哈希一致，以及每条曲线与 raw/phone-samples.json 的原始读数逐点一致（读数 × 100）。',
      },
    },
    notMigrated: [
      { path: 'data/svm/**', reason: '频闪以本仓库 public/datasets 为唯一来源；atlas 快照只做交叉核对（见 svmCrossCheck）。' },
      { path: 'data/reflectance/source/*.png', reason: '旧的 PNG 数字化路线，仅作对照；现有 64 条曲线全部来自仪器 XML。' },
    ],
  },
  svmCrossCheck: svm,
};

if (errors.length) {
  console.error(`迁移校验失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

if (args.check) {
  const drift = [];
  for (const f of files) {
    const p = path.join(root, f.path);
    if (!fs.existsSync(p)) drift.push(`${f.path} 不存在`);
    else if (sha256(fs.readFileSync(p)) !== f.sha256) drift.push(`${f.path} 与 atlas ${commit.slice(0, 7)} 不同`);
  }
  const provPath = path.join(root, 'data/provenance.json');
  if (!fs.existsSync(provPath) || fs.readFileSync(provPath, 'utf8') !== jsonText(provenance)) drift.push('data/provenance.json 需要重新生成');
  if (drift.length) {
    for (const d of drift) console.error(`  ✗ ${d}`);
    process.exit(1);
  }
  console.log(`atlas 迁移一致：${files.length} 个文件与 ${commit.slice(0, 7)} 逐字节相同。`);
} else {
  for (const f of files) {
    const p = path.join(root, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, blobs.get(f.path));
  }
  fs.writeFileSync(path.join(root, 'data/provenance.json'), jsonText(provenance));
  console.log(`已从 atlas ${commit.slice(0, 7)} 复制 ${files.length} 个文件到 data/，并写入 data/provenance.json。`);
}
console.log(`  均匀度热力图：${assetMatches}/${assets.length} 个 assetSha256 一致`);
console.log(`  反射率：${refl.phones.length} 台 · ${reflCmp.conditions} 个样品 · ${reflCmp.matched}/${reflCmp.curves} 条曲线与原始读数逐点一致`);
console.log(`  频闪交叉核对：atlas ${svm.atlasRecords} 条 / 仓库 ${svm.repoRecords} 条，${svm.identicalRecords} 条完全相同；atlas 缺 ${svm.missingFromAtlas.length} 条（${svm.missingFromAtlas.join(', ')}）`);
if (svm.differences.length) for (const d of svm.differences) console.log(`  ! ${d}`);
