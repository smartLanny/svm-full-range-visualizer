# 架构决策记录（ADR）

每个文件记录一个已定的决策：背景、决定、后果。修改决策时新增一条 ADR 并在旧条目标注“已被取代”。

| 编号 | 决策 |
| --- | --- |
| [0001](0001-two-modes.md) | 分析模式 + 演示模式并重 |
| [0002](0002-unified-cell-layout.md) | 3D 统一坐标与单元格布局；俯视用正交相机并压平高度 |
| [0003](0003-timeline-driven-animation.md) | 动画由时间轴驱动，保留原分镜 |
| [0004](0004-low-gray-clip-default.md) | 默认隐藏 G<15 |
| [0005](0005-i18n-zh-first.md) | 中文为主，可切英文 |
| [0006](0006-canvas-2d-chart.md) | 2D 图改为 Canvas 自绘；机型分色、模式分线型、图例在图内右上 |
| [0007](0007-local-persistence.md) | 导入数据与设置自动保存在本机浏览器 |
| [0008](0008-offline-standalone.md) | 零外部运行时依赖 + 单文件离线版 + 快速入口 |
| [0009](0009-summary-stats.md) | 统计摘要指标定义 |
| [0010](0010-export.md) | 导出：逐帧离线渲染优先，实时录制兜底 |
| [0011](0011-dark-instrument-style.md) | 深色专业仪器风格 |
| [0012](0012-anomaly-exclusion.md) | 明显异常值：检测与降噪（剔除已被降噪取代） |
