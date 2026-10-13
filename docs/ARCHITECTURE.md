# 开发架构（详版）

> 面向要改本仓代码的人。仓库定位、总体决策见 [`../README.md`](../README.md)；本文给目录职责、进程边界、IPC 契约、数据流与实现约定。
> 上游（解析内核）的架构细节见 [mediaGet/docs/architecture.md](https://github.com/hotier/mediaGet/blob/main/docs/architecture.md)。

## 0. 一句话数据流

```
用户在 renderer 粘贴分享文案
  → preload: bridge.parse(text)  → IPC invoke "parse:run"
  → main/engine.ts: 装配后的内核 identifyPlatform → platformRoutes 动态 import → parseCore(url)
  → main 归一化结果 → 返回 renderer 渲染结果卡
  → 用户点「下载」 → IPC "download:enqueue" → downloader.ts 流式落盘（Referer/Range/重试）
```

渲染层**永不**接触直链以外的网络请求；除「回落线上 API」外，所有出网动作都在主进程。

## 1. 进程边界与依赖方向

| 层 | 可运行环境 | 能 import | 不能 import |
| --- | --- | --- | --- |
| `core-adapter/` | Node（主进程） | `mediaGet/src/lib/**`、本仓 `core-adapter/*` | electron、renderer、`src/app/api/**` |
| `electron/main/` | Node（主进程） | `core-adapter`、解析内核、`electron`、Node 内置 | renderer 代码、任何 TSX/React |
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
| `electron/main/engine.ts` | 解析引擎装配：注入 `core-adapter`（cache/config/analytics）→ 暴露 `parse(textOrUrl)` / `identify(text)` | HTTP、窗口操作 |
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

## 8. 与 mediaGet 的耦合治理

| 关注点 | 做法 |
| --- | --- |
| 内核版本 | dev 走本地路径链接（`file:../mediaGet`）；发 Release 时锁定 mediaGet 的 commit/tag 并在 `about` 页展示 |
| 抽取进度跟踪 | mediaGet 仓 `docs/DESKTOP-PLAN.md`（若存在）；P0 未完成前本仓只实现骨架 + mock 内核，避免等阻塞 |
| 分叉防线 | 本仓不写平台解析；若某天必须临时补，标 `// DIVERGENCE:` 并在 issue 跟踪回流上游 |
| 域名/平台清单 | 一律来自内核 `PLATFORM_INFO`，客户端不复制表 |
| 契约类型 | `normalize-result` 的输出结构是唯一真源，放 `types/ipc.ts` 镜像并注明来源 |
