# MediaGet Desktop

> 把「粘一条分享链接 → 拿到视频/图集并落盘」做成 Windows 桌面客户端：解析走你本机的住宅 IP，直链拿到就下，Cookie 只存在你自己机器上。

![CI](https://github.com/hotier/mediaGet-desktop/actions/workflows/ci.yml/badge.svg)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-44-2b2e3a?logo=electron)
![License](https://img.shields.io/badge/license-MIT-green)

**解析内核不在本仓。** 解析逻辑只在 [mediaGet](https://github.com/hotier/mediaGet) 仓的 `packages/parse-core/` 维护一份，本仓以版本化工件 `@mediaget/parse-core` 消费——线上 Web 与桌面客户端同源，平台接口一改两端同时受益。

## 简介

线上解析服务失败的头号原因是**数据中心出口 IP 被平台 WAF 拦截**（抖音 -412、B 站 -352、小红书风控等），桌面客户端走你本机的家庭宽带 IP 直连，成功率普遍高于线上服务。另有两件浏览器与线上服务做不到的事：解析直链只有分钟级时效，客户端拿到就在主进程流式落盘，不做「复制直链」让用户二跳；TikTok 链路要 yt-dlp + ffmpeg，随包分发就能跑。Cookie 由你在本机设置页配置，不经过任何第三方服务器。

面向的是「把自己有权保存的内容收进本地库」的个人场景：无水印素材备份、自媒体自己的作品归档、跨平台收藏。它不是批量抓取或分发工具——不做反检测加码，不碰黑名单平台，也不携带任何服务端凭据。

## 功能特性

**解析**

- 21 个平台的链接与整段分享文案识别，解析全部在本机完成：抖音、快手、小红书、皮皮虾、西瓜视频、最右、皮皮搞笑、虎牙直播、哔哩哔哩、微博、全民K歌、六间房、新片场、好看视频、AcFun、Twitter/X、TikTok、Instagram、YouTube、QQ音乐、汽水音乐
- 支持注册表标注平台的「平台 + ID」直接解析；粘贴 600ms 自动解析，也可点平台墙注入提示
- 首页批量导入：一次粘多行，或选 txt·csv 模板文件，逐条串行解析
- 结果卡给无水印直链、可选画质、图集缩略网格 + 模态预览、作者与计数元数据、缓存命中与失败态重试
- 平台开关在设置「引擎」体检表的「提供」列：关掉的平台在**任何引擎被调用之前**就回绝，缓存里的旧结果也不放行——不是只在 UI 上藏起来
- 线上 API 只作逃生通道（上游改版风暴、用户主动开启时才用）；无网络且回落关闭时落 mock，结果来源（local / online / mock）在结果卡如实标注

**下载**

- 主进程流式落盘：Range 断点续传 + 平台 Referer/UA 防盗链 + 失败重试；重启后未完成任务自动恢复
- 队列页一张表九列：多资源链接按作品聚合成主线程行、可展开逐文件，暂停/继续/重试逐任务控制
- 文件名组合可配（预设 + 自定义片段）、下载目录可换、并发可配
- TikTok 走随包 yt-dlp（ffmpeg 同包），二进制版本与 SHA-256 钉在 `resources/binaries.json`
- 系统通知按作品分组收敛（图集不逐张弹）、托盘 + 关窗最小化（下载中关窗不杀任务）、可选剪贴板监听命中链接自动投首页

**记录与统计**

- 历史页是**解析台账**：解析成功即记录，没下载也留一行（「未下载」是一个正常状态而非缺数据），支持多选删除
- 统计页：趋势、成功率、平台/类型榜、活跃热力、解析通道、体积分布、常看作者；两本账分开——比率只从计数档算，不从明细算

**客户端本身**

- 五页（首页 / 队列 / 历史 / 统计 / 设置）+ 快捷键 `Ctrl+1–4`、`Ctrl+K` 聚焦粘贴、`Ctrl+,` 设置、`Esc` 返回
- 明暗 × 五套风格 × 字号三轴正交，字体族按本机已装字体枚举
- 应用内检查更新（electron-updater + GitHub Releases）：不静默下载，包体几十 MB 由你点

## 演示 / 截图

界面截图尚未入仓。本地一眼看到全部五页（含 mock 数据，无需真链接与网络）：

```bash
pnpm install --frozen-lockfile
pnpm dev                      # Electron 真窗口；renderer 同时监听 http://127.0.0.1:5433
```

只用浏览器看界面就打开 `127.0.0.1:5433`——它走 dev-only mock 桥，解析与下载都是假数据，用来核对布局、主题与浮层足够；要看真实链路必须起 Electron。窗口默认 1080×740、最小 820×560，主题默认跟随系统。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 44 + electron-builder 26（Windows：`nsis` + `portable` 双产物），electron-updater 6 |
| 主进程 | Node + TypeScript 5.9，tsup 打包；`undici` 出站；`font-list` 枚举本机字体 |
| 解析内核 | `@mediaget/parse-core` 0.1.x（上游仓 `packages/parse-core/` 的版本化工件），本地注入件在 `core-adapter/` |
| 渲染层 | Vite 7 + React 19 + Tailwind v4 + shadcn/ui（vendored 基座）+ Radix 原语 |
| 状态与校验 | zod 3.25（IPC 载荷形状唯一声明处）、Zustand 5（两个 store：平台开关、首页草稿） |
| 图表与动效 | ECharts 6（统计页整页懒加载、色值由 CSS Token 探针取）、motion 14（图标动效）、sonner（toast） |
| 测试与工程 | vitest 3.2（43 个测试文件，全离线）、eslint 9 + typescript-eslint、husky + lint-staged + commitlint、release-it 21 |
| 随包二进制 | yt-dlp `2026.08.19`、ffmpeg `b6.1.1`（固定 tag 直链 + SHA-256 强校验，见 `resources/binaries.json`） |
| 包管理 | pnpm 唯一（`packageManager` 字段是版本真源；npm/yarn 被根 `preinstall` 守卫拦掉） |

## 快速开始

前置只有本仓 + pnpm，**不需要并列检出 `../mediaGet`**（物理链接桥已拆除）。

```bash
corepack enable pnpm          # 没有 pnpm 时
pnpm install --frozen-lockfile
pnpm dev                      # 先软补随包二进制，再 vite + tsup --watch + Electron 联调
pnpm run build:app            # 只出 dist-electron/ + dist-renderer/（本机验收门用这个）
pnpm run build                # 上面 + electron-builder --win → release/
pnpm run typecheck            # tsc --noEmit
pnpm run lint                 # eslint（flat config）
pnpm run test                 # vitest run（全离线，禁真网络）
pnpm run fetch:binaries       # 手动补齐/重下随包二进制（CI 用严格版，缺件即红）
pnpm run release              # 过三门禁 → 按 commit 前缀升版本 → 写 CHANGELOG → 打 tag → push
```

提交格式 `type(scope): 摘要`（scope 必填）——前缀不是审美而是发版输入：`feat`→minor、`fix`→patch、`!` 或 `BREAKING CHANGE`→major。

改 IPC 通道 = 动六处（`types/ipc.ts` / `types/ipc-contract.ts` / `electron/main/ipc.ts` / `electron/preload/index.ts` / `renderer/src/lib/bridge.ts` / `renderer/src/dev/mock-bridge.ts`），并升 `CONTRACT_VERSION`；漏一处是静默少字段而不是编译错误，所以改完跑 `pnpm run test`（`contract` / `boundaries` / `ipc` 三个守卫会当天红叉），别只跑 typecheck。按「改了什么」选最低够用档的完整纪律在 [docs/TESTING.md](docs/TESTING.md)。

## 工作方式

```
renderer (Vite + React)  ──contextBridge/IPC──►  main (Node)
  五页 · 只经桥取数                              ├─ engine.ts：供给闸门 → 引擎轮询
                                                 ├─ downloader.ts：流式落盘
  加平台 = 改 shared/platforms.ts 一处            ├─ store.ts / stats.ts：userData JSON
  + 放一枚 renderer/public/logos/*.svg            └─ fallback.ts：线上逃生通道
                                                        │
                                                        └──► @mediaget/parse-core（工件）
```

三条硬约束，都有测试守着：解析逻辑只在 `packages/parse-core/` 一份（本仓 import 工件、不复制、不挖内部实现）；renderer 只能经 IPC 拿数据，全仓不 import route 层与 Next.js 运行时模块；平台清单只有一个真源 `shared/platforms.ts`，主进程与渲染进程 import 同一份。

## 项目状态

| 阶段 | 交付 | 状态 |
|---|---|---|
| P0 | 上游内核抽取为 `packages/parse-core`，本仓切工件依赖 | 已完成（21 平台联机冒烟全部 `via=local`） |
| P1 | Electron 骨架 + 粘贴→识别→解析→展示 | 已完成 |
| P2 | 下载管理器、批量图集、历史、设置 | 已完成 |
| P3 | yt-dlp/ffmpeg 随包、electron-builder 打包、CI | 已完成（本机 `pnpm run build` 末段受环境限制，验收用 `build:app`） |
| P4 | 线上回落、引擎 runner 化、平台开关切路由 | 已完成 |
| P5 | 托盘、关窗最小化、通知聚合 | 已完成 |
| P6 | 应用内自动更新 | 代码完成，端到端待第一个 `v*` 标签 |

IPC 契约 `CONTRACT_VERSION = 8`（v8 的形状零改动，但 `history.json` 的语义从下载台账改成解析历史）。剩余两件：**真实 tray 图标资产**，以及**打第一个 `v*` 标签**——没有 Release 就没有 `latest.yml`，应用内「检测更新」目前永远查不到版本（缺 Release，不是缺代码）。

## 隐私与安全

- 服务端运维 Cookie（`BILIBILI_COOKIE`、`IG_COOKIE`）**绝不打包、绝不硬编码**；客户端只接受用户在设置页自配，且 IPC 出参侧永远是脱敏视图。
- Cookie、历史、统计、文件日志全在 `userData`：不写 Cookie 值、不写媒体直链，历史与队列不保留直链。
- 不解析黑名单平台（微信视频号、付费/DRM），沿用内核判定；不做反检测加码。
- 除「回落线上 API」外，所有出网动作都在主进程，内容不经任何第三方服务器。

## 文档

| 文件 | 管什么 |
|---|---|
| [AGENTS.md](AGENTS.md) | 改代码前必读的硬约束与本机的坑 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | §1 进程边界与硬约束、§2 目录职责、§3 IPC 通道清单、§6 安全红线、§7 构建发布、§8 两仓怎么分、§9 耦合治理 |
| [docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) | Token 分层与视觉语义真源；§7 布局、§8 shadcn 基线、§9 统计页、§10 图标动效 |
| [docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md) | 施工交接单；**§6 勘误记录**逐条记每次界面决策与对蓝图的有意偏离（本文不重述） |
| [docs/TESTING.md](docs/TESTING.md) | 验证档位表：改了什么 → 最低够用档 |
| [resources/README.md](resources/README.md) | 随包二进制怎么取、怎么校验 |

## 许可

MIT（见 `package.json`；仓内 `LICENSE` 文件待补）。工具只提供解析与下载能力，内容版权与使用授权归原平台与作者——请只用于你有权保存的内容。
