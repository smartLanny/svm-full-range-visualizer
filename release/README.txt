SVM 全范围可视化 · 离线版
==========================

SVM-Visualizer.html 是完整的单文件离线版：程序、样式、字体和内置测量记录都已内置，
不需要安装 Node.js，也不需要联网。

打开方式（任选其一）
  1. Windows：双击项目根目录的 start-svm.bat，以独立应用窗口（Edge / Chrome，无地址栏）打开。
  2. Windows：双击 create-desktop-shortcut.bat，在桌面生成带图标的“SVM 全范围可视化”快捷方式，
     以后直接双击桌面图标即可。
  3. macOS：双击 start-svm.command（首次如被系统拦截：右键 → 打开；应用窗口打开后可关闭终端窗口）。
     Linux：运行 ./start-svm.sh。
  4. 也可以直接双击 SVM-Visualizer.html，用默认浏览器打开。
     推荐使用最新版 Microsoft Edge 或 Google Chrome（视频导出为 H.264 MP4）。

数据保存
  导入的记录和界面设置自动保存在当前浏览器本地（IndexedDB），不会上传。
  不同浏览器之间不共享；清除浏览器数据会一并清除。
  若把本文件移动到别的文件夹，已保存的数据仍然有效（同一浏览器内）。

icon.ico 是桌面快捷方式使用的图标。
