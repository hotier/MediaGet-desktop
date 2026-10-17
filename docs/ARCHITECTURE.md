# 开发架构（详版）

> 面向要改本仓代码的人。仓库定位、总体决策见 [`../README.md`](../README.md)；本文给目录职责、进程边界、IPC 契约、数据流与实现约定。
> 上游（解析内核）的架构细节见 [mediaGet/docs/architecture.md](https://github.com/hotier/mediaGet/blob/main/docs/architecture.md)。
> **两仓怎么分、内核怎么同步**见本文 §8（定稿，含业界参照与换方案信号）。

## 0. 一句话数据流

```
用户在 renderer 粘贴分享文案
  → preload: bridge.parse(text)  → IPC invoke "parse:run"
  → main/engine.ts: 供给闸门（注册表 × 开关）→ main/engines.ts 引擎轮询 → parse-core 工件（§8）
  → main 归一化结果 → 返回 renderer 渲染结果卡
  → 用户点「下载」 → IPC "download:enqueue" → downloader.ts 流式落盘（Referer/Range/重试；403 先换一条同资源的新链再跑一次）
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
   - 载荷**形状**的声明真源是 `types/ipc-contract.ts`（zod），`types/ipc.ts` 只做 `z.infer` 派生 + 通道常量 + `MgBridge`；ipc.ts 必须保持零运行时（只 `import type`），否则 zod 会被卷进 renderer 包（`tests/boundaries.test.ts` 铁律 3 守这一条）。

## 2. 目录职责

| 路径 | 放什么 | 不放什么 |
| --- | --- | --- |
| `electron/main/index.ts` | 应用生命周期、窗口、托盘、单实例锁、深链注册 | 业务逻辑 |
| `electron/main/engine.ts` | 解析引擎宿主：装配 `core-adapter`（cache/config/analytics）与引擎列表，先过**供给闸门**（`shared/platforms.ts` × `settings.platformSwitches`，关掉的平台在引擎被调用之前就 400），再按顺序轮询引擎；暴露 `identify(text)` / `parse(textOrUrl)` / `health()` | HTTP、窗口操作、单个平台的解析算法 |
| `electron/main/engines.ts` | 引擎 runner 层：`ParseEngine { id, label, covers(), run() }`。`covers()` = 注册表能力位 ∧ 引擎自报覆盖；`run()` 的 `ok:false` 表示「可以换下一个引擎」并携带没得换时的最终答复。加引擎 = 加列表项，选路与开关判定不动（§9「引擎与供给解耦」） | 产品开关（在注册表与 settings）、HTTP 之外的副作用 |
| `electron/main/ipc.ts` | 所有 `ipcMain.handle` 注册；入参按 `types/ipc-contract.ts` 的 in schema 校验（不可信输入才进内核），dev 构建再对出参过 out schema（漂移报 `contract-drift`） | 直接调平台解析器；在本文件重声明 schema |
| `electron/main/downloader.ts` | 下载队列：并发上限、优先级、断点续传、Referer/UA 组装、进度事件、失败重试；上游回 **403** 时先向 `link-renew.ts` 要一条同资源的新链并**只重跑一次**（换链同时同步 `.part.meta`，断点不许因此归零）；**v13 起队列是跨重启的全量台账**：`snapshot()` 不再滤 `done`、`restore()` 不再跳过 `done`/`canceled`（业主指令 2026-10-17「保留所有进过队列的数据」，推翻 v4 那两条重启语义），终态三件套 `filePath`/`error`/`finishedAt` 跟着落盘，`downloading` 回来仍降为 `queued`，`pump()` 只挑 `queued` 所以终态行只是台账不会自己开跑 | 解析逻辑、怎么判断链过期（只认状态码）；「超过 N 分钟判定过期」这类猜不出的时效判据 |
| `electron/main/link-renew.ts` | 直链续取器（v12）：按**作品分享链接**合并再解析——并发任务共用同一个在飞请求、结果在 60s 内复用，再解析失败也进表（下架的作品不该被反复捶）。再解析走 `engine.parse(..., { skipCache: true })`：24h 结果缓存存的正是带过期直链的那份，不绕开就永远拿回同一条死链 | 认哪一条才是同一份资源（在 `shared/link-identity.ts`）、日志（**一行不打**：直链按 §6 红线不落盘）、按钮语义（渲染层不再按时间改下载按钮） |
| `electron/main/resources.ts` | yt-dlp/ffmpeg 定位：dev 用本地路径，prod 首启从 `resources/` 释放到 `userData/bin/` 并校验哈希 | — |
| `electron/main/fallback.ts` | 线上 API 回落：按开关把请求转发 `https://get.hotier.cc.cd/api/parse`，超时与错误归类 | 自造解析 |
| `electron/main/updater.ts` | 自动更新状态机：把 electron-updater 事件收敛成单个 `UpdateState` 快照（阶段 + 进度 + 错误），守卫「无源不检查、未下载完不安装」 | 窗口操作、下载队列 |
| `electron/main/notify.ts` | 下载通知聚合器：文件粒度的 done/error 按组收敛成一次系统通知（组内无排队/下载中任务时才播报，图集不逐张弹） | `Notification` 本体（由 index.ts 装配注入） |
| `electron/main/clipboard.ts` | 剪贴板监听：开关开启时轮询剪贴板 → 内核 `identify` 纯本地识别 → 命中分享链接投 `app:clipboardLink`（文本不落盘、不出本机） | — |
| `electron/main/store.ts` | `userData` 配置/历史读写（JSON 文件 + 原子写；不用 SQLite 除非历史量大）。历史窗口 `HISTORY_MAX = 5000`（2026-10-16 由 500 提档：统计页的作者榜与体积分布要够长的明细才画得出形状）。两个写入口分得很清：`appendHistory` 逐行追加（下载落地，一个文件一行），`upsertHistory` 按作品键刷新（解析，重复解析不堆行）。队列档 `queue.json` 上限 `QUEUE_MAX = 200`——v13 起完成行也留档，这个上限才第一次成为实际约束（满了丢最旧那一头，并不优先保住待办），写走 `saveQueueThrottled`（窗口内**留最后一次快照**）并由退出路径的 `flush()` 同步补写 | 敏感凭据明文（见 §6）；队列里的长期直链（见 §6 第 11 条） |
| `electron/main/stats.ts` | 生命周期计数器（`userData/stats.json`）：解析/下载/失败/取消/字节/耗时按 `totals` + `byDay`/`byPlatform`/`byKind`/`byHour` 只加不删，落盘走 JsonStore 同一节流口；`byDay` 保留 366 天 | url、文件名、作者名、Cookie（见 §6 第 8 条：统计面不许看出任何人下过什么）；逐条明细（那是 history 的活） |
| `renderer/src/lib/stats.ts` | 统计页的聚合出口：把计数档 + 历史明细两份原始数据换成视图模型（趋势补零、两榜、成功率、速度、解析通道、热力、体积直方、作者榜）。纯函数、除零现算（比率 `null` / 份额 `0`） | 读盘、IPC、色值、ECharts option（那在 `charts/options.ts`） |
| `renderer/src/components/charts/` | ECharts 适配器四件：`echarts-core.ts`（唯一注册点，摇树落点）/ `palette.ts`（CSS Token 探针 → canvas 取色）/ `options.ts`（纯 option 构造，node 环境可测）/ `EChart.tsx`（哑宿主：init/setOption/resize/dispose） | 业务口径（口径在 `lib/stats.ts`）；色值字面量（一个都不许写，见 UIUX §9.3） |
| `electron/preload/index.ts` | `contextBridge.exposeInMainWorld('mg', {...})` 白名单 | 通配转发（禁止 `ipcRenderer` 原样暴露） |
| `renderer/src/lib/bridge.ts` | 对 `window.mg` 的类型化封装 + React hooks | 直接拼 IPC channel 名 |
| `renderer/src/components/ui/` | vendored shadcn/ui 基座（16 件，`cva` 变体 + Radix 原语 + `cn()`），组件只在这里包一层视觉 | 业务语义、IPC 调用、契约类型（真源在 `types/`）；件与件之间不互相依赖业务字段 |
| `renderer/src/lib/utils.ts` | 只有 `cn()`：clsx 合条件类 + tailwind-merge 后者胜出 | 任何格式化/业务工具（别把这里长成杂物间） |
| `renderer/src/styles.css` | 三层 Token（层 1 唯一 hex 处）+ `@theme inline` 把层 2 桥成 shadcn 语义 utility + 少数无法 utility 化的全局（`@utility drag-region/no-drag`、细滚动条、reduced-motion） | 组件层样式（2026-10-14 迁 shadcn 后已删，组件样式在 JSX 的 utility 里） |
| `renderer/src/lib/download-plan.ts` | 下载计划纯函数：`ParseData` + 清晰度选择 → 将要落盘的每一项（含多 P 清晰度回落标注、同直链去重） | 渲染、IPC 调用 |
| `renderer/src/lib/history-works.ts` | 历史页聚合纯函数：`HistoryEntry[]` → 「作品」行（同作品键的解析行与下载行并成一行，每个字段各取组里最新那条有值的行）。v8 起一行不再等于一次下载，所以这条规则必须可测 | 读盘、筛选与搜索（留在页面）、身份计算（在 `shared/history.ts`） |
| `core-adapter/` | 内核的本地注入件（cache/analytics/config/ratelimit） | 任何解析算法 |
| `types/ipc-contract.ts` | 载荷形状的唯一声明处（zod）：每通道 in/out schema + `CONTRACT`/`EVENTS` 注册表 | 运行时以外的东西；被 renderer 以值 import |
| `types/ipc.ts` | 通道常量 `IPC`、`MgBridge` 面、`DEFAULT_SETTINGS`，以及从 contract 派生的类型 | 任何运行时值（须保持只 `import type`）|
| `shared/platforms.ts` | 平台注册表：本项目「有哪些平台、叫什么、哪枚图标、哪个引擎能解、供不供」的唯一真源（零依赖，主进程与渲染进程 import 同一份，见 §9） | 解析算法、IPC、图标文件本体（SVG 在 `renderer/public/logos/`） |
| `shared/history.ts` | 历史记录的身份规则（零依赖，与注册表同一处置）：`workKeyOf(分享链接)` 算出可复算的作品键，解析侧与下载侧各写自己的行却算出同一个键 → 历史页聚成一行；`parseHistoryEntry()` 造「未下载」那一行，入参表不收任何直链 | 落盘（在 `store.ts`）、聚合展示（在 `lib/history-works.ts`）、平台定义（在注册表） |
| `shared/author.ts` | `buildAuthorSnapshot(ParseData)`：「哪些字段算一个作者」的一份口径，下载行由渲染层随 enqueue 带上、解析行由主进程在 parse 成功时造 | 第二份字段映射（2026-10-17 从 `renderer/src/lib/work-info.ts` 提上来，抄两份迟早漏字段） |
| `shared/link-identity.ts` | 直链的身份规则（零依赖，v12）：`pickRenewedUrl(失败链, 候选链)` 按「host+pathname ∧ 非时效参数集合全等」认对象，签名/到期那类键（`sign`/`expires`/`x-expires`/`lk3s`/`s`…）不参与身份；判据全等还要求新链与旧链**不是同一条**，否则 403 重试会变成死循环。`collectMediaUrls(ParseData)` 按主媒体→音频→图集→清晰度→多 P 的顺序收集候选 | 再解析与合并（在 `electron/main/link-renew.ts`）、任何持久化（这些是直链，§6 红线：不落日志、不进历史与队列） |
| `shared/work-stat.ts` | 作品计数与发布时间的归一（零依赖，主进程 / 渲染层 / dev mock 同一份，v10）：`WORK_STAT_SLOTS` 决定「哪一档叫什么、按什么顺序出现、从内核哪些字段兜底取」，结果卡徽标、txt 正文与表格三档都读它；`pickPublishedAt` 按量级判秒 / 毫秒 / ISO 三套单位并把未来时刻判为不可信；`toCount` 只收纯数字，`"1.2万"` 这种已缩水的字符串计数宁可留空 | 直链与任何媒体字段（隐私红线：这里只挑公开数字与时间）、格式化（`fmtCount` 在渲染层）、行身份（在 `shared/history.ts`） |
| `renderer/src/store/platforms.ts` | 平台开关的渲染层视图（本仓第一个 Zustand store）：乐观置态 → `settings:set` 整表提交 → 失败回滚。消费者 = 设置「引擎」体检表的「提供」列，开关即时生效、不进脏计数（§2 的 `probe:engines` 与它同源） | 平台静态定义（在注册表）；持久化（在 `config.json` 的 `settings.platformSwitches`，主进程读这份而不是渲染层内存） |
| `renderer/src/store/home-draft.ts` | 首页工作台的会话草稿（第二个 Zustand store）：输入文本 / 识别提示 / 结果卡批次 / 进行态。页面是条件渲染 + `key={page}`，切页即卸载重挂，这些态留在组件里会一起归零（业主指令 2026-10-17：切回来还要看到上次解析的结果） | 落盘（只在内存，重启即清；长期记忆归历史页）、解析发起与 IPC（在 `pages/HomePage.tsx`） |
| `resources/` | 第三方二进制（git-lfs 或 CI 拉取，**不入 git**） | 源码 |

## 3. IPC 契约（v0 草案）

约定：所有 invoke 返回 `{ ok: true, data } | { ok: false, error: { code, message, failType? } }`；`failType` 沿用 mediaGet 语义（`bot-gated` / `sources-down` / `source-unavailable` / `script-error`），renderer 据此差异化提示与触发回落。

入参校验失败的 `code` 固定为 `bad-input`，`message` 是 zod 的 `path: message; …` 单行文案（设置页按字段拆内联提示）；内部异常是 `internal`；`contract-drift` 只在 dev 出现，代表主进程产出与出参 schema 不符 —— 它是给开发者看的，不是给用户看的。

下表是**说明**，不是真源。形状与通道集合的真源是 `types/ipc-contract.ts` 的 `CONTRACT`/`EVENTS`，由 `tests/contract.test.ts` 逐条对账（每个 `IPC` 常量都必须登记、注册集合 == 契约键集合、每通道跑一次真 handler）。

### 请求/响应

| channel | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `app:getMeta` | — | `{ version, electron, platforms[] }` | 平台清单来自内核 `PLATFORM_INFO`，不在 renderer 复制 |
| `parse:identify` | `{ text }` | `{ platform, kind }` \| null | 纯识别，不发起抓取 |
| `parse:run` | `{ text, platformHint?, sourceId? }` | `ParseResult`（`normalize-result` 同构） | 统一入口，等价线上 `/api/parse`。**解析成功即由这一层落一条历史**（v8）：写在主进程而不是首页，任何入口发起的解析都留同一条记录；`via=mock` 的演示结果不落 |
| `download:enqueue` | `{ items: DownloadItem[], groupId? }` | `{ taskId }` | `DownloadItem = { url, filename, referer?, headers?, kind }` |
| `download:progress` | —（事件流） | `{ taskId, received, total, speed, status }` | `webContents.send` 推送，节流 ~200ms |
| `download:cancel` / `pause` / `resume` | `{ taskId }` | `{ ok }` | 续传依赖 `.part` + `Range: bytes=` |
| `settings:get` / `settings:set` | 部分字段 | 全量生效配置 | Cookie/下载目录/并发/回落开关/日志级别与保留天数 |
| `app:cacheStatus` / `app:cacheClear` | — / `{ keys }` | `{ items[], totalBytes, clearableBytes }` / `{ freed, skipped, report }` | 只清具名临时文件（网络缓存/孤儿断点/残留/日志）；更新包与本机记录只报占用，活任务的 `.part` 避让 |
| `app:openLogDir` / `app:log` | — / `{ level, message }` | `{ ok }` | 渲染层未捕获异常经 `app:log` 落进同一份文件日志（上限 50 条/次会话） |
| `history:list` / `history:remove` | `{ filter?, limit? }`（`limit` 上限 = 窗口 `HISTORY_MAX` = 5000） / `{ keys }`（≤5000） | `HistoryEntry[]` | **解析历史**（v8）：解析成功就有一条，下不下载都在。`files` 空数组 = 只解析没下载，界面上那一列写「未下载」。只存平台/标题/作者快照/时间/落地路径，v10 起再加 `publishedAt`（作品在平台上的发布时刻，本地毫秒）与 `stat`（解析那一刻的公开互动数八档）——导出要的是完整作品信息，而这两个值只有在解析当场抓得到，事后补不回来；**不存媒体直链**（时效与隐私），内核那份 `ParseData` 是 passthrough 的活水，`data.url` / `images[]` / `qualities[].url` 连入参表都不收，进档前由 `shared/work-stat.ts` 按字段挑；作者主页与头像是公开页面，2026-10-14 业主批准入档。`history:remove` 的行键同时命中条目 `id` 与作品键 `groupId`（图集删一行 = 撤整组），出参直接给剩余列表；整表清空也走这条（界面是「表头全选 → 移除记录」），**v9 起 `history:clear` 整条已删**，不留第二条语义重复的通道 |
| `stats:get` | — | `StatsSnapshot` | 统计页真源（契约 v5，2026-10-16）：`totals` + `parse` + `byDay`/`byPlatform`/`byKind`/`byHour`。只有计数、字节、时长，**没有 url 与文件名**；失败与取消只在这份档里（history 只有成功记录，从它算失败率永远是 100%） |
| `probe:engines` | — | `EngineHealth[]` | 本地版体检 = 注册表全量 × 在场引擎能力位 × 用户开关（`engine.health()`），不发抓取、不打平台风控；与解析路由同源，所以界面说「不可解」的平台真的不会被解 |
| `update:state` | — | `UpdateState` | 当前更新快照（renderer 挂载时先取一次，补上窗口未建期间丢掉的事件） |
| `update:check` / `update:download` | — | `UpdateState` | 主动检查 / 显式下载；失败不外抛，收敛进快照的 `phase=error` |
| `update:install` | — | `{ ok }` | 仅 `downloaded` 阶段有效，触发 `quitAndInstall`（进程随即退出） |

### 事件（main → renderer）

`download:progress`、`download:done`、`download:error`、`app:updateState`、`app:clipboardLink`（剪贴板监听命中：`IdentifyOutcome` 形状，`platform` 非空且 `url` 有值）。

（`engine:status` 曾是契约里的预留位，全仓无发送/订阅，2026-10-14 单一真源改造时删除；P4 远程开关落地时再随 `CONTRACT`/`EVENTS` 一并登记。）

## 4. 下载管理器要点

- **落盘策略**：先写 `<目标>.part`，完成后 rename；同名冲突走内核既有 `utils/filename.ts` 规则 + 序号后缀。
- **续传**：`.part` 存在时带 `Range: bytes=<size>-`；上游返回 200（不支持 Range）则整体重下。
- **防盗链**：Referer/UA 按平台补，逻辑与 `mediaGet` 的 `video-proxy`/`image` 代理对齐（来源同为 `lib/platforms.ts` 域名映射，勿在客户端复制一份域名表）。
- **图集**：图文平台（小红书/微博/B站图文）返回多 URL → 打包为一次 group 入队，并发上限受设置控制。
- **失败隔离**：单个任务失败不影响队列其余；错误分类后可选回落线上代理重试一次。
- **直链到期只认状态码**（v12）：上游回 **403** 才是「这条链过期」的硬证据，于是下载器把失败链交给 `link-renew.ts` 换一条**同一资源**的新签名再跑一次（`shared/link-identity.ts` 负责「是不是同一份」，认不出就返回 null、照原样进重试与报错）。为什么不做「超过 N 分钟就判定过期」：实测各家 CDN 根本没有统一时效（抖音播放链串上没有时刻，封面签名约 14 天），拿一个验证不了的数去改按钮语义只会让用户以为必须先重新解析。续链**一颗任务至多一次**、同一作品 60s 内只再解析一次（图集连环 403 共用一份新链），换链时同步 `.part.meta` 所以断点不归零；`note`「直链已过期，已自动重新取链」只随事件到界面，**不进队列快照**（重启即消失），里面也没有 url（§6 红线）。

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
7. 文件日志（`userData/logs/app.log`）与 config 同处 userData，受同一红线约束：**不写 Cookie 值、不写媒体直链**，下载失败只投「文件名 + 原因」；渲染层转发的异常文本截到 2000 字符、单会话上限 50 条，避免堆栈把盘刷满。
8. `userData/stats.json`（统计页计数档）只落**计数、字节、时长**：没有 url、文件名、作者名、Cookie。逐条明细归 history，统计面看不出任何人下过什么 —— 这条同时也决定了页面的算法：失败与取消只在计数档里，所以任何比率都不从历史明细算。
9. `userData/history.json` 从 v8 起每条**成功解析**都落一行（不下下载也有），但字段口径没有放宽：只有平台、标题、作者快照、落地路径与用户自己粘的那条分享链接，v10 再加**发布时间与公开互动计数**（导出要完整作品信息）。内核给的 `data.url` / `images[]` / `qualities[].url` 一律不入档 —— 记录变多不等于直链变多，写入口 `shared/history.ts` 的入参表根本不收它们；v10 那两档也不是「把整份 `ParseData` 搬进档」，`shared/work-stat.ts` 逐字段挑，挑出来的只有数字与时间。`via=mock` 的演示结果不落盘。
10. **renderer 不碰系统能力**：`setPermissionRequestHandler` 那条 deny-all 不放宽（第 4 条的延伸）。Chromium 写剪贴板也要过这条钩子，且 Electron 把写也报成 `clipboard-read`——**做不到只放行写**，所以复制动作走 `app:copyText` 由主进程代发，与 `app:openExternal`（renderer 不自己开窗）同一条理由。代价换来自检：`tests/boundaries.test.ts` 禁止 renderer 源码出现 `navigator.clipboard`，因为旧写法在真应用里全部静默 reject，而 dev 预览（mock 桥跑在普通浏览器）照样写成功——这个差异只有源码扫描抓得到。剪贴板内容不落盘、不进日志（第 7 条同源）。
11. **`userData/queue.json` 只给「还能续或还能重试」的行留直链**（v13 新增的边界，不是旧行为）：队列档一直存 `url`（媒体直链）——断点续传与重试必须拿它再打一次，这条没得选。旧实现靠「完成行根本不落盘」顺带满足了红线；v13 起完成行也留档，同一句「队列不保留直链 URL」就必须换个执行法：**`snapshot()` 把 `done` 行的 `url` 剥成空串**，`queued`/`downloading`/`paused`/`error`/`canceled` 照旧留（剥了等于把续传与重试两个动作废掉）。到期直链对一条已完成记录本来也没有用途，界面对应撤掉入口——队列页右键「复制下载链接」没有 url 就不渲染那一项（与 §2.3 历史页「不出现需要直链的动作」同一口径）。`error` 文本落盘截到 300 字符：写流错误会带本机路径，而契约 `PersistedQueueTask.error` 就限到那里。`note`（v12 那句「已自动重新取链」）不进快照——它是一次性说明，隔天还挂着就成了说明书。

## 7. 构建与发布

- `electron-builder`：`nsis`（per-user 安装、桌面快捷方式、卸载器）+ `portable`（单文件免安装，内测分发）。产物目录 `release/`。
- 二进制随包：`yt-dlp.exe`、`ffmpeg.exe` 放 `extraResources`，**不打进 asar**；首启校验 SHA-256 后释放到 `userData/bin/`，支持「用户自备路径」覆盖。
- 开发期补件：`pnpm dev` 前置 `node scripts/fetch-binaries.cjs --soft`——脚本幂等（在位且校验通过即跳过，约 0.3s），新机器不必先手动跑 `fetch:binaries`；`--soft` 只对**下载失败**容错（退出 0 + 播报「随包二进制未就绪」，manifest 写成部分清单，运行时对应链路如实降级），`binaries.json` 本身残缺或哈希不符仍非零退出。CI 不传 `--soft`，严格语义不变——这条分界由 `tests/binaries-watch.test.ts` 用真子进程锁住退出码。
- 自动更新：`electron-updater` + GitHub Releases（generic provider）。无证书阶段接受 SmartScreen 提示；更新包需 `sha512` 校验（builder 自动生成）。
- CI（GitHub Actions）：
  - `ci.yml`（push `main` / PR）：`test` = typecheck + lint + vitest（全离线）；`build-win` = 拉固定版本二进制并强校验 → `electron-builder --win --publish never` → 断言安装包内 `resources/bin` 的 `yt-dlp.exe`/`ffmpeg.exe`/`manifest.json` 齐备。
  - `release.yml`（push `v*` 标签）：`verify` 复检三关 → `publish` 打包，再用 `gh release create` 把 `*.exe` + `latest.yml` + `*.blockmap` 传到同一个 Release。`latest.yml` 与安装包不同 Release，应用内「检测更新」就永远查不到版本。
  - 内核腐化告警不再靠并列检出冒烟（`smoke:kernel` 已随 2982811 拆桥删除）：`tests/kernel-sync.test.ts` 直接对工件 `dist/index.d.ts` 断言契约面，装不上依赖即红。
- 发版：`pnpm release`（release-it）—— 先跑 `typecheck`/`lint`/`test` 门禁，再按 commit 前缀推导版本（`feat`→minor、`fix`→patch、`!` 或 `BREAKING CHANGE`→major），写 `CHANGELOG.md`、提交 `chore(release): vX.Y.Z`、打附注标签并 push。版本号只写进 `package.json`（`npm.publish: false`，本包 `private`，不上注册表）。要改档位随时覆盖：`pnpm release patch|minor|major|1.2.3`（显式参数优先于 commit 推导，实测确认）。
- 提交规范由 commitlint 强制（husky `commit-msg`）：`type(scope): 摘要`，scope 必填、摘要 ≤120 字符。卡它的理由不是审美——commit 前缀是 release-it 的**发版输入**，写歪一个 `fix` 就决定档位，CHANGELOG 分组也直接取摘要行。
- 包管理器只有 pnpm：`packageManager: pnpm@11.22.0` 是唯一版本源（CI 的 `pnpm/action-setup` 不写死版本，直接读它）；根 `preinstall` 跑 `scripts/only-pnpm.cjs`，非 pnpm 的 UA 一律拒装；`.npmrc` 里 `package-lock=false` 兜住 npm 抢在守卫前落盘的 `package-lock.json`。真源是 `pnpm-lock.yaml`——两把锁对同一份 `package.json` 给出两棵不同的树，混用直接造成「CI 绿本机红」且无从排查。
- 依赖升级由 Renovate 提 PR（`renovate.json5`，需先在仓库装 GitHub App 才生效）：`minimumReleaseAge: 7 days` + `minimumReleaseAgeBuffer: 1 day` 对齐 pnpm 默认一周的发布年龄冷却，避免机器人开出「本地装不动、CI 必红」的 PR；minor/patch 合成一枚周一的 PR，但 `@mediaget/parse-core` 与 Electron 打包链各自单独成组——内核升版是解析行为变更，跟 react 样式升级捆在一起就没法只回滚内核。
- 随包二进制（yt-dlp/ffmpeg）在 Renovate 管辖之外：它不是 npm 依赖，且托管版 Renovate 不执行 `postUpgradeTasks`，不可能替我们下载并算 SHA-256。所以 `resources/binaries.json` 永远由人手改；观察上游用 `node scripts/fetch-binaries.cjs --check-updates`（CI 每周跑一次并贴出可直接粘贴的补丁，见 `binaries-watch.yml`）。
- 代码约定：全 TS（含 main/preload，走 tsup/esbuild 编译）；命名沿用 mediaGet 约定（组件 PascalCase，hook/store/util kebab-case）；Windows 不敏感大小写，禁止两个文件仅首字母大小写之差。
- 渲染层的第三方运行时依赖多了一枚 **echarts@6**（2026-10-16 统计页）：canvas 渲染、不触网、不落盘，因此 §1 的依赖边界照旧（它不是内核模块，也不碰 IPC）。两条纪律守着体积，只在架构层面重复一次：`echarts` 只在 `components/charts/echarts-core.ts` 一处 `use([...])` 注册（别处 import 到 `echarts` 就会把全量拉回启动面），整页 `React.lazy` 挂在第 5 项导航后。实测数字与选型论证见 [UIUX §9.2](UIUX-DESIGN.md)。
- 渲染层的第三方运行时依赖又多了一枚 **exceljs@4.4**（2026-10-17 历史页导出的 xlsx 档；业主在「自写最小 OOXML / 引库 / 先不做」三选一里点了引库）：它只在 `lib/history-selection.ts` 的 `buildWorksXlsx()` 里 **动态 import**，全仓没有第二处 —— 静态 import 会把它拉进启动 chunk。实测产物（`pnpm run build:app`）：`exceljs.min-*.js` 独立 chunk 936.95 kB / gzip 270.72 kB，四档里只有按 xlsx 那一会才解析它。Vite 走包里的 `browser` 字段（`dist/exceljs.min.js`），不触网、不落盘、不碰 IPC，§1 三条边界照旧；155 个传递依赖全部进 `pnpm-lock.yaml`。它写的是**字节**，所以落盘侧不能挂 BOM —— 文本三档（txt/csv/json）前置 `\uFEFF` 是给记事本与 Excel 认 UTF-8 用的，xlsx 头前多一个字节就打不开。

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

本仓**不含任何解析源码**，只含 `node_modules` 里的版本化工件 + 自己的适配层，因此 clone 后 `pnpm install --frozen-lockfile` 即可运行，不依赖 `../mediaGet` 存在。

### 同步流水线（单向）

| # | 动作 | 位置 |
| --- | --- | --- |
| 1 | 改 `packages/parse-core/src/**` | mediaGet 仓 |
| 2 | CI：parse-core 单测 + web 全量测试（零行为变化铁律） | mediaGet 仓 CI |
| 3 | `version patch/minor` → 打 tag `parse-core-vX.Y.Z`，CI 发 npm + 附同版本 Release tarball | mediaGet 仓 CI |
| 4 | 本仓改 `package.json` 版本号 → PR | 本仓 |
| 5 | CI：parse-core 测试 + 3 平台真机解析 → 合并打包 | 本仓 CI |

方向**永远单向**：本仓发现 parse-core 有 bug → 回 mediaGet 仓修 → 发新版 → 本仓升版本号。本仓独有件（下载管理 / IPC / 窗口 / 设置）天生只属本仓，不进 parse-core，故不存在反向同步。

版本号与 web 发布节奏**解耦**：parse-core 独立 semver，它不发版不挡住 web 上线；web 上线也不强制 parse-core 动。

### 消费方式：npm 主渠道 + Release tarball 双通道（已定稿）

| 候选方案 | 结论 | 理由 |
| --- | --- | --- |
| monorepo 物理链接（`file:../mediaGet`） | ❌ 仅本地 dev | CI 无 `../mediaGet`，`npm ci` 必挂 |
| git submodule / subtree | ❌ | 拿到的是 commit 不是 semver，版本语义全丢，CI 需额外检出 |
| 抽成独立第三仓 | ❌ | 内核与调用方跨仓，产生「内核已发版、web 未跟上」中间态 |
| **版本化工件：npm 注册表 + Release tarball 同源** | ✅ | CI 可 `npm ci`；版本语义清晰；与 web 侧共用同一工件；注册表版本不可覆盖，比 Release asset 更可审计 |

- 本地联调可用 `file:` 链接临时指向 `../mediaGet/packages/parse-core`，**提交态必须是版本化工件**。
- 包名 `@mediaget/parse-core`，`exports` 白名单只暴露解析入口与类型，把「禁 import route 层」从 grep 变成模块解析层面的物理不可能。
- **双通道同源机制**：上游 release workflow 先 `npm pack` 出 tarball，再用 `npm publish <该 tarball>` 上传**同一个文件本体**（不是重新 pack），随后比对 registry 副本 sha256 与本地 tarball，不一致即红叉。所以 `npm install @mediaget/parse-core` 与下载 Release 的 .tgz 拿到的是同一字节串，不存在「两个渠道版本漂移」。
- 上游仓本身是 PUBLIC，tarball 一直挂在公开 Release 上人人可下，发布到注册表不新增暴露面。§6 红线 1（绝不打包服务端凭据）已核：工件内唯一的硬编码 Cookie 是 `xiguaCore.js:13` 的匿名页面指纹（`MONITOR_WEB_ID`/`ttcid`/`ixigua-a-s`/`BD_REF`，无 sessionid 类登录凭据），不属于全站共用风控资产，不构成发布阻断项。

### 发布载体选型

| 候选 | 成本 | 结论 |
| --- | --- | --- |
| **npm 注册表（public scoped 包）** | 需注册 `mediaget` org + 一个 publish token 存仓 secret；workflow 加一步 `npm publish` | ✅ **主渠道**：不可覆盖的版本、生态默认安装路径、`npm audit`/deprecate/dist-tags 全可用 |
| **mediaGet GitHub Release 附带版本化 tarball**（`https://github.com/hotier/mediaGet/releases/download/parse-core-vX.Y.Z/….tgz`） | 已由 `release-parse-core.yaml` 自动化，附 `.sha256` | ✅ **保留为第二通道**：离线/审计/非 npm 用户；与 npm 副本经 sha256 对拍保证字节一致 |
| GitHub Packages npm | 免费但**拉取公开包也要 token**，协作者/CI 上手摩擦 | ❌ |
| 自建 Verdaccio / 付费私有 scope | 多一道运维或账单 | ❌ 无按仓分权限的需求前不引入 |

- 首发已完成：npm 侧 `mediaget` org 已建（`hotier` 为 owner），`@mediaget/parse-core@0.1.2` 由上游 CI 于 2026-10-15 16:49:28Z 发出，`latest` 已指 0.1.2；本仓 `package.json` 的依赖行已从 Release URL 换成 `"^0.1.2"`，import 侧零改动。`npm profile get` 显示 2FA = `auth-and-writes`，即任何 publish 与 `npm token create` 都要一次性验证码，**所以本地 CLI 直发不可行，发布只能走 CI**。凭据形态实测代价：前两枚 publish token 在 `Publish to npm` 步连续挂 `EOTP`（前面 7 步全绿，纯凭据问题），换第三类 token 后才通过——**哪一类 token 免 OTP 至今没有权威文档结论，别再按文档描述下断言**。
- 新包发布后有 npm 扫描期：0.1.2 发出后约 4 分钟才在 registry 可查，期间 `versions` 里会出现 `0.0.0-stage` 占位（staged publishing）。因此**sha256 对拍步必须排在 Create GitHub Release 之后**，且用 10 分钟有界等待：查不到只出 warning（Release 不受阻），查到但字节不同才红叉。0.1.2 那版 Release 是失败 run 未走到 Release 步、事后用 registry 副本补建的（附件 sha1 与 CI publish 日志 `666aabf7…` 相符）。
- 已知取舍：Release asset 可被同 tag 覆盖重传，注册表版本不可覆盖，故对拍校验只在 CI 发布当次成立；这也是把 npm 定为主渠道的核心理由。
- **同源只可能发生在同一次 pack**：实测本地 `npm pack` 出的 0.1.1 与 Release 上的 0.1.1 字节不同（sha256 `454f5d24…` vs `6919324d…`），差的 33 字节恰好等于 `package.json` 的行数——Windows `core.autocrlf` 把工作区检出成 CRLF，CI 检出 LF，dist 三个文件大小逐项相同，说明构建本身可复现，漂移只来自 pack 时的行尾规范化。结论：**不允许跨机器补发同版本号**，`0.1.1` 保持 Release-only，npm 首发从 `0.1.2` 起由 CI 一次 pack 两处用。实测两个 registry 的 `versions` 只列出 `0.0.0-stage` 与 `0.1.2`，印证 0.1.1 从未上过注册表。
- 本机 npm 全局 `registry` 已指回 `https://registry.npmjs.org`；`pnpm` 侧仍是 `registry.npmmirror.com`。实测 2026-10-16 两侧均能查到 `latest → 0.1.2`（镜像已同步），但新发版本存在镜像同步时延，装不到时先直接对 `registry.npmjs.org` 查版本号再判断是发布问题还是同步问题。
- 未加 `--provenance`：发布的是已 pack 好的 tarball 本体，npm 对 tarball 发布的 attestation 支持未经实测验证；同源保证已由 sha256 对拍承担。要补 provenance 时先在 workflow_dispatch 上跑通再固化。

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

### 何时重新评估载体

- 出现外部消费者（npm 主渠道的价值这时才真正兑现）；
- 需要按包粒度控权限 → 私有 scope / Verdaccio；
- Release 通道无人使用 → 可只留 `.sha256` 供审计，撤 tarball 附件。

## 9. 其他耦合治理

| 关注点 | 做法 |
| --- | --- |
| 内核版本 | 以 npm semver 版本号声明依赖（离线/审计场景可指 Release tarball URL）；`about` 页展示当前 parse-core 版本；dev 可临时 `file:` 链接 |
| 抽取进度跟踪 | mediaGet 仓 `docs/DESKTOP-PLAN.md`（若存在）；P0 未完成前本仓只实现骨架 + mock 内核，避免等阻塞 |
| 分叉防线 | 本仓不写平台解析；若某天必须临时补，标 `// DIVERGENCE:` 并在 issue 跟踪回流上游 |
| 域名/平台清单 | **以 `shared/platforms.ts` 注册表为真源**（2026-10-16 业主改口，此前写「一律来自内核 `PLATFORM_INFO`」）。理由：parse-core 只是引擎之一（还有 yt-dlp、后续更多），引擎决定「能不能解」，注册表决定「供不供」；若以内核为真源，换引擎或关平台都得等上游发版，产品边界就不归我们管。内核那份降级为**引擎侧事实**，由 `tests/platform-registry.test.ts` 逐键对账（名称/域名/短链/ID 模式 + 有本地 parser 才可声明 `parseCore: ready`），漂移即红叉。 |
| 引擎选路 | 选路不在 `engine.ts` 写 if-else，改为 `engines.ts` 的 `ParseEngine` 列表轮询（本地内核 → 线上 API）。上游工件因此只是列表上的一项，不再是解析面的全部：接 yt-dlp 直连或新增兜底引擎 = 加一项 + 在注册表把该平台的能力位改成 `ready`，`tests/engine.test.ts` 的「供给闸门 / health 矩阵」两组用例保证开关与体检说的、解析做的三件事一致。 |
| 契约类型 | `normalize-result` 的输出结构是唯一真源，在 `types/ipc-contract.ts` 以 zod 镜像并注明来源；`types/ipc.ts` 只做 `z.infer` 派生 |
