# 0010 导出：逐帧离线渲染优先，实时录制兜底

- 状态：已采纳（2026-09）

- **图片**：当前视图导出 PNG，分辨率可选 当前 / 1080p / 1440p / 4K，画幅 16:9 / 9:16 / 1:1。
- **视频**：优先使用 WebCodecs + MP4 封装，按帧求值渲染（动画是时间的纯函数），不受机器性能影响、没有掉帧；30/60 fps。浏览器不支持时退回 MediaRecorder 实时录制（WebM/MP4）。
- 视图通过统一的 `ExportTarget` 接口（`src/export/registry.ts`）暴露给导出模块：`begin(size)` → `renderFrame(t)` → `end()`。
- **文件名**（2026-09 补充）：`safeFileName()` 把空白、文件系统不接受的字符以及标签里的中点（`·` `•` `・`）连同两侧空格合并成一个 `_`，
  例如 `Xiaomi_18_Pro_Max_Adaptive_refresh_Pro_on_Surface_3D_1920x1080.png`，不会出现 `_·_`；中文保留。单元测试见 `src/export/exportNames.test.ts`。
