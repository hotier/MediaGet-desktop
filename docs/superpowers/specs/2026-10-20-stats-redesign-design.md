# 统计页重设计：单项统计卡片化 — 设计规格

日期：2026-10-20 · 状态：已获业主批准（对话内逐项定稿）

## 背景与决策链

业主四项全选（信息过载 / 口径混 / 摆放无章法 / 图表难读）→ 否掉「分组标账 / 减法重排 / 首屏折叠」三案 → 指定抛开现有布局重想 → 我提「个人报告」案（结论句先行）→ 业主定向「**单项统计以卡片的方式展示**」→ 卡片案定稿；开篇结论句**不要**（卡片足够）。

设计立场：这是单机单人工具，不是运维仪表盘——砍掉「看过一次就不会再看」的技术琐事图，每个指标一张卡、一格一事。

## 页面结构（自上而下，全部为卡片）

### 1. KPI 卡 ×4（4 列网格，窄屏降 2 列）

| 卡 | 主值 | 口径标注（卡角） | 补充行（sub） |
|----|------|------------------|---------------|
| 成功率 | 近 30 天成功率（窗口内 `1 − 失败/下载`，无下载样本显示 `—`） | 近 30 天 | 失败 N 次（窗口内） |
| 累计下载 | `health.bytes`（fmtBytes） | 自安装起 | N 个文件 · 自 M 月 D 日起第 D 天（现有 since） |
| 解析 | `parse.total` 次 | 自安装起 | 均耗 X · 通道摘要（全本地 =「全部本地解析」；否则「本地 N · mock M」） |
| 平均速度 | `speed.avgBytesPerSec`（fmtSpeed） | 有耗时样本 | 样本 N 条；0 样本时主值 `—`、sub 沿用现有说明句 |

### 2. 趋势卡（全页唯一 ECharts 图）

- 逐日下载柱状图；**当日失败 > 0 的柱子标红**（失败信息并入趋势，不再单独折线）
- 窗口 Segment 保留现状 `7 / 30 / 90 / 365`；口径 Segment 保留 `次数 / 字节`
- 卡头右侧合计（现有 `desc` 逻辑不动）

### 3. 平台卡 + 类型卡（两列）

- **行式榜单**（名称 + 「N · 占比%」右对齐），不再用 ECharts 条形图
- 平台行可点 → `onNavPlatform(key)`（保留现有跳转交互），卡角标注「点平台名 → 历史页过滤」
- 类型卡同样行式，无跳转

### 4. 常看作者卡

- 行式榜单（`@作者` + 文件数），保留匿名计数注；卡角标注「来自历史明细」

### 删除

- 活跃热力图（`heat`/`heatOption`）
- 单文件体积直方图（`sizeHistogram`/`histogramOption`）
- 解析通道占比图（via 改为解析卡的通道摘要一句；`parse.avgDurationMs` 进 sub）
- `historyScope` 明细窗口跨度描述

## 口径问题的解法

每张卡右上角小字标注口径/来源（「近 30 天」「自安装起」「来自历史明细」），下载快照账与历史明细账不再无标注地混排。

## 不变

- **IPC 契约零改动**：现有 `stats:snapshot` 聚合 + `history:list` 明细足够算出全部卡片数据
- ECharts 依赖与 `charts/EChart`、`charts/palette` 适配器（趋势是唯一消费点）
- 空态页（`isEmptyStats` 分支）与加载骨架（按新卡片重排高度）
- `tests/stats*.test.ts` 的聚合纯函数大多沿用：`trendByDay`/`trendTotal`/`platformRank`/`kindRank`/`authorTop`/`downloadHealth`/`speedStats`/`parseStats`/`since` 不动

## 测试影响面

- 删除：`heat`/`heatOption`、`sizeHistogram`/`histogramOption`、via 榜单 option、`historyScope` 相关用例
- 修改：`trendOption`（失败日红柱断言）
- 新增：近 30 天成功率纯函数（窗口内无下载样本 → `null` → 卡显 `—`）
- `stats-aggregation` / `stats-options` / `stats.test` 按上述删改

## 验收

- L1：改/增的聚合纯函数单测（成功率、红柱标记）
- L5 人工：dev server（mock 桥）核对卡片布局、4 列→2 列降级、平台点击跳历史、口径标注
- 无契约变更 → 不跑 contract/boundaries 专项；收尾全量一次
