# SVM 3D Analyzer Pro - 开发文档

本文档旨在为开发人员提供系统的架构概览、模块详解、接口规范及部署指南，帮助新成员快速理解并上手项目开发。

---

## 1. 系统架构设计 (System Architecture)

### 1.1 架构概览
本项目采用现代化的 **单页应用 (SPA)** 架构，基于 **React 19** 和 **TypeScript** 构建。核心渲染层分为两个独立但数据同步的部分：
- **3D 引擎层**：基于 **Three.js** (`@react-three/fiber`)，负责高性能的曲面地形渲染和交互。
- **2D 图表层**：基于 **Recharts**，负责精确的数据截面分析和对比。
- **数据层**：纯前端内存管理，支持 JSON 序列化以实现数据的导入导出。

### 1.2 核心技术栈
| 模块 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **Core** | React 19 + TypeScript | 强类型组件化开发 |
| **Build** | Vite | 极速冷启动与 HMR |
| **3D Engine** | Three.js + R3F + Drei | 声明式 3D 场景构建 |
| **Shaders** | GLSL | 自定义着色器实现高性能热力图渲染 |
| **Charts** | Recharts | 响应式 SVG 图表 |
| **Styling** | Tailwind CSS | 原子化 CSS 样式管理 |
| **State** | React Context / Hooks | 轻量级状态管理 |

---

## 2. 模块划分与核心业务流程 (Modules & Logic)

### 2.1 3D 可视化模块 (`components/Visualizer3D.tsx`)
负责将 SVM 数据渲染为 3D 地形。

- **坐标系映射**：
  - **X 轴 (Brightness)**: 对数坐标 (`log10(nits + 1)`)，以适应 0-500+ nits 的宽动态范围。
  - **Y 轴 (SVM)**: 线性坐标，代表频闪风险高度。
  - **Z 轴 (Gray Level)**: 线性坐标，代表 0-255 灰阶。
- **核心逻辑**：
  - **Mesh 生成**：根据视图模式 (`ViewStyle`) 动态生成 `BufferGeometry` (Surface) 或 `InstancedMesh` (Bars)。
  - **Shader 渲染**：使用自定义 GLSL 着色器 (`utils/colormapUtils.ts`) 在 GPU 端计算热力图颜色和等高线 (`fwidth` 技术)。
  - **相机控制**：
    - `ISO` 模式：使用 `OrbitControls` 实现自由视角。
    - `HEATMAP` 模式：锁定正交相机 (`OrthographicCamera`) 为顶视图，禁用旋转，仅允许平移和缩放。

### 2.2 2D 对比图表模块 (`components/ComparisonChart.tsx`)
负责多数据集的截面分析。

- **性能优化**：
  - **分离关注点**：将数据计算 (`pointsData`) 与颜色渲染 (`chartData`) 分离。拖动取色器时，只更新颜色引用，不触发重昂贵的数据点重算，解决 React 最大更新深度溢出问题。
  - **非受控输入**：取色器 Input 使用 `defaultValue` + `onBlur`，避免实时渲染带来的性能损耗。
- **核心功能**：
  - **灰阶动画 (Physics-Based)**：
    - 模拟亮度随灰阶降低而下降、SVM 随之升高的物理过程。
    - **线性插值**：基于相邻灰阶的真实测量数据进行加权插值，确保动画平滑且符合物理规律。
    - **严格边界**：仅在双端数据均存在时进行插值，**杜绝**低灰阶下亮度数据错误外推的问题。
  - **插值 Tooltip**：当鼠标悬停时，计算非采样点处的线性插值 SVM 值。

### 2.3 数据处理模块 (`utils/dataUtils.ts`)
负责原始数据的清洗和结构化。

- **解析逻辑 (`parseRawData`)**：
  - 自动识别 Excel/TSV 粘贴板内容。
  - 支持 "Compact" (单单元格) 和 "Dual Column" (双列) 两种格式。
  - **亮度校正**：在解析阶段应用 `correctionFactor`，公式：`Nits_Corrected = Nits_Raw * Factor`。
- **数据结构**：
  - 将稀疏的测量数据转换为稠密的 `matrix` 结构，便于 3D 网格生成。

---

## 3. 接口定义 (Interface Definitions)

核心类型定义位于 `types.ts`。

### 3.1 数据集接口 (`Dataset`)
```typescript
export interface Dataset {
  id: string;           // UUID
  name: string;         // 机型/文件名
  data: DataPoint[];    // 原始扁平数据
  matrix: {             // 结构化网格数据 (用于 3D 渲染)
    rows: number[];     // 排序后的灰阶列表 (0-255)
    cols: number[];     // 排序后的亮度百分比列表
    headerNits: number[]; // 255灰阶下的基准亮度 (用于对齐 X 轴)
    grid: (DataPoint | null)[][]; // 二维网格: grid[rowIndex][colIndex]
  };
  color: string;        // 默认线条颜色
}
```

### 3.2 数据点接口 (`DataPoint`)
```typescript
export interface DataPoint {
  gray: number;             // 灰阶值 (0-255)
  brightnessPercent: number;// 亮度百分比 (0-100)
  nits: number;             // 绝对亮度值 (cd/m²)
  svm: number;              // 频闪可视度值
}
```

### 3.3 色谱枚举 (`ColormapType`)
```typescript
export enum ColormapType {
  TURBO = 'TURBO',
  RD_YL_BU_ENHANCED = 'RD_YL_BU_ENHANCED', // 推荐：感知均匀色谱
  TRAFFIC_LIGHT = 'TRAFFIC_LIGHT',         // 绿-黄-红
  COOL_WARM = 'COOL_WARM',                 // 蓝-白-红
  // ... 其他标准色谱
}
```

---

## 4. 数据库设计 (Database Design)

本项目为 **纯前端应用 (Client-side Only)**，**无后端数据库**。

### 4.1 数据持久化策略
- **运行时内存**：所有加载的数据集存储在 React 根组件 (`App.tsx`) 的 `datasets` State 中。
- **会话持久化**：刷新页面后数据会重置（设计如此，确保数据隐私）。
- **文件归档**：
  - **Export**：用户可将当前数据集导出为 `.json` 文件。
  - **Import**：通过读取 JSON 文件恢复完整的数据结构。

### 4.2 JSON 文件结构示例
```json
{
  "id": "abc-123",
  "name": "Model-X_Sample",
  "color": "#ff0000",
  "data": [
    { "gray": 255, "nits": 400.5, "svm": 0.1 },
    { "gray": 127, "nits": 150.2, "svm": 0.8 }
  ],
  "matrix": { ... } // 包含完整的预计算网格数据
}
```

---

## 5. 部署指南 (Deployment Guide)

### 5.1 环境准备
- 确保服务器已安装 Nginx 或 Apache 等静态文件服务器。
- 构建机器需安装 Node.js (v18+)。

### 5.2 构建步骤
1. **安装依赖**：
   ```bash
   npm install
   ```
2. **执行构建**：
   ```bash
   npm run build
   ```
   构建产物将生成在 `dist/` 目录下。

### 5.3 Nginx 配置示例
```nginx
server {
    listen 80;
    server_name svm-analyzer.internal;
    root /var/www/svm-analyzer/dist;
    index index.html;

    # 开启 Gzip 压缩，加速大 JS/JSON 文件加载
    gzip on;
    gzip_types text/plain application/javascript application/json;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 5.4 常见部署问题
- **路径问题**：如果部署在子路径（如 `example.com/svm/`），请在 `vite.config.ts` 中设置 `base: '/svm/'`。
- **缓存问题**：Vite 构建的文件带有 Hash 指纹，通常无需担心缓存，但建议配置 Nginx 的 `Cache-Control` 头。

---
