# 主页面导航栏收起 — 设计规格

日期：2026-10-20 · 状态：已获业主批准（对话内逐项定稿）

## 需求

主页面左侧导航栏支持收起/展开：收起后仅显示图标，悬停浮出名称提示；品牌行在收起态只显示展开按钮（原「无文字 logo」构想被「收起时干脆不显示 logo」取代，无需新品牌资产）。收起状态持久化。仅主外壳导航栏，设置页侧栏不变。

## 定稿决策（对话记录）

| 问题 | 决策 |
|------|------|
| 收起形态 | A：56px 窄条，仅图标 + 悬停 tooltip |
| 切换按钮位置 | 品牌行内 logo 右侧（`ms-auto`） |
| 收起态品牌行 | 不显示 logo，只显示展开箭头 |
| 状态持久化 | 是，重启后保持 |
| 范围 | 仅主外壳；设置页侧栏不动 |
| 数字徽标 | 收起时缩为图标右上角小角标（不隐藏） |
| 快捷键 | 不做 |

## 交互形态

- **展开态**（208px，现状不变）：品牌行 = `BrandLogo`（左，垂直落点为「页面顶 0px」与「导航栏顶 56px」中点，即带中心下移 8px）+ 收起箭头按钮（右）。
- **收起态**（56px）：
  - 品牌行 = 展开箭头按钮（图标同款、方向翻转），不渲染 logo。
  - 导航项（首页/下载/历史/统计）：只显示 `AnimIcon`（16px，水平居中），文字标签不渲染；悬停经现有 shadcn `Tooltip` 显示页面名。
  - 底部「设置」按钮：同导航项规则，只留图标；悬停出 tooltip。
  - 「下载」进行中数字徽标：缩为图标右上角小号角标（绝对定位），数字保留。
  - 「更新包已就绪」底部图标按钮：行为不变（本就无文字）。
- 宽度与文字以约 200ms 过渡切换；`prefers-reduced-motion` 下跳过过渡。

## 技术方案

- **状态**：`App.tsx` 内 `sidebarCollapsed` state；初值读 `localStorage`（key `mg.sidebar.collapsed`，值 `"1"`/缺省），变更即写回。
- **不入 `AppSettings`**：收起是 UI chrome 而非用户数据；进设置意味着动 IPC 六件套（types/ipc、ipc-contract zod、handler、preload、bridge、mock-bridge）并沾上脏计数/保存条语义——收益为零，否决。
- **样式**：`styles.css` 在 `--w-side: 208px` 旁新增 `--w-side-collapsed: 56px`；侧栏按状态消费二者。收起态导航按钮 `h-9 w-9` 居中（`px` 收敛为居中布局）。
- **品牌**：无新资产。`BrandLogo` 仅在展开态渲染；`make-icons.cjs` 与 `brand/` 均不动。
- **无 IPC/契约变更**：`CONTRACT_VERSION` 不动，`tests/contract.test.ts`、`tests/boundaries.test.ts` 无新面。

## 组件改动面

| 文件 | 改动 |
|------|------|
| `renderer/src/App.tsx` | state + localStorage 读写；品牌行按钮（收起/展开双态）；导航按钮收起态渲染分支（图标居中 + Tooltip + 角标徽标）；设置按钮同步 |
| `renderer/src/styles.css` | `--w-side-collapsed` token；收起态过渡（如需要则补 utility 类） |
| 设置页 `SettingsPage.tsx` | **不改** |

## 验收

- L1：`localStorage` 读写封装为可测纯函数（初值解析：缺 key = 展开；`"1"` = 收起），加一条单测。
- L5（人工）：dev server `127.0.0.1:5433`（mock 桥）核对——收起/展开动画、tooltip、角标徽标、重启后状态保持、设置页不受影响、拖拽区（drag-region）仍正常。
- 不跑 `contract`/`boundaries`（无契约面）；收尾跑一次 `pnpm typecheck + lint + test`。

## 明确不做

- 设置页侧栏收起；快捷键；收起态二级浮出菜单（hover 展开整条）；记住每个宽度的中间态。
