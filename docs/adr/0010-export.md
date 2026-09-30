# 0010 导出：逐帧离线渲染优先，实时录制兜底

- 状态：已采纳（2026-09）

- **图片**：当前视图导出 PNG，分辨率可选 当前 / 1080p / 1440p / 4K，画幅 16:9 / 9:16 / 1:1。
- **视频**：优先使用 WebCodecs + MP4 封装，按帧求值渲染（动画是时间的纯函数），不受机器性能影响、没有掉帧；30/60 fps。浏览器不支持时退回 MediaRecorder 实时录制（WebM/MP4）。
- 视图通过统一的 `ExportTarget` 接口（`src/export/registry.ts`）暴露给导出模块：`begin(size)` → `renderFrame(t)` → `end()`。
- **文件名**（2026-09 补充）：`safeFileName()` 把空白、文件系统不接受的字符以及标签里的中点（`·` `•` `・`）连同两侧空格合并成一个 `_`，
  例如 `Xiaomi_18_Pro_Max_Adaptive_refresh_Pro_on_Surface_3D_1920x1080.png`，不会出现 `_·_`；中文保留。单元测试见 `src/export/exportNames.test.ts`。

## 补充：导出内容（2026-09-30）

**背景**：导出原来只有“当前画面 PNG”和视图唯一的动画（3D 开场动画 / 2D 当前截面模式的扫描）。用户要的是“看什么就能导出什么”：
俯视热力图、并排对比（2–6 条）、差值图、另一种 2D 截面……而且最好不必先把屏幕切过去再导出。

**决定**：视图通过 `ExportTarget.contents()` 列出自己的**导出内容**（`ExportContent`：`id`、`kind: 'image' | 'video'`、`label`、`detail`、
视频的 `duration`、`current` = 与屏幕上此刻的画面相同、`icon`）。对话框先选“导出内容”，再选分辨率 / 画幅 / 帧率；
`begin(size, id)`、`renderFrame(t, id)`、`animation(id)`、`fileName(kind, id)` 都带上所选内容的 id。

| 视图 | 内容（id） | 说明 |
| --- | --- | --- |
| 3D | 当前画面（`current`） | 与屏幕完全一致，含缩放 / 旋转；开场动画开着时是那一帧 |
| 3D | 俯视热力图（`top`） | 当前布局（单条 / 并排 2–6 条 / 差值）的俯视，完整视野，屏幕上是立体也一样 |
| 3D | 立体图（`perspective`） | 当前布局的默认立体视角 |
| 3D | 并排对比 N 条（俯视）（`sideBySide`） | 屏幕上不是并排布局、且已配置 A、B（+C–F）时 |
| 3D | 差值图 A−B（俯视）（`diff`） | 屏幕上不是差值布局、且 A、B 有重叠数据时 |
| 3D | 开场动画视频（`intro`） | 记录 A，同原来 |
| 2D | 当前画面（`current`） | 同原来（扫描打开或暂停时是那一帧） |
| 2D | 灰阶截面 G…（`graySlice`）/ 亮度截面 … nits（`levelSlice`） | 当前灰阶 / 当前档位亮度；不在屏幕上的那种用截面模式覆盖渲染 |
| 2D | 灰阶扫描 G255→G50（`graySweep`）/ 档位亮度扫描 500→2 nits（`levelSweep`） | 两个都可选，与屏幕上的截面模式无关；沿用当前坐标模式、可见记录和样式 |

规则：

1. **离屏覆盖，不动 store**。与屏幕不同的内容只在 `begin()` 里加覆盖、在 `end()` 里撤掉：3D 引擎的 *export scene*
   （`Engine.beginExport(w, h, { layout?, view? })`，与开场动画视频已有的 `layoutOverride` 同一思路，视角按默认姿态渲染）；
   2D 给 `buildScene` 传一份改了 `sliceMode` 的输入。导出期间 app store 零更新（持久化的设置自然不变），
   `end()` 之后屏幕逐像素还原（`scripts/verify-export-contents.mjs` 截图比对）。恢复时按屏幕的尺寸与留白重建模型，
   只是不做淡入淡出和镜头动画（引擎的 `restoring` 状态）；导出帧里的模型重建、数值提示变化都不会通知 React。
2. **帧仍是 (内容, t) 的纯函数**；内容图像与“把屏幕切过去再导出当前画面”逐像素相同（校验脚本逐项比对）。
3. **默认选中**：上次在这个视图导出的内容（仍可用时，按视图记在 `svm-export-prefs.v1`），否则“当前画面”。
   与屏幕相同的其他内容标注“屏幕上”。
4. **文件名随内容**：`…_曲面_俯视`、`…_曲面_立体`、`A_vs_B_+2_曲面_俯视`、`diff_A_vs_B_…`、`…_开场动画`、
   `SVM_2D_G127`、`SVM_2D_100nits`、`SVM_2D_sweep_G255-G50`、`SVM_2D_sweep_500-2nits`，再附尺寸 / 帧率。
5. **向后兼容**：没有 `contents()` 的目标隐含两项内容：`current`（当前画面）和 `animation`（有动画时）；
   目标可以忽略 id 参数（旧调用方传 `undefined`：图片 = 当前画面，视频 = 视图的动画）。
6. **可扩展到 DOM / Canvas 视图**（统计页）：契约只要求 `renderFrame()` 返回一块画布，DOM 视图自行把内容画进 2D 画布即可；
   `viewSize()` 返回元素尺寸 × devicePixelRatio。导出按钮只在视图没有注册目标时禁用。
