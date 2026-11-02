#!/usr/bin/env node
/**
 * data/angle/summary.json — key viewing-angle numbers, computed by RUNNING the standalone
 * project's own optical model (phone-view-angle-sim web/model.js with web/data.js and
 * web/duo-data.js) in a Node vm context. Nothing here re-implements the optics: every number is
 * a field of model.evalAt(θ, ψ).
 *
 *   node pipeline/angle/summarise.mjs [--standalone <dir>] [--rev HEAD]   write the summary
 *   node pipeline/angle/summarise.mjs --check                             exit 1 if it is stale
 *
 * The standalone sources are read from git objects at the given revision, so the recorded commit
 * is exactly what was run. The standalone repository is only read.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import vm from 'vm';
import { REPO_ROOT, firstDir, gitBlob, gitCommit, gitCommitDate, jsonText, parseArgs, sha256 } from '../lib/util.mjs';

export const STANDALONE_REPO = 'https://github.com/smartLanny/phone-view-angle-sim';
export const SOURCE_FILES = ['web/model.js', 'web/data.js', 'web/duo-data.js', 'web/devices.js', 'web/app.js'];
export const THETAS = [30, 45, 60];
/** ψ in the model's own convention (phone coordinates, seen from the front): 0 right, 90 up. */
export const DIRECTIONS = { horizontal: { right: 0, left: 180 }, vertical: { up: 90, down: 270 } };

/**
 * How app.js builds a model and its profile list. If the standalone changes these lines the
 * summary would silently diverge from what the app shows, so summarise refuses to run.
 */
const APP_CONTRACT = {
  modelCall: "AngleModel.createModel({ angles: DATA.angles, sets: byId(id).sets }, { fill: 'vmirror' })",
  duoProfile: "{ id: `duo-${surface}`, device: 'iPhone Duo', surface, privacy: false }",
  profileList: 'const PROFILES = [...DATA.profiles, ...DUO_PROFILES];',
  deviceOrder: 'const DEVICES = [...new Set(PROFILES.map((p) => p.device))].sort((a, b) => rank(a) - rank(b));',
};
const MODEL_OPTS = { fill: 'vmirror' };

export function findStandalone(explicit) {
  return firstDir([explicit, process.env.VAS_DIR, '../phone-view-angle-sim', '../smartlanny/phone-view-angle-sim', '/home/user/smartlanny/phone-view-angle-sim']);
}

/** Loads the standalone sources at `rev` into a fresh vm context. */
export function loadStandalone(dir, rev = 'HEAD') {
  const commit = gitCommit(dir, rev);
  const src = Object.fromEntries(SOURCE_FILES.map((f) => [f, gitBlob(dir, commit, f)]));
  const app = src['web/app.js'].toString('utf8');
  const missing = Object.entries(APP_CONTRACT).filter(([, s]) => !app.includes(s)).map(([k]) => k);
  if (missing.length) {
    throw new Error(`独立项目 ${commit.slice(0, 7)} 的 web/app.js 不再包含约定的代码（${missing.join(', ')}）：先核对 app.js 现在如何构造模型和机型列表，再更新 pipeline/angle/summarise.mjs。`);
  }
  const ctx = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['web/data.js', 'web/duo-data.js', 'web/devices.js', 'web/model.js']) {
    vm.runInContext(src[f].toString('utf8'), ctx, { filename: f });
  }
  for (const k of ['ANG_DATA', 'DUO_DATA', 'DEVICE_SPECS', 'AngleModel']) {
    if (!ctx[k]) throw new Error(`独立项目没有定义 window.${k}`);
  }
  return {
    dir,
    commit,
    commitDate: gitCommitDate(dir, commit),
    files: Object.fromEntries(SOURCE_FILES.map((f) => [f, sha256(src[f])])),
    DATA: ctx.ANG_DATA,
    DUO: ctx.DUO_DATA,
    SPECS: ctx.DEVICE_SPECS,
    AngleModel: ctx.AngleModel,
  };
}

/** The profile list exactly as app.js assembles it (data.js profiles, then Duo inner / outer). */
export function standaloneProfiles(s) {
  const duo = ['inner', 'outer'].map((surface) => Object.assign(
    { sets: null }, s.DUO[surface] || {},
    { id: `duo-${surface}`, device: 'iPhone Duo', surface, privacy: false },
  ));
  return [...s.DATA.profiles, ...duo];
}

/** app.js `DEVICES` order: the `dev=<i>` hash parameter indexes this list. */
function deviceOrder(s, profiles) {
  const KNOWN = Object.keys(s.SPECS);
  const specKey = (device) => KNOWN.filter((k) => device === k || device.startsWith(k + ' ')).sort((a, b) => b.length - a.length)[0];
  const rank = (device) => { const i = KNOWN.indexOf(specKey(device)); return i < 0 ? KNOWN.length : i; };
  return [...new Set(profiles.map((p) => p.device))].sort((a, b) => rank(a) - rank(b));
}

const round = (x, d) => (x === null ? null : Number(x.toFixed(d)));

/** First θ (deg) along ψ where the model's white luminance ratio falls to ≤ 0.5, or null. */
function halfLuminanceAngle(model, psi) {
  const y = (t) => model.evalAt(t, psi).yRatio;
  const steps = Math.round(model.thetaMax * 10);
  let prev = 0;
  for (let k = 1; k <= steps; k++) {
    const t = k / 10;
    if (y(t) <= 0.5) {
      let lo = prev, hi = t;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (y(mid) <= 0.5) hi = mid; else lo = mid;
      }
      return hi;
    }
    prev = t;
  }
  return null;
}

function directionMetrics(model, psi) {
  const atTheta = {};
  for (const t of THETAS) {
    const e = model.evalAt(t, psi);
    if (e.clamped) throw new Error(`θ = ${t}° 超出模型范围（θmax ${model.thetaMax}°）`);
    atTheta[t] = { luminancePct: round(e.yRatio * 100, 2), duv: round(e.duv, 5), jncd: round(e.jncd, 2) };
  }
  const half = halfLuminanceAngle(model, psi);
  return {
    psiDeg: psi,
    atTheta,
    halfLuminanceDeg: round(half, 2),
    ...(half === null ? { halfLuminanceBeyondDeg: model.thetaMax } : {}),
  };
}

const setsKey = (sets) => JSON.stringify(sets.map((x) => ({ phi: x.phi, data: x.data })));

export function buildSummary(s) {
  const profiles = standaloneProfiles(s);
  const devices = deviceOrder(s, profiles);
  const out = profiles.map((p) => {
    const measurement = p.measurement ?? null;
    const substitute = measurement?.temporary ? measurement.profile ?? null : null;
    const measured = !!p.sets && !measurement?.temporary;
    const base = {
      id: p.id,
      device: p.device,
      devIndexAtCommit: devices.indexOf(p.device),
      surface: p.surface ?? null,
      privacy: !!p.privacy,
      privacyKind: p.privacyKind ?? null,
      measured,
      sourceFiles: p.sets ? [...new Set(p.sets.map((x) => x.file))] : [],
      azimuthsDeg: p.sets ? p.sets.map((x) => x.phi) : [],
      standaloneSourceNote: p.sourceNote ?? null,
      standaloneMeasurement: measurement,
    };
    if (!measured) {
      const sub = substitute && profiles.find((q) => q.id === substitute);
      return {
        ...base,
        substituteOf: substitute,
        setsIdenticalToSubstitute: sub && p.sets ? setsKey(p.sets) === setsKey(sub.sets) : null,
        note: substitute
          ? `独立项目中的这组数据是临时替代：复制自 ${substitute}（${measurement.device ?? ''}），不是本机实测，数据库记为未测、不给数值。`
          : '独立项目中没有这组数据，记为未测。',
        metrics: null,
      };
    }
    for (const set of p.sets) {
      for (const k of ['W', 'R', 'G', 'B']) {
        if (set.data[k].length !== s.DATA.angles.length) throw new Error(`${p.id} ${set.file} 的 ${k} 点数与角度网格不一致`);
      }
    }
    const model = s.AngleModel.createModel({ angles: s.DATA.angles, sets: p.sets }, MODEL_OPTS);
    const metrics = {};
    for (const [axis, dirs] of Object.entries(DIRECTIONS)) {
      metrics[axis] = {};
      for (const [name, psi] of Object.entries(dirs)) metrics[axis][name] = directionMetrics(model, psi);
    }
    return { ...base, thetaMaxDeg: model.thetaMax, metrics };
  });
  return {
    schemaVersion: 1,
    generatedBy: 'pipeline/angle/summarise.mjs',
    standalone: {
      repository: STANDALONE_REPO,
      commit: s.commit,
      commitDate: s.commitDate,
      files: s.files,
      modelCall: APP_CONTRACT.modelCall,
      devicesAtCommit: devices,
    },
    method: {
      thetaDeg: THETAS,
      directions: DIRECTIONS,
      convention: 'ψ 为屏幕面内方位角（model.js 约定：手机坐标系、从屏幕正面看，0° 右、90° 上、180° 左、270° 下）。水平 = 右 / 左，垂直 = 上 / 下；这四个方向正好是 φ = 0° 与 φ = 90° 两组实测线。',
      luminancePct: 'model.evalAt(θ, ψ).yRatio × 100：白场亮度相对本 profile 法线方向（0°）的百分比。θ 不在 2° 网格上时（如 45°）由模型自己的单调三次 Hermite 插值得到。',
      duv: 'model.evalAt(θ, ψ).duv：白场 Δu′v′，相对法线方向参考白点。',
      jncd: 'model.evalAt(θ, ψ).jncd = Δu′v′ / 0.004（model.js 的 JNCD 定义）。',
      halfLuminanceDeg: '沿该方位从 0° 起，yRatio 首次 ≤ 0.5 的 θ：按 0.1° 扫描 evalAt，再二分到 0.01°。在 θmax 内没有降到一半时为 null，并给出 halfLuminanceBeyondDeg = θmax。',
      relativeOnly: '只给相对值：各文件测量时 0° 白场的绝对亮度条件不同，不能直接比较绝对亮度。',
      devIndexAtCommit: '独立项目 #dev=<i> 参数在该提交下对应的序号（按 web/devices.js 的机型顺序排列，新增机型会让序号移动），仅作兜底链接用。',
    },
    profiles: out,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = findStandalone(args.standalone);
  if (!dir) {
    console.error('找不到 phone-view-angle-sim 仓库：用 --standalone <目录> 或环境变量 VAS_DIR 指定。');
    process.exit(2);
  }
  const summary = buildSummary(loadStandalone(dir, args.rev ?? 'HEAD'));
  const outFile = path.join(REPO_ROOT, 'data/angle/summary.json');
  const text = jsonText(summary);
  if (args.check) {
    const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
    if (cur !== text) {
      console.error(`data/angle/summary.json 与独立项目 ${summary.standalone.commit.slice(0, 7)} 的模型输出不一致：运行 npm run db:angle 重新生成。`);
      process.exit(1);
    }
    console.log(`data/angle/summary.json 与独立项目 ${summary.standalone.commit.slice(0, 7)} 一致。`);
    return;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  const measured = summary.profiles.filter((p) => p.measured);
  console.log(`已写入 data/angle/summary.json（独立项目 ${summary.standalone.commit.slice(0, 7)}）：${summary.profiles.length} 个 profile，其中 ${measured.length} 个实测。`);
  for (const p of summary.profiles) {
    if (!p.measured) { console.log(`  ${p.id.padEnd(10)} ${p.device} · 未测（${p.substituteOf ? `临时替代自 ${p.substituteOf}` : '无数据'}）`); continue; }
    const h = p.metrics.horizontal, v = p.metrics.vertical;
    const f = (d) => `${d.atTheta[45].luminancePct}% / Δu′v′ ${d.atTheta[45].duv}`;
    console.log(`  ${p.id.padEnd(10)} ${p.device}${p.privacy ? '（防窥）' : ''} · 45°：右 ${f(h.right)}，上 ${f(v.up)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
