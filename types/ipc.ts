/**
 * IPC 契约 —— renderer 与 main 的唯一共享类型真源。
 *
 * 依据 docs/ARCHITECTURE.md §1 硬约束 3 与 §8：跨进程类型放这里（types/ipc.ts），
 * `ParseResult` 结构镜像 mediaGet `normalize-result` 的输出契约
 * （源：mediaGet/src/types/api.ts 的 ApiResponse/ParseData，此处注明镜像来源，
 * 不 import Next 工程）。
 *
 * 2026-10-14 单一真源改造（对标 Motrix v2 的 Zod 契约层）：payload 的**形状**只在
 * `types/ipc-contract.ts` 用 zod 声明一次，本文件以 `import type` + `z.infer` 派生。
 * 「加一个字段」由此前四处联动（interface + 主进程 schema + preload + bridge，
 * 且两份描述会各自漂移）收敛成改 ipc-contract 一处。
 *
 * `import type` 是硬要求，不是风格：本文件必须零运行时，否则 zod 会被卷进 renderer 包。
 */
import type { z } from "zod";
import type {
  AppMetaSchema,
  AppSettingsSchema,
  AuthorSnapshotSchema,
  BinaryStatusReportSchema,
  BinaryStatusViewSchema,
  CacheClearResultSchema,
  CacheItemSchema,
  CacheStatusSchema,
  ClearTasksInputSchema,
  ClearTasksResultSchema,
  CookieLoginInputSchema,
  CookieLoginResultSchema,
  DownloadItemSchema,
  DownloadTaskViewSchema,
  EngineHealthSchema,
  EnqueueInputSchema,
  EnqueueOutcomeSchema,
  HistoryEntrySchema,
  HistoryFilterSchema,
  HistoryRemoveInputSchema,
  IdentifyInputSchema,
  IdentifyOutcomeSchema,
  ParseDataSchema,
  ParseInputSchema,
  ParseResultSchema,
  ParseRunOutcomeSchema,
  ParsedVideoItemSchema,
  ParsedVideoQualitySchema,
  PersistedQueueTaskSchema,
  StatsSnapshotSchema,
  StatsDateRangeSchema,
  StatsQueryResultSchema,
  UpdateStateSchema,
  WorkStatSchema,
} from "./ipc-contract";

// ————————————————————————————————————————————————
// 镜像自 mediaGet src/types/api.ts（单一真源在上游，此处仅镜像消费）
// ————————————————————————————————————————————————

/** 单个清晰度直链（bilibili / youtube 等） */
export type ParsedVideoQuality = z.infer<typeof ParsedVideoQualitySchema>;

/** 多分P / 多清晰度视频项 */
export type ParsedVideoItem = z.infer<typeof ParsedVideoItemSchema>;

/** 统一解析数据结构（normalize-result 归一化后的 data 契约） */
export type ParseData = z.infer<typeof ParseDataSchema>;

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与解析内核输出同构） */
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ————————————————————————————————————————————————
// IPC 信封（ARCHITECTURE §3：所有 invoke 返回统一信封）
// ————————————————————————————————————————————————

export type InvokeOk<T> = { ok: true; data: T };
export type InvokeErr = {
  ok: false;
  error: { code: string; message: string; failType?: string };
};
export type InvokeResult<T> = InvokeOk<T> | InvokeErr;

// ————————————————————————————————————————————————
// 架构版本：跨进程契约的演进号（设置→关于 展示）。
// 通道集合增删或载荷形状不兼容变更时递增；纯新增可选字段不升。
// v2：新增 app:listFonts 通道；fontFamily 由枚举改为自由字体名（旧枚举值仍为合法字符串，
//     但不保证本机存在 → 回落，故按不兼容载荷形状变更升版）。
// v3：新增 app:cacheStatus / app:cacheClear / app:openLogDir / app:log 四条通道
//     （设置字段 logLevel、logRetentionDays 是纯新增可选键，不额外构成不兼容）。
// v4：新增 download:clear 通道（队列卫生：把终态行移出队列与落盘档），并改判重启恢复
//     语义 —— canceled 不再复活。落盘队列由此前的「只增不减」变成有上限、可清空。
// v5：新增 stats:get 通道（统计页：生命周期计数器快照，来自 userData/stats.json）。
//     同时 history 窗口 500 → 5000（`history:list` 的 limit 上界随之放宽，载荷形状不变）。
//     升号的理由是**通道集合增了**，不是存档形状变了：旧 stats.json 读不进来时按空档起算。
// v6：平台清单的真源从内核 PLATFORM_INFO 移到本仓 `shared/platforms.ts`（业主定调：parse-core 只是
//     引擎之一，「有哪些平台、提不提供」归本仓注册表 + 开关决定）。载荷侧两条不兼容变更：
//     `app:getMeta` 去掉 `platforms`（两进程改为 import 同一模块，不再过 IPC 复制一张表），
//     `settings` 新增 `platformSwitches`（每平台 enabled 覆盖，缺省跟随注册表默认）。
// v7：新增两条通道 `history:remove`（历史多选删除：行键 = 条目 id 或 groupId，出参直接回剩余列表）与
//     `app:openExternal`（结果卡「在浏览器打开」，scheme 白名单只放 http/https）。
//     `settings` 另加两键 `filenamePreset` / `filenameExtra`（下载文件名主体与追加开关）。
//     升号理由与 v5 同一条：通道集合增了。两把新键都有缺省值，旧存档读进来按 v7 解释不会缺字段。
// v8：`HistoryEntry` 的含义从「一次落地文件」变成「一条解析记录」（业主指令 2026-10-17）。
//     zod 形状一个字没改（`files` 一直是数组、可为空），改的是谁在写它：主进程在 parse:run
//     成功时就写一行，`files: []` = 解析过但没下载；`groupId` 现在是可复算的作品键
//     （`shared/history.ts` 的 workKeyOf），同一作品的解析行与下载行靠它聚成历史页的一行。
//     形状兼容但口径变了，所以必须升号：拿 v7 的解释读 v8 的档，统计页的「文件数」会把
//     0 文件的解析行也数成一个文件 —— 数值错，界面上没有任何异常。旧档（每行都有文件）反过来读
//     成新口径不受影响，不需要迁移。
// v9：删掉 `history:clear` 整条通道（业主指令 2026-10-17：历史页不再有「清空历史」按钮）。
//     全清改走 `history:remove`（表头全选 → 移除记录），它的 `keys` 上限 5000 = `HISTORY_MAX`，
//     一次点得掉整张表，不必留第二条语义重复的通道。升号理由与 v5/v7 同一条：**通道集合变了**
//     （存档形状没变，清空与移除落到的结果本来一样，旧档不需要迁移）。
// v10：`HistoryEntry` 新增三个可选键 `publishedAt` / `stat` / `author.videoCount`（业主指令
//     2026-10-17：导出的信息要完整——发布时间、点赞评论收藏、作者主页与粉丝量）。通道集合没变，
//     但载荷形状变了，按 v6/v7 那条口径必须升号：不升号就等于让「有没有这列数据」变成不可见的
//     运气。旧记录三个键都缺 → 导出这几格留空（`loadHistory` 没有迁移机制，缺字段在契约层合法），
//     想要就把那几条选中点「重新解析」，解析行按作品键覆盖那一条，字段自己就补上了。
// v11：新增 `app:copyText`（复制动作改由主进程代发）。**这条通道的存在本身就是一处修复**：
//     主进程 `index.ts` 装了「所有权限请求一律拒」的 `setPermissionRequestHandler`，而 Chromium 的
//     `navigator.clipboard.writeText` 要过那条钩子（Electron 把写也报成 `clipboard-read`），
//     于是渲染层三处复制在真应用里**全部** reject NotAllowedError —— 队列页与结果卡那两处连
//     catch 都没有，就成了「点了没反应」。实机探针证据、两条路线的取舍与「为什么不能只放行写」
//     记在 docs/UIUX-HANDOFF.md §6。升号理由与 v5/v7/v9 同一条：通道集合变了。存档形状没动，
//     旧档不需要迁移。
// v12：`DownloadTaskView` 新增可选键 `note`（业主指令 2026-10-17：直链过期这类情况静默重试）。
//     下载遇到 HTTP 403 时主进程自动重新取一次链并就地重试，`note` 就是队列那一行给出的
//     「已自动重新取链」说明——它是**解释**而不是状态，成功与否照旧走 `status`/`error`。
//     通道集合没变，但出参形状变了，按 v6/v7/v10 那条口径必须升号：不升号，旧版界面读到
//     带 `note` 的载荷时既不会显示也不会报错，用户永远不知道这一行为什么自己动过。
//     旧档不受影响（队列快照 `PersistedQueueTask` 没带这个键，重启后说明自然消失）。
// v13：队列快照 `PersistedQueueTask` 新增三个可选键 `filePath` / `error` / `finishedAt`，语义从
//     「只记没干完的活」改成**进过队列的行全部留档**（业主指令 2026-10-17：重启开发服务器之后
//     之前的下载队列记录消失了）。旧实现 `snapshot()` 滤掉 done、`restore()` 跳过 done 与
//     canceled（v4 定的「落地目录才是真源」「作废行不该每次回来占位」），两条一并推翻并就地标注。
//     没有这三个键，重启后的「已完成」行是**坏的**而不是少一列：「打开所在文件夹」「复制文件路径」
//     都按 `status === "done" && filePath` 渲染，缺 filePath 就整项消失；缺 error 则是一条不知道为什么
//     失败的「失败」。通道集合没变，但档内形状变了，按 v6/v7/v10/v12 同一条口径升号。
//     旧档不需要迁移（三个键都可选，缺就是空）；done 行的 `url` 落盘时剥成空串，见契约注释。
// v14：`ParseData` 镜像随内核 1.0.0 补齐 14 个字段（`source` / `favorite` / `reply` / `share` /
//     `playCount` / `likeCount` / `commentCount` / `shareCount` / `collectionCount` / `durationFormat` /
//     `noteId` / `ipRegion` / `verifiedReason` / `statusesCount`），`ParsedVideoItem` 补 3 个
//     （`qualityLabel` / `video_url` / `pic`）。通道集合没变、线形也没变（ParseData 是 passthrough，
//     这些键本来就在内核载荷里），但**声明面**变了：引擎出口的类型收拢从此把它们当契约字段处理。
//     按 v6/v7/v10/v12 那条口径升号，别让「收没收到类型」变成不可见的运气。
// v15：移除线上回落（业主指令 2026-10-18）。设置里删 `fallbackOnline` / `onlineApiBase`，
//     `ParseRunOutcome` 删 `fallbackReason`、`via` 收窄成 local|mock，`ParseInput.forceOnline`
//     改成语义更准的 `skipCache`（它此前一半职责是「别选本地引擎」，线上引擎没了只剩跳缓存）。
//     通道集合没变、载荷形状变了，按 v6/v7/v10/v12/v13 同一条口径升号。旧 config.json 里那两个
//     键会被 zod 丢键忽略，不需要迁移；旧 stats.json 的 `parse.online` 保留原值、不再增长。
// v16：`ParseRunOutcome` 新增可选键 `sourceUrl`（业主指令 2026-10-18：来源应当是真实资源链接，
//     不是分享短链）。主进程在解析成功后把短链跟到最终页面（或由作品 ID 拼官方页），首页拿它
//     写下载 meta、主进程拿它写历史，三处从同一条真实链接算作品键。通道集合没变，载荷形状变了，
//     按 v6/v7/v10/v12/v13 同一条口径升号；旧历史行里的短链不回溯改写（跟跳要联网，读档时不做）。
// v17：队列快照 `PersistedQueueTask` 新增可选键 `speed`（业主指令 2026-10-18：暂停时保留当时的速度
//     与剩余时间）。`DownloadTaskView.speed` 的语义就地扩一档：paused 行里它是**暂停那一刻的快照**，
//     主进程 `pause()` 不再清、`resume()` 才清；只有 paused 行把它写进 queue.json，重启后照样说得清
//     「当时多快」。完成行的平均速度没有占这个键（界面按 `received ÷ (finishedAt − createdAt)` 算，
//     与统计页 `elapsedMs` 同一把尺），所以 done 行仍是 0。通道集合没变，档内形状变了，
//     按 v6/v7/v10/v12/v13 同一条口径升号；旧档缺这个键 → 暂停行显示「—」，不需要迁移。
// v18：完成行的平均速度改口径（业主追问 2026-10-18「暂停一段时间再下载，计算速度的逻辑就有问题」）。
//     `DownloadTaskView` / `PersistedQueueTask` 新增 `transferMs`（实际传输时长）与 `transferBytes`
//     （这段时长里收到的字节），平均速度 = transferBytes ÷ transferMs；暂停、排队、重试退避、
//     首字节等待都不进分母。**v17 那条「按 received ÷ (finishedAt − createdAt) 算」作废** ——
//     分母是墙钟时间，暂停一小时就把速度稀释成另一个数。旧档缺这两个键 → 完成行显示「—」。
//     同一口径同步给统计：`stats.done` 的 elapsedMs 改传 transferMs（只有整段都被测到的下载才进样本）。
//     通道集合没变，载荷形状变了，按 v6/v7/v10/v12/v13/v17 同一条口径升号。
// v19：新增 `settings:cookieLogin`（设置页打开登录页、登录后自动抓 Cookie，业主指令 2026-10-19）。
//     入参只收四个受支持的键，出参只有 `{ captured, reason }`——**值不回渲染层**，
//     与 settings:get 的 "***" 掩码同一条隐私契约。通道集合变了，按 v6 起同一条口径升号。
// ————————————————————————————————————————————————

export const CONTRACT_VERSION = 20;

// ————————————————————————————————————————————————
// channel 常量（preload/main/renderer 三方共用字面量，禁止散落拼写）
// ————————————————————————————————————————————————

export const IPC = {
  appGetMeta: "app:getMeta",
  parseIdentify: "parse:identify",
  parseRun: "parse:run",
  downloadEnqueue: "download:enqueue",
  downloadCancel: "download:cancel",
  downloadPause: "download:pause",
  downloadResume: "download:resume",
  downloadList: "download:list",
  downloadClear: "download:clear",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsCookieLogin: "settings:cookieLogin",
  historyList: "history:list",
  historyRemove: "history:remove",
  probeEngines: "probe:engines",
  appGetBinaryStatus: "app:getBinaryStatus",
  appPickDownloadDir: "app:pickDownloadDir",
  appShowInFolder: "app:showInFolder",
  appListFonts: "app:listFonts",
  appCacheStatus: "app:cacheStatus",
  appCacheClear: "app:cacheClear",
  appOpenLogDir: "app:openLogDir",
  appLog: "app:log",
  appOpenExternal: "app:openExternal",
  appCopyText: "app:copyText",
  statsGet: "stats:get",
  updateGetState: "update:state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updatePause: "update:pause",
  updateResume: "update:resume",
  updateCancel: "update:cancel",
  updateInstall: "update:install",
  // main → renderer 事件
  evDownloadProgress: "download:progress",
  evDownloadDone: "download:done",
  evDownloadError: "download:error",
  evUpdateState: "app:updateState",
  evClipboardLink: "app:clipboardLink",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ————————————————————————————————————————————————
// 各 channel 的入参 / 出参（形状真源 = types/ipc-contract.ts）
// ————————————————————————————————————————————————

/** app:getMeta */
export type AppMeta = z.infer<typeof AppMetaSchema>;

/** parse:identify */
export type IdentifyInput = z.infer<typeof IdentifyInputSchema>;
export type IdentifyOutcome = z.infer<typeof IdentifyOutcomeSchema>;

/** parse:run */
export type ParseInput = z.infer<typeof ParseInputSchema>;
/** parse:run 返回：归一化结果 + 来源标记（本地内核 / mock） */
export type ParseRunOutcome = z.infer<typeof ParseRunOutcomeSchema>;

/** download:enqueue */
export type DownloadItem = z.infer<typeof DownloadItemSchema>;
export type EnqueueInput = z.infer<typeof EnqueueInputSchema>;
export type EnqueueOutcome = z.infer<typeof EnqueueOutcomeSchema>;

/** 作者快照（解析那一刻的公开信息，随任务/历史透传） */
export type AuthorSnapshot = z.infer<typeof AuthorSnapshotSchema>;

/** 作品计数快照（解析那一刻的公开互动数；档位与来源归一见 shared/work-stat.ts） */
export type WorkStat = z.infer<typeof WorkStatSchema>;

export type DownloadStatus = z.infer<typeof PersistedQueueTaskSchema>["status"];

/** 队列持久化条目（重启恢复；store.ts 与 downloader.ts 共用） */
export type PersistedQueueTask = z.infer<typeof PersistedQueueTaskSchema>;

/** download:progress 事件 / download:list 项 */
export type DownloadTaskView = z.infer<typeof DownloadTaskViewSchema>;

/** download:clear —— 点名移除 + 实际移除条数 */
export type ClearTasksInput = z.infer<typeof ClearTasksInputSchema>;
export type ClearTasksResult = z.infer<typeof ClearTasksResultSchema>;

/** settings:get / settings:set —— 部分字段 set，返回全量生效配置 */
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** settings:cookieLogin —— 入参只有键名，出参只有「抓到没有」；值留在主进程 */
export type CookieLoginInput = z.infer<typeof CookieLoginInputSchema>;
export type CookieLoginResult = z.infer<typeof CookieLoginResultSchema>;

/** 文件日志级别（写 userData/logs/app.log 的门槛）；off = 一行都不落 */
export type LogLevel = AppSettings["logLevel"];

/** 日志写入等级（渲染层转发用）：off 不是「写一条」而是「不写」，故不在候选里 */
export type LogSeverity = Exclude<LogLevel, "off">;

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: "",
  maxConcurrent: 3,
  cookies: {},
  throttleMs: 0,
  minimizeToTray: true,
  launchAtLogin: false,
  proxyMode: "system",
  proxyUrl: "",
  theme: "system",
  themeStyle: "azure",
  fontSizePx: 13,
  fontFamily: "system",
  openFolderOnDone: false,
  retryTimes: 1,
  defaultQuality: "main",
  filenamePreset: "title",
  filenameExtra: { quality: true, index: true },
  keepPartials: false,
  notifyOnDone: true,
  notifyOnError: true,
  clipboardWatch: false,
  logLevel: "info",
  logRetentionDays: 30,
  updateOnStartup: true,
  updateAutoDownload: false,
  // 只存用户改过的平台；没改过的跟随注册表 enabledByDefault，
  // 于是内核加一个平台不需要写迁移就能出现在界面上
  platformSwitches: {},
};

/** history:list */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;
/** history:remove */
export type HistoryRemoveInput = z.infer<typeof HistoryRemoveInputSchema>;

/** probe:engines —— 本地版体检 */
export type EngineHealth = z.infer<typeof EngineHealthSchema>;

// ————————————————————————————————————————————————
// 随包二进制（yt-dlp / ffmpeg）完整性汇报
// ————————————————————————————————————————————————

/**
 * 单个二进制的运行时状态。
 *
 * `integrity` 是「降级可见」的关键字段：`degraded` 表示**没有**完整性基线
 * （dev 自备 / 旧包未带 manifest），此时只定位不校验 —— 不假装有防护。
 * 设置页应把它如实展示，而不是只显示「可用」。
 */
export type BinaryStatusView = z.infer<typeof BinaryStatusViewSchema>;

/** app:getBinaryStatus 返回 */
export type BinaryStatusReport = z.infer<typeof BinaryStatusReportSchema>;

// ————————————————————————————————————————————————
// 本地缓存 / 日志占用（设置→通用）
// ————————————————————————————————————————————————

/** 占用项键：net=内核 HTTP 缓存 / update=更新包缓存 / partials=断点文件 / junk=残档 / logs=日志 / records=本机记录 */
export type CacheItemKey = z.infer<typeof CacheItemSchema>["key"];

/** 单项占用（键 → 中文文案的映射在渲染层，主进程只出数字） */
export type CacheItem = z.infer<typeof CacheItemSchema>;

/** app:cacheStatus 返回：扫描当下的字节快照（按项拆分，renderer 只做展示与键→文案映射） */
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

/** app:cacheClear 返回：释放字节数 + 被拒的项 + 清理后的快照 */
export type CacheClearResult = z.infer<typeof CacheClearResultSchema>;

// ————————————————————————————————————————————————
// 自动更新（P6）—— 主进程状态机收敛成一个可渲染快照
// ————————————————————————————————————————————————

export type UpdatePhase = z.infer<typeof UpdateStateSchema>["phase"];

/** update:state / update:check / update:download 返回，亦是 app:updateState 事件载荷 */
export type UpdateState = z.infer<typeof UpdateStateSchema>;

/** stats:get 出参：生命周期计数器快照（只有计数/字节/时长，无 url、无文件名） */
export type StatsSnapshot = z.infer<typeof StatsSnapshotSchema>;
export type StatsDateRange = z.infer<typeof StatsDateRangeSchema>;
export type StatsQueryResult = z.infer<typeof StatsQueryResultSchema>;

// ————————————————————————————————————————————————
// preload 暴露给 window.mg 的 API 面（contextBridge 白名单）
// ————————————————————————————————————————————————

export interface MgBridge {
  getMeta(): Promise<InvokeResult<AppMeta>>;
  identify(input: IdentifyInput): Promise<InvokeResult<IdentifyOutcome>>;
  parse(input: ParseInput): Promise<InvokeResult<ParseRunOutcome>>;
  download: {
    enqueue(input: EnqueueInput): Promise<InvokeResult<EnqueueOutcome>>;
    cancel(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    pause(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    resume(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    list(): Promise<InvokeResult<DownloadTaskView[]>>;
    /** 把终态行移出队列（活跃任务不会被删）：返回实际移除条数 */
    clear(taskIds: string[]): Promise<InvokeResult<ClearTasksResult>>;
    onProgress(cb: (t: DownloadTaskView) => void): () => void;
    onDone(cb: (t: DownloadTaskView) => void): () => void;
    onError(cb: (t: DownloadTaskView) => void): () => void;
  };
  settings: {
    get(): Promise<InvokeResult<AppSettings>>;
    set(patch: Partial<AppSettings>): Promise<InvokeResult<AppSettings>>;
    /** 打开登录窗口，登录后自动抓取并**在主进程落档**；值不回渲染层，只说抓到没有 */
    cookieLogin(input: CookieLoginInput): Promise<InvokeResult<CookieLoginResult>>;
  };
  history: {
    list(filter?: HistoryFilter): Promise<InvokeResult<HistoryEntry[]>>;
    /** 删除选中行（行键 = 条目 id 或 groupId，主进程双命中删整组），返回剩余列表。
     *  整表清空也走这条（keys 上限 = HISTORY_MAX），没有第二条 clear 通道 */
    remove(keys: string[]): Promise<InvokeResult<HistoryEntry[]>>;
  };
  probe: {
    engines(): Promise<InvokeResult<EngineHealth[]>>;
  };
  /** 统计查询；无日期参数仅用于统计 UI 切换前的兼容快照。 */
  stats: {
    get(): Promise<InvokeResult<StatsSnapshot>>;
    get(range: StatsDateRange): Promise<InvokeResult<StatsQueryResult>>;
  };
  app: {
    pickDownloadDir(): Promise<InvokeResult<string | null>>;
    showInFolder(path: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 随包二进制完整性状态（降级可见：degraded/rejected 要能被用户看到） */
    getBinaryStatus(): Promise<InvokeResult<BinaryStatusReport>>;
    /** 本机已安装字体 family 名（设置→外观→界面字体 可搜索下拉的数据源；主进程 font-list 枚举 + 缓存） */
    listFonts(): Promise<InvokeResult<string[]>>;
    /** 本地缓存/日志占用快照（扫描在用户点开「通用」时按需进行，不在启动时抢时间） */
    cacheStatus(): Promise<InvokeResult<CacheStatus>>;
    /** 只接受 clearable 的键；被拒的项（如已下载待安装的更新包）在 skipped 里如实返回 */
    clearCache(keys: CacheItemKey[]): Promise<InvokeResult<CacheClearResult>>;
    /** 在资源管理器打开日志目录（userData/logs） */
    openLogDir(): Promise<InvokeResult<{ ok: boolean }>>;
    /** 用系统默认浏览器打开外链（scheme 白名单 http/https；不抢焦点） */
    openExternal(url: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 复制文本到系统剪贴板（主进程代发：renderer 的 navigator.clipboard 被「所有权限一律拒」那条钩子挡死，见 CONTRACT_VERSION v11 注） */
    copyText(text: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 渲染层异常转发到文件日志（窗口崩溃外的另一条线索；级别不含 off） */
    log(level: LogSeverity, message: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 剪贴板监听命中分享链接（main 端已识别：url 有值时可直接填入输入面） */
    onClipboardLink(cb: (o: IdentifyOutcome) => void): () => void;
    /** 自动更新（P6）：state 是快照，check/download 返回迁移后的快照 */
    update: {
      state(): Promise<InvokeResult<UpdateState>>;
      check(): Promise<InvokeResult<UpdateState>>;
      download(): Promise<InvokeResult<UpdateState>>;
      /** 暂停进行中的更新包下载（cancel 传输令牌，进度冻结在弹窗显示值；恢复会从头重下）；返回迁移后快照 */
      pause(): Promise<InvokeResult<UpdateState>>;
      /** 继续下载：electron-updater 无断点续传，实为从头重下 */
      resume(): Promise<InvokeResult<UpdateState>>;
      /** 取消下载：cancel 令牌中断传输并清掉已下的 part，状态回落 available（可重新下载） */
      cancel(): Promise<InvokeResult<UpdateState>>;
      install(): Promise<InvokeResult<{ ok: boolean }>>;
      onState(cb: (s: UpdateState) => void): () => void;
    };
  };
}

declare global {
  interface Window {
    /** preload contextBridge 白名单 API（唯一渲染层入口） */
    mg?: MgBridge;
  }
}
