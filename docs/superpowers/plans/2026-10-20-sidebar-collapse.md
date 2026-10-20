# 主页面导航栏收起 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 主页面左侧导航栏支持收起（56px 仅图标 + 悬停 tooltip），品牌行放收起/展开切换按钮，收起态不显示 logo，状态经 localStorage 持久化。

**架构：** 收起状态是 UI chrome，不入 `AppSettings`（不动 IPC 六件套）。纯函数 `renderer/src/lib/sidebar-pref.ts` 负责 localStorage 值的解析/序列化并被单测钉住；`App.tsx` 的侧栏按状态在两条宽度与两种渲染形态间切换，宽度过渡 200ms（`prefers-reduced-motion` 下关闭）。规格见 `docs/superpowers/specs/2026-10-20-sidebar-collapse-design.md`。

**技术栈：** React 19 + Tailwind（arbitrary value 消费 CSS token）+ 现有 shadcn `Tooltip`/`Badge` + vitest。

**规格偏差记录（实现定稿）：** 规格里「文字淡出」简化为「文字卸载」——标签保持挂载做淡出会把 `gap-2.5` 留在居中布局里，图标偏移 5px；宽度过渡本身已承担动效语义。其余全按规格。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `renderer/src/lib/sidebar-pref.ts` | localStorage 键常量 + 解析/序列化纯函数（可单测） |
| 创建 `tests/sidebar-pref.test.ts` | 上述纯函数的 L1 守卫（缺 key=展开、`"1"`=收起、往返一致） |
| 修改 `renderer/src/App.tsx` | 状态 + 持久化接线；品牌行切换按钮；导航项/设置钮收起态渲染 |
| 修改 `renderer/src/styles.css` | 新增 `--w-side-collapsed: 56px` token（紧挨 `--w-side`） |

不改：设置页 `SettingsPage.tsx`、品牌资产、IPC 任何一层。

---

### 任务 1：收起偏好的纯函数（TDD）

**文件：**
- 创建：`tests/sidebar-pref.test.ts`
- 创建：`renderer/src/lib/sidebar-pref.ts`

- [ ] **步骤 1.1：编写失败的测试**

```ts
/**
 * 侧栏收起偏好的读写守卫（L1，纯函数无 DOM）。
 * localStorage 里只允许两种值：缺 key/非 "1" = 展开，"1" = 收起——
 * 解析器把任何脏值都折叠回展开，序列化器只产出 "0"/"1"。
 */
import { describe, expect, it } from "vitest";
import { parseSidebarCollapsed, serializeSidebarCollapsed } from "../renderer/src/lib/sidebar-pref";

describe("parseSidebarCollapsed", () => {
  it("缺 key 与任意脏值都折叠回展开", () => {
    expect(parseSidebarCollapsed(null)).toBe(false);
    expect(parseSidebarCollapsed("")).toBe(false);
    expect(parseSidebarCollapsed("junk")).toBe(false);
    expect(parseSidebarCollapsed("0")).toBe(false);
  });

  it("「1」= 收起", () => {
    expect(parseSidebarCollapsed("1")).toBe(true);
  });
});

describe("serializeSidebarCollapsed", () => {
  it("布尔只产出 0/1，且与解析器往返一致", () => {
    expect(serializeSidebarCollapsed(false)).toBe("0");
    expect(serializeSidebarCollapsed(true)).toBe("1");
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(true))).toBe(true);
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(false))).toBe(false);
  });
});
```

- [ ] **步骤 1.2：运行测试验证失败**

运行：`pnpm vitest run tests/sidebar-pref.test.ts`
预期：FAIL，`Cannot find module '../renderer/src/lib/sidebar-pref'`

- [ ] **步骤 1.3：编写最小实现**

`renderer/src/lib/sidebar-pref.ts`：

```ts
/**
 * 侧栏收起偏好的读写契约（规格 docs/superpowers/specs/2026-10-20-sidebar-collapse-design.md）。
 *
 * 为什么是 localStorage 而不是 AppSettings：收起是 UI chrome 不是用户数据——
 * 进设置要动 IPC 六件套（types/ipc、ipc-contract、handler、preload、bridge、mock-bridge），
 * 还会被设置页的草稿/脏计数/保存条语义裹挟。渲染层自管，一行读写。
 *
 * 值域刻意收窄成 "0"/"1"：解析器把缺 key 与任何脏值都折叠回展开（false），
 * 未来即便有人手改了 localStorage 也不会炸出半收起态。
 */
export const SIDEBAR_COLLAPSED_KEY = "mg.sidebar.collapsed";

/** localStorage 原始值 → 是否收起。缺 key/脏值一律展开 */
export function parseSidebarCollapsed(raw: string | null): boolean {
  return raw === "1";
}

/** 是否收起 → localStorage 原始值，与 parseSidebarCollapsed 互逆 */
export function serializeSidebarCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}
```

- [ ] **步骤 1.4：运行测试验证通过**

运行：`pnpm vitest run tests/sidebar-pref.test.ts`
预期：PASS（3 条全绿）

- [ ] **步骤 1.5：Commit**

```bash
git add renderer/src/lib/sidebar-pref.ts tests/sidebar-pref.test.ts
git commit -m "feat(shell): 侧栏收起偏好的持久化纯函数"
```

---

### 任务 2：宽度 token + App 状态与品牌行切换按钮

**文件：**
- 修改：`renderer/src/styles.css:297`（`--w-side` 那一行旁）
- 修改：`renderer/src/App.tsx`

- [ ] **步骤 2.1：styles.css 加 token**

在 `--w-side: 208px;`（约 297 行）下面插一行：

```css
  --w-side: 208px; /* 外壳侧栏（utility 里以 w-(--w-side) 消费） */
  --w-side-collapsed: 56px; /* 外壳侧栏收起态：仅图标列（规格 2026-10-20） */
```

- [ ] **步骤 2.2：App.tsx 补 import**

import 区（第 9–30 行附近）确保有这三行（已有则跳过）：

```tsx
import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Download, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "./lib/utils";
```

并在 `./lib/nav-icons` 的 import 之后加：

```tsx
import { SIDEBAR_COLLAPSED_KEY, parseSidebarCollapsed, serializeSidebarCollapsed } from "./lib/sidebar-pref";
```

- [ ] **步骤 2.3：App.tsx 加状态（`reducedMotion` 声明之后）**

```tsx
  /** 侧栏收起（规格 2026-10-20）：UI chrome，localStorage 自管，不入 AppSettings（不进脏计数/保存条） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    parseSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)),
  );
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, serializeSidebarCollapsed(next));
      return next;
    });
  }, []);
```

- [ ] **步骤 2.4：改 `<nav>` 宽度与品牌行（替换现 188–194 行那段）**

现结构（定位锚点）：

```tsx
        <nav className="drag-region flex w-(--w-side) shrink-0 flex-col gap-1 border-r border-border bg-panel pb-3 ps-2 pe-2" aria-label="页面导航">
          {/* 品牌行：字标垂直居中于「页面顶部」与「首个导航项（56px 线）」之间 = 带中心（20px）再下移 8px（translate-y-2）。
              mb-3 + 列表 gap-1 = 16px，首个导航项与右侧内容（带高 40 + main 的 p-4）都落在 56px 这条线上。
              字标 18px 高：比 15px 文字略重，又不至于顶满带高（品牌资产见 BrandLogo） */}
          <div className="mb-3 flex h-(--wco-h) items-center px-3">
            <BrandLogo className="h-[18px] w-auto translate-y-2" />
          </div>
```

整段替换为：

```tsx
        <nav
          aria-label="页面导航"
          className={cn(
            "drag-region flex shrink-0 flex-col gap-1 border-r border-border bg-panel pb-3 ps-2 pe-2",
            "transition-[width] duration-200 motion-reduce:transition-none",
            sidebarCollapsed ? "w-(--w-side-collapsed)" : "w-(--w-side)",
          )}
        >
          {/* 品牌行：展开 = 字标（垂直落点=「页面顶 0px」与「导航栏顶 56px」的中点，带中心下移 8px）
              + 收起钮在字标右侧（业主 2026-10-20）；收起 = 只剩展开钮，不渲染 logo（同日定稿）。
              mb-3 + 列表 gap-1 = 16px，首个导航项与右侧内容（带高 40 + main 的 p-4）都落在 56px 这条线上 */}
          <div className="mb-3 flex h-(--wco-h) items-center px-3">
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label="展开导航栏"
                aria-expanded={false}
                className="no-drag mx-auto flex h-9 w-9 translate-y-2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <PanelLeftOpen size={16} strokeWidth={1.5} />
              </button>
            ) : (
              <>
                <BrandLogo className="h-[18px] w-auto translate-y-2" />
                <button
                  type="button"
                  onClick={toggleSidebar}
                  aria-label="收起导航栏"
                  aria-expanded={true}
                  className="no-drag ms-auto flex h-9 w-9 translate-y-2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <PanelLeftClose size={16} strokeWidth={1.5} />
                </button>
              </>
            )}
          </div>
```

注意：切换按钮沿用字标的 `translate-y-2`（同一视觉行）。`no-drag` 不能省——nav 整条是 `drag-region`，漏掉按钮会变成拖拽把手。

- [ ] **步骤 2.5：typecheck**

运行：`pnpm typecheck`
预期：0 error

- [ ] **步骤 2.6：Commit**

```bash
git add renderer/src/styles.css renderer/src/App.tsx
git commit -m "feat(shell): 侧栏收起状态与品牌行切换按钮"
```

---

### 任务 3：导航项与底部按钮的收起态渲染

**文件：**
- 修改：`renderer/src/App.tsx`（nav 内 NAV_ITEMS.map 与底部 `mt-auto` 块）

- [ ] **步骤 3.1：替换 NAV_ITEMS.map 整段**

定位锚点：`{NAV_ITEMS.map((it) => (` 到对应 `))}`（约 196–218 行）。整段替换为：

```tsx
          {NAV_ITEMS.map((it) => {
            const btn = (
              <button
                type="button"
                onClick={() => setPage(it.key)}
                aria-current={page === it.key ? "page" : undefined}
                aria-label={it.label}
                className={cn(
                  "no-drag relative flex h-9 items-center gap-2.5 rounded-md text-sm text-muted-foreground outline-none transition-colors",
                  "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-[current=page]:font-medium",
                  sidebarCollapsed ? "w-9 justify-center px-0" : "px-3",
                )}
              >
                {/* 切换那一下的入场动效由入仓组件自带（成为当前页时 AnimIcon 唤起，见 lib/nav-icons.ts） */}
                <AnimIcon Icon={it.Icon} active={page === it.key} />
                {!sidebarCollapsed && <span>{it.label}</span>}
                {it.key === "downloads" && running > 0 && !sidebarCollapsed && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="ok" className="ms-auto">
                        {running}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{running} 个任务进行中</TooltipContent>
                  </Tooltip>
                )}
                {/* 收起态徽标缩为图标右上角角标：数字是窄条里唯一非文字信息，不随文字一起消失 */}
                {it.key === "downloads" && running > 0 && sidebarCollapsed && (
                  <Badge variant="ok" className="absolute right-0.5 top-0.5 h-3.5 min-w-3.5 px-1 py-0 text-[9px] leading-none">
                    {running}
                  </Badge>
                )}
              </button>
            );
            // 收起态包 Tooltip（side="right"）；aria-label 已保证无文字时屏幕阅读器可读
            return sidebarCollapsed ? (
              <Fragment key={it.key}>
                <Tooltip>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right">{it.label}</TooltipContent>
                </Tooltip>
              </Fragment>
            ) : (
              <Fragment key={it.key}>{btn}</Fragment>
            );
          })}
```

- [ ] **步骤 3.2：替换底部 `mt-auto` 块**

定位锚点：`<div className="mt-auto flex items-center gap-1">` 到对应 `</div>`（约 220–255 行，「设置」按钮 + 更新就绪按钮）。整段替换为（「设置」按钮先提成 `settingsBtn` 常量再按状态包 Tooltip；更新就绪按钮原样保留）：

```tsx
          <div className={cn("mt-auto flex items-center gap-1", sidebarCollapsed && "flex-col")}>
            {(() => {
              const settingsBtn = (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsEntry(null);
                    setSettingsMode(true);
                  }}
                  onMouseEnter={() => {
                    if (!reducedMotion) settingsGlyphRef.current?.startAnimation();
                  }}
                  onMouseLeave={() => settingsGlyphRef.current?.stopAnimation()}
                  aria-label="设置"
                  className={cn(
                    "no-drag flex h-9 items-center gap-2.5 rounded-md text-sm text-muted-foreground outline-none transition-colors",
                    "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    sidebarCollapsed ? "w-9 justify-center px-0" : "flex-1 px-3",
                  )}
                >
                  {/* 悬停驱动（挂 ref 后组件自身不响应 hover，见 components/AnimIcon.tsx）；离开即 stop——settings 是整枚回转，不复位也能复播，但与其他字形统一语义 */}
                  <SETTINGS_GLYPHS.entry ref={settingsGlyphRef} size={16} className="anim-icon" aria-hidden="true" />
                  {!sidebarCollapsed && <span>设置</span>}
                </button>
              );
              return sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>{settingsBtn}</TooltipTrigger>
                  <TooltipContent side="right">设置</TooltipContent>
                </Tooltip>
              ) : (
                settingsBtn
              );
            })()}
            {update?.phase === "downloaded" && updatePolicy.onStartup && updatePolicy.autoDownload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="更新包已下载完成，去关于页安装"
                    onClick={() => {
                      setSettingsEntry("about");
                      setSettingsMode(true);
                    }}
                    className="no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ok outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <Download size={16} strokeWidth={1.5} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>更新包已就绪，点「立即重启」安装</TooltipContent>
              </Tooltip>
            )}
          </div>
```

收起时容器转 `flex-col`：56px 窄条横排放不下「设置 36px + 更新钮 36px + gap」，竖排才能共存。

- [ ] **步骤 3.3：typecheck + lint**

运行：`pnpm typecheck && pnpm lint`
预期：0 error（碰了 `App.tsx` 全量 lint 会跑，属正常）

- [ ] **步骤 3.4：Commit**

```bash
git add renderer/src/App.tsx
git commit -m "feat(shell): 导航项与设置钮的收起态渲染"
```

---

### 任务 4：收尾验证（同一批改动只完整验证这一次）

- [ ] **步骤 4.1：全量门**

运行：`pnpm typecheck && pnpm lint && pnpm test`
预期：全绿。`pnpm test` 全离线；`tests/sidebar-pref.test.ts` 3 条应全过。

无 IPC/契约面 → 不跑 `contract`/`boundaries` 专项；无新 runtime 依赖/打包链路改动 → 不跑 `verify:binaries*`。

- [ ] **步骤 4.2：L5 人工核对（dev server，不写进验收门）**

`pnpm dev` 后在 `127.0.0.1:5433`（mock 桥）逐条核对：

1. 收起/展开动画平滑（reduced-motion 系统设置下直接切换、无过渡）
2. 收起态：四页图标 + 底部设置图标，悬停右侧浮 tooltip；下载页有任务时右上角数字角标
3. 展开态：字标 + 右侧收起钮，一切如旧
4. 收起状态刷新页面（重启 Electron）后保持
5. 设置模式侧栏不受影响（始终展开，「返回」在左下角）
6. 侧栏窄条上的窗口拖拽仍正常（drag-region），切换按钮可点（no-drag）

- [ ] **步骤 4.3：如有人工修正，随修随 commit**

```bash
git add -A
git commit -m "fix(shell): 侧栏收起实机核对修正"
```
