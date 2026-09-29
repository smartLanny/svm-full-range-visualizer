# 0008 零外部运行时依赖 + 单文件离线版 + 快速入口

- 状态：已采纳（2026-09）

## 背景
- 样式依赖 `cdn.tailwindcss.com`，3D 文字（drei `<Text>`）默认从 jsDelivr 下载字体；网络不通时 3D 视图崩溃、数据列表为空。国内网络下这两个 CDN 都不稳定。
- `manifest.json` 中 iPhone 文件名大小写与实际文件不符，在区分大小写的服务器上加载失败。

## 决定
- Tailwind 改为构建期编译；3D 字体随包本地提供；运行时不访问任何外部网络。
- 提供**单文件离线版** `release/SVM-Visualizer.html`：所有代码、样式、字体、内置记录都内联，双击即可打开，无需 Node、无需联网。
- 快速入口：`start-svm.bat`（Windows）/ `start-svm.command`（macOS）/ `start-svm.sh`（Linux）以“应用窗口”方式打开离线版（Edge/Chrome `--app` 模式，无地址栏）；`create-desktop-shortcut.bat` 在桌面创建带图标的快捷方式。
- 修正 manifest 文件名大小写。

## 后果
不引入 Electron/Tauri（体积大、需要各平台打包）；需要时可在此基础上再封装。

## 补充（2026-09，v2 实现）
- 3D 画布里的文字（坐标轴、标题、色标、等高线标签、数值表）不再使用 drei `<Text>`，改由 Canvas 2D 绘制成纹理（`src/scene3d/engine/text.ts`）：拉丁字母用随包提供的 Inter（@fontsource），中文用系统字体，不需要任何字体文件下载。代码不再引用 drei，依赖中也已移除。
- 离线版只内联 Inter 的 woff2 字体；内置数据集只内嵌 `matrix`、`excluded` 和元数据，扁平的 `data` 列表在加载时由矩阵重建（`vite.config.ts` 的 `standaloneTrim`）。
- 离线版是提交到仓库的构建产物，容易在改代码后忘记重新生成。`scripts/finalize-standalone.mjs` 在文件中写入构建输入指纹（`<meta name="svm-build-inputs">`，算法见 `scripts/build-inputs.mjs`），`src/export/releaseFreshness.test.ts` 在 `npm test` 中重新计算并比对，过期时失败并提示运行 `npm run build:standalone`。
- 启动器：macOS 的 `start-svm.command` 通过常用目录和 Spotlight（bundle id）查找 Chrome / Edge / Chromium / Brave，不使用会弹出 Finder 窗口的 `open -R`；Linux 提供 `start-svm.sh`。没有离线版时，启动器先检查 Node.js 版本（20.19+ 或 22.12+，与 `package.json` 的 `engines` 一致）再启动开发服务器。
