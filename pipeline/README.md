# 数据更新流程（`pipeline/`）

屏幕数据库按**批次**更新：一次测量收集一批原始文件，经核对后导入数据库，生成一条更新记录和一个新的数据版本。数据目录本身的结构见 [`data/README.md`](../data/README.md)。

```
NAS 原始文件
  │  ① Mac：pipeline/mac/collect_batch.py   复制进 inbox/<批次>/，算 sha256，写 batch.json 草稿
  ▼
inbox/<批次>/files/…  +  batch.json（草稿）
  │  ② 你：填写 batch.json（标题、每个文件属于哪台机型、导入参数）
  │  ③ npm run db:import -- inbox/<批次>/batch.json --dry-run   先看会改什么
  │  ④ npm run db:import -- inbox/<批次>/batch.json             正式导入
  ▼
data/、public/datasets/ 更新；data/batches/<批次>/ 留下 batch.json + audit.json；
data/version.json 升版本；data/CHANGELOG.md 多一条
  │  ⑤ npm test，提交
```

第 ③④ 步可以在 Mac 上做，也可以在云端会话里做：先通过 Remote Control 共享仓库目录，或者把 `inbox/<批次>/` 这个小文件夹发给会话。

## 1. NAS_ROOT 与隐私

- **NAS_ROOT** 指 NAS 上你自己的数据文件夹，例如 `/Volumes/dav/<你的文件夹>`。这个路径只存在于 Mac 的环境变量里（`export NAS_ROOT=…`），**不进仓库**。
- 批次文件里的路径一律写成**相对 NAS_ROOT 的路径**，例如 `手机数据整理/01单机数据/Apple iPhone 17 Pro Max/均匀性/300nits 亮度.txt`、`反射率.xml`。
- 以下情况会被拒绝，`collect_batch.py` 和 `db:import` 用同一套规则检查：
  - 绝对路径（`/…`、`~/…`、`C:\…`）、`..`、反斜杠；
  - 以 `Volumes/`、`Users/`、`home/` 等开头的路径（说明 NAS_ROOT 设得太浅）；
  - 本机用户名；
  - 环境变量 `SCREENDB_PRIVATE_WORDS` 里列出的词。用逗号分隔，例如你的文件夹名；只设在本机，不写进仓库。
- 批次文件（`title`、`notes` 等）、审计记录和更新记录里的任何字符串，只要像绝对路径，也会被拒绝。
- `inbox/` 已加入 `.gitignore`，原始文件永远不提交。随批次提交的只有：
  - 飞书表的 CSV 导出（很小，作为频闪的源文件存档，放在 `data/batches/<批次>/sources/`）；
  - 各输入文件的相对路径和 sha256。

  反射率 XML 里有其他项目的样品，Radiant TXT 体积很大，这两类都不提交。

## 2. 批次文件 `batch.json`

```jsonc
{
  "schemaVersion": 1,
  "id": "2026-11-05-ip17pm-unif",          // YYYY-MM-DD-短名（小写字母、数字、连字符）；目录名同 id
  "date": "2026-11-05",                    // 必须与 id 的日期相同
  "title": "iPhone 17 Pro Max 均匀度指标；小米 17 Ultra 100 nits 白场复测",
  "notes": "可选，进更新记录",
  "inputs": [
    {
      "path": "视频项目/data/uniformity_metrics.json",   // 相对 NAS_ROOT
      "sha256": "…64 位…", "bytes": 12345,                // collect_batch.py 自动填
      "type": "uniformity-metrics",                       // 见下表
      "devices": ["iphone-17-pro-max"],                   // 机型 id（data/catalog-overrides.json）
      "notes": "可选",
      "options": { "devices": ["iphone-17-pro-max"] }     // 交给导入器的参数，见第 3 节
    },
    {
      "type": "uniformity-white",                         // 手工读数：没有 path / sha256
      "devices": ["xiaomi-17-ultra"],
      "notes": "CA-410，2026-11-05，同一台样机，100 nits 设定下全白场中心点",  // 必填：怎么测的
      "options": { "white": { "xiaomi-17-ultra": { "100": { "nits": 101.2, "note": "复测白场" } } } }
    }
  ],
  "expect": { "uniformityConditions": 3 }               // 可选：本批应带来的数量变化，不符就拒绝导入
}
```

| `type` | 输入 | 导入器 | 写入 |
|---|---|---|---|
| `svm-feishu-csv` | 飞书工作表的 CSV 导出（一张表一台机型） | `import/svm_feishu_csv.py` | `public/datasets/*.json`、`manifest.json`（只追加） |
| `uniformity-metrics` | 视频项目的 `uniformity_metrics.json` | `import/uniformity_metrics.py` | `data/uniformity/index.json` |
| `uniformity-maps` | `uniformity/make_maps.py` 打包的热力图 zip | `import/uniformity_maps.py` | `data/uniformity/maps/*.png`、`index.json` |
| `uniformity-white` | 手工读数（无文件） | `import/uniformity_metrics.py` | `data/uniformity/index.json` 某档的 `whiteMeasuredNits` |
| `reflectance-xml` | ThreeNH 仪器导出的 `反射率.xml` | `import/reflectance_xml.py` | `data/reflectance/raw/phone-samples.json`、`index.json`、`source-manifest.json` |

`devices` 必须与 `options` 里涉及的机型一致，`db:import` 会核对。**新机型**要先在 `data/catalog-overrides.json` 的 `devices` 里加一条，否则导入会被拒绝，脚本不会自己猜机型。

可以照抄的例子：[`examples/duo-revision91.batch.json`](examples/duo-revision91.batch.json)。这是 iPhone Duo 两张表的批次，数据早已在库里，所以 `npm run db:import -- pipeline/examples/duo-revision91.batch.json --nas-root test-fixtures --dry-run` 的结果应该是「无变化」。

## 3. 导入器

三个导入器都是 Python 标准库脚本，用 `python3 -I` 运行，规则相同：

- **幂等**：同样的输入再导一次不会有任何变化；文件内容没变就不重写，连字节都相同。
- **不覆盖原始数据**：已有数据与新文件不同时，直接报错。确实要替换，得在 options 里显式写 `"replace": true`。
- **不补、不估**：空格保持空，0 保持 0；缺的数据就是缺，不补。
- 标准输出只打印一个 JSON 结果，其中有 `changedFiles`、给更新记录用的 `changelog` 和审计详情；给人看的说明打在 stderr。
- 都可以单独运行，加 `--root <目录>` 就能指向测试用的副本。

### 3.1 频闪：`svm_feishu_csv.py`

由 `scripts/import-duo-svm.py` 和 `scripts/import-mate90-svm.py` 合并而来。一张工作表由若干 27 行的块组成：标题行、亮度行、表头行、24 行灰阶。`options` 逐块说明：

```jsonc
{
  "sheet": { "url": "https://…feishu.cn/sheets/…?sheet=…", "revision": 91 },   // 可选，记入审计
  "refreshRateHz": 120,                                                         // 可选，记入审计
  "expectedSha256": "…",                                                        // 可选
  "blocks": [
    { "startRow": 1, "title": "iPhone Duo 内屏", "file": "iPhoneDuo_inner_120hz.json",
      "device": "iPhone Duo 内屏", "deviceEn": "iPhone Duo Inner display",
      "mode": "普通 120Hz", "modeEn": "Standard 120Hz" },
    { "startRow": 28, "title": "华为 Mate 90 Pro Max 典藏版 屏幕低频闪", "skip": "empty",
      "reason": "未使用的模板块" }
  ]
}
```

- `title` 必须与源表 A 列的标题原文一致。亮度轴（100 … 0 %）和灰阶轴（255 … 1）默认是标准轴，与工作台相同。
- 表里每个非空单元格都必须落在某个声明过的块里，否则报错，并列出单元格地址。
- 亮度和 SVM 必须成对：两个都空才记为 `null`，只空一个就报错。
- 写入后，逐个单元格把源值和保存的 JSON 再比一遍（按十进制比较）。
- 新记录追加到 manifest 末尾，所以已有机型在 2D 图里的颜色不变。
- `recordStyle: "name-only"` 生成 Mate 90 那种不带 `device` / `mode` 字段的记录。新数据用默认值即可。
- 回归测试：
  - 用 `test-fixtures/iphone_duo_*_revision91.csv` 生成的 4 条记录和 manifest，与仓库里提交的**逐字节相同**；
  - 用 Mate 90 记录反推出的 CSV，也能逐字节还原 `huawei_mate90promax.json`。原 Mate 90 CSV 导出不在仓库里。

> **频闪会让离线版过期。** `public/datasets` 是工作台离线版 `release/SVM-Visualizer.html` 的指纹输入。只要导入改了 `public/datasets`：
>
> - 导入器的结果里会写 `requiresStandaloneRebuild: true`；
> - `db:import` 写入数据后会自动运行 `npm run build:standalone`。加了 `--skip-release-build` 时不运行，`db:import` 以退出码 1 结束，并提示你手动运行；
> - 重建之前，`npm test`（releaseFreshness）和 `db:check`（「工作台离线版」一节）都会失败；
> - 重建后的 `release/SVM-Visualizer.html` 要和数据一起提交。

### 3.2 均匀度：`uniformity_metrics.py`

读取视频项目的 `uniformity_metrics.json`。格式与 atlas 的 `scripts/uniformity/export_maps.py` 读取的相同，是一个行数组：

```jsonc
[{ "id": "ip17pm", "level": "100", "kind": "lum", "cond": "", "typ": 0.3512, "u9": 93.1, "ua": 89.2, "dev10": 0 },
 { "id": "ip17pm", "level": "300", "kind": "cct", "cond": "", "typ": 6612.3, "d9": 120.1, "da": 251.0 }]
```

`options`：

```jsonc
{ "devices": { "iphone-17-pro-max": { "sourceId": "ip17pm" } },   // 或 ["iphone-17-pro-max"]（库里已知源 id 时）
  "white": { "xiaomi-17-ultra": { "100": { "nits": 101.2, "note": "复测白场" } } },
  "replace": false }
```

- 只导入 `options.devices` 里列出的机型，文件里其他机型的行不动。只导入默认条件（`cond` 为空）的行，其他条件的行列在审计里。
- **已有热力图的机型**（小米 18 Pro Max、iPhone 18 Pro Max、小米 17 Ultra）：
  - 只核对数值。新文件的指标必须和热力图导出时用的一致（舍入规则与 `export_maps.py` 相同）。
  - 不一致就报错。热力图和数字对不上时，要先重新导出热力图，这一步属于 P1。
- **其他机型**：数值写进 `index.json` 的 `metricsOnly`，状态变为「仅指标」。原来记为「未测」（`notRecorded`）的机型会移到 `metricsOnly`，同时给出警告。
- **`white`**：在该档条件上记 `whiteMeasuredNits` 和 `whiteMeasuredSource`，用作 Gamma 2.2 参考亮度的白场。
  - G20 档会算 `γ_eff = ln(典型 / 白场) / ln(20/255)`。结果不在 1.6–2.8 之间时，视为白场或单位写错，拒绝导入；确认无误可加 `"allowUnusualGamma": true`。
  - 实测白场与设定值相差超过 30 % 时给出警告。
- 回归测试：
  - 用当前 `index.json` 反推的指标文件导入三台有热力图的机型，结果**逐字节不变**；
  - 仅指标导入、白场、替换、拒绝等情况都有测试，用的是只存在于临时目录里的合成数字。
- iPhone 17 Pro Max、Mate 80 RS、Mate 70 Air 目前是「已测待导入」：等你把 NAS 上视频项目里的 `uniformity_metrics.json` 放进批次。源 id 分别是 `ip17pm`、`m80rs`、`m70a`，库里已经登记，`devices` 写成列表就行。

### 3.2b 均匀度热力图：`uniformity/make_maps.py` → `uniformity_maps.py`

热力图分两步，第一步在有 NumPy / SciPy / Pillow 的机器上做，第二步是普通的 `db:import`：

```sh
python3 pipeline/uniformity/make_maps.py --data-root <NAS>/01单机数据 --ids ip17pm,mi15u \
    [--extra extra.json] --out inbox/<批次 id>/files/uniformity_maps.zip
```

- 用的是视频项目自己的脚本（`pipeline/uniformity/vendor/`：`render.py`、`uni.py`、`export_maps.py`，逐字节照搬，哈希写进包里），所以热力图和数字与 `uniformity_metrics.json` 出自同一套计算。`make_maps.py` 只做三件事：把脚本指向 NAS 目录和要导出的机型；也能读 CSV 矩阵（华为 Mate 90 Pro Max 典藏版是 CSV）；把 PNG 无损旋转成竖图、记下每个原始矩阵的 sha256 和尺寸，打成 zip。
- `--extra`：`render.py` 里没有的机型，格式同 `render.py` 的 `PH`：`[["m90pm", "华为 Mate 90 Pro Max 典藏版", {"300": [["", "<亮度矩阵>", "<色温矩阵或 null>"]], …}]]`，路径相对 `--data-root`，每档第一项是默认条件。
- 批次里写 `"type": "uniformity-maps"`，`options` 同 `uniformity-metrics`：`{"devices": {"honor-magic-v5": {"sourceId": "mv5", "display": "outer"}}}`。
- 导入器（只用标准库）核对：PNG 的 sha256、8 位 RGBA、竖图尺寸；色条和库里一致；包里每张图都属于列出的机型。
  - **仅指标机型**：包里的指标必须和库里的逐项一致（同样的舍入）、档位也一致，然后整台移到 `phones`，带上热力图；已记的实测白场保留。
  - **库里没有的机型**：直接新增，数字取自包。
  - **已有热力图的机型**：完全相同则不变，不同则报错（`"replace": true` 才替换）。

### 3.3 反射率：`reflectance_xml.py`（**等待真实 XML 文件**）

atlas 的 `raw_ingest.py` 要经过 `rebuild.py`（PNG 数字化，依赖 NumPy 和 Pillow，PNG 文件也没有迁移过来）才能生成索引。新脚本只用 XML 和标准库：

```sh
python3 -I pipeline/import/reflectance_xml.py import --xml <反射率.xml> --options <options.json>
python3 -I pipeline/import/reflectance_xml.py index [--pure] [--compare data/reflectance/index.json]
python3 -I pipeline/import/reflectance_xml.py verify --xml <反射率.xml>     # 独立逐点核对，不经过导入函数
```

- **白名单**：已核准的样品就是 `raw/phone-samples.json` 里已有的样品，按 `recordId` 加 `expectedName` 识别；XML 里的其他样品（iPad、显示器、其他项目）一律不读。
- 新样品写在 `options.add` 里：

  ```json
  { "add": [{ "recordTag": "Standard", "recordId": "431", "expectedName": "<XML 里的 Name 原文>",
              "phoneId": "<机型 id>", "conditionId": "as-measured", "conditionLabel": "原始样品 · 状态未注明" }] }
  ```

  - `conditionId` 必须对应 `catalog-overrides.json` 里的 `reflectanceConditions`，同一机型另一天的样品加 `-YYYYMMDD` 后缀；
  - `phoneName` 不写时，取目录里的中文名。
- **已核准样品**：每次导入都从新 XML 重新读一遍，名称、时间、仪器、读数必须逐点相同，否则报错，不覆盖。新 XML 的哈希会记到 `raw/phone-samples.json`、`source-manifest.json` 和每条曲线上。
- **格式限制**：拒绝 `DOCTYPE` / `ENTITY`；只收 400–700 nm、步长 10 nm 的光谱，这是数据库现有的网格。
- **回归测试**：
  - 以现有索引为底，从 `raw/phone-samples.json` 重新生成，结果**逐字节相同**；
  - 不用现有索引、只从原始读数生成（`--pure`）时，与提交的索引只差 PNG 对照字段：`legendLabelPercent`、`corroboratingPngSourceId`（各 40 处）、`sourcePlotBounds`、`corroboration`、`reflectanceRangePercent`、`sourceManifest`，以及机型顺序。
- **待验证**：仓库里和本机都没有真实的 ThreeNH XML。XML 结构是按 atlas 的 `raw_ingest.py` / `verify_xml.py` 实现的：根元素 `ThreeNHJob`，样品元素 `Standard ID Name DateTime IsTransmission Instrument …`，子元素 `SCI` / `SCE` 下的 `Reflectances Min/Max/WavelengthStep`，读数为分号分隔的反射比。测试用的是由现有原始读数反推的合成 XML。第一次拿到真实文件时：
  1. 先运行 `import --dry-run` 和 `verify`；
  2. 32 个已核准样品应当「读数逐点不变」。如果结构不同，导入器会报错并指出位置，不会写入。

### 3.4 Radiant TXT（**TODO，未实现**）

Radiant 均匀度原始矩阵（2448 × 1632）应当先在 Mac 上降采样成小网格（约 1/8），再离开 Mac。目前手头没有样本文件，所以还没实现：

- `collect_batch.py` 会把 `.txt` 文件记成 `radiant-txt` 类型，只用于登记哈希；
- `db:import` 不接受这个类型。

拿到样本后再补，计划见方案 P1-2。

## 4. `npm run db:import`

```sh
npm run db:import -- <batch.json> [--dry-run] [--nas-root <目录>] [--inbox <目录>] [--skip-release-build]
npm run db:import -- --record "<说明>" [--dry-run]
```

1. **校验批次文件**：字段、路径隐私规则、机型 id、`devices` 与 options 是否一致。
2. **找输入文件并核对大小和 sha256**：先找 `--inbox`，默认是 `inbox/<批次>/files/`；找不到再去 `--nas-root` 下找，默认取环境变量 `NAS_ROOT`。文件登记后又变过，会被拒绝。
3. **在临时副本上导入**：把 `data/` 和 `public/datasets/` 复制到临时目录，逐个运行导入器。
4. **生成记录**：
   - 重新生成 `data/devices.json`；
   - 核对频闪记录确实归到批次写的机型，核对 `expect`；
   - 写 `data/batches/<批次>/audit.json`；
   - 版本号升一级，`data/CHANGELOG.md` 加一条。
5. **在副本上跑 `db:check`**。全部通过后，才把变化的文件拷进仓库。`--dry-run` 到这里为止，只打印会改哪些文件、更新记录和新版本号。
6. **离线版**：`public/datasets` 有变化时，运行 `npm run build:standalone`，见 3.1。最后对仓库跑一次 `db:check`。

其他规则：

- 任何一步失败，**仓库保持原样**，不会只导入半个批次。
- 同一批次再导一次：数据没变就报告「已导入，无变化」；数据会变就报错，新数据请用新的批次 id。
- 批次里的数据全都已经在库里时，报告「无变化」，不记录新版本。
- 批次外的改动，例如 `npm run db:angle` 同步了可视角，用 `--record "<说明>"` 记一个版本和一条更新记录。不记的话，`db:check` 会报「数据变了却没有记录版本」。

### 生成的文件

- **`data/batches/<批次>/batch.json`**：原样保存的批次文件。
- **`data/batches/<批次>/audit.json`**，记录：
  - 每个输入：类型、相对路径、sha256、在 inbox 还是 NAS 找到、导入器详情（逐格核对数、跳过的行、新增样品等）；
  - `files`：每个改动的数据文件导入前后的 sha256；
  - `counts`：导入前后的数量和变化量；
  - `requiresStandaloneRebuild`。
- **`data/batches/<批次>/sources/`**：频闪 CSV 原样副本。`db:check` 会核对它的哈希。
- **`data/version.json`**：`{ dataVersion: "YYYY.MM.DD[.n]", date, batch, batches: [按导入顺序], counts }`。
  - `counts` 必须与 `devices.json` 的 `counts` 相同；
  - 同一天的第二个版本是 `.2`，依次类推。
- **`data/CHANGELOG.md`**：最新的在最上面，每条包括：
  - 版本号、批次 id、标题；
  - 每个导入器给出的说明，例如「均匀度：iPhone 17 Pro Max 新增仅指标数据（…）」；
  - 数量变化；
  - 改动的数据文件。

### `db:check` 相关的检查

- **批次与数据版本**：
  - 每个批次文件都合格，目录名等于 id；
  - 有 `audit.json` 的批次必须在 `version.json` 里列出，反之亦然；只有 `batch.json` 的批次显示为「待导入」警告；
  - CHANGELOG 有每个批次和当前版本的条目；
  - `version.json` 的数量与目录一致。
- **来源与哈希**：
  - 哈希链为「atlas 迁移 → 批次 1 → 批次 2 …」。每个批次记录的导入前哈希，必须等于上一状态的哈希；文件当前的哈希，必须等于最后一次导入后的哈希；
  - 手改数据会报错，改动要走新批次；
  - `npm run db:migrate-atlas` 不会覆盖批次更新过的文件。
- **工作台离线版**：离线版指纹必须与当前 `src/` 和 `public/`（含 `public/datasets`）一致。设置 `SVM_SKIP_RELEASE_CHECK=1` 时，这一项降为警告。

## 5. Mac 端：`pipeline/mac/collect_batch.py`

```sh
cd <仓库目录>
export NAS_ROOT="/Volumes/dav/<你的文件夹>"
export SCREENDB_PRIVATE_WORDS="<你的文件夹名>"        # 可选，再加一道保险
python3 -I pipeline/mac/collect_batch.py --batch 2026-11-05-ip17pm-unif \
  --title "iPhone 17 Pro Max 均匀度指标" \
  "视频项目/data/uniformity_metrics.json" "反射率.xml" "飞书导出/*.csv"
```

- 参数是相对 NAS_ROOT 的路径或通配符，支持 `**`。
- 匹配到的文件原样复制到 `inbox/<批次>/files/<相对路径>`，复制后再核对一次 sha256。
- 写或更新 `inbox/<批次>/batch.json` 草稿：按扩展名猜 `type`，认不出的写「待填写」。再次运行时，已经填写的内容保留，新文件追加。
- 打印每个文件的大小和总大小，超过 20 MB 的单独标出来。
- 拒绝：
  - 绝对路径、`..`、挂载点开头的路径、私人字样；
  - 通过链接指到 NAS_ROOT 以外的文件；
  - inbox 里已有的同名文件内容不同时，加 `--force` 才覆盖。

### Mac 前置条件

| 做什么 | 需要 |
|---|---|
| 收集批次（`collect_batch.py`） | NAS 已挂载；`python3`（macOS 自带的 Xcode 命令行工具里就有，3.9 及以上）。不需要 Node |
| 在 Mac 上导入（`db:import`） | 再加上 Node 20.19+ 或 22.12+，并在仓库里运行过 `npm ci`；`git` |
| 交给云端会话导入 | 在 Claude 桌面应用里打开「设置 → Claude Code → Remote Control」，共享仓库目录；或者在仓库目录运行 `claude remote-control`；或者把 `inbox/<批次>/` 发给会话 |

## 6. 测试

```sh
npx vitest run pipeline db       # 数据库全部测试（导入器测试会启动 python3 -I）
npm run db:check
npm run typecheck
npm run check:release            # 离线版指纹（本流程只读 public/，不改它）
```

| 测试文件 | 内容 |
|---|---|
| `import/svm_feishu_csv.test.ts` | Duo、Mate 90 逐字节回归；幂等；dry-run；成对空白、覆盖、未声明单元格、标题、manifest 改写都会被拒绝 |
| `import/uniformity_metrics.test.ts` | 现有索引逐字节回归；仅指标导入；白场与 γ_eff；替换；「未测」机型改为仅指标 |
| `import/uniformity_maps.test.ts` | 合成热力图包：新增机型、仅指标机型升级（保留外屏）、指标不符、PNG 被改 / 横图 / 色条不同 / 多出机型都会被拒绝；重复导入无变化 |
| `import/reflectance_xml.test.ts` | 索引逐字节回归；只用 XML 生成时只差 PNG 字段；合成 XML 导入、新增样品、拒绝的情况 |
| `db_import.test.ts` | 四种输入一起导入的完整流程；dry-run；幂等；哈希链；同一天的 `.2` 版本；失败时不留半个批次；`expect` 不符；`--record`；批次校验 |
| `mac/collect_batch.test.ts` | 复制和哈希、草稿合并、各种拒绝 |

所有导入测试都只写临时目录，不会动 `public/` 和 `data/`。
