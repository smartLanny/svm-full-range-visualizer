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
    denoise.ts        降噪：检测 + 显示时处理 processRecord（ADR 0012 补充），displayNotes 按显示的矩阵找回说明
    denoiseText.ts    降噪说明的白话文案（提示、徽标、导入预览共用）
    anomalies.ts      旧版破坏性剔除（已被降噪取代；应用只用其中的 restoreExcluded 还原旧文件）
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
  stats/              统计页（卡片 / 表格 / 缩略热力图 heatmap.ts）+ 导出（exportRender / exportLayout / exportContents）
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
- `excluded`（旧格式）：旧版“剔除”挪出的原始测量点。加载时由 `rawDataset()` 放回网格，记录在内存和本地保存中永远是原始读数。

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

场景加权 SVM（ADR 0009 补充“场景加权参考”）：`data/scenarios.ts` 的 `scenarioReference(record, config)` 在（log10 档位亮度 × 灰阶）平面上对夜间 / 室内 / 户外三个矩形求面积加权算术平均（部分落入的格按重叠面积、名义单元格布局、外侧边界不外推），覆盖率 ≥ 40 % 的场景按权重合成综合，否则重新分配权重；分级 `scenarioGrade()`（界限 0.4 / 1.0 / 3.0）。它与统计范围无关，结果挂在 `RecordStats.scenario` 上（`StatsOptions.scenarios`，默认 `DEFAULT_SCENARIOS`），按“矩阵 + 配置”单独缓存。配置保存在设置 `scenarios`，`store/bootstrap.ts` 用 `sanitizeScenarios()` 逐个场景校验；设置面板 `ScenarioSettings` 可编辑并恢复默认。界面：卡片底部 `stats/parts.tsx` 的 `ScenarioBlock`，表格列组与 `model.ts` 的 `scenario / scNight / scIndoor / scOutdoor` 指标（越低越好；权重被重新分配的综合不参与“最佳”），TSV 末尾四列，导出 `exportRender.ts` 同步绘制。3D 俯视叠加层 `scene3d/engine/scenarioOverlay.ts`（`overlays.scenarios`，默认关）。

### 3.7 时间轴（`src/timeline`）

`Timeline` 是一个时钟：`time`（秒）、播放 / 暂停 / 拖动 / 调速（0.5×–2×）/ 循环。视图在自己的渲染循环里读取 `timeline.time` 并据此求值画面；React 只订阅粗粒度变化（播放状态、结束等）。打开动画的视图用 `useRegisterActiveTimeline()` 登记为“当前动画”，空格、←/→、R 等全局快捷键作用于它。

### 3.8 导入与降噪

- 粘贴 / 拖放 / 选择 TSV、TXT：`parse.splitTables()` 把一次粘贴拆成多张表，`parseRawData()` 逐张解析（表头为亮度百分比，每列是“nits、SVM”两格或一格；可设亮度校正系数）。无法解析的格为 `null`。
- JSON：`records.validateDataset()` 校验矩阵形状；缺少 `headerNits` 时从最高灰阶行重建。v1 导出的文件可以直接导入。
- 导入的记录始终是**原始读数**（带 `excluded` 的旧 JSON 由 `rawDataset()` 还原）。导入器的预览用 `shell/screening.ts` 的 `screenDataset()`（即 `denoiseSummary()`）列出降噪将处理的格子，没有需要勾选的选项。
- **降噪**（ADR 0012 补充）：`data/denoise.ts` 的 `processRecord(record, { denoise })` 是唯一的处理步骤，纯函数、按“记录 + 选项”缓存。设置 `denoise`（默认开）决定视图拿到什么：`store/appStore.ts` 的 `displayOf()` / `processedOf()`（非 React）和 `store/hooks.ts` 的 `useDisplayRecords()` / `useProcessed()`。3D（`Scene3DView.readSettings` 把 A、B、C–F 换成显示记录）、2D（`Chart2DView` 的 `ChartInputs.records`）、统计（`StatsView`）和它们的导出都用显示记录，所以同一开关对所有视图和导出一致。
- 显示记录的说明用 `displayNotes(record)` 按**显示的矩阵对象**找回（`noteGrid[行][列]`、`noteAt(gray, %)`、`levelNoteAt(%)`、`summary`），原始记录返回 `null`。3D 提示用 `scene3d/engine/cellNotes.ts`（差值图同时给出 A 的格和 B 被重采样用到的格），2D 用 `chart2d/denoiseMarks.ts` 把截面点映射回格子（`pointCells` / `pointNotes` / `gapNotes`，曲线节点带 `keys`，`curveSpanAt()` 找十字线下的曲线段或空缺），文案统一用 `data/denoiseText.ts`（`common.denoise.*`）。
- 呈现：无有效数据的格与缺失格一样用中性斜纹（3D、热力图、缩略图），2D 曲线在此断开（点线示意）。插值补全的格：俯视图中在采样点画小空心圆（`materials.makeInterpMaterial`，只在地形压平时淡入，数值表显示时让开，格子小于约 11 px 时不画），2D 静态截面上画空心点（扫描动画中不画），数据表中为斜体虚线下划线；悬停任一被处理的格子都显示“做了什么 / 原因 / 插值来源或亮度估算方式 / 原始读数”。记录面板显示“降噪 N 格”徽标，统计页显示统计范围内的“降噪 N 格”并在 TSV 中给出插值补全 / 无有效数据 / 亮度估算三列；覆盖率把实测格和插值格都算作有效。

## 4. 导出（`src/export`，ADR 0010）

视图在挂载期间向 `registry.ts` 注册一个 **ExportTarget**，并通过 `contents()` 列出可导出的**内容**（ADR 0010 补充“导出内容”）：

```ts
interface ExportTarget {
  id: MainTab;
  contents?(): ExportContent[];                     // 当前画面、俯视热力图、并排对比、截面、动画视频……
  fileName(kind?: 'image' | 'video', content?: string): string;   // 不含扩展名
  animation(content?: string): { duration: number; label: string; fileName?: string } | null;
  begin(size, content?: string): Promise<void>;     // 切到指定尺寸渲染，并加上该内容的离屏覆盖
  renderFrame(t: number | null, content?: string): Promise<HTMLCanvasElement>;
  end(): void;                                      // 撤掉覆盖、恢复交互渲染（出错时也会调用）
  viewSize?(): { width: number; height: number };   // 当前画布的绘图缓冲尺寸（设备像素）
}
interface ExportContent { id: string; kind: 'image' | 'video'; label: string; detail?: string; duration?: number; current?: boolean; icon?: … }
```

- **内容**：对话框先列出当前视图的内容（`contents.ts` 的 `listContents()`：去重、视频以 `animation(id)` 的时长为准；没有 `contents()` 的旧目标隐含 `current` + `animation`），默认选中上次在该视图导出的内容（仍可用时），否则“当前画面”。3D 的内容与离屏场景见 `scene3d/exportContents.ts`（引擎 `beginExport(w, h, { layout?, view? })`），2D 见 `chart2d/exportContents.ts`（覆盖 `sliceMode`），统计页见 `stats/exportContents.ts`（统计卡片 / 统计表格，只有图片）。覆盖只在 `begin()`/`end()` 之间存在，不写 store；`end()` 后屏幕逐像素还原。
- **统计页**（ADR 0010 补充“统计页”）：不截 DOM，而是 `stats/exportRender.ts` 用 Canvas2D 按屏幕设计（设计像素 = StatsCard / StatsTable 的 CSS px）重画：标题 / 统计范围条、卡片网格或表格、底部图例条。每张卡片、每段表格由一个“遍历”函数从上到下排版，不传画布时只测量高度，传画布时同时绘制，所以排版与绘制不会不一致。`stats/exportLayout.ts`（纯函数、有单元测试）按导出尺寸选列数和卡片宽度（296–460 设计像素，所有卡片同高），表格在竖屏且能明显放大文字时分成两段（记录列重复），宽度不够时行高最多加 50 % 填满。热力图缩略图与屏幕共用 `stats/heatmap.ts`。“在 3D 中查看”按钮、悬停状态和未激活列的排序图标不画。
- **PNG**（`png.ts`）：`begin(size, id)` → `renderFrame(null, id)` → 立即复制到 2D 画布（WebGL 缓冲在合成后会被清空）→ `end()` → 编码。对“当前画面”，`renderFrame(null)` 必须渲染用户此刻看到的画面：动画开着（播放、暂停或拖到某处）时，就渲染动画在当前时间的那一帧。导出开始前会暂停正在播放的时间轴，结束后恢复。
- **视频**（`video.ts`）：按帧求值 `renderFrame(i / fps, id)`，帧数 = 时长 × fps + 1（最后一帧是动画终点）。优先 WebCodecs 编码 H.264（硬件优先），不支持时用 VP9，都封装为 MP4（mp4-muxer）；两者都是离线逐帧渲染，与机器速度无关，不掉帧。浏览器没有可用的 WebCodecs 编码器时退回 MediaRecorder 实时录制（WebM / MP4）。编码器队列有背压，可随时取消。`codecs.ts` 按分辨率和帧率选择 H.264 level。
- **尺寸**（`presets.ts`）：当前视图（`viewSize()`，与屏幕上的画面尺寸和比例一致，最长边不超过 4096）/ 1080p / 1440p / 4K，画幅 16:9、9:16、1:1；视频尺寸取偶数。
- **文件名**：PNG 用 `fileName('image', id)`；视频优先用 `animation(id).fileName`（例如 2D 扫描、并排布局下只含记录 A 的开场动画），否则用 `fileName('video', id)`；再附上尺寸和帧率。文件名在 `begin()` 之前确定。`safeFileName()` 去掉 Windows / macOS 不允许的字符，保留中文；标题里的“·”连同两侧空格合并为一个 `_`。
- `session.ts`：同一时间只有一个导出任务；进度弹窗的预览画布命令式绘制（约 8 Hz），React 状态最多约 12 Hz 更新一次。导出期间全局快捷键被屏蔽，Esc 取消。
- 没有记录、或视图尚未注册导出目标时，“导出”按钮禁用并在提示中说明原因；可用时提示列出该视图可导出的内容。3D、2D 和统计页都注册了目标。并排 / 差值布局下，开场动画视频一项注明只演示记录 A。
- 端到端校验：`scripts/verify-export.mjs`（导出引擎，DEV 模拟目标）和 `scripts/verify-export-contents.mjs`（真实视图的每项内容：尺寸、非空白、视角正确、文件名、屏幕与 store 不变；统计页另查已知排版的渲染、每张卡片的文字与缩略图、导出卡片与屏幕卡片逐像素接近；`--quick` 跳过视频，`--only=3d|2d|stats|header` 只跑一部分）。

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
- 体积优化（`vite.config.ts` 的 `standaloneTrim`）：只内联 Inter 的 woff2 字体（能运行本应用的浏览器都支持 woff2）；数据集只内嵌 `matrix`、`excluded`（旧格式，加载时还原）和元数据，扁平的 `data` 列表在加载时重建。
- `scripts/finalize-standalone.mjs`：检查没有任何外部或本地文件引用（`<script src>`、`<link href>`、`url(http…)`、`@import`）、全部内置数据集都已内嵌，写入构建输入指纹 `<meta name="svm-build-inputs">` 和版本号 `<meta name="svm-version">`，输出到 `release/SVM-Visualizer.html`（`--out <文件>` 可改输出位置）。
- **防止离线版过期**：指纹是 `src/`、`public/`、`index.html`、`vite.config.ts`、Tailwind / PostCSS 配置和 `package-lock.json`（只取已解析的依赖）的 SHA-256（`scripts/build-inputs.mjs`；不含测试文件，换行统一为 LF）。`src/export/releaseFreshness.test.ts` 重新计算并与文件里的指纹比较，不一致时 `npm test` 失败并提示 “run `npm run build:standalone`”。改了源码就要重新生成并提交离线版。`npm run check:release` 只跑这一项；确定稍后会统一重建时，可用 `SVM_SKIP_RELEASE_CHECK=1` 跳过。
- `scripts/verify-standalone.mjs`：用 Playwright 以 file:// 打开离线版，检查指纹、无报错、无网络请求、内置记录数量、WebCodecs 可用、设置经 IndexedDB 跨刷新保存、IndexedDB 被禁用时仍能启动。

**启动器**：`start-svm.bat`（Windows）、`start-svm.command`（macOS）、`start-svm.sh`（Linux）优先以 Edge / Chrome / Chromium 的 `--app` 窗口打开离线版，找不到时用默认浏览器；没有离线版时先检查 Node.js 版本，再启动开发服务器（端口 5188）。`create-desktop-shortcut.bat` 调用 `scripts/windows/create-shortcut.ps1` 在桌面创建带图标（`release/icon.ico`）的快捷方式。

## 6. 测试与检查

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest：src/**/*.test.ts
```

单元测试覆盖：网格与插值（`data/grid.test.ts`）、降噪（`data/denoise.test.ts`：检测、插值规则、未标记的格与原始读数完全相同等属性测试；`data/denoiseView.test.ts`：显示记录的说明、全部内置记录每条说明的中英文案、3D 提示的格子说明；`chart2d/denoiseMarks.test.ts`：截面点与格子的对应）、旧版剔除（`data/anomalies.test.ts`）、记录解析（`data/records.test.ts`）、统计（`data/stats.test.ts`、`stats/model.test.ts`）、场景加权参考（`data/scenarios.test.ts`：均匀矩阵、部分格裁剪、对数面积加权、缺场景重新分配权重、覆盖率门槛、分级边界、与裁剪 / 上限无关、配置校验；`stats/scenarioExport.test.ts`；`scene3d/engine/scenarioOverlay.test.ts`）、统计页导出的排版与文件名（`stats/export.test.ts`）、2D 截面与样条（`chart2d/chart2d.test.ts`）、3D 模型与开场动画（`scene3d/engine/model.test.ts`、`intro.test.ts`）、导出尺寸 / 帧时间 / 编码参数 / 文件名（`export/presets.test.ts`、`export/exportNames.test.ts`）、离线版是否过期（`export/releaseFreshness.test.ts`）。

浏览器端检查（需要 Playwright，用 `PW_MODULE` 指向其 `index.mjs`）：

- `scripts/dev/snap.mjs <url> <输出目录> [steps.json]`：按步骤操作并截图，报告控制台错误和外部请求。
- `scripts/verify-export.mjs <开发服务器 url>`：用仅开发模式可用的模拟导出目标（`?mockExport`）驱动真实的导出界面，检查 PNG 尺寸、MP4 封装与解码时长、取消和兜底路径。
- `scripts/verify-standalone.mjs [离线版文件]`：见 §5。

自动化句柄：`window.__svm.store`（Zustand store，例如 `getState().set('view', 'top')`）和 `window.__svm.timeline()`（当前动画的时间轴，可 `seek(t)`）。检查动画时，在相近的 t 上逐帧截图，比较相邻帧的平均像素差，确认没有周期性的尖峰。

## 7. 添加内置数据

1. 在应用里粘贴 Excel/TSV 或导入 JSON，检查预览、亮度校正和降噪预览，然后在记录面板中导出 JSON（导出的是原始读数）。
2. 把文件放进 `public/datasets/`（文件名区分大小写）。
3. 在 `public/datasets/manifest.json` **末尾**追加一条：`file`、`device`、`mode`，可选 `deviceEn`、`modeEn`。追加到末尾能保证已有机型的颜色不变。同一台设备的不同模式请使用完全相同的 `device`，这样 2D 图中它们同色、不同线型。
4. 在 [`DATASETS.md`](DATASETS.md) 中写明设备、刷新率、调制模式、覆盖范围、测量条件，以及降噪会处理哪些格子（表格里的一行）。
5. 运行 `npm test`；再运行 `npm run build:standalone` 并提交新的 `release/SVM-Visualizer.html`（否则 `releaseFreshness` 测试会失败）。

## 8. 界面文案

所有界面文字都经过 `src/i18n`（ADR 0005）：每个模块一个 `strings/<模块>.ts`，导出 `{ zh, en }`；用 `t('<模块>.<路径>', { 变量 })` 取用，`{n}` 形式插值。缺少某个键时回退到中文，再回退到键名（开发模式下警告一次）。记录名称属于数据，不翻译；内置记录的英文名来自 manifest。
