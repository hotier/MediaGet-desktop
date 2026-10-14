# 即刻解析（mediaGet-desktop）UI/UX 完整设计方案

| 项 | 内容 |
| --- | --- |
| 交付物 | 设计系统 + 四界面信息架构 + 交互规范 + 渐进式落地路线 |
| 适用版本 | `0.1.0`（P1 骨架 + P2 下载/历史/设置 + P3 二进制随包/自动更新骨架） |
| 技术基线 | Electron 44 + Vite 7 + React 19 + TypeScript 5.9，**无 UI 组件库、无 react-router**，样式集中在 `renderer/src/styles.css` 单文件；Tailwind v4 已于 §7 迁移中经业主授权接入（CSS-first `@theme inline` 桥接 Token，非 utility 重写样式） |
| 首发平台 | Windows（NSIS + portable），窗口 1080×740，最小 820×560 |
| 作者 | UI 设计师 Agent |
| 日期 | 2026-10-14 |
| 交付边界 | **只读项目，本方案不修改任何源码**；文档本身写在仓库之外 |

> ⚠️ 撰写期间仓库正被并发修改（`git status` 显示 16 个已跟踪文件为 M，`SettingsPage.tsx` 在我阅读期间从 162 行变为 208 行，`styles.css` 从 412 行变为 437 行）。因此本方案**以选择器 / 组件名 / IPC channel 名为准定位**，行号仅作参考。

---

## 0. 设计前提：四条不可妥协的工程约束

做任何视觉决策前，先把工程边界钉死。这四条决定了哪些"漂亮方案"在本仓是**不可执行**的：

| # | 约束 | 出处 | 对设计的直接影响 |
| --- | --- | --- | --- |
| C1 | CSP `default-src 'self'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'` | `renderer/index.html:6-9` | **禁止 Web 字体（Google Fonts / CDN 字体）**。排版系统只能建立在 Windows 系统字体栈上。图标必须内联 SVG（`'self'` + `data:`），不允许 icon font / 外链 SVG |
| C2 | `img-src 'self' data: blob: https:` | 同上 | 平台封面图、头像可远程加载 —— 但必须处理加载失败与防盗链 403（现用 `referrerPolicy="no-referrer"`） |
| C3 | renderer 只能经 `window.mg` 白名单通信，`sandbox:true` + `contextIsolation:true` | `electron/main/index.ts:206-213`、`docs/ARCHITECTURE.md §1 铁律 1` | 任何新增 UI 能力若要主进程配合，等于**改 4 处**：`types/ipc.ts` → `electron/preload/index.ts` → `electron/main/ipc.ts` → `renderer/src/lib/bridge.ts`。设计必须优先选择**零契约变更**的方案 |
| C4 | 依赖基线（**2026-10-14 业主修订 ×2**）：仅允许已评审的 headless 原语与图标包；package.json 现有 4 个 runtime dep（react/react-dom/zod/electron-updater）+ §7 迁移新增 tailwindcss@4（dev）/lucide-react | `package.json:25-30` + README「关键设计决策」 | **白名单**：`@radix-ui/react-dialog`、`react-select`、`react-switch`、`react-toast`、`lucide-react`、**Tailwind v4（§7 授权，仅作 Token 桥接与少量工具类）**。**仍禁止**：shadcn / framer-motion / tanstack（绑架样式范式或本方案 Token 已覆盖）。动效与 Token 系统仍走原生 CSS；Radix 只接行为/a11y，样式仍由本方案 Token 提供 |

**结论**：本方案是"**在 437 行 CSS 上做加法**"的设计，不是"重做前端"的设计。所有 Token 都是 CSS 自定义属性，可直接替换 `:root` 块而不动一行 TSX。

---

## 1. 设计系统

### 1.1 风格定位

> **2026-10-14 修订**：视觉系统已整体迁移至 Air 风格（§7）。本节与 §1.3/§2 的色板、强调色、布局描述在冲突处以 §7 为准；三层 Token 架构（§1.2）与工程约束（§0）不变。

| 维度 | 决策 | 理由 |
| --- | --- | --- |
| 风格 | **克制的工程工具风**（Dark-first + Light 双轨，中性冷灰 + 单一蓝强调） | 用户是"拿来下载"的效率型用户，不是来欣赏界面的。现仓库注释已写明「克制优先：少即是多」，延续它 |
| 反风格 | 不做玻璃拟态 / 渐变营销感 / 大圆角卡片堆叠 / emoji 图标 | 下载器需要长时间停留在任务列表，视觉噪音直接降低扫读效率 |
| 视觉重心 | 把注意力预算全部给 **进度条 + 状态**，其余全部降噪 | 任务列表是产品的心脏 |
| 品牌色承接 | 保留现有 `--accent` 蓝色相（`#3b82f6` 家族），只调整明度层级 | 避免" redesign = 换色" 的常见浪费 |

### 1.2 主题架构：三层 Token

采用 **原始层（palette）→ 语义层（role）→ 组件层（component）** 三层。renderer 与主进程**只消费语义层**，永远不直接引用 `--blue-500`。

```css
/* 层 1：原始色板（唯一允许出现十六进制字面量的地方） */
:root { --blue-300:#93c5fd; --blue-400:#7cb3ff; --blue-500:#3b82f6;
         --blue-600:#2f6fed; --blue-700:#1d4ed8; /* …slate/emerald/amber/red */ }

/* 层 2：语义角色 —— 主题切换只改这一层 */
:root, [data-theme="dark"] { --bg:#0f1115; --surface:#1d2129; --text:#e6e8ee; /* … */ }
[data-theme="light"]       { --bg:#f6f7f9; --surface:#ffffff; --text:#14161a; /* … */ }

/* 层 3：组件级 —— 用 var() 组合，不引入新色值 */
.button-solid { background:var(--accent-solid); color:var(--on-accent); }
```

**为什么是这个结构**：现仓库 `:root` 里 10 个变量（`--bg/--panel/--card/--line/--text/--muted/--accent/--ok/--warn/--err`）**已经是语义层**，命名良好。本方案做的是**补齐语义层缺口**（分层表面、控件描边、语义底色、遮罩、强调文字色），并把硬编码色值下放进原始层 —— 迁移成本 ≈ 替换一个 `:root` 块。

### 1.3 明暗双主题色板（**对比度全部实测**，见 §1.3.3）

#### 1.3.1 表面与文字

| 语义 Token | Dark | Light | 用途 | 与相邻表面实测对比度 |
| --- | --- | --- | --- | --- |
| `--bg` | `#0f1115` | `#f6f7f9` | 应用底色（窗口最外） | — |
| `--surface` | `#1d2129` | `#ffffff` | 卡片 / 表格行 / 弹层 | L：`#14161a` on `#ffffff` = **18.11 AAA** |
| `--surface-2` | `#22262f` | `#f2f4f7` | 悬停态 / 输入框底 / 内凹区 | D：`#e6e8ee` on `#22262f` = **12.37 AAA**；L：**16.44 AAA** |
| `--surface-sunken` | `#171a21` | `#eef0f3` | 进度条槽、代码块、选中列表底 | 承自现仓库 `--panel`（保持不改，减少 diff） |
| `--overlay` | `#0b0d12cc` | `#14161ab3` | 模态遮罩 | — |
| `--text` | `#e6e8ee` | `#14161a` | 主文本 | D on `--bg` = **15.42 AAA** |
| `--text-muted` | `#9aa3b5` | `#5b6472` | 次要文本 / 提示 / 表格元数据 | D on `--surface` = **6.36 AA**；L on `--surface` = **5.98 AA** |
| `--text-placeholder` | `#7d879a` | `#7b8496` | placeholder（**现状缺失**：浏览器默认用正文色，placeholder 与真实输入无法区分） | L on `--surface` = **3.76**（仅装饰性，非必需） |
| `--text-disabled` | `#6b7689` | `#8b95a7` | 禁用态文本 | D：**3.52**；L：**3.02**（禁用元素 WCAG 豁免，此处刻意不超过 muted，形成"不可用"直觉） |
| `--text-on-accent` | `#ffffff` | `#ffffff` | 实心按钮文字 | 见 §1.3.3 |

> 现仓库的 `--muted: #8b93a5`（on `--card` = 5.23，**已达标**）**保留可用**；升到 `#9aa3b5` 是为 Light 主题统一取值时的余量，属可选优化，不必当成 breaking change。

#### 1.3.2 描边：必须区分"装饰线"与"控件边界"

这是本方案**最重要的无障碍修正**。WCAG 1.4.11 要求"控件边界与图形"≥ 3:1，而**纯分隔线不在要求范围内**。现仓库把两者混用同一个 `--line`，导致输入框在暗色下"看不见边框"。

| 语义 Token | Dark | Light | 用途 | 实测 |
| --- | --- | --- | --- | --- |
| `--line` | `#2a2f3a` | `#e2e5ea` | **装饰线**：卡片外框、表格行分隔、内凹槽边（不参与"这是可交互的"判断） | 1.41 / 1.18 —— **有意低于 3:1**，降噪 |
| `--line-control` | `#78849a` | `#6b7280` | **控件边界**：input / textarea / select / checkbox / 描边按钮 / tab | **4.28**（on `--surface`）/ **4.83** —— 满足 1.4.11 |
| `--line-control-hover` | `#9aa3b5` | `#54617a` | 控件悬停 | 6.36 / 6.24 |
| `--line-focus` | `#7cb3ff` | `#2563eb` | 焦点环（2px + 2px offset） | 7.49 / 5.17 |
| `--line-valid` | `#34d399` | `#15803d` | 成功态控件边 | — |
| `--line-invalid` | `#f87171` | `#b91c1c` | 错误态控件边 | 5.83 / 6.47 |

> 为什么 `--line-control` 在 Dark 要跳到 `#78849a`（而不是 `#4a5464` 这类"看起来刚好"的值）：我实测 `#4a5464` on `#1d2129` 只有 **2.11**、`#5a6577` 只有 **2.74**，**都不达标**。3:1 是硬门，猜不得。

#### 1.3.3 强调色与语义色（含一个必须修的 AA 缺陷）

| 用途 | Dark（现状） | Dark（建议） | Light（建议） | 实测说明 |
| --- | --- | --- | --- | --- |
| 实心按钮底 + 白字 | `#3b82f6` | `#2f6fed`（深背景可用 `#2563eb`） | `#2563eb` | ⚠️ **现状 `#ffffff` on `#3b82f6` = 3.68:1 —— 不满足 AA(4.5)**，正文 14px 按钮文字是 WCAG 违规。修正后：on `#2f6fed` = **4.55 AA**，on `#2563eb` = **5.17 AA** |
| 强调文字 / 链接 / 选中态 | `#3b82f6` | `#7cb3ff` | `#1d4ed8` | ⚠️ 现状 `#3b82f6` on `#1d2129` = **4.39 不达标**（`.linkish` 文件名列就是它）。修正后 D = **7.49 AAA**、L = **6.70 AA** |
| 选中行/标签底 | — | `#17243a` | `#eaf1ff` | 文字 on 它：12.70 / 15.98 |
| Success | `#22c55e` | `#34d399` | `#15803d` | 现值 7.08 已达标；升 `#34d399` 是为与 tint 底搭配（8.02 AAA） |
| Warning | `#f59e0b` | `#fbbf24` | `#b45309` | 现值 7.51 已达标 |
| Danger | `#ef4444` | `#f87171` | `#b91c1c` | ⚠️ 现状 `#ef4444` on `#1d2129` = **4.29 不达标**（`.banner.error` 与 `button.danger` 都吃这个）。修正后 **5.83 AA** / **6.47 AA** |
| 语义 tint 底（横幅/徽标背景） | ok `#12291f` / warn `#2a2210` / err `#2a1518` / info `#17243a` | 同左 | ok `#f0fdf4` / warn `#fffbeb` / err `#fef2f2` / info `#eaf1ff` | 语义文字 on 自身 tint 底：D 8.02 / 9.42 / 6.23 / 7.22；L 4.79 / 4.84 / 5.91 / 5.91 —— 全部 ≥ AA |

**语义色用法铁律**：tint 底 + 语义文字 + 语义图标，**三者同时出现**。禁止"只靠颜色区分状态"（WCAG 1.4.1）—— 见 §3.1 任务状态徽标（图标 + 文字 + 颜色三重编码）。

#### 1.3.4 进度与数据可视化色

| Token | Dark | Light | 说明 |
| --- | --- | --- | --- |
| `--progress-fill` | `#7cb3ff` | `#2563eb` | on `--progress-track`：D **6.60**、L **4.25** ≥ 3:1 ✅ |
| `--progress-track` | `#262b34` | `#e6e9ee` | 槽本身是装饰，不要求 3:1 |
| `--progress-fill-done` | `#34d399` | `#15803d` | 完成瞬间由蓝转绿（一次性状态确认，避免"进度条永远蓝"的钝感） |
| `--progress-fill-error` | `#f87171` | `#b91c1c` | 失败任务的残量条转红并停在断点位置 —— **让"续传从这里继续"可见** |
| `--speed-normal` | `#9aa3b5` | `#5b6472` | 速度文本 |

> 图集（group）总进度条使用同一 fill，但**高度 4px**（子行 3px），层级靠尺寸区分而非颜色。

### 1.4 字体层级

#### 1.4.1 字体族 —— 受 C1 约束，只能用系统栈

```css
--font-ui:  "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
--font-num: "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; /* 数字用 tabular-nums */
--font-mono:"Cascadia Mono","Consolas","Microsoft YaHei Mono",monospace;
```

三条要点：

1. `font-variant-numeric: tabular-nums` 用于**速度 / 字节数 / 百分比** —— 现仓库这三处用比例字体，数字跳动时列宽抖动，任务列表"抖"的观感主要来自这里（`DownloadsPage.tsx:74` `${fmtBytes(t.speed)}/s`）。这是**零成本的高性价比修正**。
2. `Segoe UI Variable` 是 Win11 正典字体，Win10 自动回落 `Segoe UI`；中文回落微软雅黑。**不打包字体**（体积 + CSP 双输）。
3. 等宽只用于 Cookie 输入框（现状已如此 `.mono`）与文件路径，**不用于正文**。

#### 1.4.2 字号阶梯（8 级，含用途锁定）

| Token | px / line-height | 字重 | 用途（对应现有选择器） |
| --- | --- | --- | --- |
| `--fs-display` | 22 / 1.3 | 700 | 结果卡标题（长标题上限 2 行）；首页未启动态的引导语 |
| `--fs-h1` | 18 / 1.4 | 600 | 页面级标题（**现状缺失** —— 四个 `<section class="page">` 都没有页面标题，靠 topbar tab 暗示所在页） |
| `--fs-h2` | 15 / 1.4 | 600 | 卡片标题 `.card-title`（现状无字号定义，继承 14px —— 与正文同级，层级塌陷） |
| `--fs-body` | 14 / 1.55 | 400 | 正文默认（**保持现状 14px**，桌面工具不必 16px；WCAG 16px 下限针对移动端，min-width 820px 不适用） |
| `--fs-body-strong` | 14 / 1.55 | 600 | 任务文件名、按钮文字 |
| `--fs-meta` | 13 / 1.5 | 400 | 表格元数据列、`--text-muted` 描述 `.desc`、字段标签 `.field > label` |
| `--fs-caption` | 12 / 1.45 | 400 | `.hint`、`.chip`、`.via-line`（现状 12px 保留） |
| `--fs-micro` | 11 / 1.4 | 500 | 徽标计数、快捷键提示（**仅用于非关键信息**） |

比例选择理由：1.067 步长（22→18→15→14→13）是"桌面工具密集排版"的常见收敛比例，比 1.25 模数比例更适合 820px 窄窗口；层级靠**字重 + 色彩**而非字号堆叠。

### 1.5 间距 · 圆角 · 阴影 · 层级

#### 1.5.1 间距（4px 基准，现状代码已隐含 4 的倍数：6/10/14/18 → 规整为 4 的倍数为准，允许 6 例外）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--sp-1` | 4px | 图标与文字间距、chip 内上下 |
| `--sp-2` | 8px | 同组控件间隙（`.row` gap、`.ops` gap） |
| `--sp-3` | 12px | 卡片内块间（现 `.card` gap 8 → 12，提升可读性） |
| `--sp-4` | 16px | 卡片内边距横向（现 14 → 16）、按钮横向（现 14 → 16） |
| `--sp-5` | 20px | 页面纵向节奏、区块间隔 |
| `--sp-6` | 24px | `.content` 内边距（现 18 → 24，宽屏留白） |
| `--sp-8` | 32px | 空态上下留白（现 `.empty` 60px → 上下分 32+内容） |
| `--sp-12` | 48px | 空态插图与文字间距 |

现状 `.save-bar { padding-bottom: 30px }`、`.topbar { padding: 10px 18px }`、`.empty { padding: 60px 0 }` 都是魔法数，规整到刻度即可，无需重排布局。

#### 1.5.2 圆角（4 档，克制）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--r-sm` | 6px | chip、小按钮、徽标、输入框（现 8 → 6，控件收紧） |
| `--r-md` | 8px | 按钮、tab、封面图 |
| `--r-lg` | 12px | 卡片、弹层、banner（**保持现状**，不制造无谓 diff） |
| `--r-full` | 999px | 头像、状态点、进度条帽 |

#### 1.5.3 阴影（暗色靠表面，Light 靠阴影 —— 不对称是有意的）

```css
/* Dark：阴影几乎不可见，层级靠 --surface 明度差 + --line */
--sh-1: 0 1px 2px #00000040;                      /* 卡片静态 */
--sh-2: 0 4px 12px #00000059;                     /* hover / 浮起 */
--sh-3: 0 12px 32px #00000073;                    /* 模态、右键菜单 */

/* Light：同层级改用低透明度冷灰投影 */
--sh-1: 0 1px 2px #14161a0f, 0 0 0 1px #e2e5ea;
--sh-2: 0 4px 12px #14161a14, 0 0 0 1px #e2e5ea;
--sh-3: 0 12px 32px #14161a1f, 0 0 0 1px #cbd2da;
```

`--sh-1/2/3` 在 Light 附带 `0 0 0 1px` 内描边，是因为实测 `--surface #ffffff` on `--bg #f6f7f9` 仅 **1.07:1** —— 白卡贴浅灰底时**阴影单独撑不住边界**，必须有描边。

#### 1.5.4 z-index 阶梯（现状完全无定义，弹层会打架）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--z-sticky` | 10 | topbar、表头（长列表滚动时状态可见） |
| `--z-drawer` | 20 | 底部 toast 容器 |
| `--z-modal` | 30 | 确认弹层、图集预览 |
| `--z-menu` | 40 | 任务行"更多"下拉、右键菜单 |
| `--z-tip` | 50 | tooltip |

### 1.6 组件规格（Design Token → 组件的落点）

| 组件 | 尺寸规格 | 状态集 |
| --- | --- | --- |
| **Button** | sm 28px / **md 32px（默认）** / lg 40px；横向 pad `--sp-4`；图标 16px | rest / hover / **pressed（下移 1px）** / **focus-visible（`--line-focus` 2px + offset 2px）** / disabled（`--text-disabled`，**禁用 opacity 改为换色**）/ loading |
| Button 变体 | `solid`（主操作，1 屏最多 1 个）/ `outline`（次级）/ `ghost`（行内操作，透明底）/ `danger`（`--line-invalid` 描边 + `--danger` 文字，**实心红只用于"清空/删除"确认**）| — |
| **触控/点击目标** | 行内 ghost 按钮视觉 24px，但 `min-height:32px; padding` 补齐到 **≥ 32px 实际命中区**；纯图标按钮命中区 **40×40** | 现状 `button { padding:6px 14px }` ≈ 30px 高，勉强可用；密集任务行的"取消"按钮是最容易点错的 |
| **Input / Select** | 高 32px；`--surface-2` 底 + `--line-control` 边；focus 时边框转 `--line-focus` + 1px ring | rest / hover / focus / **invalid**（左边 3px `--danger` 色条 + 下方错误文本）/ disabled |
| **Textarea（粘贴框）** | 默认 3 行 → **可粘贴后自动增高至 6 行**；focus ring | rest / **有内容（右边出现清除 ✕）** / 识别成功（左侧 3px `--accent`）/ 识别失败（左侧 3px `--warning`） |
| **Chip 状态徽标** | 高 20px；`--r-sm`；tint 底 + 语义文字 + 12px 图标 | 6 种下载状态（§3.1）+ 平台 chip + `via` 通道 chip |
| **Card** | pad `--sp-4`/`--sp-5`；`--r-lg`；`--sh-1`；边框 `--line` | static / **interactive**（cursor pointer + hover `--sh-2`） |
| **Progress** | 主任务 6px、子任务/图集子行 4px；`--r-full` | determinate / **indeterminate**（`total===0` 时的滑动条，现状只有一行 `…` 文本）/ done / error / paused（fill 降透明度 60%） |
| **Table** | 行高 56px（双行内容）；表头 36px 粘性；斑马线**不用**（改 hover 单行高亮 `--surface-2`） | hover / **选中** / 拖拽中 |
| **Toast** | 底部右对齐，宽 320px，`--z-drawer`，同屏最多 3 条，4s 自动消失（**现状 `.banner` 内联在内容流里 → 布局跳动**） | info / success / warning / error（可带"撤销"动作按钮） |
| **Modal** | 420px（确认）/ 720px（图集预览）；`--z-modal`；ESC 关闭；焦点圈闭 | — |

### 1.7 图标系统

C1 约束下的可行方案有两类（**2026-10-14 业主修订：`lucide-react` 进白名单**）：**内联 SVG sprite**（`<svg><use href="#icon-x">`，同源自包含）或 **lucide-react**（tree-shaking 后按需打包，构建期同源自包含，不违反 CSP）。**仍禁止 icon font 与远程 SVG**（违反 C1）。

- 统一 24×24 viewBox，描边 1.5px，`stroke="currentColor"` —— 于是图标颜色自动跟随文字色，主题切换零维护。
- **必须成套**（自绘或选单一开源集，MIT/ISC 许可，落地时 vendored 进 `renderer/src/icons.tsx`），禁止混用两套描边风格。
- 关键图标清单（覆盖全部现有交互）：`download / pause / play / retry / cancel / folder-open / trash / more-horizontal / search / filter / check / alert-triangle / x-circle / info / moon / sun / clipboard / image / video / music / layers（图集）/ refresh（重新解析）/ keyboard`。
- **禁止用 emoji 当 UI 图标**。现状 `已保存 ✓`、`已加入队列 ✓` 用了字符勾 —— 属于文本符号不是 emoji，可保留但建议替换为 `#icon-check`（跨字体渲染不稳）。

### 1.8 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `--t-fast` | 120ms / `cubic-bezier(.2,0,.38,.9)` | hover、focus、颜色过渡 |
| `--t-base` | 200ms / `cubic-bezier(.4,0,.2,1)` | tab 切换、下拉展开、toast 进出 |
| `--t-slow` | 320ms / `cubic-bezier(0,0,.2,1)` | 模态、抽屉、卡片展开 |
| `--t-progress` | 300ms linear | 进度条宽度过渡（**必须 < 200ms 节流周期的 1.5 倍**，见下） |

两条来自代码的硬约束：

1. 主进程进度事件 **200ms 节流**（`downloader.ts:67 PROGRESS_THROTTLE_MS`）。进度条 CSS 过渡设 300ms 可把 5 帧/秒的离散跳变抹成连续滑动 —— 但**绝不能超过 400ms**，否则过渡时长 > 数据间隔，进度条会"追不上"造成回缩抖动。
2. 全局必须包 `@media (prefers-reduced-motion: reduce) { *{animation-duration:.01ms!important; transition-duration:.01ms!important} }`，并且**进度条过渡在 reduce 下改为 0**（否则用户看到的是滞后的假进度）。现状 CSS 无任何 transition，加这段零风险。

**只允许 `transform` / `opacity` 做动画**（Electron 合成器友好，避免 layout 抖动）。禁止 `width/height` 动画（进度条是唯一例外 —— 它已有 `width`，改为 `transform:scaleX()` + `transform-origin:left` 可省掉重排；这是 §4 里一个明确的微优化建议）。

---

## 2. 四个主界面的信息架构与布局

### 2.0 全局外壳（App Shell）

现状 topbar 承担 3 件事（品牌 / tab 导航 / 拖拽区），缺 4 件事。建议外壳布局：

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [◈ logo 即刻解析]  [v0.1.0]         解析 下载 历史 设置        [◐主题][⚙][— □ ✕]│ ← 48px 拖拽区
├───────────────────────────────────────────────────────────────────────────┤
│ ⓘ 发现新版本 0.2.0 · [查看更新] [稍后]                                      │ ← 更新横幅（仅需要时）
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   <page>  max-width:1040px; margin:0 auto; padding:24px                   │
│                                                                           │
├───────────────────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓  3 个任务进行中 · 12.4 MB/s · 剩余 01:32   [全部暂停] [×]            │ ← 全局下载栏（有活任务时常驻）
└───────────────────────────────────────────────────────────────────────────┘
```

| 区域 | 决策 | 代码依据 / 缺口 |
| --- | --- | --- |
| **导航形态** | **保持顶部 tab，不改成侧边栏**。理由：窗口 minWidth 820px 下侧边栏吃掉 ~200px 内容宽度，且现有 `.topbar{-webkit-app-region:drag}` + `no-drag` 例外已经跑通（`styles.css:45-52`），改侧栏等于重写拖拽区 | 减法优先：`App.tsx` 注释已定「四固定页 state 路由足够」，不动 |
| **tab 加图标** | 每个 tab 加 16px 图标 + 文字（`解析/下载/历史/设置`），文字 4 字宽度差异造成的视觉跳动用 `min-width` 固定 | 现状纯文字 tab，扫读时靠阅读中文词义定位，图标降低认知成本 |
| **下载 tab 徽标** | tab 右上 11px 计数徽标：进行中数量（`--accent` 实心）；无进行中但有失败时显示 `--danger` 徽标 | `DownloadTaskView.status` 已具备全部判定信息，**纯渲染层，零 IPC 变更** |
| **状态区（新增）** | topbar 右侧：主题切换按钮（`--z-tip` 提示快捷键）+ 内核/引擎健康点 + 原生窗口按钮 | 现状 `--line` 顶栏里 `meta-chip` 显示 `v0.1.0 · local`：① **内核模式是 app 级信息**，但真实通道是逐请求的 `via`（`engine.ts` 每条结果自带 `via`），二者混在一个 chip 里必然误导 ② 无主题入口 |
| **健康点设计** | 用一个 8px 状态点 + tooltip 取代 `local` 文字：绿=本地内核可用且回落开；黄=纯线上回落；灰=mock 骨架。tooltip 文案写全 | 保留 `kernelMode` 原语义，只是降其视觉权重 |
| **全局下载栏（新增）** | 有 queued/downloading 任务时**常驻底部**，聚合显示：活跃数 / 总速度 / 总剩余时间 / `全部暂停·继续` | 现状：下载进度只能在切到"下载"页时看到；用户解析完就切走 → 完全盲飞。`download:onProgress` 已在 `bridge.ts` 暴露可直接复用 |
| **`--line-control` 落地** | topbar 与内容间分隔线用 `--line`（装饰） | — |

> **响应式策略**（桌面窗口可拖拽，必须给规则）：
> `≥1000px` 完整三列/五列表格 → `860–999px` 隐藏"速度"列并合并进进度单元格 → `≤820px`（minWidth）任务列表从**表格降级为卡片行**（文件名 + 状态徽标在上，进度条 + 操作在下）。现表格 5 列 + `.prog{min-width:160px}` 在 820px 下必然挤压，`App.tsx`/`DownloadsPage.tsx` 目前无任何降级 —— 这是实测可复现的破版点。

### 2.1 首页 / 解析页（`ParsePage.tsx`）

**产品定位**：这是"粘贴即走"的效率入口，**首屏唯一目标是那个输入框**。

```
                    ┌──────────────────────────────────────────────┐
                    │  解析                                         │ ← --fs-h1（新增）
                    ├──────────────────────────────────────────────┤
   ▓▓▓ 核心动作区 ▓▓ │ ▾ 已识别：抖音 · 从分享文案提取               │ ← 识别条（在框内顶部）
                    │ ┌──────────────────────────────────────────┐ │
                    │ │ 粘贴分享链接或整段分享文案                  │ │
                    │ │                                        │ │
                    │ └──────────────────────────────────────────┘ │
                    │ [20 个平台 ▾]      ⌨ Ctrl+Enter   [ 解析 ]   │
                    ├──────────────────────────────────────────────┤
   ▓▓ 结果卡 ▓▓▓▓▓▓ │ ┌─ 封面 ─┐  标题（22px/2 行）                 │
                    │ │ 128×178│  抖音 · @作者 · 00:12 · 1080P     │
                    │ └────────┘  [1080P ▾] [720P] [仅音频]        │ ← 清晰度选择（缺口）
                    │  简介文本（13px muted，3 行后…展开）           │
                    │ [ ⬇ 下载全部(3) ] [ ⧉ 复制封面 ] [ ↗ 原页面 ] │
                    │ ▓ 本地内核 · 1.2s · ✅ 已加入队列              │
                    ├──────────────────────────────────────────────┤
   ▓▓ 底部辅助 ▓▓▓▓ │ 最近解析：[卡1][卡2][卡3]  ← 复用结果卡 slim   │
                    │ 支持平台：抖音 快手 小红书 …（chip 墙，可点即筛）│
                    └──────────────────────────────────────────────┘
```

| 层级 | 内容 | 关键决策 |
| --- | --- | --- |
| L1 输入 | 粘贴框 + 识别提示 + 解析按钮 | 识别提示**从框下方 `.hint` 移入框内顶部**（现状在框下，与按钮同行 `justify-content:space-between`，视线要横跨 600px 才看得到）。提示带**状态色左边条**：识别成功 `--accent`、未识别 `--warning` |
| L1 输入 | 「20 个平台 ▾」下拉 | `meta.platforms` 有完整的 `key/name/nameEn/supportsIdParse`（`types/ipc.ts:144`），**但现状只用了 `.length`**（`ParsePage.tsx:116`）—— 数据已在，只差渲染。点击 chip 填 `platformHint`（`ParseInput.platformHint` 契约已存在） |
| L2 结果 | 结果卡 | 见下 |
| L3 辅助 | 最近解析 + 平台墙 | 填补首屏下半部的空白；数据源 `history:list`（已有）+ `meta.platforms`（已有） |

**结果卡（`ResultCard.tsx`）改造要点**

1. **清晰度 / 多音质选择器（最大功能缺口）**：契约里 `ParseData.qualities`、`ParsedVideoItem.qualities`、`.accept` **全部未被消费**（`ResultCard.tsx:21-41` 只读 `url / audioUrl / videos / images`）。B站/YouTube 这类多清晰度平台，用户**无法选择画质，只能拿到内核给的那一个**。
   - UI：chip 组（`1080P` / `720P` / `仅音频`），默认选中内核返回的主 `url` 对应项，单选。
   - **落地成本极低**：下载项本就由渲染层拼 `DownloadItem[]`（`ResultCard.tsx:26-40`），改成"按选中清晰度取 `qualities[i].url`"即可 —— **零 IPC 契约变更**。
   - 文件名需带清晰度后缀（`${title}-1080P.mp4`），注意 `ipc.ts:162` 的 `sanitizeFilename(name, 80, "download")` 会截断到 80 字符 —— UI 显示的最终名应与截断后一致，否则会"显示的和学习到的不一样"。
2. **图集预览**：`data.images[]` 现状被平铺进 `items`（`ResultCard.tsx:37-39`）但**界面上看不见有几张、长什么样**，用户只能信任按钮上那个数字。改为 **9 张缩略网格 + "+N"**，点击进入模态大图（`--z-modal`）。
3. **元数据补全**：`data.stat`（view/like/share）、`data.avatar`、`data.music` 全部未使用 —— 在结果卡加一行统计（12px muted，`tabular-nums`），信息密度提升但需处理 `statsUnreliable`（契约字段）：为 true 时该行加 `⚠︎ 数据可能不准` tooltip。
4. **`embedUrl` 的处理**：现状只在下载按钮旁挂一句 hint（`ResultCard.tsx:110-112`），但 `ParseData.embedUrl` 意味着"这平台只能官方嵌入播放"。建议：隐藏下载按钮，改为 `[↗ 在浏览器中打开播放]`（走 `shell.openExternal` —— 注意 renderer 无此 API，`main/index.ts:219-221` 的 `setWindowOpenHandler` 会拦截 `window.open`，所以用 `<a target="_blank">` 触发它，**零契约变更**）。
5. **通道标注保持诚实**：`.via-line` 的「本地内核 / 线上回落 / mock 骨架」+ 耗时是本项目最好的设计之一（README「结果来源如实标注」），**只优化视觉**（tint 底 chip），**文案不改**。`fallbackReason` 从灰色 hint 升级为可展开的「为什么走了线上？」详情（默认折叠）。

**空态 / 首次使用**

```
        [插图：48px 剪贴板→下载箭头，单色描边]
        粘贴一条分享链接，本机直连解析并下载
        解析和下载都在你自己的电脑上完成 — 住宅 IP，成功率更高，内容不经任何第三方服务器。
        ⌨ Ctrl+V 粘贴后自动开始解析 · Ctrl+Enter 手动解析
        [ 查看支持的 20 个平台 ]   [ 配置 Cookie ]
```

现状空态是两句说明文字（`ParsePage.tsx:111-120`），信息对但无引导动作。加入**两个次级动作按钮**指向两个最关键的转化障碍（不知道支持哪些平台 / B站IG 无 Cookie 常失败）。

### 2.2 任务列表页 / 下载（`DownloadsPage.tsx`）

**核心洞察**：契约里有 `groupId` 三处（`EnqueueInput` / `EnqueueOutcome` / `DownloadTaskView` / `PersistedQueueTask`），`ARCHITECTURE.md §4` 明确"图集打包为一次 group 入队"，**但 `DownloadsPage` 把每个子任务平铺成独立表格行**。一次小红书 30 图 = 30 行列表 —— 这是当前 UI 最严重的一处"数据模型与呈现脱节"。

#### 布局：分组 + 分段 + 工具栏

```
┌ 工具栏 ───────────────────────────────────────────────────────────────────┐
│ 全部(12) 进行中(3) 完成(7) 失败(2)      [🔍搜索] [平台▾] [类型▾]  [清理完成] │
├───────────────────────────────────────────────────────────────────────────┤
│ ▾ 图集 · 春日穿搭合集            小红书   ▓▓▓▓▓▓░░ 18/30   8.2 MB/s  [...]  │ ← 组行（可折叠）
│     ├ 春日穿搭合集-1.jpg   ▓▓▓▓▓▓▓▓ 100%  2.1 MB              [位置]       │
│     ├ 春日穿搭合集-2.jpg   ▓▓▓▓░░░░  46%  1.4/2.0 MB           [⏸][×]      │
│     └ …（折叠时显示前 3 条 + "还有 27 项"）                                  │
├───────────────────────────────────────────────────────────────────────────┤
│ 单文件 · 某视频标题          抖音   ▓▓▓▓▓▓▓░ 78%  124/159 MB  12.4MB/s 00:41 [...]│
└───────────────────────────────────────────────────────────────────────────┘
```

| 区域 | 规格 |
| --- | --- |
| **分段标签** | `全部/进行中/完成/失败/已取消` + 计数（13px）。选中态：`--accent` 文字 + 下边框 2px + `--accent-soft` 底。**分段是渲染层过滤**，`download:list` 已返回全量，零契约变更 |
| **搜索 / 筛选** | 按 `filename`/`title`/`platform` 客户端过滤（数据已在内存）；平台选项来自 `meta.platforms` 的 `name`（**现状 `HistoryPage` 用的是裸 `h.platform` key**，显示 `redbook` 而非"小红书"—— 见 §2.3） |
| **组行** | 高 44px；组进度 = 子项字节加权（`Σreceived / Σtotal`）；点击展开/折叠（`--t-base`，chevron `rotate`）；展开状态记忆在组件 state（不必持久化） |
| **子行** | 高 36px，左缩进 24px + 3px 竖向 `--line` 连接线；进度条 4px |
| **主信息列** | 文件名 `--fs-body-strong` 单行省略 + `title=完整名`；第二行 12px muted：`平台 · 类型 · 落地目录` |
| **进度单元格** | 条 6px + 上行 `78%`（tabular）、下行 `124 / 159 MB`；**`total===0` 时切换为 indeterminate 滑动条 + `已下载 X`**（现状只有一行 `…`，用户无法区分"在跑但不知道总量"与"卡住了"） |
| **速度 + ETA** | `12.4 MB/s` 与 `剩余 00:41` 同列。**ETA 是现算的**：`(total-received)/speed`，数据齐备但界面没有 —— 高价值低成本。速度文本需 `tabular-nums` 防抖 |
| **重试可见** | 现状 `attempts`（`downloader.ts:61`）**不在 `DownloadTaskView` 里**，UI 无法显示"重试中 2/3"。建议 §4-P6 加一个可选字段 `attempts`，状态徽标显示 `重试中 2/3`（否则用户看到进度条反复归零会以为卡死并手动取消）|

#### 任务行操作（状态 × 动作矩阵）

按 `DownloadStatus` 6 态（`types/ipc.ts:199-205`）× 现状代码行为（`DownloadsPage.tsx:76-90`）核对，**并修正两处语义错误**：

| 状态 | 建议徽标（图标+文字+色） | 行内可见（≤3 个） | `⋯` 更多菜单 | 双击行 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `queued` 排队 | `⏱ 排队中` muted | 取消 | 移到最前 / 优先级高 | 打开所在目录（若已知） | 现状排队态**只有"取消"**（L84 条件含 queued）✅ |
| `downloading` 下载中 | `⬇ 下载中` accent | 暂停 · 取消 | 打开目录（.part） | 打开目录 | — |
| `paused` 已暂停 | `⏸ 已暂停` warning | 继续 · 取消 | 重新开始（丢弃 .part） | 打开目录 | `.part` 保留 → 文案要告诉"续传点已保存" |
| `done` 完成 | `✓ 完成` ok | 打开文件 · 打开目录 · 删除 | 重新解析 / 复制路径 | **打开文件** | 现状只有"位置"一个按钮，**缺"打开文件"**（`showInFolder` 只 reveal，不 open —— 需新增 `app:openPath`，见 §4-P7） |
| `error` 失败 | `✕ 失败` **danger（红）** | 重试 · 取消 | 查看详情 / 打开目录 | 显示错误详情 | ⚠️ **现状 error 映射到 `warn`（橙色）**（`DownloadsPage.tsx:113`）—— 失败与暂停同色，用户必须读文字才能发现失败。修正为红 |
| `canceled` 已取消 | `⊘ 已取消` muted | 重新下载 · 从列表移除 | 打开目录 | — | 现状 `canceled` 显示"继续"按钮（L79-82），语义上"取消后继续"易误解为原任务恢复；改为"重新下载"并说明直链可能已过期 |

**"⋯"菜单**：40×40 命中区，`--z-menu`，项高 32px，键盘 `↑↓ + Enter + Esc`。

#### 状态色之外的三重编码（WCAG 1.4.1）

`颜色 + 图标 + 文字`。现状只有 `颜色 + 文字`（`.chip.warn` 橙 / `.chip.ok` 绿），色觉障碍用户在密集列表里靠文字尚可，但 `queued`（无 class）与 `canceled`（无 class）视觉完全相同 —— 加图标即可解。

#### 批量与全局操作

- 组行/单行支持多选（Ctrl+点 / Shift+点）→ 底部浮出批量条：`开始 / 暂停 / 取消 / 移除记录 / 打开全部所在目录`。
- **「清理已完成」缺失**：`downloader.list()` 返回 `order` 全量（`downloader.ts:137-138`），`snapshot()` 才过滤 done（L323）—— 即 **done 任务永久留在列表里，界面无限增长**，且与历史页内容重复。必须提供"清理已完成/已取消"。
  - ⚠️ 落地要留神：`cancel/pause/resume` 都按 `taskId` 定位内存 `tasks`，`list()` 也读它。**纯渲染层隐藏 done** 是最小改动（不影响重启恢复与历史），但"从队列真正移除"需要新 IPC channel（§4-P7）。

### 2.3 历史页（`HistoryPage.tsx`）

**契约事实**：`HistoryEntry{platform,title,files[],sourceUrl?,createdAt}`，存储上限 500（`store.ts:32 HISTORY_MAX`），接口默认返回 200（`ipc.ts:239`）。**不存直链**是隐私红线（`ARCHITECTURE.md §3`），设计必须尊重：不出现"复制直链""重新下载"这类需要直链的动作 —— 用"**重新解析**"（把 `sourceUrl` 回填首页输入框，由内核重新走一遍）替代。

```
┌ 工具栏 ───────────────────────────────────────────────────────────────────┐
│ 历史  │ [🔍 搜索标题或文件名]  [平台 ▾ 全部/抖音/小红书…]  [时间 ▾ 7天/30天]  │
│       │ [导出清单…]  [清空历史]                                              │
├───────────────────────────────────────────────────────────────────────────┤
│ ▾ 今天 · 4 项                                                              │ ← 日期分组
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ [封面/类型图标] 春日穿搭合集                          小红书  14:22    │ │
│ │   📁 D:\Downloads · 30 个文件                              [⋯]        │ │
│ │   ▸ 展开：3 个文件芯片 + "+27"                                        │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────────────────┤
│ ▾ 10 月 13 日 · 7 项                                                       │
```

| 决策 | 说明 | 现状问题 |
| --- | --- | --- |
| **平台显示名** | 一律显示 `meta.platforms[].name`（"小红书"） | `HistoryPage.tsx:49` 直接渲染 `h.platform` 原始 key → 界面出现 `redbook` / `qqmusic`；而体检 chips 用的是 `name`（`SettingsPage.tsx:163`）—— **同一份数据两种显示，是碎片化起点** |
| **筛选选项来源修正** | 平台下拉选项来自 `meta.platforms`（内核真源），不是来自"当前已加载列表里去重" | `HistoryPage.tsx:20-25` 从 `list` 里 `new Set(...)`：一旦选了某平台，`list` 变窄 → 下拉选项跟着变少 → **用户无法切回"全部"以外的第二平台**（功能性 bug，非样式问题） |
| **日期分组 + 粘性头** | 今天 / 昨天 / 具体日期，可折叠 | 现状平铺 `<ul>`，500 条无锚点 |
| **文件芯片折叠** | 单条 entry 显示前 3 个文件芯片 + `+N`，点击展开 | 现状 `h.files.map` 全量平铺（`HistoryPage.tsx:55-66`）—— 30 图 entry 撑出 5 行芯片墙 |
| **失效文件态** | 渲染前对每个路径做一次存在性检查（`app:pathExists`，§4-P7）；不存在 → 芯片置灰 + tooltip「文件已移动或删除」 | 现状点开不存在的文件：`shell.showItemInFolder` 静默无效，用户以为程序坏了。**这是可复现的死按钮** |
| **搜索** | 关键词匹配 `title`/`filename`/`path` —— 先做**纯渲染层过滤**（当页 200 条内），跨量搜索再加 `HistoryFilter.keyword` | `HistoryFilter` 目前只有 `platform/limit`（`types/ipc.ts:280-283`） |
| **单条删除** | `⋯` 菜单：打开目录 / 复制路径 / **从历史移除** | 只有"清空全部"这一个原子操作 —— **误点即丢 500 条**，粒度太粗 |
| **清空确认** | 自定义模态：`420px`，红色实心 danger 主按钮，文案明确"不删除已下载文件"（现状文案正确，保留） | 用了原生 `confirm()`（`HistoryPage.tsx:30`）：Electron 里是系统级灰框，**与主题完全脱节**，且阻塞式无取消回退 |
| **撤销** | 清空后 toast 带「撤销」（渲染层保留副本 30s，重新写入） | 现状不可撤销 |

**空态**：图标 + 「暂无下载历史」+ 一句"历史只记录平台 / 标题 / 时间 / 落地路径，不保存直链"（现状文案诚实且传达隐私承诺，**原样保留**）+ `[ 去解析第一条 ]` 主按钮。

### 2.4 设置页（`SettingsPage.tsx`）

现状：4 张卡片纵向平铺（下载 / 解析 / Cookie / 体检）+ 底部固定保存条（`.save-bar`）。问题：**没有导航**（5 类设置靠滚动找）、**"保存"是全量提交**、**主题/语言/快捷键/托盘完全缺失**。

#### 布局：左侧锚点导航 + 右侧分组

```
┌ 设置 ─────────────────────────────────────────────────────────────────────┐
│ ┌ 侧栏 (200px) ┐  ┌ 面板 ────────────────────────────────────────────────┐│
│ │ ⚙ 下载       │  │ 下载                                                  ││
│ │ ⤡ 解析       │  │ ┌──────────────────────────────────────────────────┐ ││
│ │ ◈ 平台凭据   │  │ │ 下载目录  [D:\Downloads                    ][浏览]│ ││
│ │ ⬒ 外观       │  │ │  可用空间 218 GB ▓▓▓▓▓▓░░  (新增)                 │ ││
│ │ ⌘ 快捷键     │  │ │ 并发上限  [−] 3 [+]   1…10，建议 3               │ ││
│ │ ⊞ 高级/关于  │  │ │ 温和节流  [ 0 ] ms  ⓘ 平台风控升级时用它降速       │ ││
│ │              │  │ └──────────────────────────────────────────────────┘ ││
│ │              │  │ ⚠ 3 项未保存                                 [放弃][保存]││
│ └──────────────┘  └──────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────┘
```

窄窗口（≤860px）侧栏降级为顶部横向 chip 导航（复用 §2.2 的分段样式）。

#### 各分组规格

| 分组 | 字段 | 交互决策 |
| --- | --- | --- |
| **下载** | `downloadDir`、`maxConcurrent`、`throttleMs` | 目录输入旁实时校验：不存在 → 内联错误「目录不存在，保存时将自动创建」（主进程行为）；非写入权限 → `--danger`。`maxConcurrent` 改 **stepper + slider**（1–10 整数，`ipc.ts:65` schema 已强制 min1/max10）—— 现状裸 `type=number` 可键入 99 再被 zod 拒绝，报 `bad-input` 一长串路径文本，体验极差 |
| **解析** | `fallbackOnline`、`onlineApiBase` | 开关改为**自定义 Switch**（32×18，`--r-full`，开=`--accent-solid`）+ 右侧"开（推荐）"文字（现状 checkbox + 文字已可用，但 checkbox 默认样式在暗色下对比不足 → 用 `--line-control` 描边）。`onlineApiBase` 加**即时校验 + `[测试连接]`**（现 `zod .url()` 校验失败 → 报 `onlineApiBase: Invalid URL`，应内联显示而非全局 banner） |
| **平台凭据（Cookie）** | 5 个 `*_COOKIE` + `supportsIdParse` 说明 | ① 每张凭据行：平台 logo chip + 状态点（**已配置 绿 / 未配置 灰**）+ `[粘贴] [清除]`；② **不要让用户"输入空并保存=清除"来猜**（现状 `SettingsPage.tsx:117` placeholder 写"输入空并保存=清除"，反直觉）→ 显式清除按钮 + 确认；③ **补"如何获取 Cookie"步骤链接**（外链走 `shell.openExternal`）—— 这是新用户流失的第一道墙，现状只写"需自行登录平台申请"；④ 保留 `.mono` 等宽 + 掩码 `***` 语义（`ipc.ts:191-195` 的脱敏是正确的，UI 必须继续显示"已配置"而不是长度） |
| **外观（新增）** | `theme: dark \| light \| system`、`accent`（可选，蓝/青/紫）、`density: comfortable \| compact` | `system` → 主进程 `nativeTheme.shouldFollowDarkContent`（现状完全没用 `nativeTheme`，grep 零命中）。`theme` 需进 `AppSettings` 契约（§4-P4）；`density` 纯渲染层 `data-density` 属性 |
| **快捷键（新增）** | 只读速查表 + `[复制]` + 冲突提示 | 桌面用户最需要的是"粘贴即解析"。§3.4 全表 |
| **高级/关于** | `BinaryStatusReport`（完整性）、`probe:engines`（体检）、版本、内核模式、`exportRedacted` 导出、日志目录 | ① 现状体检 chips **只有绿/橙两色，`detail` 藏在 `title` 里**（`SettingsPage.tsx:163`）—— 三种真相（本地已抽取 / 经线上回落 / **两者皆无 → 不可用**）用两色表达不完，`ipc.ts:249-258` 明确有三种 detail。改为**三态**：绿 `本地内核` / 蓝 `经线上回落` / 灰 `不可用`，且**默认展开当前平台清单表格**而非 chip 墙 ② 二进制完整性（`已校验/降级/已拒绝/未找到`）现状已渲染，保留，但"降级"必须给**可执行建议**（现状给的是 `node scripts/fetch-binaries.cjs` 命令行 —— 对终端用户无意义，应仅 dev 构建显示，prod 显示"请重新安装或下载最新版"） |

**保存交互**：现状"底部 `保存设置` 全量提交 + `已保存 ✓` chip 2.5s"。**改为脏状态跟踪**：任一字段变更 → 底部条变 `--warning` tint + 「N 项未保存」+ `保存/放弃`；离开该分组/切页时若脏 → 确认弹层。切页丢设置是现状可复现的问题（`SettingsPage` 的 `s` 是局部 state，切页即卸载 → 未保存内容静默消失）。

---

## 3. 交互规范

### 3.1 状态呈现四态（空 / 加载 / 错误 / 成功）

| 态 | 规范 | 现状与修正 |
| --- | --- | --- |
| **加载（骨架优先）** | 首次进入页面：`--surface-2` 骨架块 + `--shimmer`（1.2s linear，reduce 下关）。**骨架尺寸必须等于真实内容尺寸**（防 CLS）。局部刷新（tab 切换、筛选变化）**禁止全屏骨架** —— 保留旧内容 + 顶栏 2px 不确定进度条 | ⚠️ `SettingsPage.tsx:30` 用 `className="page empty"` 显示"加载设置…" —— **加载态被渲染成空态**，用户会以为"没有设置"。必须区分：空态=确认无数据；加载态=未知。`DownloadsPage` 首帧 `tasks=[]` 也走空态分支，是同一个 bug 的第二现场 |
| **空（两种）** | **首次空**（从未有过数据）：插图 + 一句价值说明 + **一个主 CTA**。**过滤空**（有数据但当前条件无匹配）：一句「没有匹配「小红书」的记录」+ `[清除筛选]`。**绝不用同一个空态** | 现状只有一个 `.empty`，`HistoryPage` 搜索无结果会显示"暂无历史记录" —— **谎报**（数据存在） |
| **错误（三层）** | ① **控件级**（表单校验）：内联在字段下方 13px `--danger` + 左边 3px 色条 + `aria-describedby`，**禁用 toast 报表单错**；② **操作级**（解析失败/下载失败）：就近 banner（结果卡内 / 任务行内）+ `[重试]` + 技术详情折叠（`failType`、`fallbackReason`、HTTP 码）；③ **系统级**（桥未注入、更新失败）：顶部横幅 + `[复制诊断信息]` | ① `DownloadsPage.tsx:25-27` 的 `act()` **静默 `catch {}`**（注释："状态竞争忽略"）—— 用户点"暂停"没反应也不知道为什么。规范：**状态竞争类错误（409 语义）静默但必须重同步列表**（现状已重取 list ✅）；**其他错误必须 toast**。当前二者混在一个 catch 里，无法区分 → 建议主进程错误带 `code`（`ipc.ts` 已有 `code` 字段，`BridgeError.code` 已暴露但 renderer 从不读 —— **数据在手，判断没用**）② `bad-input` 的 zod 文本直接抛给用户（`ipc.ts:121` 拼 `path: message`）→ 必须映射为人话 + 保留原文在折叠区 |
| **成功** | 300ms 内的即时反馈：按钮变 `[✓ 已加入队列]`（现状 ✅）+ **toast 带 `[前往下载页]` 动作链接**（现状 toast 是纯文本，用户还得自己切 tab）。成功反馈**不阻塞**、4s 自动消失 | `ParsePage.tsx:102-105` 文案"到「下载」页查看进度"—— 把导航工作推给用户。改为动作按钮 |

**Toast 规范**（现状：内联 `.banner.info` 在内容流中 → 出现/消失都造成布局跳动，且 4s 定时器在 state 里 `setToast("")` 复用同一 `.banner`，与真正的面包信息无法区分）

- 容器固定右下（`--z-drawer`），`flex-column-reverse`，同屏 ≤3 条，间距 8px。
- 进出：`translateY(8px)+opacity`，`--t-base`。
- 类型：info（`--accent` 图标）/ success / warning / error。**error 类不自动消失**（`[×]` 手动关），因为用户可能已切走窗口。
- 带 1 个可选动作按钮（撤销 / 前往 / 重试）。
- `aria-live="polite"`（error 用 `assertive`），且**不要 `role="alert"` 滥用**。

### 3.2 解析 → 下载 主流程时序（含边界）

```
输入/粘贴
  ├─ 空内容            → 解析按钮 disabled + tooltip「先粘贴一条链接」
  ├─ 250ms 防抖识别     → 识别条：未识别 / 已识别平台 / 从分享文案提取
  ├─ Ctrl+Enter 或点击  → 按钮 loading 态（spinner + "解析中…"，disabled）+ 结果卡骨架预占位
  ├─ 命中黑名单         → 结果卡内联：「暂不支持解析 腾讯视频 的内容（会员/付费/DRM 保护）」
  │                      ↑ engine.ts:176-180 已本地即时判定，UI 需给"为什么"的说明与「查看支持清单」
  ├─ 未提取到链接        → 输入框 invalid 态（左边条红）+ 内联错 + 「示例链接」帮助弹层
  ├─ 成功 local          → 结果卡 + via chip 绿 + 耗时
  ├─ 成功 online         → 结果卡 + via chip 蓝 + 折叠「为什么走了线上？」= fallbackReason
  ├─ 成功 mock           → 结果卡 + via chip 灰 + **顶部黄 tint 提示条**「当前为骨架演示结果，非真实解析」
  │                      ↑ 现状 mock 只靠 chip 区分，用户可能拿假直链去下载并困惑失败
  └─ 失败               → 结果卡错误态 + failType chip + [重试]（第二次重试后追加 [换平台入口] / [反馈]）
       ↓ 用户点 [下载全部(N)]
     按钮 → [✓ 已加入队列] + toast[前往下载页] + tab 徽标 +1
     若 items.length===0 → 按钮文案「无可下载文件」+ disabled（现状 ✅）
```

**并发与时序细节**

| 场景 | 规范 |
| --- | --- |
| 解析中重复触发 | `busy` 已挡（`ParsePage.tsx:56` ✅），但**按钮需视觉 loading**，不只是文字变化 |
| 解析中切页 | 组件卸载 → `await api.parse` 结果落到已卸载组件。规范：**切页不取消解析**（结果入历史"最近解析"），回来可看见；用 `AbortController` 语义在 bridge 层加 cancel（§4-P7 可选） |
| 直链时效 | README 明确"分钟级"。UI 规则：**结果卡下载按钮超过 5 分钟未点 → 变 `[重新解析并下载]`** + 一句「直链可能已过期」（现状无任何时效提示，失败后才报 `HTTP 403`，用户以为是软件坏了） |
| 同一链接重复解析 | 内核 24h LRU 缓存（`core-adapter/cache.ts`）→ `durationMs` 会突然变成 1ms。UI **必须**在此时显示 `缓存命中` chip，否则"1ms 解析成功"看起来像假的 |
| 重复入队 | `downloader.ts:211-247` 有 `claimedTargets` 避让逻辑（同目标活任务防双写）。UI 应显式提示「该文件已在队列中」而不是静默加一条看不见的重复 |

### 3.3 系统托盘与窗口行为（**当前完全不存在 —— 本方案最重要的一处补全**）

**事实核查**：全仓 grep `Tray` / `Menu.` / `globalShortcut` / `nativeTheme` → **零命中**。且 `main/index.ts:258-261`：

```
app.on("window-all-closed", () => { store.flush(); if (process.platform !== "darwin") app.quit(); })
```

**后果（可直接复现的产品缺陷）**：Windows 上点 ✕ → **整个应用退出** → 正在下载的任务被切断。README/ARCHITECTURE 的 P2 验收是「重启后队列/历史完整」，`.part` 续传确实能救回来，但**用户心智里"关闭窗口 = 最小化到托盘"（所有国内下载器的惯例）**。当前行为等于：**用户只是想收起窗口，却杀掉了 12 个下载**。这是比任何配色都严重的问题。

#### 托盘规格

| 项 | 规格 |
| --- | --- |
| **图标** | 16×16（`tray-icon.png`，Win 通知区实际按 DPI 缩放，建议同时提供 32 备用的 `@2x`）。**双份**：`tray-dark.png` / `tray-light.png`，随主题切；单色描边版，不直接用彩色 logo（通知区小尺寸下糊成一团） |
| **活跃态** | 有 queued/downloading 时图标叠加进度环（用 `Tray.setTitle` 或 `setOverlayIcon`，Win 用 `setOverlayIcon` 更稳）。完成 1 个 → 图标闪一次（`flashFrame(true)`）|
| **Tooltip** | 动态：`即刻解析 · 3 个任务进行中 · 12.4 MB/s`；空闲：`即刻解析` |
| **左键单击** | 显示/聚焦主窗口（`restore()+focus()`，复用 `second-instance` 已有代码 `index.ts:236-241`）|
| **左键双击** | 同上（Win 惯例） |
| **右键** | 托盘菜单（见下）|
| **关窗行为** | 托盘存在时：**点 ✕ = 隐藏到托盘**（首次执行时发一条系统通知「即刻解析仍在后台下载 · 点此恢复」，让用户知道去哪找）。设置项 `closeToTray: true（默认）/ false` |
| **通知** | `new Notification()` 走主进程（renderer 无通知权限，`setPermissionRequestHandler` 已全拒 `index.ts:246`）。触发条件：全部任务完成、失败数 >0、有任务等待用户操作（Cookie 失效类）、更新就绪。**每条通知必须可关**（设置项） |

**托盘菜单**（`Menu.buildFromTemplate`，与 Win11 上下文菜单风格一致，系统原生渲染 —— **不需要我们做样式**，这是选原生而非自绘的关键理由）

```
打开即刻解析                    Ctrl+Alt+O
─────────────
⏸ 全部暂停        （无活任务时置灰）
▶ 全部继续
─────────────
进行中 3 · 12.4 MB/s · 剩余 01:32   （信息行，置灰）
─────────────
暂停更新检查
检查更新…
─────────────
开机自动启动        ☐
显示托盘图标        ☑
─────────────
退出即刻解析        Ctrl+Q     ← 唯一真正的退出入口
```

**任务在飞时点"退出"** → 原生模态（主进程 `dialog.showMessageBox`，`type:'warning'`, `buttons:['仍然退出','取消并继续下载']`）：3 个下载未完成，退出后可从托盘恢复并断点续传。**不静默丢任务**。

**应用菜单（菜单栏）**：`autoHideMenuBar:true`（`index.ts:204`）意味着 Alt 才出现 —— Win 用户几乎不知道有菜单。**建议**：保持隐藏，但把关键项搬到快捷键（§3.4），并在设置页"快捷键"分组里让这套表可见；否则用户无法发现 Ctrl+F/Ctrl+, 之外的功能。

### 3.4 快捷键

**两级实现**（务必区分，二者成本完全不同）：

| 级别 | 范围 | 实现位置 | 是否需要契约变更 |
| --- | --- | --- | --- |
| **L1 应用内**（窗口聚焦时） | 绝大多数 | renderer `keydown` 监听（新增一个 `useHotkeys` hook）| ❌ 零变更，**先做这层** |
| **L2 系统级**（窗口最小化/托盘时） | 仅 2 个 | 主进程 `globalShortcut.register` | ❌ 零契约变更，但要处理**注册失败**（与其他应用冲突）→ 设置页显示"冲突：该组合已被系统/其他应用占用" |

| 快捷键 | 动作 | 说明 |
| --- | --- | --- |
| `Ctrl+V` | 粘贴并解析 | **首页聚焦时**：现状 `Ctrl+Enter` 需要两个键 —— 下载器用户肌肉记忆是"Ctrl+V 一把梭"。粘贴后 600ms 无新字符即自动解析（设置可关）|
| `Ctrl+Enter` | 解析 | **保留现状**（`ParsePage.tsx:81` ✅）|
| `Ctrl+D` | 下载全部（结果卡可见时）| 与浏览器"收藏"冲突无害（Electron 内）|
| `Ctrl+1 / 2 / 3 / 4` | 切页（解析/下载/历史/设置）| VS Code 惯例；tab 上加 `⌃1` 角标提示 |
| `Ctrl+F` | 聚焦当前页搜索框 | 历史/下载页 |
| `Ctrl+Shift+C` | 打开 Cookie 凭据设置 | 解析失败率高时的第一出路，给直达键 |
| `Ctrl+,` | 打开设置 | Windows 应用已普遍采纳 |
| `Esc` | 关弹层 / 清输入框 / 取消当前筛选 | **优先级顺序固定**：模态 > 下拉 > 输入内容 > 筛选。现状无任何 Esc 处理 |
| `Enter` | 表格焦点行 = 主操作（下载 / 打开文件）| 键盘可达性 |
| `↑ / ↓` | 任务行、历史行间移动 | 现状 **Tab 键是唯一导航**，50 行任务 = 按 50 次 Tab。真实可用性问题 |
| `Delete` | 取消选中任务（不删文件）| 需焦点行 + 明确不触碰磁盘 |
| `Ctrl+Shift+P` | 全部暂停 / `Ctrl+Shift+R` 全部继续 | 全局下载栏按钮的等价键 |
| `Ctrl+Alt+V` | 🌐 **系统级**： anywhere 粘贴解析 | 注册于主进程：唤起窗口 → 读剪贴板 → 直接开解析。核心卖点，值得一个全局键 |
| `Ctrl+Alt+O` | 🌐 显示/隐藏主窗口 | 从托盘回来最快路径 |

**冲突与合规**：`Ctrl+D`、`Ctrl+D` 之外的 Win 保留组合（`Win+…`）不占用；`Alt+F4` 不拦截（拦截原生关闭 = 反用户预期）。`globalShortcut` 注册失败必须**降级并提示**，不能静默失效。

### 3.5 无障碍规范（WCAG 2.1 AA 为底线，逐条对应可验收检查）

| 项 | 规格 | 现状缺口 |
| --- | --- | --- |
| **色彩对比** | 正文 ≥4.5，大文本(≥24px 或 ≥18.66px bold) ≥3.0，控件边界/图形 ≥3.0 | 实测 3 处 FAIL：实心按钮 3.68、`--err` 文字 4.29、`.linkish` 链接 4.39 —— §1.3.3 给出修正值（4.55 / 5.83 / 7.49） |
| **焦点可见** | 全局 `:focus-visible { outline:2px solid var(--line-focus); outline-offset:2px }`，**禁止 `outline:none` 而无替代** | 现状仅 `.paste-box textarea:focus{outline:none}` —— **主动移除了焦点环**且无替代。tab 按钮、所有 `button`、`.linkish`、`select` 均无焦点样式 |
| **键盘可达 + 顺序** | DOM 顺序 = 视觉顺序；模态焦点圈闭；`Esc` 可出；无键盘陷阱 | tab 是 `<button>`（原生可聚焦 ✅）；表格行操作按钮可聚焦；**无 aria 标记、无跳过导航** |
| **状态语义** | `role="progressbar"` + `aria-valuenow/min/max`（`total===0` 时**省略 valuemin/valuenow** 表示 indeterminate）；`aria-live="polite"` 区域播报 `文件名 + 完成/失败` | 现状进度条是**两个空 `<div>`**（`DownloadsPage.tsx:61-63`），屏幕阅读器读出来是无声 —— 整个下载页对读屏用户是空页 |
| **图标按钮命名** | 每个纯图标按钮 `aria-label`（"暂停下载 某文件"），`title` 同步 | 现状按钮是文字（"位置""取消"），✅ 可接受；新设计的 `⋯` / 图标化按钮**必须**补 |
| **表单标签** | 每个 input/select 关联 `<label for>` 或 `aria-label`；`aria-describedby` 指向 hint/err | 现状 `Field` 组件的 `<label>` **没有 `htmlFor`**（`SettingsPage.tsx:186-193`）—— 点击标签不聚焦输入，读屏也关联不上。textarea 只有 placeholder（**placeholder 不是标签**）|
| **颜色不是唯一编码** | 状态=图标+文字+色；错误=色+图标+文字 | §3.2 已定 |
| **命中区** | 正文操作 ≥32px（桌面惯例，非 44px 触控线；触屏笔电可选升到 44）| §1.6 已定 |
| **动效敏感** | `prefers-reduced-motion` 全局降级 + 进度条过渡归零 | §1.8 已定 |
| **文本缩放** | 支持 `Ctrl +/-` 到 200% 不破版（用 `rem` 承载字号 Token，根字号 16px，14px=0.875rem）| 现状 CSS **全用 px**，且主进程没有缩放快捷键 —— 无法放大。这是真实的可用性缺陷（老花用户看不清 12px `.chip`）|
| **语言** | `<html lang="zh-CN">`（✅ 现状有）；日期用 `toLocaleString("zh-CN")`（✅）| — |

### 3.6 隐私与"如实呈现"规范（本项目的品牌性格）

代码注释里反复出现"如实"二字（`README:6`「结果来源如实标注」、`types/ipc.ts:296-313`「降级可见 —— 不假装有防护」、`index.ts:71`「启动期如实汇报完整性档位」）。这是这个产品最稀缺的设计资产，**UI 必须把它当视觉语言来强化，而不是抹平**：

1. 任何"降级/回落/mock/未校验"状态**不得只显示一个绿点**。三态色 + 文字 + 可展开原因。
2. 二进制完整性四态（`verified/degraded/rejected/missing`）在**首页**也应有一处低干扰的存在感（如结果卡底部 `via` 行出现「TikTok 需 ffmpeg · 当前未校验 ⓘ」），因为它是解析失败的潜在根因。
3. Cookie 一律掩码 `***`（现状正确 ✅），UI 永不明文回显、不进历史、不进"复制诊断信息"。
4. 「复制诊断信息」内容需白名单：版本号、Electron 版本、内核模式、failType、耗时 —— **不含** Cookie、不含完整文件路径（可含目录名）、不含用户链接。
5. 隐私承诺在空态/关于页用一句人话讲清（现状 `ParsePage.tsx:113` 那句已经很好，保留并强化）。

---

## 4. 渐进式落地建议（贴合现有技术栈，零功能代码推翻）

### 4.0 总原则

| 原则 | 具体化 |
| --- | --- |
| **依赖只用白名单** | 允许 `@radix-ui/react-dialog/select/switch/toast` + `lucide-react`（headless/无样式，只接行为与 a11y）；**不加** Tailwind / shadcn / framer-motion / tanstack。理由见 C4 业主修订（2026-10-14）：模态/combobox/toast 自研 a11y 成本 1–2 天/件且易错，headless 原语收益为正；样式仍全走现有 `styles.css` Token |
| **不推翻结构** | 保留 `App.tsx` 的 state 路由（不引 router）、保留四页文件划分、保留 `.page / .card / .chip / .table / .field` 等现有选择器名（**只在原选择器上换 Token，不重命名**，把 diff 压到最小）|
| **不动功能代码** | `electron/main/downloader.ts`（19KB，含 Range/Referer/重试/避让，且 `tests/downloader.test.ts` 覆盖）、`engine.ts`、`fallback.ts`、`core-adapter/*` 的**逻辑一律不改**。需要新数据时**只加可选字段/新 channel**，向后兼容 |
| **契约变更最贵，最后做** | 每加一个字段要同改 `types/ipc.ts` + `preload/index.ts` + `main/ipc.ts`(+zod) + `renderer/lib/bridge.ts`（`types/ipc.ts:9` 的警告注释已写死这条）。§4.2 明确标注每个阶段的"契约成本" |
| **CI 不破坏** | `npm run typecheck`（`strict` + `noUnusedLocals` + `noUnusedParameters`）与 `npm run test`（含 `boundaries.test.ts` 铁律 1：renderer 不得出现 `@/lib`）是每阶段的验收门 |

### 4.1 分阶段路线（P0 纯样式 → P6 需契约扩展）

> 优先级判据：**用户可感知缺陷严重度 × 实现成本 × 契约风险**。

| 阶段 | 内容 | 触及文件 | 契约成本 | 验收信号 |
| --- | --- | --- | --- | --- |
| **P0 · Token 基座（1 天，最高 ROI）** | `styles.css` `:root` 换成三层 Token；**色值与现值保持兼容**（`--panel`→`--surface-sunken` 同值），补齐 `--line-control / --surface-2 / tint / overlay / r-* / sp-* / t-* / z-*`；字号改 `rem` + tabular-nums；全局 `:focus-visible`；`prefers-reduced-motion`；Light 主题块（`[data-theme="light"]`，此时先不被触发）| `renderer/src/styles.css` **仅此 1 个文件** | **无** | `npm run dev` 双主题手改 `data-theme` 截图；对比度脚本（§4.3）全绿；`typecheck/test` 不受影响 |
| **P1 · 组件层修补（1–2 天）** | 按钮变体（solid/outline/ghost/danger）、自定义 Switch、输入框 invalid 态、chip 三态、骨架屏类 `.skeleton`、toast 容器（portal 到 `--z-drawer`）、进度条 indeterminate + `transform:scaleX`、表格粘性头 + 行 hover、`.empty` 拆成 `.empty--first/.empty--filtered` | `styles.css` + 各 `pages/*.tsx` 的 **className 与包装 div**（逻辑不动）| **无** | 首页/下载/历史/设置四页在 820px 与 1440px 各截一图；无破版 |
| **P2 · 明暗主题可用（2 天，需小契约）** | `AppSettings.theme: "dark"\|"light"\|"system"`；设置页"外观"分组；主进程读 `nativeTheme` 并回传；托盘/任务栏图标双份预留 | `types/ipc.ts`（`AppSettings` 加**可选**字段 + `DEFAULT_SETTINGS`）→ `ipc.ts` zod → `SettingsPage.tsx` → `index.ts`（`nativeTheme` 监听）| **低**（加字段，非加 channel；`DEFAULT_SETTINGS` 兜底旧档）| 改系统主题 → 应用跟随；重启后保持；`tests/ipc.test.ts` 的 settings round-trip 不挂 |
| **P3 · 下载页重构（3–4 天，**零契约**） | ① **按 `groupId` 分组 + 折叠**（数据已在 `DownloadTaskView.groupId`！）② 分段筛选/搜索（客户端过滤）③ 状态×动作矩阵（§3.2）④ error 徽标改红 + 图标 ⑤ ETA + tabular ⑥ done 行渲染层隐藏 + 「清理已完成」⑦ 批量选择条 ⑧ 全局底部下载栏（复用现有 `onProgress` 事件）| `DownloadsPage.tsx`、`App.tsx`（徽标+全局栏）、`styles.css`；新增 `components/DownloadRow.tsx / GroupRow.tsx / Toast.tsx` | **无**（`groupId` 与 `onProgress` 均已存在）| 30 图集 → 1 个组行 + 折叠；切页后进度仍可见；`npm run test`（`downloader.test.ts` 不受影响）|
| **P4 · 结果卡补全（2–3 天，**零契约**）** | ① **清晰度选择器**（消费 `ParseData.qualities`/`videos[].qualities`，此前完全未被使用）② 图集缩略网格 + 预览模态 ③ `stat/avatar` 元数据行（含 `statsUnreliable` 警告）④ `embedUrl` → `[在浏览器打开]`（`<a target=_blank>` 走既有 `setWindowOpenHandler`）⑤ 直链时效提示 ⑥ `缓存命中` chip（`durationMs<50` 推断）⑦ 失败态 `[重试]` + `failType` 折叠 | `ResultCard.tsx`（+ 少量 `styles.css`）| **无**（契约字段早就有，是渲染层漏读）| 用 B站链接实测出现多清晰度可选；小红书出现缩略网格 |
| **P5 · 托盘 + 窗口 + 快捷键（3–4 天，**零契约**，风险最高价值最大）** | `Tray` + 上下文菜单 + 关窗最小化到托盘 + 系统通知 + 应用菜单模板 + `globalShortcut`（2 个）+ renderer `useHotkeys`（L1 全部）+ 设置页"外观/快捷键"分组 | `electron/main/index.ts`（装配层，符合"业务逻辑不在这"的注释约束 —— 建议新开 `electron/main/tray.ts` + `menu.ts` + `shortcuts.ts` 三个装配件）、`App.tsx` | **无** | **核心验收**：下载中点 ✕ → 托盘仍在、任务继续、托盘恢复后状态完好；`Ctrl+Alt+V` 从任意应用唤起解析；`second-instance` 复用路径不退化 |
| **P6 · 需要新 channel / 字段的能力（按需，逐个评估）** | 见下表 | — | **高**（4 处联动 + zod + 测试） | — |

#### P6 明细（把"想要的体验"和"必须付的契约成本"对齐，避免顺手加字段）

| 需求 | 需要的最小新增 | 不做会怎样 | 建议时机 |
| --- | --- | --- | --- |
| 显示重试进度 `重试中 2/3` | `DownloadTaskView` 加**可选** `attempts?: number`（`downloader.ts:61` 已有该字段，`toView()` 里加一行） | 用户看到进度条反复归零以为卡死 → 手动取消 | 低成本，随 P3 |
| 打开文件（非仅 reveal） | `app:openPath`（主进程 `shell.openPath`）+ `bridge` + zod | done 态只能"打开所在目录"，多一步 | 随 P5 |
| 队列真正移除 / 清理已完成 | `download:remove`（含 taskId 数组）+ 主进程剪 `order/tasks` + 落盘 | 渲染层隐藏可覆盖 90% 需求；但 `snapshot()` 仍写 queue.json，**重启后隐藏项会回来** | 先隐藏，P6 再补真删除 |
| 历史全文搜索 / 单条删除 / 关键词 | `HistoryFilter.keyword?` + `history:remove{id}` | 200 条内可渲染层过滤（够用）；单条删不掉是真实痛点（只有"清空全部"） | 随 P6-1 |
| 文件是否存在（失效灰） | `app:pathExists{paths[]}` | 历史点开失效路径静默无反应 | 随 P6 |
| 更新完整流程 | `evUpdateDownloaded` + `app:quitAndInstall` + `download-progress` 事件 | **现状文案"重启应用即自动更新"与实际不符**：`index.ts:273` 只监听 `update-available`，从未监听 `update-downloaded`，也没触发 `quitAndInstall` —— 重启并不会自动装上。这是**文案骗人**，P0 阶段就应把该横幅改为「发现新版本，去设置检查并安装」，或补 `update-downloaded` | 文案修正立即（P0/P1）；完整 UI 随 P6 |
| 剪贴板监听（打开窗口自动填入） | 主进程 `clipboard.readText()` + `app:pasteFromClipboard` | 无自动化，需用户 Ctrl+V（已够用）—— **不建议做**，静默读剪贴板是隐私噪音 | 不做，除非用户要求 |
| 远程功能开关（README P4） | `engine:status` 事件 | `IPC.evEngineStatus`（`types/ipc.ts:129`）**已在契约里定义但全仓无人发送、无人订阅** —— 属于"预留位"。等 P4 远程开关真正落地时一并接 UI（首页顶部黄条"部分平台暂停服务：X"） | 随上游 P4 |
| 导出脱敏配置 | `app:exportConfig`（`store.ts:118 exportRedacted` **已实现但无 IPC 通道暴露**） | 后端能力在，UI 摸不到 → "备份设置"无法做 | 低成本（store 现成），P6 |

### 4.2 契约变更的标准动作清单（每次改动照抄）

```
1) types/ipc.ts            —— 加字段用 `?:` 或给 DEFAULT_SETTINGS 兜底；加 channel 进 IPC 常量表（禁散落字面量）
2) electron/main/ipc.ts    —— zod schema 同步（.strict() 会拒未知键！注意 SettingsPatchSchema 是 strict）
3) electron/preload/index.ts —— 白名单加一行，返回解绑函数（事件类）
4) renderer/src/lib/bridge.ts —— 类型化封装 + unwrap
5) tests/ipc.test.ts / boot.test.ts —— 端到端断言新字段；boundaries.test.ts 应无需改（renderer 不得 import @/lib）
6) 旧档兼容：userData/config.json 缺新字段 → loadConfig() 的 { ...DEFAULT_SETTINGS, ...raw.settings } 已兜底 ✅（store.ts:95-101）
```

⚠️ 三个易踩的坑（读码所得）：

- `SettingsPatchSchema` 是 **`.strict()`**（`ipc.ts:71`）→ renderer 传任何未声明字段直接 `bad-input`。P2 加 `theme` 必须先加 schema。
- `settings:set` 传**全量** `AppSettings`（`SettingsPage.tsx:38-42` 现状 `...current`）→ 新字段若漏进 `current` 会被 strict 拒。
- Cookie 掩码约定：`"***"` = 不修改、`""` = 清除（`ipc.ts:196-200`）。任何"清空 Cookie"的新按钮必须**发空串**，不能不发。

### 4.3 每条设计声明的验收方式（不靠感觉交付）

| 声明 | 验收命令 / 动作 |
| --- | --- |
| 不破构建 | `npm run typecheck && npm run lint && npm run test` |
| 不破边界铁律 | `npm run test -- tests/boundaries.test.ts`（确保新加的 `components/*.tsx` 没误引 `@/lib`）|
| 双主题不破版 | `MG_KERNEL_MODE=mock npm run dev`，`Ctrl+Shift+C` 打开 DevTools → 设备工具栏设 820×560 与 1920×1080 → 四页 × 两主题 = **16 张截图**逐一肉眼核（重点：表格列挤压、chip 换行、模态溢出）|
| 对比度真的达标 | 用一个 20 行的对比度脚本（我在本方案中已用此法实测，脚本临时用完已删）遍历 `fg/bg` 配对表 → 断言 `ratio >= 4.5`（正文）/ `>= 3.0`（控件）。**不要凭"看起来够"** —— 本方案就靠它抓出了 3 处 AA 违规（3.68 / 4.29 / 4.39），并证明"看着刚好"的 `#5a6577` 描边其实只有 2.74，不满足 1.4.11 |
| 键盘可达 | 只用键盘完成：粘贴→解析→选清晰度→下载→切下载页→暂停一个→打开目录→进设置改主题→退出。每一步都要能看见焦点环 |
| 读屏可懂 | DevTools → Accessibility → 检查进度条有 `progressbar` role 与 value；toast 在 `log`/`status` 地标内 |
| 动效可关闭 | 系统设置开"显示动画效果"关闭（Win `prefers-reduced-motion`）→ 复跑首页/下载页，确认无滑动/闪烁 |
| 托盘不退化 | 下载中点 ✕ → 检查进程仍在（任务管理器）→ 托盘恢复 → 队列与 `.part` 完好 → 与 `downloader.restore()` 的 P2 验收一致 |

### 4.4 明确不建议做的事（减法清单）

| 诱惑 | 为什么不做 |
| --- | --- |
| 换 shadcn/Tailwind/Next 风格栈 | C1–C4 全线冲突；`typecheck` 的 `strict` + 现有 11 个渲染文件的体量，重写收益为负 |
| 侧边栏导航 | 820px 最小宽下吃 200px 内容；现有拖拽区逻辑已跑通；4 个页面不需要 |
| 首屏 hero 化 / 大插画营销风 | 工具类应用，用户停留时长集中在任务列表；视觉预算该给进度与状态 |
| ~~引入 lucide-react 等图标包~~（**2026-10-14 业主修订：允许**） | 原判定"违反无新依赖基线"已被 README C4 修订取代：`lucide-react` 进入白名单（tree-shaking、按需打包）。仍不建议引入**其他**图标方案（icon font 违反 C1、SVG sprite 外链违反 CSP）。注意：图标统一 `strokeWidth={1.5}` 以保持原方案 1.5px 描边一致性 |
| 打包 Web 字体 | CSP `default-src 'self'` 需改 CSP 才能加载远程字体（**安全倒退**），本地打包则 +2–5MB 体积换不到质变；`Segoe UI Variable` 在 Win11 已是优质选择 |
| 自绘窗口标题栏（frameless） | 现状用原生帧 + `app-region:drag` 已工作；frameless 要自己实现 Win11 圆角/贴边吸附/最大化遮挡/DPI/快照，成本极高收益极小 |
| 历史存直链 / "一键重新下载" | 违反 `ARCHITECTURE.md §3` 与隐私红线；直链分钟级失效，存了也是废数据。用"重新解析"替代 |
| 剪贴板静默监听 | 隐私噪音，且 `Ctrl+Alt+V` 显式动作已覆盖需求 |
| 多窗口 / 每任务独立窗口 | Electron 多窗 + 单实例锁 + `restore()` 语义会复杂化（`claimedTargets` 防双写逻辑跨窗会失效）|

---

## 5. 附录

### 5.1 现状问题清单（读码核对，按严重度）

| # | 严重度 | 问题 | 位置 | 本方案对应 |
| --- | --- | --- | --- | --- |
| 1 | **高** | 关窗即退出，正在下载的任务被打断；无托盘 | `main/index.ts:258-261`（grep `Tray`/`Menu.`/`globalShortcut`/`nativeTheme` 全仓零命中） | §3.3 / P5 |
| 2 | **高** | 实心按钮 `#fff on #3b82f6` = **3.68:1**，AA 不达标 | `styles.css:9,152-157` | §1.3.3 改 `#2f6fed`(4.55)/Light `#2563eb`(5.17) |
| 3 | **高** | 控件边界对比不足：`--line` 在暗色对 `--surface` 仅 **1.06**，输入框靠 `--panel` 底 + `--line` 边几乎不可辨 | `styles.css:6,350-360` | §1.3.2 新增 `--line-control`（4.28） |
| 4 | **高** | `ParseData.qualities` / `videos[].qualities` / `.accept` **完全未被消费** → 多清晰度平台用户无法选画质 | `ResultCard.tsx:21-41` | §2.1-P4 |
| 5 | **高** | `groupId` 契约齐备但界面平铺 → 30 图 = 30 行 | `types/ipc.ts` 4 处 + `DownloadsPage.tsx:49` | §2.2 / P3 |
| 6 | **高** | 更新横幅文案「重启应用即自动更新」与实际不符：只监听 `update-available`，无 `update-downloaded`/`quitAndInstall` | `main/index.ts:272-278` | §4.2-P6 表首行（文案先改）|
| 7 | **中** | `error` 状态徽标映射为 `warn`（橙），与"已暂停"同色 | `DownloadsPage.tsx:113` | §2.2 状态矩阵 |
| 8 | **中** | 历史页平台筛选项来自"当前列表去重" → 选过一个平台后无法切到另一个（选项池随结果收缩）| `HistoryPage.tsx:20-25` | §2.3（选项源改 `meta.platforms`）|
| 9 | **中** | 历史页显示原始 key（`redbook`）而体检显示中文名（`小红书`）—— 同一数据两套显示 | `HistoryPage.tsx:49` vs `SettingsPage.tsx:163` | §2.3 |
| 10 | **中** | 加载态被渲染成空态（"加载设置…" 用 `.page.empty`）| `SettingsPage.tsx:30`、`DownloadsPage.tsx:32` 首帧 | §3.1 四态分离 |
| 11 | **中** | `.linkish`（历史文件名按钮）`#3b82f6 on #1d2129` = **4.39:1** 不达标 | `styles.css:341-348` | §1.3.3 改 `--accent-text` |
| 12 | **中** | `--err #ef4444 on #1d2129` = **4.29:1** 不达标（`button.danger`、`.banner.error`）| `styles.css:12,159-162,171-174` | §1.3.3 改 `#f87171` |
| 13 | **中** | 焦点环被主动移除且无替代：`textarea:focus{outline:none}`；其余控件无 `:focus-visible` | `styles.css:120-123` | §3.5 |
| 14 | **中** | `act()` 空 catch 静默吞所有错误（无法区分状态竞争与真实失败），尽管 `BridgeError.code` 已可用 | `DownloadsPage.tsx:21-28` | §3.1 错误三层 |
| 15 | **中** | toast 复用内容流里的 `.banner` → 出现即布局跳动；与"信息横幅"视觉同形 | `ParsePage.tsx:96,111` | §3.1 Toast |
| 16 | **中** | `meta.platforms`（含 `name/nameEn/supportsIdParse`）只用于显示数量；支持清单不可发现，`platformHint` 契约字段闲置 | `ParsePage.tsx:116` | §2.1 平台墙/下拉 |
| 17 | **中** | 速度/字节/百分比无 `tabular-nums` → 数字宽度跳动 | `DownloadsPage.tsx:64-74` | §1.4.1 |
| 18 | **中** | 表格 5 列 + `.prog{min-width:160px}` 在 `minWidth:820` 下挤压无降级策略 | `styles.css:294-299` + `index.ts:200` | §2.0 响应式策略 |
| 19 | **中** | `Field` 的 `<label>` 无 `htmlFor`；textarea 只有 placeholder 无标签 | `SettingsPage.tsx:186-193`、`ParsePage.tsx:77-86` | §3.5 |
| 20 | **中** | 设置页脏状态不跟踪，切页即静默丢弃未保存内容（`s` 为局部 state，组件卸载）| `SettingsPage.tsx:18,24-30` | §2.4 保存交互 |
| 21 | **中** | `maxConcurrent` 裸 number 输入可键 99 → 被 zod `max(10)` 拒，错误原文抛给用户 | `SettingsPage.tsx:67-75` + `ipc.ts:65` | §2.4 stepper |
| 22 | **中** | `done` 任务永不离开 `list()`（`order` 只增不减）→ 列表无限增长 + 与历史重复，且无"清理已完成" | `downloader.ts:137-138,323` | §2.2 清理 |
| 23 | **中** | `store.exportRedacted()` 已实现但**无 IPC 通道暴露** → 无法"备份设置" | `store.ts:118` vs `preload/index.ts` | §4.2-P6 |
| 24 | **中** | 无 Light 主题：`:root` 硬编码暗色，无 `data-theme`/`prefers-color-scheme`（grep 零命中）| `styles.css:2-13` | §1.2 / P2 |
| 25 | **低** | 无 `z-index` 体系；原生 `confirm()` 用于危险操作（清空历史）| `styles.css` 全文 / `HistoryPage.tsx:30` | §1.5.4 / §2.3 |
| 26 | **低** | `IPC.evEngineStatus` 已定义但全仓无发送/订阅（预留位）| `types/ipc.ts:129` | §4.2-P6 随上游 P4 |
| 27 | **低** | UI 显示的文件名由渲染层拼装，主进程 `sanitizeFilename(x,80)` 会截断 → 显示名与实际落盘名可能不一致 | `ResultCard.tsx:24-40` vs `ipc.ts:162` | §2.1 结果卡注 1 |
| 28 | **低** | `.mono` 用 Consolas；`已保存 ✓`/`已加入队列 ✓` 用文本字符而非 SVG 图标 | `styles.css:362-365,341` | §1.7 |

### 5.2 Design Token 总表（可直接粘贴的 CSS）

```css
/* —— 层 1：原始色板（唯一允许 hex 字面量之处）—— */
:root{
  --gray-0:#ffffff; --gray-50:#f6f7f9; --gray-100:#eef0f3; --gray-150:#e2e5ea;
  --gray-200:#e6e9ee; --gray-500:#8b95a7; --gray-600:#6b7280; --gray-700:#54617a;
  --gray-800:#5b6472; --gray-900:#22262f; --gray-950:#14161a;
  --blue-300:#93c5fd; --blue-400:#7cb3ff; --blue-500:#3b82f6; --blue-600:#2f6fed;
  --blue-700:#2563eb; --blue-800:#1d4ed8;
  --emerald-400:#34d399; --emerald-700:#15803d;
  --amber-400:#fbbf24;   --amber-700:#b45309;
  --red-400:#f87171;     --red-700:#b91c1c;
}

/* —— 层 2：语义角色（主题切换只改这里）—— */
:root,[data-theme="dark"]{
  --bg:#0f1115; --surface:#1d2129; --surface-2:#22262f; --surface-sunken:#171a21;
  --overlay:#0b0d12cc;
  --text:#e6e8ee; --text-muted:#9aa3b5; --text-placeholder:#7d879a;
  --text-disabled:#6b7689; --text-on-accent:#ffffff;
  --line:#2a2f3a; --line-control:#78849a; --line-control-hover:#9aa3b5;
  --line-focus:#7cb3ff; --line-invalid:#f87171; --line-valid:#34d399;
  --accent-solid:#2f6fed; --accent-text:#7cb3ff; --accent-soft:#17243a;
  --ok:#34d399; --warn:#fbbf24; --err:#f87171;
  --tint-ok:#12291f; --tint-warn:#2a2210; --tint-err:#2a1518; --tint-info:#17243a;
  --progress-fill:#7cb3ff; --progress-track:#262b34;
  --sh-1:0 1px 2px #00000040; --sh-2:0 4px 12px #00000059; --sh-3:0 12px 32px #00000073;
}
[data-theme="light"]{
  --bg:#f6f7f9; --surface:#ffffff; --surface-2:#f2f4f7; --surface-sunken:#eef0f3;
  --overlay:#14161ab3;
  --text:#14161a; --text-muted:#5b6472; --text-placeholder:#7b8496;
  --text-disabled:#8b95a7; --text-on-accent:#ffffff;
  --line:#e2e5ea; --line-control:#6b7280; --line-control-hover:#54617a;
  --line-focus:#2563eb; --line-invalid:#b91c1c; --line-valid:#15803d;
  --accent-solid:#2563eb; --accent-text:#1d4ed8; --accent-soft:#eaf1ff;
  --ok:#15803d; --warn:#b45309; --err:#b91c1c;
  --tint-ok:#f0fdf4; --tint-warn:#fffbeb; --tint-err:#fef2f2; --tint-info:#eaf1ff;
  --progress-fill:#2563eb; --progress-track:#e6e9ee;
  --sh-1:0 1px 2px #14161a0f,0 0 0 1px #e2e5ea; --sh-2:0 4px 12px #14161a14,0 0 0 1px #e2e5ea;
  --sh-3:0 12px 32px #14161a1f,0 0 0 1px #cbd2da;
}

/* —— 层 2.5：排版 / 间距 / 圆角 / 动效 / 层级（主题无关）—— */
:root{
  --font-ui:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  --font-mono:"Cascadia Mono","Consolas",monospace;
  --fs-display:1.375rem; /* 22 */ --fs-h1:1.125rem; /* 18 */ --fs-h2:.9375rem; /* 15 */
  --fs-body:.875rem;     /* 14 */ --fs-meta:.8125rem; /* 13 */ --fs-caption:.75rem; /* 12 */
  --fs-micro:.6875rem;   /* 11 */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-8:32px; --sp-12:48px;
  --r-sm:6px; --r-md:8px; --r-lg:12px; --r-full:999px;
  --t-fast:120ms cubic-bezier(.2,0,.38,.9);
  --t-base:200ms cubic-bezier(.4,0,.2,1);
  --t-slow:320ms cubic-bezier(0,0,.2,1);
  --t-progress:300ms linear;
  --z-sticky:10; --z-drawer:20; --z-modal:30; --z-menu:40; --z-tip:50;
}

/* —— 全局基线补丁 —— */
html{font-size:16px}
body{font-family:var(--font-ui);font-size:var(--fs-body);line-height:1.55;
     background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--line-focus);outline-offset:2px;border-radius:var(--r-sm)}
.num,table td:nth-child(n+3){font-variant-numeric:tabular-nums}
button{min-height:32px;border-radius:var(--r-md)}
button:disabled{color:var(--text-disabled);border-color:var(--line);opacity:1} /* 换色不换透明度 */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
  .bar-in{transition:none!important}
}
```

### 5.3 组件状态速查（交付给开发的规格粒度）

| 组件 | rest | hover | active | focus-visible | disabled | loading |
| --- | --- | --- | --- | --- | --- | --- |
| Button solid | `--accent-solid` / `--text-on-accent` | 亮度 −6% + `--sh-2` + `translateY(-1px)` | `translateY(0)` + 亮度 −10% | ring `--line-focus` 2px/offset 2 | `--surface-2` 底 + `--text-disabled` | 16px spinner + 文案不变，宽度锁定（防抖） |
| Button outline | `--surface` 底 / `--line-control` 边 | 边转 `--accent-text` + 底 `--accent-soft` | 底 `--accent-soft` 加深 | 同上 | 边 `--line` + 字 `--text-disabled` | — |
| Button danger | 边 `--line-invalid` 字 `--err` | 底 `--tint-err` | 底 `--tint-err` 加深 | 同上 | — | — |
| Input | `--surface-2` 底 / `--line-control` 边 | 边 `--line-control-hover` | — | 边 `--line-focus` + `0 0 0 3px var(--accent-soft)` | 底 `--surface` + 字 `--text-disabled` | — |
| Input invalid | 边 `--line-invalid` + 左 3px 色条 + `--fs-meta` 错误文本（`aria-describedby`）| | | | | |
| Switch | 32×18，`--line-control` 描边，off 底 `--surface-sunken` | 拇指放大 1px | — | ring | 透明度 40% | 变更时 120ms 位移 |
| Chip 状态 | tint 底 + 语义字 + 12px 图标 | — | — | 可点 chip：ring | — | — |
| Progress | track `--progress-track` / fill `--progress-fill`，`scaleX` + 300ms | — | — | `role=progressbar` + value | — | indeterminate：16px 亮段 1.4s 循环 |
| Task row | `--surface` | `--surface-2` | 选中 `--accent-soft` + 左 2px `--accent-text` | `tabindex=0` + ring | — | 重试中：fill 60% 透明度 + `重试中 2/3` |
| Toast | 4s 自动关（error 不自动），`--z-drawer`，≤3 条，动作按钮 1 个 | — | — | `aria-live` | — | — |

### 5.4 关键术语对照（保持与代码一致，避免 UI/开发两头叫法）

| 界面用语 | 代码用语 | 契约 |
| --- | --- | --- |
| 解析 | parse | `parse:run` / `ParseRunOutcome` |
| 识别 | identify | `parse:identify` |
| 任务 / 队列 | download task | `DownloadTaskView` / `DownloadStatus` |
| 图集（一组文件） | group | `groupId` / `EnqueueOutcome` |
| 历史 | history | `HistoryEntry`（**不含直链**）|
| 线上回落 | fallback / via=`online` | `fallbackReason` |
| 本地内核 | via=`local` | `kernelMode`（app 级）与 `via`（请求级）**不同层级** |
| 骨架演示 | via=`mock` | `MG_KERNEL_MODE` |
| 随包组件完整性 | binary integrity | `BinaryStatusView.integrity`（4 态）|
| 解析通道体检 | engines probe | `probe:engines` / `EngineHealth.detail`（3 种真相）|

---

## 6. 一句话总结

**不重写、不加依赖、不推翻功能代码**：先在 `styles.css` 单文件里把三层 Token（含明暗双主题与已实测达标的对比度）换成地基（P0，1 天），再修组件层的 3 处 AA 违规与控件边界可见性（P1），然后用**契约里早已存在却没被界面消费的字段**（`groupId`、`qualities`、`meta.platforms`、`onProgress`）把下载页和结果卡补齐（P3/P4，零契约成本），最后补上当前完全缺失、且正在真实伤害下载体验的**托盘 + 快捷键**（P5）。需要新增 IPC 的能力全部集中在 P6 逐条评估 —— 因为每加一个字段要改 4 个文件。

---

## 7. Air 风格迁移（2026-10-14，业主授权；与 §1–§2 冲突处以本节为准）

### 7.1 迁移定位

借鉴 QQ Music 21.x「Air 空气设计」的**手法**而非其音乐播放器形态：视觉降噪、克制、通透、动态光影。禁项（业主原话钉死）：不做音乐播放器界面；不复制 QQ 音乐 Logo/版权图标/品牌绿；不用 Material FAB 与厚重阴影；品牌/动态色「吝啬」使用；禁纯黑 `#000` 与纯白 `#FFF`（品牌平台图标除外，沿用上游 `public/logos` SVG，见 §1.7）。

概念迁移位：专辑封面→视频缩略图；底部播放器→底部任务控制条；歌词页→解析日志/下载详情；封面魔法色→缩略图主色驱动的 `--accent-color`。

### 7.2 色板与魔法色协议

- **高对比黑白灰基座**（Token 层 1，`styles.css`）：底色 `#121212`、卡片 `#1E1E1E`、主文字 `#F2F2F2`（非纯白）、次要 `#B3B3B3`；light 覆盖 `#F2F2F3/#FBFBFC/#1A1A1C`。静态强调一律灰（`--air-accent-fallback #D4D4D4`），色彩只经动态魔法色进入。
- **动态魔法色**（`renderer/src/lib/accent.ts`）：当前封面 → canvas 32×32 降采样 → 每通道 32 级量化直方图、权重 =1+3×饱和度（死黑/过曝像素剔除）→ 主色 HSL 亮度钳位 L∈[0.45,0.75] → 写 `documentElement` 的 `--accent-color`；`@property --accent-color`（syntax `<color>`, inherits true）+ **只在 `:root` 声明** 400ms `cubic-bezier(0.4,0,0.2,1)` 过渡（写在 `*` 会覆盖组件自身 transition 简写）；`--accent-ink` 按相对亮度翻转（>0.5→`--air-on-accent-dark`，否则 light）。提取失败/跨域污染画布 = 移除内联覆盖回落缺省灰。**JS 内不写 hex 字面量**（色值只活在层 1）。
- 派生角色全走 `color-mix`：`--accent-soft 18%`、`--accent-glow 30%`、`--tint-info 12%`、`--line-focus/--accent-solid/--progress-fill = --accent-color`。消费点：选中竖条（侧栏 3px）、进度条填充、主按钮填充、聚焦描边、底条光晕。

### 7.3 四区布局（App Shell 修订，替代 §2.0）

| 区 | 规格（实测值） | 说明 |
| --- | --- | --- |
| 左侧栏 | 220px；`#121212` 60% + `backdrop-filter: blur(20px)`；含品牌字、五页导航（lucide 图标 + `⌃1–5` 角标 + 选中左侧 3px accent 竖条）、版本 meta-chip | 拖拽区，控件 no-drag |
| 悬浮顶栏 | 高 60px，距边 16px（`.air-main` padding/gap 均 16）；玻璃同侧栏、圆角 8px；**全局粘贴入口**（输入 + 解析按钮，Ctrl+K 直达，Enter 提交后切解析页自动解析） | 聚焦光感 = accent 描边 |
| 主内容 | 大卡片网格；缩略图 16:9 圆角 6px；标题 16px/500、元信息 12px 灰；页面切换 `page-in` 250ms 淡入上移 8px（`key={page}` 重挂载） | 首页 `HomePage.tsx`（最近历史 + 队列摘要） |
| 底部任务条 | 高 80px 悬浮玻璃 `blur(30px)`；`.taskbar-bg` = 当前封面 `blur(60px) saturate(1.3)`，上叠 `#00000099` 遮罩；下载中 `breathe` 20s alternate scale 1→1.05（reduced-motion 关闭）；左=首字缩略/文件名/状态，中=进度条(4px)+速度+ETA+暂停/继续/取消，右=队列数→点切队列页；App 层订阅 `download.list/onProgress/onDone/onError`，跨页存活 | 封面切换 = 双层交叉淡入 400ms（旧层垫底 + 新层 `key` 重挂载淡入；`background-image` 不可 transition，故用双层） |

### 7.4 组件状态与动效包

- 按钮：圆角 6px 扁平无阴影；主按钮 `--accent-color` 填充 + `--accent-ink` 文字；`:active` 通用 `translateY(1px)`，`.primary` 专规 `scale(0.96)`（transform 并入按钮 transition）。
- 卡片：hover `translateY(-4px)` + `--sh-2`（`0 8px 24px #00000066`）；仅结果卡/历史卡/首页卡启用。
- 进度条：轨道 `rgba(255,255,255,.3)`（light `#00000026`），填充 accent，宽度过渡 300ms linear。
- 日志/详情：等宽字体、`#0D0D0D` 底 `#D4D4D4` 字（既有实现对齐即可）。
- 图标分工：导航/动作 = lucide-react（strokeWidth 1.5）；平台 = 上游品牌 SVG（`PlatformIcon` 单点出口，遵守 §1.7 同源纪律）。字体族维持 §1.4.1 系统栈（C1 不变）。
- 降级：`prefers-reduced-motion` 关 `page-in`/`breathe`/`enter`/进度宽度过渡。

### 7.5 实现落点与验收

`vite.config.ts`（`@tailwindcss/vite`，CSS-first 无 tailwind.config）；`styles.css`（层 1 Air 色板 + `@theme inline` 桥工具类到语义变量，运行时 var 变更即时生效）；`App.tsx`（四区 + 全局粘贴 + 任务订阅）；`components/Taskbar.tsx`；`pages/HomePage.tsx`；`lib/accent.ts`。验收门：typecheck/lint/165 测试/build:app 全绿；浏览器数值实测四区几何 220/60/16/80、玻璃 blur 20·30·60 与 alpha、accent 竖条 3px、进度 4px、`--accent-glow` 随内联 accent 更新（headless 隐藏页会挂起过渡时钟，插值终值以解除 transition 后取样验证）。

**零 IPC 变更**：封面 URL 经解析结果 `data.cover` 由 ParsePage 上抛（`onCover`），契约未加字段（C3 纪律保持）。
