# SVM 全范围可视化 · SVM Full-Range Visualizer

一个面向显示测量、屏幕评测和频闪研究的开源工具：把 **全亮度 × 全灰阶** 的 SVM（Stroboscopic Effect Visibility Measure，频闪可视度）测量矩阵变成可交互的 3D 地形、热力图、2D 截面曲线和统计摘要，方便观察频闪风险在不同亮度与灰阶条件下的变化，并直接对比多份测量记录。

界面默认中文，可一键切换 English。

## 最快的打开方式

**不需要安装任何东西：**

1. 下载仓库（或只下载 [`release/SVM-Visualizer.html`](./release/SVM-Visualizer.html)）。
2. 双击 `SVM-Visualizer.html`，用 Edge / Chrome 打开即可。所有代码、样式、字体和内置数据都在这一个文件里（约 2 MB），离线可用。

**像独立软件一样使用（Windows）：**

- 双击 `start-svm.bat`：以“应用窗口”方式打开（无地址栏、无标签页）。
- 双击 `create-desktop-shortcut.bat`：在桌面创建“SVM 全范围可视化”快捷方式，以后从桌面一键打开。

macOS 用户可双击 `start-svm.command`（首次如被系统拦截：右键 → 打开），Linux 用户运行 `start-svm.sh`。它们同样优先用 Chrome / Edge / Chromium 的应用窗口打开，找不到时用默认浏览器。

## 功能

- **3D 地形**：曲面 / 柱状两种呈现；立体、俯视（正交热力图，永不重叠）、正视、侧视四种视角，切换时镜头平滑过渡。柱状图与热力图共用同一套单元格坐标，互相切换位置不跳。
- **开场动画**：G255 柱子长出 → 转俯视、其余灰阶依次长出 → 压平成数值表 → 渐变为热力图 + 等高线。带时间轴：播放/暂停、拖动进度、0.5×–2× 调速、循环。
- **双记录对比**：并排对比（共用色标）和差值图 ΔSVM = A − B（蓝 = A 更好，红 = A 更差）。
- **2D 截面**：固定灰阶看 SVM–亮度曲线，或固定档位亮度看 SVM–灰阶曲线；同一机型同一颜色、不同模式不同线型；图例画在图内，点击可显隐；灰阶扫描（G255→G50）/ 亮度扫描（500→2 nits）动画；可打开数据表，复制当前截面的数值。
- **统计摘要**：安全占比（SVM < 0.4）、临界占比（SVM ≥ 1.0）、全白达标亮度、峰值、平均值、典型亮度下的 SVM、有效数据覆盖率；卡片和可排序表格，可复制为 TSV。覆盖率明显偏低的记录不参与“最佳”高亮，并标注原因。
- **演示模式**：全屏、隐藏所有面板，只保留画面、标题、图例/色标和自动隐藏的时间轴；可选纯黑背景和 16:9 / 9:16 / 1:1 画幅，适合录屏讲解。
- **导出**：3D / 2D 视图导出 PNG（当前视图尺寸，或 1080p / 2K / 4K 的横屏、竖屏、方形）；开场动画和扫描动画逐帧离线渲染导出 MP4（30/60 fps），不受电脑性能影响、不掉帧。动画暂停时导出 PNG，得到的就是屏幕上的那一帧。
- **数据导入导出**：粘贴 Excel/TSV（带实时预览和亮度校正，一次可粘贴多张表）、导入 JSON（兼容 v1 导出文件）、拖放文件导入、导出 JSON。导入的数据自动保存在本机浏览器，不会上传。
- **异常值筛查与剔除**：导入时自动检查明显无效的读数（低于仪器噪声底、重复的整列/整行、陈旧读数、SVM 尖峰），按原因列出数量，默认勾选“剔除明显异常值（推荐）”。剔除的点在图上显示为“无有效数据”，不会被当成 0，也不会被插值连起来；原始值和原因保存在记录的 `excluded` 字段里，可以还原。规则见 [ADR 0012](./docs/adr/0012-anomaly-exclusion.md)。
- **内置对比样例**：iPhone 17 Pro Max、小米 17 Ultra 徕卡、华为 Mate 70 Air、华为 Mate 80 RS、小米 18 Pro Max 共 14 条不同刷新率 / 调制模式的记录，启动后自动加载。小米 18 Pro Max 两条记录已剔除低亮度、低灰阶区域的异常读数（详见 [`DATASETS.md`](./DATASETS.md)）。

### 快捷键

| 键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停当前动画 |
| ← / → | 动画后退 / 前进 0.5 秒（Shift：2 秒） |
| [ / ] | 3D 开场动画跳到上一章 / 下一章 |
| R | 重播 |
| F | 进入 / 退出演示模式（Esc 也可退出） |
| H | 隐藏 / 显示画面内的标题与图例、色标（录制干净画面）；统计页只在演示模式中隐藏页头 |
| 1 / 2 / 3 | 切换 3D 地形 / 2D 截面 / 统计 |
| T | 3D 视图在立体与俯视间切换 |
| ? | 显示快捷键 |

## 开发

需要 Node.js 20.19+ 或 22.12+（推荐 22 LTS；运行单元测试需要 22.12+）。只使用离线版则不需要安装 Node.js。

```bash
git clone https://github.com/smartLanny/svm-full-range-visualizer.git
cd svm-full-range-visualizer
npm install
npm run dev              # 开发服务器
npm run build            # 网页版构建（dist/，可部署到任意静态服务器）
npm run build:standalone # 单文件离线版（release/SVM-Visualizer.html）
npm run typecheck        # 类型检查
npm test                 # 单元测试（包含离线版是否过期的检查）
```

`release/SVM-Visualizer.html` 是提交到仓库的构建产物。修改源码后请运行 `npm run build:standalone` 并一起提交；文件里记录了构建所用源码的指纹，过期时 `npm test` 会提示重新生成。

## 数据说明

内置记录位于 [`public/datasets`](./public/datasets)，网页版通过 [`manifest.json`](./public/datasets/manifest.json) 在运行时发现并加载它们（离线版在构建时内联）。数据字段、覆盖范围和使用边界见 [`DATASETS.md`](./DATASETS.md)。

SVM 是与测量条件相关的指标。比较不同记录时，应同时记录亮度范围、灰阶范围、刷新率、调制模式、仪器和测试条件；应用展示的是原始记录及其可视化，缺失值不会被当成 0，插值只在相邻真实测量点之间进行。

## 文档

- [`CONTEXT.md`](./CONTEXT.md)：领域术语（灰阶、档位亮度、单元格、截面……）
- [`docs/adr`](./docs/adr)：架构与产品决策记录
- [`TECH_DOCS.md`](./TECH_DOCS.md)：实现说明（模块结构、数据流、导出、离线版构建、测试、如何添加数据）
- [`DATASETS.md`](./DATASETS.md)：内置记录的覆盖范围、数据格式和已知特征

## 技术栈

React 19 · TypeScript · Vite · Three.js / React Three Fiber · Canvas 2D · Tailwind CSS · Zustand · IndexedDB · WebCodecs

## 贡献

欢迎提交新的测量记录、可复现的 bug 报告和改进建议。新增数据时请注明设备、刷新率、调制模式、亮度/灰阶覆盖范围和测量条件，并同步更新 `public/datasets/manifest.json`（`device` / `mode` 字段）与 `DATASETS.md`。

## 许可证

本项目采用 [MIT License](./LICENSE)。仓库中的测量数据为随项目提供的示例记录；使用或再发布时请保留数据来源和测试条件说明。
