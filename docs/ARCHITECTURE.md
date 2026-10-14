# 开发架构（详版）

> 面向要改本仓代码的人。仓库定位、总体决策见 [`../README.md`](../README.md)；本文给目录职责、进程边界、IPC 契约、数据流与实现约定。
> 上游（解析内核）的架构细节见 [mediaGet/docs/architecture.md](https://github.com/hotier/mediaGet/blob/main/docs/architecture.md)。
> **两仓怎么分、内核怎么同步**见本文 §8（定稿，含业界参照与换方案信号）。

## 0. 一句话数据流

```
用户在 renderer 粘贴分享文案
  → preload: bridge.parse(text)  → IPC invoke "parse:run"
  → main/engine.ts: 装配 parse-core 工件（§8）identifyPlatform → parseCore(url)
  → main 归一化结果 → 返回 renderer 渲染结果卡
  → 用户点「下载」 → IPC "download:enqueue" → downloader.ts 流式落盘（Referer/Range/重试）
```

渲染层**永不**接触直链以外的网络请求；除「回落线上 API」外，所有出网动作都在主进程。

## 1. 进程边界与依赖方向

| 层 | 可运行环境 | 能 import | 不能 import |
| --- | --- | --- | --- |
| `core-adapter/` | Node（主进程） | `@mediaget/parse-core` 公开入口（§8；P0 过渡期为物理链接的 `mediaGet/src/lib/**`）、本仓 `core-adapter/*` | electron、renderer、`src/app/api/**` |
| `electron/main/` | Node（主进程） | `core-adapter`、parse-core 工件、`electron`、Node 内置 | renderer 代码、任何 TSX/React |
| `electron/preload/` | 隔离 world | `electron`（`contextBridge`/`ipcRenderer`）、共享类型 | 解析内核、Node 重模块（沙箱开启后 Node 能力受限） |
| `renderer/` | 浏览器 | 本仓 `renderer/**`、`src/types` 纯类型、mediaGet 的**纯前端** util（`utils/share.ts`、`format.ts`、部分 `components/videos`） | `src/lib/**` 服务端模块、`electron`、Node 内置 |

三条硬约束（CI 应校验）：

1. `renderer/**` 不得出现 `@/lib/`（服务端解析层）——只能经 IPC。
2. 全仓不得 import `mediaGet/src/app/api/**`；route 层属于线上服务。
3. 跨进程共享的类型放 `packages/shared-types`（或 `types/ipc.ts`），单一真源，renderer 与 main 都从这里取。

## 2. 目录职责

| 路径 | 放什么 | 不放什么 |
| --- | --- | --- |
| `electron/main/index.ts` | 应用生命周期、窗口、菜单、单实例锁、深链注册 | 业务逻辑 |
| `electron/main/engine.ts` | 解析引擎装配：注入 `core-adapter`（cache/config/analytics）→ 调 parse-core 工件（§8）→ 暴露 `parse(textOrUrl)` / `identify(text)` | HTTP、窗口操作 |
| `electron/main/ipc.ts` | 所有 `ipcMain.handle` 注册；入参校验（不可信输入一律 zod 式校验后才进内核） | 直接调平台解析器 |
| `electron/main/downloader.ts` | 下载队列：并发上限、优先级、断点续传、Referer/UA 组装、进度事件、失败重试 | 解析逻辑 |
| `electron/main/resources.ts` | yt-dlp/ffmpeg 定位：dev 用本地路径，prod 首启从 `resources/` 释放到 `userData/bin/` 并校验哈希 | — |
| `electron/main/fallback.ts` | 线上 API 回落：按开关把请求转发 `https://get.hotier.cc.cd/api/parse`，超时与错误归类 | 自造解析 |
| `electron/main/store.ts` | `userData` 配置/历史读写（JSON 文件 + 原子写；不用 SQLite 除非历史量大） | 敏感凭据明文（见 §6） |
| `electron/preload/index.ts` | `contextBridge.exposeInMainWorld('mg', {...})` 白名单 | 通配转发（禁止 `ipcRenderer` 原样暴露） |
| `renderer/src/lib/bridge.ts` | 对 `window.mg` 的类型化封装 + React hooks | 直接拼 IPC channel 名 |
| `core-adapter/` | 内核的本地注入件（cache/analytics/config/ratelimit） | 任何解析算法 |
| `resources/` | 第三方二进制（git-lfs 或 CI 拉取，**不入 git**） | 源码 |

## 3. IPC 契约（v0 草案）

约定：所有 invoke 返回 `{ ok: true, data } | { ok: false, error: { code, message, failType? } }`；`failType` 沿用 mediaGet 语义（`bot-gated` / `sources-down` / `source-unavailable` / `script-error`），renderer 据此差异化提示与触发回落。

### 请求/响应

| channel | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `app:getMeta` | — | `{ version, electron, platforms[] }` | 平台清单来自内核 `PLATFORM_INFO`，不在 renderer 复制 |
| `parse:identify` | `{ text }` | `{ platform, kind }` \| null | 纯识别，不发起抓取 |
| `parse:run` | `{ text, platformHint?, sourceId? }` | `ParseResult`（`normalize-result` 同构） | 统一入口，等价线上 `/api/parse` |
| `download:enqueue` | `{ items: DownloadItem[], groupId? }` | `{ taskId }` | `DownloadItem = { url, filename, referer?, headers?, kind }` |
| `download:progress` | —（事件流） | `{ taskId, received, total, speed, status }` | `webContents.send` 推送，节流 ~200ms |
| `download:cancel` / `pause` / `resume` | `{ taskId }` | `{ ok }` | 续传依赖 `.part` + `Range: bytes=` |
| `settings:get` / `settings:set` | 部分字段 | 全量生效配置 | Cookie/下载目录/并发/回落开关 |
| `history:list` / `history:clear` | `{ filter? }` | `HistoryEntry[]` | 只存平台/标题/时间/落地路径，**不存直链**（时效与隐私） |
| `probe:engines` | — | `EngineHealth[]` | 本地版体检：逐平台跑固定样例，替代线上 `/api/engines` |

### 事件（main → renderer）

`download:progress`、`download:done`、`download:error`、`app:updateAvailable`、`engine:status`。

## 4. 下载管理器要点

- **落盘策略**：先写 `<目标>.part`，完成后 rename；同名冲突走内核既有 `utils/filename.ts` 规则 + 序号后缀。
- **续传**：`.part` 存在时带 `Range: bytes=<size>-`；上游返回 200（不支持 Range）则整体重下。
- **防盗链**：Referer/UA 按平台补，逻辑与 `mediaGet` 的 `video-proxy`/`image` 代理对齐（来源同为 `lib/platforms.ts` 域名映射，勿在客户端复制一份域名表）。
- **图集**：图文平台（小红书/微博/B站图文）返回多 URL → 打包为一次 group 入队，并发上限受设置控制。
- **失败隔离**：单个任务失败不影响队列其余；错误分类后可选回落线上代理重试一次。

## 5. 配置模型（core-adapter/config）

两级求值，与内核改造点一致：

```
读某项 = 注入的本机配置（userData/config.json，用户可见可编辑）
       ?? process.env.<KEY>（仅 dev 便利，prod 不依赖）
       ?? 代码内默认值
```

键位沿用 mediaGet 命名（`DOUYIN_COOKIE`、`XHS_COOKIE`、`IG_COOKIE`、`BILIBILI_COOKIE`、`YOUTUBE_PIPED_HOSTS`、`TWITTER_FIXER_SERVICES`…），**语义变化**：线上是部署级秘密，桌面是用户自配。设置页需明确标注「需用户自行申请，风险自负」。

## 6. 安全与隐私红线

1. **绝不打包服务端凭据**：mediaGet 的运维 Cookie（尤其 `BILIBILI_COOKIE`、`IG_COOKIE`）是全站共用风控资产，泄露即伤害线上服务。
2. 用户 Cookie 存本机 `userData`，文件权限限制到当前用户；导出配置时默认剔除凭据；提供「一键清除」。
3. **SSRF 面**：主进程 fetch 用户提供的 URL 时保留 `proxy-guard` 同源校验思想（拒私网/回环/元数据地址）；桌面版威胁模型不同（用户自己受害），但仍不应让畸形链接打到内网。
4. `webSecurity` 不关闭；`nodeIntegration: false`；`contextIsolation: true`；renderer 不加载远程内容。
5. 不解析 `blockedPlatforms.ts` 黑名单里的平台（微信视频号、付费/DRM 内容），沿用内核判定。
6. 不做反检测加码：UA/请求头治理以内核既有实现为限。

## 7. 构建与发布

- `electron-builder`：`nsis`（per-user 安装、桌面快捷方式、卸载器）+ `portable`（单文件免安装，内测分发）。产物目录 `release/`。
- 二进制随包：`yt-dlp.exe`、`ffmpeg.exe` 放 `extraResources`，**不打进 asar**；首启校验 SHA-256 后释放到 `userData/bin/`，支持「用户自备路径」覆盖。
- 自动更新：`electron-updater` + GitHub Releases（generic provider）。无证书阶段接受 SmartScreen 提示；更新包需 `sha512` 校验（builder 自动生成）。
- CI（GitHub Actions）：
  - `test`：vitest（适配层、下载器、IPC 校验）；
  - `smoke:kernel`：拉 `mediaGet@main` 最新内核跑固定链接冒烟解析，暴露上游接口腐化；
  - `build:win`：`electron-builder --win`，产物作 artifact；打 tag 时发 Release。
- 代码约定：全 TS（含 main/preload，走 tsup/esbuild 编译）；命名沿用 mediaGet 约定（组件 PascalCase，hook/store/util kebab-case）；Windows 不敏感大小写，禁止两个文件仅首字母大小写之差。

## 8. 分仓与同步（定稿）

**两仓，一个源码源。不设第三个仓库。**

```
mediaGet（已有，web 仓）                     mediaGet-desktop（本仓）
├─ packages/parse-core/   ← 唯一源码真源    ├─ node_modules/@mediaget/parse-core  ← 只读工件
│   └─ src/<platform>Core.js                ├─ core-adapter/        ← 注入 cache/ratelimit/config
├─ src/lib/**            ── import ──┐      ├─ electron/main/engine.ts  ← 调 parse-core
├─ src/app/api/**        （route 薄壳）      └─ fallback ──→ 线上 mediaGet API
```

`parse-core` 放在 mediaGet 仓**内部**的 `packages/` 下，而不是独立成第三个仓：改解析时内核与调用方在同一次原子提交里，不会出现「内核发了新版、web 还没跟上」的中间态。

本仓**不含任何解析源码**，只含 `node_modules` 里的版本化工件 + 自己的适配层，因此 clone 后 `npm ci` 即可运行，不依赖 `../mediaGet` 存在。

### 同步流水线（单向）

| # | 动作 | 位置 |
| --- | --- | --- |
| 1 | 改 `packages/parse-core/src/**` | mediaGet 仓 |
| 2 | CI：parse-core 单测 + web 全量测试（零行为变化铁律） | mediaGet 仓 CI |
| 3 | `version patch/minor` + publish 到私有源 | mediaGet 仓 |
| 4 | 本仓改 `package.json` 版本号 → PR | 本仓 |
| 5 | CI：parse-core 测试 + 3 平台真机解析 → 合并打包 | 本仓 CI |

方向**永远单向**：本仓发现 parse-core 有 bug → 回 mediaGet 仓修 → 发新版 → 本仓升版本号。本仓独有件（下载管理 / IPC / 窗口 / 设置）天生只属本仓，不进 parse-core，故不存在反向同步。

版本号与 web 发布节奏**解耦**：parse-core 独立 semver，它不发版不挡住 web 上线；web 上线也不强制 parse-core 动。

### 消费方式：私有 npm 源（已定稿，取代「二选一」）

| 候选方案 | 结论 | 理由 |
| --- | --- | --- |
| monorepo 物理链接（`file:../mediaGet`） | ❌ 仅本地 dev | CI 无 `../mediaGet`，`npm ci` 必挂 |
| git submodule / subtree | ❌ | 拿到的是 commit 不是 semver，版本语义全丢，CI 需额外检出 |
| 抽成独立第三仓 | ❌ | 内核与调用方跨仓，产生「内核已发版、web 未跟上」中间态 |
| **私有 npm 源（tarball 版本化工件）** | ✅ | CI 可 `npm ci`；版本语义清晰；与 web 侧共用同一工件 |

- 本地联调可用 `file:` 链接临时指向 `../mediaGet/packages/parse-core`，**提交态必须是版本化工件**。
- 包名建议 `@mediaget/parse-core`，`exports` 白名单只暴露解析入口与类型，把「禁 import route 层」从 grep 变成模块解析层面的物理不可能。
- 桌面端构建时从私有源拉取；不发布到公网 npm（含零敏感资产考量，见 §6）。

### 私有载体选型（P0 开工前定死）

| 候选 | 成本 | 结论 |
| --- | --- | --- |
| **mediaGet GitHub Release 附带版本化 tarball**（`"parse-core": "https://github.com/hotier/mediaGet/releases/download/parse-core-vX.Y.Z/….tgz"`） | 零注册表运维；semver 语义完整；CI `npm ci` 直连可用；鉴权走公开 Release（包内无敏感资产） | ✅ **首发采用**：当前单人项目，此形态即"版本化工件"的最小实现 |
| GitHub Packages npm | 免费但**拉取公开包也要 token**，协作者/CI 上手摩擦 | 备选 |
| 自建 Verdaccio / 付费私有 scope | 多一道运维或账单 | 出现第二个消费者 / 需要 per-pkg 权限时升级 |

升级路径：tarball → 私有源只改 `package.json` 一行 resolution，工件内容不变。

### parse-core 依赖闭包（P0 的真实工作量，别低估）

各平台 `*Core.js` **不是叶子模块**：上游现状里 `kuaishouCore → lib/http`、`douyin-extract → lib/api-utils`、`verifyUrl → http`、`unified-parser → platforms/share-text/blockedPlatforms/…`。抽取时必须连同这层共享件一起进 `packages/parse-core`：

- **决策**：把 `platforms.ts / share-text.ts / blockedPlatforms.ts / normalize-result.ts / http.ts / api-utils.js / verifyUrl.js` 及各 `*Core.js` 整体迁入 `packages/parse-core/src/`；mediaGet 的 `src/lib/**` 对同名模块改为 **re-export**（`export * from "../../packages/parse-core/src/…"`），web 侧零行为变化，路径别名 `@/lib/xxx` 不动。
- 迁完跑 `npm test` + `test:live` 基线 = P0 项 1 的验收，与「原子提交」原则一致（同一次 PR 完成迁移+re-export+回归）。
- 反例（禁止）：parse-core 里复制一份 http/api-utils——立刻分叉。

### 兜底：内核滞后不阻塞桌面端

`electron/main/engine.ts` 中 parse-core 解析失败（版本旧 / 平台未覆盖 / 上游改版）→ 回落打线上 mediaGet API（见 §2 `fallback.ts`）。**因此 P0 抽取失败可退**：抽不动即退为纯回落模式，架构不塌。

### 业界参照

| 项目 | 做法 | 对本仓的意义 |
| --- | --- | --- |
| [cobalt](https://github.com/imputnet/cobalt)（44.9k★） | monorepo，解析器与 web 服务同仓同进程；`packages/` 仅 api-client（HTTP 客户端）+ version-info，无解析包；客户端全部走 HTTP API | 「内核留原处、客户端变壳」；第三方只给 API 边界，不分享析库 |
| [mediago](https://github.com/caorushizi/mediago)（9.3k★） | pnpm workspace：`apps/core`（Go 服务）+ `apps/ui` + `@mediago/electron` + `packages/core-sdk`（TS SDK，exports 仅 `.`）；Electron 经 `service-runner` 拉起 Core，UI 走 HTTP/SSE | Core 是独立进程而非被 import 的库；`core-sdk` 位置与 `parse-core` 完全对应 |
| [mediago-core](https://github.com/caorushizi/mediago-core)（44★） | 内核独立库仓，Go 平台分包经 npm 分发（版本优先级 环境变量 VERSION > Git Tag > 'dev'） | 「跨语言内核用平台分包 + npm 分发」的先例 |

### 换方案信号（满足其一即重新评估）

- P0 内核抽取返工 > 2 轮；
- 内核出现第三个消费者；
- 桌面端成为主线（web 不再主更）；
- 第二人加入，需要按仓分权限。

## 9. 其他耦合治理

| 关注点 | 做法 |
| --- | --- |
| 内核版本 | 以私有源 semver 版本号声明依赖；`about` 页展示当前 parse-core 版本；dev 可临时 `file:` 链接 |
| 抽取进度跟踪 | mediaGet 仓 `docs/DESKTOP-PLAN.md`（若存在）；P0 未完成前本仓只实现骨架 + mock 内核，避免等阻塞 |
| 分叉防线 | 本仓不写平台解析；若某天必须临时补，标 `// DIVERGENCE:` 并在 issue 跟踪回流上游 |
| 域名/平台清单 | 一律来自内核 `PLATFORM_INFO`，客户端不复制表 |
| 契约类型 | `normalize-result` 的输出结构是唯一真源，放 `types/ipc.ts` 镜像并注明来源 |
