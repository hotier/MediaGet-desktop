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
  UpdateStateSchema,
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

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与线上 API 契约同构） */
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
// ————————————————————————————————————————————————

export const CONTRACT_VERSION = 7;

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
  historyList: "history:list",
  historyRemove: "history:remove",
  historyClear: "history:clear",
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
/** parse:run 返回：归一化结果 + 来源标记（本地内核 / 线上回落 / mock） */
export type ParseRunOutcome = z.infer<typeof ParseRunOutcomeSchema>;

/** download:enqueue */
export type DownloadItem = z.infer<typeof DownloadItemSchema>;
export type EnqueueInput = z.infer<typeof EnqueueInputSchema>;
export type EnqueueOutcome = z.infer<typeof EnqueueOutcomeSchema>;

/** 作者快照（解析那一刻的公开信息，随任务/历史透传） */
export type AuthorSnapshot = z.infer<typeof AuthorSnapshotSchema>;

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

/** 文件日志级别（写 userData/logs/app.log 的门槛）；off = 一行都不落 */
export type LogLevel = AppSettings["logLevel"];

/** 日志写入等级（渲染层转发用）：off 不是「写一条」而是「不写」，故不在候选里 */
export type LogSeverity = Exclude<LogLevel, "off">;

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: "",
  maxConcurrent: 3,
  fallbackOnline: true,
  onlineApiBase: "https://get.hotier.cc.cd",
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
  logRetentionDays: 7,
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
  };
  history: {
    list(filter?: HistoryFilter): Promise<InvokeResult<HistoryEntry[]>>;
    /** 删除选中行（行键 = 条目 id 或 groupId，主进程双命中删整组），返回剩余列表 */
    remove(keys: string[]): Promise<InvokeResult<HistoryEntry[]>>;
    clear(): Promise<InvokeResult<{ ok: boolean }>>;
  };
  probe: {
    engines(): Promise<InvokeResult<EngineHealth[]>>;
  };
  /** 统计页数据源：生命周期计数器快照（主进程内存态，落盘走 stats.json 节流） */
  stats: {
    get(): Promise<InvokeResult<StatsSnapshot>>;
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
