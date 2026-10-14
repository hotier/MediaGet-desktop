/**
 * IPC 契约（v0）—— renderer 与 main 的唯一共享类型真源。
 *
 * 依据 docs/ARCHITECTURE.md §1 硬约束 3 与 §8：跨进程类型放这里（types/ipc.ts），
 * `ParseResult` 结构镜像 mediaGet `normalize-result` 的输出契约
 * （源：mediaGet/src/types/api.ts 的 ApiResponse/ParseData，此处注明镜像来源，
 * 不 import Next 工程，保持纯类型）。
 *
 * ⚠️ 修改本文件 = 修改 IPC 协议：preload、main/ipc.ts、renderer/bridge.ts 三处联动。
 */

// ————————————————————————————————————————————————
// 镜像自 mediaGet src/types/api.ts（单一真源在上游，此处仅镜像消费）
// ————————————————————————————————————————————————

/** 单个清晰度直链（bilibili / youtube 等） */
export interface ParsedVideoQuality {
  quality: number;
  label: string;
  url: string;
}

/** 多分P / 多清晰度视频项 */
export interface ParsedVideoItem {
  title?: string;
  url: string;
  duration?: number;
  durationFormat?: string;
  accept?: string[];
  qualities?: ParsedVideoQuality[];
  cover?: string;
}

/** 统一解析数据结构（normalize-result 归一化后的 data 契约） */
export interface ParseData {
  title?: string;
  desc?: string;
  type?: "video" | "image" | "music" | "text";
  duration?: number;
  author?: string;
  authorId?: string;
  authorUrl?: string;
  avatar?: string;
  sign?: string;
  tname?: string;
  copyright?: number | string;
  stat?: {
    view?: number;
    danmaku?: number;
    reply?: number;
    favorite?: number;
    coin?: number;
    share?: number;
    like?: number;
  };
  cover?: string;
  /** 主媒体直链（视频/音乐/单图）——渲染层只在结果卡内展示与转交下载，不自行发起网络请求 */
  url?: string;
  audioUrl?: string;
  images?: string[];
  videos?: ParsedVideoItem[];
  videoId?: string;
  embedUrl?: string;
  embedOnly?: boolean;
  qualityLabel?: string;
  qualities?: ParsedVideoQuality[];
  name?: string;
  lyrics?: string;
  like?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  time?: number | string;
  uid?: string;
  awemeId?: string;
  followerCount?: number;
  followingCount?: number;
  totalFavorited?: number;
  statsUnreliable?: boolean;
  music?: { author: string; title?: string; avatar: string };
  [key: string]: unknown;
}

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与线上 API 契约同构） */
export interface ParseResult {
  code: number;
  msg: string;
  platform?: string;
  data?: ParseData;
  /** 失败细分类型，沿用 mediaGet 语义：bot-gated / sources-down / source-unavailable / script-error 等 */
  failType?: string;
}

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
  // main → renderer 事件
  evDownloadProgress: "download:progress",
  evDownloadDone: "download:done",
  evDownloadError: "download:error",
  evUpdateAvailable: "app:updateAvailable",
  evEngineStatus: "engine:status",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ————————————————————————————————————————————————
// 各 channel 的入参 / 出参
// ————————————————————————————————————————————————

/** app:getMeta */
export interface AppMeta {
  version: string;
  electron: string;
  kernelMode: "local" | "online" | "mock";
  /** 平台清单来自内核 PLATFORM_INFO，renderer 不复制 */
  platforms: Array<{ key: string; name: string; nameEn: string; supportsIdParse: boolean }>;
}

/** parse:identify */
export interface IdentifyInput {
  text: string;
}
export interface IdentifyOutcome {
  platform: string;
  platformName: string;
  /** 提取出的链接 */
  url: string | null;
  /** 内容粗类型（链接形态推断） */
  kind: "url" | "share-text" | "unknown";
}

/** parse:run */
export interface ParseInput {
  text: string;
  platformHint?: string;
  source?: string;
  id?: string;
  /** 强制走线上回落（跳过本地），内测对比用 */
  forceOnline?: boolean;
}
/** parse:run 返回：归一化结果 + 来源标记（本地内核 / 线上回落 / mock） */
export interface ParseRunOutcome {
  result: ParseResult;
  /** 结果来源 */
  via: "local" | "online" | "mock";
  /** 本地失败转线上的原因（via=online 时有值） */
  fallbackReason?: string;
  durationMs: number;
}

/** download:enqueue */
export interface DownloadItem {
  url: string;
  filename: string;
  referer?: string;
  headers?: Record<string, string>;
  kind: "video" | "image" | "audio" | "file";
}
export interface EnqueueInput {
  items: DownloadItem[];
  /** 图集等成组下载共用 groupId */
  groupId?: string;
  /** 关联展示信息（写历史用，不存直链） */
  meta?: { platform?: string; title?: string };
}
export interface EnqueueOutcome {
  taskIds: string[];
  groupId: string;
}

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "done"
  | "error"
  | "canceled";

/** 队列持久化条目（重启恢复；store.ts 与 downloader.ts 共用） */
export interface PersistedQueueTask {
  taskId: string;
  groupId: string;
  url: string;
  filename: string;
  referer?: string;
  headers?: Record<string, string>;
  kind: string;
  received: number;
  total: number;
  createdAt: number;
  platform?: string;
  title?: string;
  status: DownloadStatus;
}

/** download:progress 事件 / download:list 项 */
export interface DownloadTaskView {
  taskId: string;
  groupId: string;
  url: string;
  filename: string;
  kind: string;
  status: DownloadStatus;
  received: number;
  total: number;
  /** 字节/秒 */
  speed: number;
  /** 落地路径（done 后） */
  filePath?: string;
  error?: string;
  platform?: string;
  title?: string;
  createdAt: number;
}

/** settings:get / settings:set —— 部分字段 set，返回全量生效配置 */
export interface AppSettings {
  /** 下载目录（绝对路径） */
  downloadDir: string;
  /** 并发上限 */
  maxConcurrent: number;
  /** 本地解析失败回落线上 API */
  fallbackOnline: boolean;
  /** 线上 API 基址（默认站点，可换自建） */
  onlineApiBase: string;
  /** 用户自配 Cookie（键位沿用 mediaGet：DOUYIN_COOKIE / XHS_COOKIE / IG_COOKIE / BILIBILI_COOKIE…） */
  cookies: Record<string, string>;
  /** 温和节流（毫秒，0=不限） */
  throttleMs: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: "",
  maxConcurrent: 3,
  fallbackOnline: true,
  onlineApiBase: "https://get.hotier.cc.cd",
  cookies: {},
  throttleMs: 0,
};

/** history:list */
export interface HistoryEntry {
  id: string;
  platform?: string;
  title?: string;
  /** 落地文件路径列表 */
  files: string[];
  /** 分享来源链接（用户自己的输入，非直链） */
  sourceUrl?: string;
  createdAt: number;
}
export interface HistoryFilter {
  platform?: string;
  limit?: number;
}

/** probe:engines —— 本地版体检 */
export interface EngineHealth {
  platform: string;
  name: string;
  ok: boolean;
  detail?: string;
  durationMs?: number;
}

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
    onUpdateAvailable(cb: (info: { version: string }) => void): () => void;
  };
}

declare global {
  interface Window {
    /** preload contextBridge 白名单 API（唯一渲染层入口） */
    mg?: MgBridge;
  }
}
