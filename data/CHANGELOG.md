# 数据更新记录

「野生的装机宅屏幕数据库」每次数据变化记一条，最新的在最上面。导入批次时由 `npm run db:import` 自动写入；当前数据版本见 [`version.json`](version.json)，批次文件和审计记录在 [`batches/`](batches/)。格式说明见 [`pipeline/README.md`](../pipeline/README.md)。

<!-- db:import 在这一行下面插入新条目，不要删除这一行 -->

## 2026.11.02.4 · `2026-11-02-unif-maps`

均匀度热力图：9 台仅指标机型补上热力图，新增华为 Mate 90 Pro Max 典藏版、OPPO Find X9

- 均匀度：iPhone 17 Pro Max 补上热力图 5 张（300 nits、100 nits、10 nits；源 id ip17pm）
- 均匀度：小米 15 Ultra 补上热力图 5 张（300 nits、100 nits、10 nits；源 id mi15u）
- 均匀度：一加 15 补上热力图 5 张（300 nits、100 nits、10 nits；源 id op15）
- 均匀度：OPPO Find X9 Ultra 补上热力图 4 张（300 nits、100 nits；源 id x9u）
- 均匀度：OPPO Find X9s Pro 补上热力图 4 张（300 nits、100 nits、10 nits；源 id x9sp）
- 均匀度：华为 Mate 80 RS 补上热力图 5 张（300 nits、100 nits、10 nits；源 id m80rs）
- 均匀度：华为 Mate 70 Air 补上热力图 5 张（300 nits、100 nits、10 nits；源 id m70a）
- 均匀度：华为 Pura 80 Ultra 补上热力图 4 张（300 nits、100 nits、10 nits；源 id p80u）
- 均匀度：荣耀 Magic V5 补上热力图 5 张（300 nits、100 nits、10 nits；源 id mv5）
- 均匀度：华为 Mate 90 Pro Max 典藏版 新增热力图 5 张（300 nits、100 nits、10 nits；源 id m90pm）
- 均匀度：OPPO Find X9 新增热力图 1 张（100 nits；源 id x9）
- 数量：均匀度档位 35 → 39；均匀度热力图 15 → 63
- 改动的数据文件：`data/uniformity/index.json`、`data/uniformity/maps/10_lum_ip17pm.png`、`data/uniformity/maps/10_lum_m70a.png`、`data/uniformity/maps/10_lum_m80rs.png`、`data/uniformity/maps/10_lum_m90pm.png`、`data/uniformity/maps/10_lum_mi15u.png`、`data/uniformity/maps/10_lum_mv5.png`、`data/uniformity/maps/10_lum_op15.png`、`data/uniformity/maps/10_lum_p80u.png`、`data/uniformity/maps/10_lum_x9sp.png`、`data/uniformity/maps/100_cct_ip17pm.png`、`data/uniformity/maps/100_cct_m70a.png`、`data/uniformity/maps/100_cct_m80rs.png`、`data/uniformity/maps/100_cct_m90pm.png`、`data/uniformity/maps/100_cct_mi15u.png`、`data/uniformity/maps/100_cct_mv5.png`、`data/uniformity/maps/100_cct_op15.png`、`data/uniformity/maps/100_cct_x9u.png`、`data/uniformity/maps/100_lum_ip17pm.png`、`data/uniformity/maps/100_lum_m70a.png`、`data/uniformity/maps/100_lum_m80rs.png`、`data/uniformity/maps/100_lum_m90pm.png`、`data/uniformity/maps/100_lum_mi15u.png`、`data/uniformity/maps/100_lum_mv5.png`、`data/uniformity/maps/100_lum_op15.png`、`data/uniformity/maps/100_lum_p80u.png`、`data/uniformity/maps/100_lum_x9.png`、`data/uniformity/maps/100_lum_x9sp.png`、`data/uniformity/maps/100_lum_x9u.png`、`data/uniformity/maps/300_cct_ip17pm.png`、`data/uniformity/maps/300_cct_m70a.png`、`data/uniformity/maps/300_cct_m80rs.png`、`data/uniformity/maps/300_cct_m90pm.png`、`data/uniformity/maps/300_cct_mi15u.png`、`data/uniformity/maps/300_cct_mv5.png`、`data/uniformity/maps/300_cct_op15.png`、`data/uniformity/maps/300_cct_p80u.png`、`data/uniformity/maps/300_cct_x9sp.png`、`data/uniformity/maps/300_cct_x9u.png`、`data/uniformity/maps/300_lum_ip17pm.png`、`data/uniformity/maps/300_lum_m70a.png`、`data/uniformity/maps/300_lum_m80rs.png`、`data/uniformity/maps/300_lum_m90pm.png`、`data/uniformity/maps/300_lum_mi15u.png`、`data/uniformity/maps/300_lum_mv5.png`、`data/uniformity/maps/300_lum_op15.png`、`data/uniformity/maps/300_lum_p80u.png`、`data/uniformity/maps/300_lum_x9sp.png`、`data/uniformity/maps/300_lum_x9u.png`
- 批次：`data/batches/2026-11-02-unif-maps/`（1 个输入，批次日期 2026-11-02；哈希与逐项核对见 audit.json）

> 用视频项目的 render.py / export_maps.py（pipeline/uniformity/vendor/）对 NAS 上的原始 Radiant 矩阵重新导出，pipeline/uniformity/make_maps.py 打包。9 台已有指标的机型，导出时算出的指标与 uniformity_metrics.json 逐项完全一致（导入器再核对一次）。华为 Mate 90 Pro Max 典藏版的矩阵是 CSV 导出，取默认模式（非低频闪）三档；OPPO Find X9 只有 100 nits G20 一档（NAS 上没有 300 nits 白场和 10 nits G20）。荣耀 Magic V5 为外屏。

## 2026.11.02.3 · `2026-11-02-unif-fullprec`

均匀度指标换成全精度：9 台仅指标机型改用视频项目的 uniformity_metrics.json

- 均匀度：iPhone 17 Pro Max 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id ip17pm）
- 均匀度：一加 15 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id op15）
- 均匀度：OPPO Find X9 Ultra 替换仅指标数据（300 nits、100 nits，无热力图；源 id x9u）
- 均匀度：OPPO Find X9s Pro 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id x9sp）
- 均匀度：华为 Mate 70 Air 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id m70a）
- 均匀度：华为 Mate 80 RS 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id m80rs）
- 均匀度：华为 Pura 80 Ultra 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id p80u）
- 均匀度：小米 15 Ultra 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id mi15u）
- 均匀度：荣耀 Magic V5 替换仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id mv5）
- 数量：不变（只更新了已有数据的来源或附加字段）
- 改动的数据文件：`data/uniformity/index.json`
- 批次：`data/batches/2026-11-02-unif-fullprec/`（1 个输入，批次日期 2026-11-02；哈希与逐项核对见 audit.json）

> 上一批（2026-11-02-unif-9phones）是从均匀性对比图标题按显示精度抄的；这一批直接用生成这些图的 uniformity_metrics.json（render.py 输出，12 台 61 条）。转录值与本文件四舍五入后逐项一致，这里只是换成全精度。库内已有热力图的 3 台只做核对、不改。OPPO Find X9s Pro 的源 id 按文件改为 x9sp。荣耀 Magic V5 为外屏。非默认条件（防窥开、关闭自适应）不导入。

## 2026.11.02.2 · `2026-11-02-unif-9phones`

均匀度指标：iPhone 17 Pro Max、一加 15、OPPO Find X9 Ultra / X9s Pro、华为 Mate 70 Air / Mate 80 RS / Pura 80 Ultra、小米 15 Ultra、荣耀 Magic V5 外屏

- 均匀度：iPhone 17 Pro Max 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id ip17pm）
- 均匀度：一加 15 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id op15）
- 均匀度：OPPO Find X9 Ultra 新增仅指标数据（300 nits、100 nits，无热力图；源 id x9u）
- 均匀度：OPPO Find X9s Pro 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id x9s）
- 均匀度：华为 Mate 70 Air 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id m70a）
- 均匀度：华为 Mate 80 RS 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id m80rs）
- 均匀度：华为 Pura 80 Ultra 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id p80u）
- 均匀度：小米 15 Ultra 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id mi15u）
- 均匀度：荣耀 Magic V5 新增仅指标数据（300 nits、100 nits、10 nits，无热力图；源 id mv5）
- 数量：机型 25 → 26；均匀度档位 9 → 35
- 改动的数据文件：`data/uniformity/index.json`
- 批次：`data/batches/2026-11-02-unif-9phones/`（1 个输入，批次日期 2026-11-02；哈希与逐项核对见 audit.json）

> 数值抄自视频项目 render.py 统一重算后输出的「均匀性对比图」PNG 标题（9 点 VESA/IDMS，面均匀性 Black Mura：1mm 滤波、去边、P0.1/P99.9），按图上显示的精度（百分比 0.1、偏离面积 0.01、色温 1 K）。同一批图里库内已有的 3 台与 index.json 逐项一致。荣耀 Magic V5 为外屏。10 nits G20 未扣反光。

## 2026.11.02 · 基线

数据库建立时已有的数据。这些数据没有经过批次导入，来源记录在 `provenance.json` 和各自的导入脚本里：

- 频闪：21 条记录，8 台机型，在 `public/datasets/`。其中最近的两次导入是：
  - 华为 Mate 90 Pro Max 典藏版，提交 `48bf54c`（2026-10-08）；
  - iPhone Duo 内外屏 4 条，提交 `aa542b7`（2026-10-25）。
- 可视角：独立项目 phone-view-angle-sim `20ef8e6`（2026-10-27）的 8 个 profile 摘要，其中 7 个实测。iPhone Duo 外屏是临时替代数据，记为未测。
- 均匀度：迁自 phone-screen-atlas `0c2846d`（2026-10-09）。3 台机型共 9 档，15 张热力图。
- 反射率：迁自 phone-screen-atlas `0c2846d`。24 台机型，32 个样品，64 条曲线。
- 数量：机型 25 台；频闪 8 台，可视角 5 台，均匀度 3 台，反射率 24 台。
