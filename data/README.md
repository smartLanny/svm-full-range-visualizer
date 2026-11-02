# 屏幕数据库的数据（`data/`）

这里是「野生的装机宅屏幕数据库」的数据。一台机型一个 id，四类测量挂在同一个 id 下：

| 类型 | 数据在哪 | 来源 |
|---|---|---|
| 频闪 SVM（亮度 × 灰阶） | `public/datasets/`（**唯一来源**，工作台与数据库共用） | 飞书表导入 |
| 可视角 | `data/angle/summary.json`（摘要）；完整数据和仿真在独立项目 [phone-view-angle-sim](https://github.com/smartLanny/phone-view-angle-sim) | 运行独立项目自己的模型生成 |
| 均匀度（Radiant 热力图） | `data/uniformity/` | 迁自 phone-screen-atlas `0c2846d`，原样 |
| 反射率（SCI / SCE 光谱） | `data/reflectance/` | 迁自 phone-screen-atlas `0c2846d`，原样 |

`data/devices.json`（机型目录）把它们串起来。数据库代码不放进 `src/`，`src/` 也不引用 `data/`、`db/`、`pipeline/`，所以改数据库**不会**让工作台离线版 `release/SVM-Visualizer.html` 过期（`pipeline/isolation.test.ts` 保证）。

## 目录结构

```
data/
  README.md                          本文件
  devices.json                       机型目录（生成，不要手改）
  catalog-overrides.json             机型资料（手工维护：名称、品牌、别名、屏幕、样机与面板码、源名称映射）
  provenance.json                    迁移来源：atlas 提交号、每个文件的 sha256、频闪交叉核对结果（生成）
  angle/summary.json                 可视角摘要（生成）
  uniformity/index.json              均匀度指标与热力图索引（原样）
  uniformity/maps/*.png              15 张热力图（原样；不进 GitHub「Download ZIP」）
  reflectance/index.json             反射率曲线（原样）
  reflectance/raw/phone-samples.json 仪器导出 XML 的白名单原始读数（原样）
  reflectance/source-manifest.json   旧 PNG 数字化路线的来源清单（原样，仅作记录）

pipeline/                            生成与校验脚本（Node，无依赖）
  check.mjs                          npm run db:check
  catalog/build_catalog.mjs          npm run db:catalog
  catalog/vocabulary.mjs             状态、屏幕、可用性等词表
  angle/summarise.mjs                npm run db:angle
  atlas/migrate.mjs                  npm run db:migrate-atlas（一次性迁移；加 --check 复核）
db/catalog/types.ts                  上述生成文件的 TypeScript 类型
```

「原样」的文件逐字节来自 atlas 的 git 对象，`provenance.json` 记了每个文件的 sha256，`db:check` 逐个复核：**这些文件不能手改**，要改就从源数据重新导入。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run db:check` | 完整校验，打印摘要；有错误时退出码为 1 |
| `npm run db:catalog` | 改了 `catalog-overrides.json` 或任何源数据后，重新生成 `devices.json` |
| `npm run db:angle` | 独立可视角项目更新后，重新生成 `angle/summary.json`。需要本地 checkout：环境变量 `VAS_DIR`，或放在本仓库旁边的 `../phone-view-angle-sim` |
| `npm run db:angle -- --check` | 只核对摘要是否与独立项目当前提交一致 |
| `npm run db:migrate-atlas -- --check` | 核对迁移来的文件仍与 atlas `0c2846d` 逐字节相同 |

数据有变化时的顺序：导入源数据 →（可视角有变化时）`db:angle` → `db:catalog` → `db:check` → `npm test`。新机型要先在 `catalog-overrides.json` 的 `devices` 里加一条，否则 `db:catalog` 会报「对应不到目录里的机型」，不会自己猜。

## 机型 id

- 小写字母、数字、连字符：`品牌-型号[-版本]`，例如 `xiaomi-18-pro-max`、`huawei-mate-90-pro-max`。
- **发布后永不修改**，网址和对比链接都用它。atlas 的 24 个 id 原样沿用，另加 `iphone-duo`。
- 折叠屏的内屏、外屏是同一个 id 下的两块屏幕（`displays`），不拆成两台机型。

## 名称、别名、样机与面板码

- `name.zh` 与工作台 manifest、atlas 的中文名一致；`name.en` 为英文名。
- `aliases`：用于搜索和导入时对应机型，例如均匀度源 id（`mi18pm`、`ip18pm`、`mi17u`、`ip17pm`、`m80rs`、`m70a`）和源数据里的写法（`华为 Mate Air`、`小米 17Ultra徕卡`）。任何名称或别名都不能和别的机型重复（`db:check` 检查）。
- `units`：物理样机。**面板码（GH3、GV3）只写在 `units[].panel` 上**，不进别名，单独检索；不同机型可以用同一个面板码。
- 条目里的 `unit`：只有来源确认是哪台样机时才填（目前只有 iPhone 18 Pro Max 可视角 p0 / p1 = `gh3`、iPhone 17 Pro Max 可视角 p5 = `gv3`），否则为 `null`，不猜。反射率源记录写了面板码时放在条目的 `panel` 字段上（iPhone 18 Pro Max：GH3），但不据此认定是哪台样机。

## 屏幕（display）

| key | 名称 |
|---|---|
| `main` | 主屏（直板机） |
| `inner` | 内屏 |
| `outer` | 外屏 |

折叠屏的反射率源记录没写是哪块屏幕时（OPPO Find N5 `screen-unspecified-20250808`），`display` 为 `null`。

## 状态（state）

| key | 显示 | 含义 |
|---|---|---|
| `default` | 默认 | 普通状态：未开防窥模式、未贴防窥膜或抗反膜 |
| `privacy` | 防窥模式 | 机身内置的防窥显示模式（小米 18 Pro Max 可视角 p3） |
| `privacy-film` | 防窥膜 | 贴防窥膜（iPhone 18 Pro Max GH3 可视角 p1） |
| `anti-reflective-film` | 抗反膜 | 抗反射膜 |
| `screen-protector` | 贴膜 | 源记录只写「贴膜」，种类未注明（小米 18 Pro Max 反射率） |
| `unspecified` | 原始样品 · 状态未注明 | 源记录没注明贴膜 / 防窥等状态。**永远不并入「默认」** |
| `inner` / `outer` | 内屏 / 外屏 | 折叠屏源记录只按屏幕区分（同样没注明贴膜状态） |

频闪的刷新 / 调光模式不是状态：`mode` 保留 manifest 原文（「标准」「平滑脉冲」「自适应刷新 Pro 开」「普通 120Hz」……），不改写、不归并。

每个条目还有 `stateBasis`：

- `source`：状态由源数据标明（可视角的 privacy / privacyKind / 内外屏、反射率的条件、频闪的内外屏）。
- `convention`：源数据没写，按常规测量状态记为 `default`，**待用户确认**。目前用于直板机的频闪记录和均匀度。

## 可用性（availability）

每台机型、每类数据一个状态：

| key | 显示 | 条件 |
|---|---|---|
| `complete` | 完整 | 有可视化数据（矩阵、热力图、曲线） |
| `partial` | 部分已测 | 部分屏幕或状态已测，其余未测（iPhone Duo 可视角：外屏未测） |
| `metrics-only` | 仅指标 | 只有均匀度数值，没有热力图（目前没有） |
| `pending-import` | 已测待导入 | 源数据存在但没导入本库（iPhone 17 Pro Max、Mate 80 RS、Mate 70 Air 的均匀度：atlas 标为「仅指标」，但指标数值从未导出） |
| `not-measured` | 未测 | 本库没有这项测量（例如 Mate 90 的均匀度） |

数值缺失就显示状态词，**不补、不估**。

## `devices.json` 结构

```jsonc
{
  "schemaVersion": 1,
  "inputs": { "<源文件>": "<sha256>" },        // 生成时用到的输入
  "vocabulary": { "dataTypes", "states", "stateBasis", "displays", "availability" },  // 中英文标签
  "brands": { "apple": { "zh": "苹果", "en": "Apple" } },
  "counts": { ... },                            // 汇总数，db:check 复核
  "devices": [{
    "id", "name": { "zh", "en" }, "brand", "aliases": [], "displays": ["main"],
    "units": [{ "id", "panel", "label", "note?" }],
    "availability": { "svm" | "angle" | "uniformity" | "reflectance": { "status", "note?", "sourceId?" } },
    "svm":         [{ "record", "manifestDevice", "mode", "modeEn?", "display", "state", "stateBasis", "unit", "note?" }],
    "angle":       [{ "profile", "standaloneDevice", "display", "state", "stateBasis", "measured", "unit",
                      "status?": "not-measured", "substituteOf?", "note?" }],
    "uniformity":  [{ "condition": "300" | "100" | "10", "label", "pattern", "referenceNits", "display", "state",
                      "stateBasis", "unit", "maps": [{ "kind": "luminance" | "colorTemperature", "asset", "sourceKey" }],
                      "metrics": ["luminance", "colorTemperature"] }],
    "reflectance": [{ "condition", "label", "display", "state", "stateBasis", "unit", "panel?", "date",
                      "measuredAt", "rawSampleId", "sourceName" }]
  }]
}
```

- `svm[].record` 是 `public/datasets/` 里的文件名；manifest 的 21 条记录每条恰好属于一台机型。
- `angle[].profile` 是独立项目里**稳定的 profile id**（`p0`…`p5`、`duo-inner`、`duo-outer`），不是 `#dev=` 序号。
- `uniformity[].maps[].asset` 相对 `data/uniformity/`；指标数值本身在 `uniformity/index.json`，目录只做引用。
- `reflectance[].condition` 对应 `reflectance/index.json` 的条件 id；`date` 是 `measuredAt`（UTC）的日期。OPPO Find N5 有 5 个条件、3 个日期；荣耀 Magic V5 分内外屏。
- iPhone Duo 外屏的可视角：独立项目里那组数据是从 iPhone 18 Pro Max GH3 的 p0 **复制的临时替代**，目录里 `measured: false`、状态「未测」，`summary.json` 不给数值。

## `angle/summary.json` 结构

由 `pipeline/angle/summarise.mjs` 在 Node 的 vm 里加载独立项目在指定提交下的 `web/model.js`、`data.js`、`duo-data.js`、`devices.js`，按 `app.js` 同样的方式 `createModel(…, { fill: 'vmirror' })`，所有数字都是 `model.evalAt(θ, ψ)` 的字段，**不另写光学公式**。如果独立项目改了 `app.js` 构造模型的那几行，脚本会拒绝运行。

- `standalone`：仓库、完整提交号（目前 `20ef8e6`）、各源文件 sha256、当时的机型顺序。
- `profiles[]`：每个 profile 的机型名、`#dev=` 兜底序号（`devIndexAtCommit`，新增机型会移动）、防窥类型、源文件、是否实测；实测的给出 `metrics`：
  - 方向（`model.js` 的约定：手机坐标、从屏幕正面看）：水平 = `right`（ψ = 0°）/ `left`（180°），垂直 = `up`（90°）/ `down`（270°）。这正是 φ = 0° 和 90° 两组实测线。
  - `atTheta["30" | "45" | "60"]`：`luminancePct`（白场亮度相对 0° 的百分比）、`duv`（白场 Δu′v′）、`jncd`（Δu′v′ / 0.004）。45° 不在 2° 网格上，由模型自己的插值得到。
  - `halfLuminanceDeg`：亮度首次降到一半的角度；70° 内没降到一半时为 `null`，并给 `halfLuminanceBeyondDeg: 70`。
- 只给相对值：各文件 0° 白场的绝对亮度条件不同，不能直接比较。

## 来源与原样数据（`provenance.json`）

- `atlas.files`：从 phone-screen-atlas `0c2846d` 复制的 19 个文件及 sha256。15 张热力图都与 `uniformity/index.json` 记录的 `assetSha256` 一致；64 条反射率曲线都与 `raw/phone-samples.json` 的仪器读数（× 100）逐点一致。`rawSourceSha256` 是仪器导出文件「反射率.xml」的哈希，XML 不在仓库里，只能核对各处记录一致。
- `svmCrossCheck`：atlas 的频闪快照（停在 `48bf54c`，17 条）与本仓库 `public/datasets`（21 条）逐字节比较：17 条完全相同，manifest 前 17 条一致；atlas 缺 iPhone Duo 的 4 条。atlas 的频闪数据不复制。
- 没迁移的：atlas `data/svm/**`（以本仓库为准）、`data/reflectance/source/*.png`（旧 PNG 数字化路线，仅作对照）。

## `db:check` 检查什么

1. 目录结构：字段齐全且没有未知字段，id 格式与唯一性，品牌、屏幕、样机、状态、`stateBasis` 都在词表里，名称 / 别名不冲突，别名不是面板码，可用性与条目一致，`counts` 正确。
2. 频闪：manifest 每条记录存在、能解析，恰好属于一台机型，模式名与 manifest 原文一致。
3. 可视角：目录里的 profile 都在摘要里、摘要里的 profile 都有归属，`measured` 一致，数值齐全且合理，未测的不带数值。
4. 均匀度：每张热力图存在且 sha256 与索引一致，没有多余文件，指标在合理范围，目录与索引一一对应，「仅指标 / 未测」与可用性一致。
5. 反射率：每条曲线 31 个点、400–700 nm、步长 10 nm、值在 0–100 %，并与原始读数逐点一致；目录与索引一一对应。
6. 来源：`provenance.json` 登记的文件哈希不变，`uniformity/`、`reflectance/` 下没有未登记的文件。
7. `devices.json` 与生成器的输出逐字节一致（忘了 `db:catalog` 会报错）。
