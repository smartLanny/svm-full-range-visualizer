# 0008 零外部运行时依赖 + 单文件离线版 + 快速入口

- 状态：已采纳（2026-09）

## 背景
- 样式依赖 `cdn.tailwindcss.com`，3D 文字（drei `<Text>`）默认从 jsDelivr 下载字体；网络不通时 3D 视图崩溃、数据列表为空。国内网络下这两个 CDN 都不稳定。
- `manifest.json` 中 iPhone 文件名大小写与实际文件不符，在区分大小写的服务器上加载失败。

## 决定
- Tailwind 改为构建期编译；3D 字体随包本地提供；运行时不访问任何外部网络。
- 提供**单文件离线版** `release/SVM-Visualizer.html`：所有代码、样式、字体、内置记录都内联，双击即可打开，无需 Node、无需联网。
- 快速入口：`start-svm.bat`（Windows）/ `start-svm.command`（macOS）以“应用窗口”方式打开离线版（Edge/Chrome `--app` 模式，无地址栏）；`create-desktop-shortcut.bat` 在桌面创建带图标的快捷方式。
- 修正 manifest 文件名大小写。

## 后果
不引入 Electron/Tauri（体积大、需要各平台打包）；需要时可在此基础上再封装。
