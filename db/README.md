# 屏幕数据库页面（`db/`）

「野生的装机宅屏幕数据库」的网页：一台机型一页，四类实测数据（均匀度、频闪 SVM、反射率、可视角），两台可以并排对比。数据结构见 [`data/README.md`](../data/README.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run db:dev` | 开发服务器，<http://localhost:5341/>。`data/` 和 `public/datasets/` 直接从仓库读取，改了数据刷新页面即可 |
| `npm run db:build` | 构建到 `dist-db/`（已加入 `.gitignore`）：页面 + 用到的数据文件 + `data/site-info.json`（数据版本） |
| `npm run db:preview` | 预览构建结果，<http://localhost:5342/> |
| `npm run db:typecheck` | 只检查数据库代码的类型（`tsconfig.db.json`）；`npm run typecheck` 两套都查 |

`dist-db/` 是纯静态文件，用相对路径（`base: './'`），可以放在任何子路径下（例如 GitHub Pages 的 `/phone-screen-atlas/`）。页面不请求任何外部网址：字体来自 `@fontsource/inter`，中文用系统字体。外链（频闪工具、可视角仿真）只在点击时打开新标签页。

## 地址（hash 路由）

| 地址 | 页面 |
|---|---|
| `#/` | 首页：机型卡片、搜索（名称、英文名、别名、面板码）、按数据类型筛选；`#/?q=gh3&has=uniformity` 可分享 |
| `#/d/<id>` | 机型页；`#/d/<id>/uniformity`（或 `svm`、`reflectance`、`angle`）直接滚到该部分 |
| `#/c/<id1>,<id2>` | 两台对比，窄屏上下排列；均匀度部分先给三档指标对比表 |
| `#/rank` | 均匀度排行榜；`#/rank?cond=100&by=deviation` 可分享（`cond` = 300 / 100 / 10，`by` = area / ninePoint / deviation / cctArea） |

旧 atlas 链接 `?phone=A`、`?phone=A&compare=B`（以及 `#flicker` 等锚点）在打开时自动换成上面的地址（`lib/route.ts` 的 `legacyRoute`）。

## 文件

```
db/
  index.html, icon.svg
  src/
    main.tsx, App.tsx, styles.css      入口、路由、可滚动页面的基础样式
    lib/                                纯函数（都有 *.test.ts）
      route.ts        路由解析 / 生成、atlas 旧参数
      ranking.ts      均匀度排行（按测试条件和指标排序，并列同名次，无数据的单列）
      uniformity.ts   Gamma 2.2 参考、偏差、标记规则
      svm.ts          频闪记录（复用工作台 src/data、src/stats 的纯函数），≤500 nits 无点时放宽上限
      reflectance.ts  曲线读取、悬停吸附到 10 nm 实测点
      angle.ts        可视角摘要读取
      search.ts       首页搜索
      data.ts         数据加载（只加载一次）
      format.ts       数字格式（4 位有效数字、真减号）
    components/       外框、通用控件、机型概览四格
    sections/         四个数据部分：Uniformity / Flicker / Reflectance / Angle（单台和对比共用）
    pages/            Home / DevicePage / ComparePage / RankingPage
  catalog/            目录与可视角摘要的类型、目录测试（数据管线共用）
vite.db.config.ts     数据库的 Vite 配置（root db/、输出 dist-db/、数据文件白名单）
tailwind.db.config.js 复制自工作台 tailwind.config.js 的设计变量
pipeline/site/files.mjs  页面需要的数据文件清单（开发服务器白名单 + 构建复制）与数据版本
```

**和工作台的边界**：`db/` 只读地 import 工作台的 `src/data/*`、`src/stats/Thumbnail.tsx`、`src/stats/parts.tsx`、`src/stats/model.ts`、`src/ui/cn.ts`，从不修改它们；不调用工作台的 `bootstrap()`，不打开工作台的 IndexedDB。工作台的 `vite.config.ts`、`tailwind.config.js`、`src/` 都没有改动，离线版 `release/SVM-Visualizer.html` 不需要重建（`pipeline/isolation.test.ts`、`src/export/releaseFreshness.test.ts`）。

## 显示规则（不编造数据）

- **缺数据**：每类数据按目录里的可用性显示「未测 / 已测待导入 / 部分已测」，首页卡片上写「待测 / 待导入 / 部分」。不估算、不补齐，也不留空白。
- **均匀度排行**：同一测试条件下按一项实测指标排序（面均匀性、9 点均匀性越高越好；偏离面积、面色温差越低越好），按显示精度相同的并列同名次。没有该数值的机型列在表格下方，不排名、不估算。勾选两台进入对比。
- **均匀度**
  - 主数字是**面均匀性**；9 点均匀性、偏离典型值 >10 % 的面积、色温指标、源文件都在默认收起的「更多指标」里。
  - **典型亮度直接写在热力图上**（4 位有效数字）。热力图颜色相对本机典型亮度（PNG 的色阶对「% 典型值」是线性的，已用像素中位数核对：中位数正好落在 100 % 的位置），所以绝对亮度必须看图上的数字；色阶两端同时标 % 和 nits。
  - G20 档在面均匀性数字旁边只给一个**参考亮度**数值（热力图上不再写参考和偏差百分比）；偏差、γ_eff 和公式说明在「更多指标」里。参考亮度即 **Gamma 2.2 参考**：`参考 = W × (20/255)^2.2`，`偏差 = 典型 / 参考 − 1`。W 用同一设定下实测的白场（`whiteMeasuredNits`，目前数据里还没有），没有就用设定值 100 / 10 nits。
  - **彩色「低灰阶亮度偏高」标记只在白场是实测值时出现**（≥ +10 % / ≥ +25 %）。目前所有 G20 档都是按设定白场算的，所以只显示中性的数字和「白场未实测，约 ±10%」，并附上同机 300 nits 白场「实测 / 设定」作为设定误差的参照。低于参考从不标记。
  - 色阶上的「参考」刻度标出 Gamma 2.2 参考亮度在这张图的相对色阶里的位置。
- **频闪**：沿用频闪工具的默认设置（降噪开、G ≥ 15、档位亮度 ≤ 500 nits、截面 G127、默认场景）。记录在 ≤ 500 nits 内没有点时（华为 Mate 90 Pro Max），上限放宽到能覆盖这条记录的值并写明「超出默认 ≤500 nits 显示范围」。同一页面所有热力图共用一个刻度。
- **反射率**：SCI 实线、SCE 虚线，只画仪器的 10 nm 实测点，悬停读数吸附到实测点；同机其他状态以灰线作背景。对比时两边共用纵轴。
- **可视角**：只读 `data/angle/summary.json`（独立项目自己的模型算出的数），不在这里重算。目录标为未测的 profile（iPhone Duo 外屏：独立项目里那组数据是 GH3 的临时替代）只显示「未测」，不给数字。主按钮「全屏打开可视角仿真」打开独立项目首页，并写明要选的机型名（按 profile 直达的链接要等独立项目支持 `#prof=` 之后再加）。
- **对比**：A 蓝 `#4c8dff`、B 橙 `#e0703a`（已用 dataviz 色板校验：色觉缺陷 ΔE 27.5，对比度 ≥ 3:1）。测试条件、热力图类型、可视角状态两边共用；防窥模式和防窥膜共用一个「防窥」选项，但各自标明实际状态。
