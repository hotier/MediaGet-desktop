# 测试与验证纪律

> 核心原则只有一条：**按「改了什么」选最低够用的一档；同一批改动只在收尾时完整验证一次。**
> 全量套件 ≈5s、构建 ≈4s，看着便宜，但对每条改动无差别地跑三遍才是真浪费——
> 既拖慢施工，又制造「全绿了应该没问题」的错觉（绿的是上一版代码）。
> 本文件是施工方（含 agent 团队）的验收口径；CI 配置见 `.github/workflows/ci.yml`。

## 1. 验证档位（从低到高）

| 档 | 命令 | 覆盖什么 | 耗时 |
|---|---|---|---|
| **L0 机械门禁** | `pnpm typecheck` `pnpm lint` | 类型、引用完整、flat-config 规则 | ~10s |
| **L1 定向单测** | `npx vitest run tests/<相关>.test.ts` | 被测改动对应的那份测试 | 1–3s |
| **L2 契约/边界** | `npx vitest run tests/contract.test.ts tests/boundaries.test.ts tests/ipc.test.ts tests/kernel-sync.test.ts` | IPC 通道对账、依赖铁律、主进程 handler、内核镜像一致性 | ~5s |
| **L3 全量** | `pnpm test`（27 文件 / 397 例） | 全部离线逻辑 | ~5s |
| **L4 构建** | `pnpm build:app` | tsup + vite 产物成立 | ~4s |
| **L5 实机人工** | `pnpm dev` / 安装包 + 浏览器 | 窗口、托盘、打包态、像素与几何 | 不可压缩 |

**升档规则**：只有当低档「覆盖不到本次改动的风险面」时才升。升了也只跑那一个相关的包，
不要顺手把上面所有档全过一遍。

## 2. 改动类型 → 最低够用档

| 改动 | 需要的验证 | 不需要 |
|---|---|---|
| README / `docs/**` 正文、注释、勘误 | **无** | 所有档 |
| `.gitignore`、环境变量样例、纯配置文本 | **无** | 所有档 |
| 界面文案字符串 | L0；**若该字符串被守卫断言钉着**（见 §3）→ L1 跑对应守卫 | L2/L3 |
| renderer 纯 className/样式（无逻辑变化） | L0；改 `styles.css` → L1 `style-discipline`；观感归 L5 | L2/L3/L4 |
| 业务逻辑 / 纯函数（`core-adapter`、`downloader`、`lib/**`） | L1 对应单测 → 收尾 L3 一次 | — |
| IPC 契约（`types/**`、`electron/main/ipc.ts`） | L2 全套 | 逐通道手测 |
| 主进程生命周期（窗口/托盘/单实例） | L2 + L5（vitest 只跑 `tests/stubs/electron.ts`，真窗口测不到） | 幻想 L3 能兜住 |
| 新增 runtime 依赖 | L0 + L3 + L4；`package.json` 与 `pnpm-lock.yaml` **同 commit**（铁律） | — |
| 随包二进制（`resources/**`、`scripts/fetch-binaries.cjs`） | `pnpm verify:binaries` + L4 | L1 |
| 消费解析内核的改动（`engine.ts`、`@/lib/**` 调用点） | L1 `engine` + L2 `kernel-sync` | 全量 |
| 重构（不改行为） | L0 + 触及面的 L1 → 收尾 L3 一次 | — |

## 3. 看似无害、实则会被打破的三处

仓库有**源码扫描型守卫**（读文件内容做断言，不执行代码），纯样式/文案改动也可能踩线：

- [tests/boundaries.test.ts](../tests/boundaries.test.ts)：**按源文件逐个生成用例**——增删一个 `.ts/.tsx` 文件，用例数就变（历史上删一个组件从 200→198 例）。
- [tests/style-discipline.test.ts](../tests/style-discipline.test.ts)：读 `renderer/src/styles.css`——hex 只在层 1、消费的变量必须已声明、无 `--air-*` 残留。
- [tests/toast-sonner.test.ts](../tests/toast-sonner.test.ts)：读三处 toast 消费方与 `ui/sonner.tsx`——`setToast` 残留、`next-themes`、`@import "sonner"` 都在断言面里。

碰到这三面时：跑**对应那一个**守卫，不是全量。

## 4. 不需要测试的修改（明确清单）

1. 文档、注释、勘误记录、里程碑状态列；
2. 未跟踪目录、`.gitignore` 加行；
3. 格式化产物（`eslint --fix` 自产的差异）；
4. 与代码无耦合的 README 示例/表格调整；
5. **已被 L0 静态保证的改动**：加 `import type`、类型收窄、补 JSDoc。

> 判断口诀：改动的字节**不会进入任何可执行分支** → 不测；会进 → 查 §2。

## 5. 同一批改动只验证一次（流程）

```
一批编辑（一个连贯意图）
  → L0（typecheck + lint 一起）
  → L1（只跑与被编辑文件相关的）
  → 触及契约/边界才 L2
  → 收尾 L3 一次  ← 唯一一次全量
  → 涉打包/依赖才 L4
  → 视觉/几何 L5 人工
```

**禁止**：

- 每 edit 一个文件就跑一次全量（前 5 次都是无效等待）；
- 失败后**没改代码**就重跑同一档（结果不会变，先读失败详情）；
- 用 `pnpm test` 去验一个只有 L5 才能验的东西（假绿比不绿更坏）；
- agent 团队里多人各自跑全量——分工按写作用域（disjoint scope），验证归收尾一方。

**提交前一次性核对**：L0 过、L3 过、（需要时）L4 过、`git status` 里没有意外文件
（现坑：`Python/` 40 MB 嵌入式 CPython 未被忽略，`git add .` 会污染仓库）。

## 6. 什么时候才写新测试

不是每条改动都要配测试。**只有这两类写**：

1. **纯函数/逻辑分支**：值得钉住的行为（`work-info`、`download-plan`、`store` 节流落盘等）。
2. **踩过坑的回归守卫**：把「一次事故」钉成一条断言，成本压到最低——
   例：`toast-sonner.test.ts` 里「styles.css 永不 `@import "sonner"`」（显式引入让产物多背 14 kB 重复样式，
   sonner 的 JS 在 import 时已运行时自注入，且 CSP `style-src 'unsafe-inline'` 放行）。

**不写**：

- 只为覆盖率的 UI 快照；
- 依赖真实网络的解析测试（一律走 mock 核 / fake fetch，本仓 `pnpm test` 必须能离线跑）；
- 需要引入 jsdom/happy-dom 才能做的 DOM 断言——本仓 test 依赖**只保留 vitest**，
  为一个冒烟测试加 30 MB 依赖不划算。

> 实况教训（2026-10-15）：给 sonner Toaster 写渲染冒烟时，`renderToStaticMarkup` 在 node 环境
> 连撞 `matchMedia`→`document.head`→`createElement`→`getAttribute`→`getComputedStyle` 五层桩，
> **桩到失真的冒烟等于不测**。正确做法：真逻辑（主题订阅）写成 `tests/theme.test.ts` 的单测，
> 接线事实（用没用对模块/Token）降级为源码结构断言。

## 7. 已知抖动与处置口径

| 现象 | 根因 | 口径 |
|---|---|---|
| `store.test.ts`「超过 500 条截断」在全量里偶尔 `Test timed out in 5000ms` | 505 次 `appendHistory` 每次 fsync 原子写；单文件跑 ≈2s，fork 并发 + 杀软拖到 5s 边缘 | **单独重跑该文件**确认即放行；不为此改被测实现、不加全局 `testTimeout`、不缩小用例（它钉的是 HISTORY_MAX 行为） |
| agent-browser / headless Chrome 在本机挂起或空输出 | 环境限制 | 视觉/几何核对走用户已有的 dev server（127.0.0.1:5433）人工看，**不写进验收门**，也别为它折腾自动化 |

## 8. 与 CI 的分工

- CI（push / PR）跑 L0 + L3，`build-win` 再跑 L4 与 `verify:binaries:release` + 安装包内容断言。这两段各只有一份实现（`.github/workflows/_verify.yml` / `_build-win.yml`），`ci.yml` 与 `release.yml` 都只是调用方——加门禁改那两个文件，别在调用方里抄步骤。
- 本地按本文件选档，**把 L3 之外的兜底交给 CI**：单 PR 里出现「CI 红、本地绿」时，
  先对齐档位差异（多半是漏了 L2 或 L4），而不是给本地加跑更多遍。
