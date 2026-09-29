# SVM 全亮度全灰阶可视化工具

一个面向显示测量、屏幕评测和频闪研究的开源 Web 工具：把 **全亮度 × 全灰阶** 的 SVM（Stroboscopic Effect Visibility Measure，频闪可视度）测量矩阵转换为可交互的 3D 地形图、柱状图、热力图和 2D 曲线，方便观察频闪风险在不同亮度与灰阶条件下的变化，并直接对比多份测量记录。

## 这个项目能做什么

- **全范围 SVM 观察**：同时查看亮度、灰阶、nits 和 SVM 值，而不是只看一个亮度点。
- **3D 可视化**：Surface 曲面、Bars 柱状图和 Flat 热力图；支持 ISO/Heatmap 相机、光照和多种色谱。
- **2D 对比分析**：在指定灰阶下比较多台设备或多种刷新/调制模式，并支持标准、Adaptive 和 Free 坐标范围。
- **真实数据插值**：基于相邻测量点进行双线性插值，用于交互展示；不对低灰阶数据做无依据的外推。
- **数据导入导出**：支持 Excel/TSV 粘贴、亮度校正、JSON 导入和 JSON 导出。
- **内置对比样例**：仓库已附带 iPhone 17 Pro Max、小米 17 Ultra、华为 Mate 70 Air、华为 Mate 80 RS 等记录，启动后自动加载。

## 快速开始

需要 Node.js 18 或更高版本。

```bash
git clone https://github.com/smartLanny/svm-full-range-visualizer.git
cd svm-full-range-visualizer
npm install
npm run dev
```

然后打开终端显示的本地地址，通常是 `http://localhost:5173`。

生产构建：

```bash
npm run build
npm run preview
```

Windows 用户也可以双击 `start-svm.bat` 启动本地开发服务。

## 数据说明

内置记录位于 [`public/datasets`](./public/datasets)，应用通过 [`manifest.json`](./public/datasets/manifest.json) 发现并加载它们。数据字段、覆盖范围和使用边界见 [`DATASETS.md`](./DATASETS.md)。

SVM 是与测量条件相关的指标。比较不同记录时，应同时记录亮度范围、灰阶范围、刷新率、调制模式、仪器和测试条件；应用展示的是原始记录及其可视化，不把缺失值、无效值和 0 混为一谈。

## 技术栈

- React 19 + TypeScript
- Vite
- Three.js / React Three Fiber / Drei
- Recharts
- Lucide React
- Tailwind CSS CDN（界面样式）

## 项目结构

```text
components/       3D 可视化、2D 图表和数据导入组件
public/datasets/  随仓库发布的 SVM 测量记录
utils/            数据解析、色谱和下载工具
App.tsx           应用状态与页面布局
TECH_DOCS.md      实现细节和算法说明
DATASETS.md       内置数据集说明
```

## 贡献

欢迎提交新的测量记录、可复现的 bug 报告和改进建议。新增数据时请注明设备、刷新率、调制模式、亮度/灰阶覆盖范围和测量条件，并同步更新 `public/datasets/manifest.json` 与 `DATASETS.md`。

## 许可证

本项目采用 [MIT License](./LICENSE)。仓库中的测量数据为随项目提供的示例记录；使用或再发布时请保留数据来源和测试条件说明。
