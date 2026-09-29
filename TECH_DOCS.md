# SVM 全范围可视化 v2 · 实现说明

面向想读代码、改代码或添加数据的开发者。产品层面的决定记录在 [`docs/adr`](docs/adr)，术语见 [`CONTEXT.md`](CONTEXT.md)；本文说明这些决定在代码里是怎样实现的。两者冲突时以 ADR 为准，并请顺手修正本文。

---

## 1. 总览

纯前端单页应用，没有后端，运行时不访问任何网络（docs/adr/0008）。

| 层 | 技术 | 位置 |
| --- | --- | --- |
| 界面 | React 19 + TypeScript，Tailwind CSS（构建期编译），自有组件库 | `src/shell`、`src/ui` |
| 状态 | Zustand 单一 store；IndexedDB（idb-keyval）自动保存 | `src/store` |
| 3D | three.js 命令式引擎，React Three Fiber 只负责画布、尺寸和按需渲染 | `src/scene3d` |
| 2D | Canvas 2D 自绘 | `src/chart2d` |
| 统计 | 纯函数 + React 视图 | `src/data/stats.ts`、`src/stats` |
| 动画 | 时间轴时钟，画面是时间 t 的纯函数 | `src/timeline` |
| 导出 | PNG；WebCodecs + mp4-muxer 逐帧离线编码，MediaRecorder 兜底 | `src/export` |
| 文案 | 中英双语，每个模块一个字符串文件 | `src/i18n` |
| 构建 | Vite 6；网页版 + 单文件离线版（vite-plugin-singlefile） | `vite.config.ts`、`scripts/` |

不使用的东西：Recharts（已由 Canvas 2D 取代，ADR 0006）、drei（3D 文字用 Canvas 2D 纹理，见 §3.4）、React Context 状态、GLSL `fwidth` 等高线（等高线是几何线，见 §3.4）。

## 2. 目录与模块

```
src/
  main.tsx            入口：字体、样式、bootstrap()、window.__svm 自动化句柄
  App.tsx             挂载 Shell
  types.ts            领域类型（DataPoint / Dataset / SvmRecord / 设置枚举）和全局阈值
  colormaps.ts        SVM 色谱（JS 与 GLSL 两份，同一组色标）
  data/               与界面无关的数值核心（有单元测试）
    grid.ts           GridView、单元格边界、双线性采样、截面、差值、刻度与格式化
    anomalies.ts      异常值检测 / 剔除 / 还原（ADR 0012）
    parse.ts          Excel/TSV 粘贴解析、多表拆分
    records.ts        JSON 校验、Dataset → SvmRecord、导出 JSON、显示名
    bundled.ts        内置记录加载（网页版 fetch，离线版内嵌）
    bundledEmbedded.ts 仅离线版：import.meta.glob 内嵌 public/datasets/*.json
    colors.ts         机型色板、模式线型
    stats.ts          统计摘要（ADR 0009）
  store/              appStore（设置 + 记录 + 动作）、persistence（IndexedDB）、bootstrap、hooks
  shell/              顶栏、记录面板、参数面板、导入器、拖放、演示模式、快捷键、对话框
  scene3d/            Scene3DView（React 外壳）+ engine/（命令式 three.js 引擎）
  chart2d/            Chart2DView + scene / render / slices / spline / scales / table / tooltip
  stats/              统计页（卡片 / 表格 / 缩略热力图）
  timeline/           Timeline 时钟、TimelineBar 控件、当前动画注册表
  export/             导出按钮、对话框、进度、PNG / 视频引擎、ExportTarget 注册表
  i18n/               t()、useT()；strings/<模块>.ts
  ui/                 Button、Dialog、Segmented、Slider、Switch、Toast……（深色仪器风格，ADR 0011）
public/
  datasets/           内置记录 + manifest.json
  icon.svg 等          图标、网页版 manifest
scripts/              离线版收尾与校验、导出端到端校验、图标生成、Windows 快捷方式
release/              单文件离线版（构建产物，已提交）、icon.ico、使用说明
```

模块之间的约定：

- `data/` 不依赖 React 和 three.js，视图只通过它读数据。
- 视图从不绑定全局快捷键（由 `shell/useGlobalShortcuts.ts` 统一处理），也不在每帧调用 React `setState`。
- 需要出现在截图和视频里的东西（标题、图例、色标、坐标轴）都画进画布，不用 DOM 叠加层（ADR 0001）。悬停提示、时间轴、工具栏是 DOM，不会被导出。

## 3. 数据流

### 3.1 启动

`main.tsx` 调用 `store/bootstrap.ts`：

1. 并行读取 IndexedDB（`persistence.loadPersisted()`）和内置记录（`data/bundled.loadBundledRecords()`）。
2. 内置记录按 manifest 顺序排列，套用本地保存的名称 / 机型 / 模式编辑，去掉用户删除过的；之后接上本地导入的记录。
3. 只接受已知的设置键并与默认值合并（新旧版本的存档都能读）；恢复显隐、A/B 选择和机型颜色。
4. `ready = true`，开始自动保存（store 变化后防抖 400 ms 写入，只写有变化的部分）。

内置记录的 ID 固定为 `bundled:<文件名>`，所以内置记录本身不写入存储，只记住它们的显隐和编辑（ADR 0007）。IndexedDB 不可用（隐私模式、被禁用）时应用照常运行，只是不保存。

### 3.2 记录与网格

一条记录（`SvmRecord`）就是一个 JSON 数据集（`Dataset`）加上机型 / 模式：

- `matrix.rows`：灰阶；`matrix.cols`：亮度档位百分比；`matrix.headerNits`：每个档位在最高灰阶下的实测亮度（档位亮度）；`matrix.grid[行][列]`：测量点或 `null`。
- `data`：有效测量点的扁平列表（兼容 v1 文件）。加载时由 `validateDataset()` 从 `matrix.grid` 重新生成，文件里的 `data` 不参与计算。
- `excluded`：被剔除的原始测量点及原因（ADR 0012）。

所有视图都通过 `data/grid.ts` 的 **GridView** 读数据：`gridView(record, { clipLowGray, maxNits })` 把矩阵整理成两个方向都**升序**的视图（灰阶升序、档位亮度升序），应用低灰阶裁剪（默认隐藏 G < 15，ADR 0004）和档位亮度上限（默认 500 nits），并去掉一个有效格都没有的行和列。结果按“矩阵对象 + 选项”缓存在 `WeakMap` 里。缺失值始终是 `null`，从不当作 0。

### 3.3 横轴、单元格和插值

- 3D、热力图、统计的横轴都是 `x = log10(档位亮度 + 1)`（`logNits()`），纵深是灰阶（线性）。
- **单元格**（ADR 0002）：`cellEdges()` 取相邻测量点坐标的中点作为边界，首尾各向外延伸半个间距（横向下限 0，灰阶夹在 0–255）。柱状图的柱子、热力图的色块、统计缩略图和面积加权统计都用这同一套单元格，所以切换呈现时位置不跳，统计的面积和热力图上看到的一致。
- `sampleView()`：在 (x, 灰阶) 处双线性采样；只要参与加权的角点有一个缺失就返回 `null`，不跨过缺失格插值。
- 截面：`sliceAtGray()`（固定灰阶，SVM 对实测亮度）和 `sliceAtLevel()`（固定档位亮度，SVM 对灰阶）。2D 图在此基础上用 `chart2d/slices.ts` 沿扫描方向做单调三次插值：扫描动画的速度连续，而在每个测量行 / 列上的取值与原始测量完全相同。
- 差值 ΔSVM = A − B（`diffRecords()`）：在 A 的网格上对 B 双线性重采样后相减；任一方缺失则为 `null`。
- 3D 世界坐标（`scene3d/engine/model.ts`）：x = logNits · SX，z = −灰阶 · SZ，y = SVM · SY · 高度倍率；超过高度上限的部分按上限绘制，数值不变。

### 3.4 3D 引擎（`src/scene3d`）

`Scene3DView.tsx` 是 React 外壳：R3F `<Canvas frameloop="demand">` 提供 WebGL 上下文和尺寸，`EngineHost` 把视口大小交给引擎；store 中相关的设置变化时调用 `engine.sync()`。每一帧的计算都在 `engine/engine.ts` 里完成：

- `model.ts`：记录 + 设置 → 世界坐标下的单元格面板（单个 / 并排 A、B / 差值 D），纯数据，可单测。
- `terrain.ts`：每个面板的曲面（`surfaceGrid.ts` 细分的双线性网格，外圈与单元格边界对齐）、柱子（InstancedMesh）、底板、数值表图层、等高线。
- `contours.ts`：在曲面三角网上用 marching triangles 追踪 SVM = 0.4 / 1.0 / 3.0 等值线，选平直处放置带底色的数值标签并在标签处断线。
- `camera.ts` + `controls.ts`：一套参数同时描述透视和正交相机，所以立体 ↔ 俯视是连续的镜头运动，末端无缝换成正交相机；用户的缩放 / 平移按相对于“适配画面”的比例保存，改变画幅或导出时构图不变。
- `hud.ts` + `axes.ts` + `text.ts`：坐标轴标签、标题、色标用 Canvas 2D 绘制成纹理后在 WebGL 画布里合成（中文用系统字体，拉丁字母用内置 Inter），标签按屏幕间距剔除，互不重叠。
- `values.ts`：俯视数值表，一个面板一张纹理，字号随单元格大小，放不下就不画。
- `frame.ts`：`FrameParams` 描述一帧中随时间变化的一切（高度系数、柱子生长、等高线绘制进度、透明度、相机）。静态视图的过渡和开场动画都产出 `FrameParams`，由引擎命令式地写入 uniform、实例矩阵和相机。

**开场动画**（`engine/intro.ts`，ADR 0003）：G255 一排柱子长出 → 镜头连续转向俯视，其余灰阶自上而下波浪式长出 → 柱子压平、镜头收窄为正交、数值表淡入 → 热力图在同一套单元格上淡入 → 等高线逐条画出。画面是时间 t 的纯函数，最后一帧等于“曲面 + 俯视 + 等高线”的静态画面；总长 `INTRO_DURATION`（约 13.2 秒）。开场动画只演示记录 A，并排 / 差值布局下也是如此。

### 3.5 2D 截面（`src/chart2d`）

- `scene.ts`：数据 + 设置 + 扫描时间 → 图表模型（与像素无关的纯函数）。
- `slices.ts`：截面与扫描。灰阶扫描 G255 → G50，档位亮度扫描 500 → 2 nits（对数），时长 `SWEEP_DURATION` = 10 秒，easeInOutSine 缓动。静态截面（不在扫描或过渡中）经 `settleSlice()` 处理：每个点要么完全不透明（插值权重 a ≥ 0.5，与数据表、统计的取值规则一致），要么视为缺口、只画虚线桥接，不会出现半透明的“残影”线段；扫描时的淡入淡出规则不变。
- `spline.ts`：单调三次（Fritsch–Carlson）插值，同时用于画曲线、悬停读数和数据表，读数与画出的线一致。
- `scales.ts`：标准 / 自适应 / 自由三种坐标范围和刻度。
- `render.ts`：Canvas 2D 绘制，所有字号、线宽、边距乘以 UI 缩放 `s`（1 = 1600×900 参考布局），屏幕、1080p、4K、竖屏共用一套设计。标题和图例都画在画布里。
- 颜色：同一机型同一颜色（`data/colors.ts`，按首次出现顺序分配，色盲安全），同一机型的不同模式用不同线型（ADR 0006）。
- 绘制循环用 `requestAnimationFrame` 读 ref 和时间轴，悬停提示直接改 DOM，不触发 React 渲染。

### 3.6 统计（`src/data/stats.ts`、`src/stats`）

指标定义见 ADR 0009：统计范围 = 当前裁剪和亮度上限下的 GridView；安全 / 中等 / 临界占比和平均值按单元格面积加权；另有峰值、全白达标亮度、典型亮度 SVM、有效单元格数。`computeRecordStats()` 按“矩阵 + 选项”缓存；`stats/model.ts` 负责排序、每列最佳值和“复制为 TSV”。

### 3.7 时间轴（`src/timeline`）

`Timeline` 是一个时钟：`time`（秒）、播放 / 暂停 / 拖动 / 调速（0.5×–2×）/ 循环。视图在自己的渲染循环里读取 `timeline.time` 并据此求值画面；React 只订阅粗粒度变化（播放状态、结束等）。打开动画的视图用 `useRegisterActiveTimeline()` 登记为“当前动画”，空格、←/→、R 等全局快捷键作用于它。

### 3.8 导入与异常值

- 粘贴 / 拖放 / 选择 TSV、TXT：`parse.splitTables()` 把一次粘贴拆成多张表，`parseRawData()` 逐张解析（表头为亮度百分比，每列是“nits、SVM”两格或一格；可设亮度校正系数）。无法解析的格为 `null`。
- JSON：`records.validateDataset()` 校验矩阵形状；缺少 `headerNits` 时从最高灰阶行重建。v1 导出的文件可以直接导入。
- 异常筛查（ADR 0012）：没有 `excluded` 字段的导入数据用 `detectAnomalies()` 检测，导入器按原因显示数量；勾选“剔除明显异常值（推荐）”（默认开启）时由 `excludeAnomalies()` 把这些格设为 `null`，原始值和原因写入 `record.excluded`，`restoreExcluded()` 可原样还原。规则依次为：低于噪声底、重复列 / 行、陈旧读数（median polish 拟合亮度规律）、SVM 尖峰。
- 界面对剔除的呈现统一用 `exclusionSummary()` 和 `common.exclusion.*` 文案：记录面板显示“有效 / 名义”格数和“已剔除 N”徽标，统计页显示覆盖率，3D 中缺失格用中性斜纹表示，2D 图例在有剔除的记录后加标记；缺失格之间从不连线。

## 4. 导出（`src/export`，ADR 0010）

视图在挂载期间向 `registry.ts` 注册一个 **ExportTarget**：

```ts
interface ExportTarget {
  id: MainTab;
  fileName(kind?: 'image' | 'video'): string;      // 不含扩展名
  animation(): { duration: number; label: string; fileName?: string } | null;
  begin(size): Promise<void>;                       // 切到指定尺寸渲染
  renderFrame(t: number | null): Promise<HTMLCanvasElement>;
  end(): void;                                      // 恢复交互渲染（出错时也会调用）
  viewSize?(): { width: number; height: number };   // 当前画布的绘图缓冲尺寸（设备像素）
}
```

- **PNG**（`png.ts`）：`begin(size)` → `renderFrame(null)` → 立即复制到 2D 画布（WebGL 缓冲在合成后会被清空）→ `end()` → 编码。`renderFrame(null)` 必须渲染用户此刻看到的画面：动画开着（播放、暂停或拖到某处）时，就渲染动画在当前时间的那一帧。导出开始前会暂停正在播放的时间轴，结束后恢复。
- **视频**（`video.ts`）：按帧求值 `renderFrame(i / fps)`，帧数 = 时长 × fps + 1（最后一帧是动画终点）。优先 WebCodecs 编码 H.264（硬件优先），不支持时用 VP9，都封装为 MP4（mp4-muxer）；两者都是离线逐帧渲染，与机器速度无关，不掉帧。浏览器没有可用的 WebCodecs 编码器时退回 MediaRecorder 实时录制（WebM / MP4）。编码器队列有背压，可随时取消。`codecs.ts` 按分辨率和帧率选择 H.264 level。
- **尺寸**（`presets.ts`）：当前视图（`viewSize()`，与屏幕上的画面尺寸和比例一致，最长边不超过 4096）/ 1080p / 1440p / 4K，画幅 16:9、9:16、1:1；视频尺寸取偶数。
- **文件名**：PNG 用 `fileName('image')`；视频优先用 `animation().fileName`（例如 2D 扫描、并排布局下只含记录 A 的开场动画），否则用 `fileName('video')`；再附上尺寸和帧率。`safeFileName()` 去掉 Windows / macOS 不允许的字符，保留中文；标题里的“·”连同两侧空格合并为一个 `_`。
- `session.ts`：同一时间只有一个导出任务；进度弹窗的预览画布命令式绘制（约 8 Hz），React 状态最多约 12 Hz 更新一次。导出期间全局快捷键被屏蔽，Esc 取消。
- 没有记录、在统计页、或视图尚未注册时，“导出”按钮禁用并在提示中说明原因。并排 / 差值布局下，导出对话框提示视频只演示记录 A。

## 5. 构建与离线版

```bash
npm run dev               # 开发服务器（http://localhost:3000）
npm run build             # 网页版 → dist/，内置记录运行时从 ./datasets/ 读取
npm run build:standalone  # 单文件离线版 → release/SVM-Visualizer.html
```

需要 Node.js 20.19+ 或 22.12+（`package.json` 的 `engines`，由 @vitejs/plugin-react 决定）；运行单元测试需要 22.12+（vitest 5）。推荐 Node.js 22 LTS。

**网页版**：`base: './'`，可以部署到任意静态服务器的任意子路径，无需改配置。新增内置记录只需把 JSON 放进 `public/datasets/` 并更新 `manifest.json`，不必重新构建网页版（浏览器按 `cache: 'no-store'` 读取）。

**离线版**（`vite build --mode standalone`，ADR 0008）：

- `VITE_STANDALONE` 为真时，`data/bundled.ts` 改从 `bundledEmbedded.ts`（`import.meta.glob`）读取内嵌的数据集；`publicDir` 关闭，favicon 改为内联 data URI，不链接网页版 manifest（file:// 下会报错）。
- vite-plugin-singlefile 把全部 JS、CSS、字体内联进一个 HTML。
- 体积优化（`vite.config.ts` 的 `standaloneTrim`）：只内联 Inter 的 woff2 字体（能运行本应用的浏览器都支持 woff2）；数据集只内嵌 `matrix`、`excluded` 和元数据，扁平的 `data` 列表在加载时重建。
- `scripts/finalize-standalone.mjs`：检查没有任何外部或本地文件引用（`<script src>`、`<link href>`、`url(http…)`、`@import`）、全部内置数据集都已内嵌，写入构建输入指纹 `<meta name="svm-build-inputs">` 和版本号 `<meta name="svm-version">`，输出到 `release/SVM-Visualizer.html`（`--out <文件>` 可改输出位置）。
- **防止离线版过期**：指纹是 `src/`、`public/`、`index.html`、`vite.config.ts`、Tailwind / PostCSS 配置和 `package-lock.json`（只取已解析的依赖）的 SHA-256（`scripts/build-inputs.mjs`；不含测试文件，换行统一为 LF）。`src/export/releaseFreshness.test.ts` 重新计算并与文件里的指纹比较，不一致时 `npm test` 失败并提示 “run `npm run build:standalone`”。改了源码就要重新生成并提交离线版。`npm run check:release` 只跑这一项；确定稍后会统一重建时，可用 `SVM_SKIP_RELEASE_CHECK=1` 跳过。
- `scripts/verify-standalone.mjs`：用 Playwright 以 file:// 打开离线版，检查指纹、无报错、无网络请求、内置记录数量、WebCodecs 可用、设置经 IndexedDB 跨刷新保存、IndexedDB 被禁用时仍能启动。

**启动器**：`start-svm.bat`（Windows）、`start-svm.command`（macOS）、`start-svm.sh`（Linux）优先以 Edge / Chrome / Chromium 的 `--app` 窗口打开离线版，找不到时用默认浏览器；没有离线版时先检查 Node.js 版本，再启动开发服务器（端口 5188）。`create-desktop-shortcut.bat` 调用 `scripts/windows/create-shortcut.ps1` 在桌面创建带图标（`release/icon.ico`）的快捷方式。

## 6. 测试与检查

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest：src/**/*.test.ts
```

单元测试覆盖：网格与插值（`data/grid.test.ts`）、异常检测（`data/anomalies.test.ts`）、记录解析（`data/records.test.ts`）、统计（`data/stats.test.ts`、`stats/model.test.ts`）、2D 截面与样条（`chart2d/chart2d.test.ts`）、3D 模型与开场动画（`scene3d/engine/model.test.ts`、`intro.test.ts`）、导出尺寸 / 帧时间 / 编码参数 / 文件名（`export/presets.test.ts`、`export/exportNames.test.ts`）、离线版是否过期（`export/releaseFreshness.test.ts`）。

浏览器端检查（需要 Playwright，用 `PW_MODULE` 指向其 `index.mjs`）：

- `scripts/dev/snap.mjs <url> <输出目录> [steps.json]`：按步骤操作并截图，报告控制台错误和外部请求。
- `scripts/verify-export.mjs <开发服务器 url>`：用仅开发模式可用的模拟导出目标（`?mockExport`）驱动真实的导出界面，检查 PNG 尺寸、MP4 封装与解码时长、取消和兜底路径。
- `scripts/verify-standalone.mjs [离线版文件]`：见 §5。

自动化句柄：`window.__svm.store`（Zustand store，例如 `getState().set('view', 'top')`）和 `window.__svm.timeline()`（当前动画的时间轴，可 `seek(t)`）。检查动画时，在相近的 t 上逐帧截图，比较相邻帧的平均像素差，确认没有周期性的尖峰。

## 7. 添加内置数据

1. 在应用里粘贴 Excel/TSV 或导入 JSON，检查预览、亮度校正和异常筛查结果，然后在记录面板中导出 JSON。
2. 把文件放进 `public/datasets/`（文件名区分大小写）。
3. 在 `public/datasets/manifest.json` **末尾**追加一条：`file`、`device`、`mode`，可选 `deviceEn`、`modeEn`。追加到末尾能保证已有机型的颜色不变。同一台设备的不同模式请使用完全相同的 `device`，这样 2D 图中它们同色、不同线型。
4. 在 [`DATASETS.md`](DATASETS.md) 中写明设备、刷新率、调制模式、覆盖范围、测量条件，以及剔除过哪些点。
5. 运行 `npm test`；再运行 `npm run build:standalone` 并提交新的 `release/SVM-Visualizer.html`（否则 `releaseFreshness` 测试会失败）。

## 8. 界面文案

所有界面文字都经过 `src/i18n`（ADR 0005）：每个模块一个 `strings/<模块>.ts`，导出 `{ zh, en }`；用 `t('<模块>.<路径>', { 变量 })` 取用，`{n}` 形式插值。缺少某个键时回退到中文，再回退到键名（开发模式下警告一次）。记录名称属于数据，不翻译；内置记录的英文名来自 manifest。
