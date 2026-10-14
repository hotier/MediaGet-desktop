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
  DownloadItemSchema,
  DownloadTaskViewSchema,
  EngineHealthSchema,
  EnqueueInputSchema,
  EnqueueOutcomeSchema,
  HistoryEntrySchema,
  HistoryFilterSchema,
  IdentifyInputSchema,
  IdentifyOutcomeSchema,
  ParseDataSchema,
  ParseInputSchema,
  ParseResultSchema,
  ParseRunOutcomeSchema,
  ParsedVideoItemSchema,
  ParsedVideoQualitySchema,
  PersistedQueueTaskSchema,
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
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  historyList: "history:list",
  historyClear: "history:clear",
  probeEngines: "probe:engines",
  appGetBinaryStatus: "app:getBinaryStatus",
  appPickDownloadDir: "app:pickDownloadDir",
  appShowInFolder: "app:showInFolder",
  updateGetState: "update:state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  // main → renderer 事件
  evDownloadProgress: "download:progress",
  evDownloadDone: "download:done",
  evDownloadError: "download:error",
  evUpdateState: "app:updateState",
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

/** settings:get / settings:set —— 部分字段 set，返回全量生效配置 */
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: "",
  maxConcurrent: 3,
  fallbackOnline: true,
  onlineApiBase: "https://get.hotier.cc.cd",
  cookies: {},
  throttleMs: 0,
  minimizeToTray: true,
  theme: "system",
};

/** history:list */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;

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
// 自动更新（P6）—— 主进程状态机收敛成一个可渲染快照
// ————————————————————————————————————————————————

export type UpdatePhase = z.infer<typeof UpdateStateSchema>["phase"];

/** update:state / update:check / update:download 返回，亦是 app:updateState 事件载荷 */
export type UpdateState = z.infer<typeof UpdateStateSchema>;

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
    clear(): Promise<InvokeResult<{ ok: boolean }>>;
  };
  probe: {
    engines(): Promise<InvokeResult<EngineHealth[]>>;
  };
  app: {
    pickDownloadDir(): Promise<InvokeResult<string | null>>;
    showInFolder(path: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 随包二进制完整性状态（降级可见：degraded/rejected 要能被用户看到） */
    getBinaryStatus(): Promise<InvokeResult<BinaryStatusReport>>;
    /** 自动更新（P6）：state 是快照，check/download 返回迁移后的快照 */
    update: {
      state(): Promise<InvokeResult<UpdateState>>;
      check(): Promise<InvokeResult<UpdateState>>;
      download(): Promise<InvokeResult<UpdateState>>;
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
