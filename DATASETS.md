# Bundled measurement datasets

仓库中的 `public/datasets/` 保存了项目附带的 SVM 测量记录，应用启动时会自动加载这些数据，便于直接进行多机型、多刷新率和不同调制模式的对比。

## 数据覆盖

- iPhone 17 Pro Max：标准记录、平滑脉冲记录
- 小米 17 Ultra 徕卡：DC 120Hz、LTPO 120Hz
- 华为 Mate 70 Air：标准、60Hz、低频闪模式、低频闪 60Hz
- 华为 Mate 80 RS：标准、60Hz、低频闪模式、低频闪 60Hz

每份 JSON 都包含完整的亮度列与灰阶行，目标是覆盖“全亮度 × 全灰阶”的 SVM 分布，而不是只展示单一亮度或单一灰阶切片。

## 数据结构

- `data`：有效测量点的扁平列表，包含 `gray`、`brightnessPercent`、`nits`、`svm`
- `matrix.rows`：灰阶轴
- `matrix.cols`：亮度百分比轴
- `matrix.grid`：按灰阶与亮度组织的二维数据；无有效记录的位置保留为 `null`
- `matrix.headerNits`：最高灰阶对应的亮度参考值

应用不会把缺失值自动当成 0，也不会在导入时进行回归补点。对比时请同时关注测量条件、刷新率、调制模式和数据覆盖情况；这些样例用于可视化与相对比较，不应被视为统一实验室基准。

如果你有新的记录，可以在应用中粘贴 Excel/TSV 数据，或导入导出的 JSON 数据集，再将整理后的文件放入 `public/datasets/` 并更新 `manifest.json`。
