/**
 * IPC 契约的运行时真源（2026-10-14 对标 Motrix v2：payload 形态只声明一次）。
 *
 * 为什么单独成文件而不是并进 types/ipc.ts：ipc.ts 必须保持「零运行时」——renderer
 * 只以 `import type` 消费它，zod 一旦落进同文件就会把整个 schema 层拉进 renderer 包。
 * 拆开后 ipc.ts 用 `import type` + `z.infer` 派生类型（纯类型位置不产生运行时边），
 * 而 zod 只随主进程走。
 *
 * 消费方：
 * - electron/main/ipc.ts：入参一律先过 in schema（renderer 是不可信输入源）；
 *   dev 构建（deps.validateOutputs）再对出参过 out schema —— 契约漂移当场报错，
 *   而不是让 UI 拿到形状不对的数据后静默降级。
 * - tests/contract.test.ts：通道集合、载荷形状、注册完整性三处守门。
 *
 * 内核镜像类型（ParseData / ParseResult）用 passthrough：上游字段是活水，
 * 客户端只声明「消费到的那些」，多出来的键放行而不是拒掉整包。
 */
import { z } from "zod";
import { IPC } from "./ipc";

const STR = z.string();

// ————————————————————————————————————————————————
// 镜像自 mediaGet src/types/api.ts（上游为单一真源，此处声明客户端消费面）
// ————————————————————————————————————————————————

/** 单个清晰度直链 */
export const ParsedVideoQualitySchema = z.object({
  quality: z.number(),
  label: STR,
  url: STR,
});

/** 多分 P / 多清晰度视频项 */
export const ParsedVideoItemSchema = z.object({
  title: STR.optional(),
  url: STR,
  duration: z.number().optional(),
  durationFormat: STR.optional(),
  accept: z.array(STR).optional(),
  qualities: z.array(ParsedVideoQualitySchema).optional(),
  cover: STR.optional(),
});

export const ParseStatSchema = z.object({
  view: z.number().optional(),
  danmaku: z.number().optional(),
  reply: z.number().optional(),
  favorite: z.number().optional(),
  coin: z.number().optional(),
  share: z.number().optional(),
  like: z.number().optional(),
});

/** 统一解析数据结构（normalize-result 归一化后的 data 契约） */
export const ParseDataSchema = z
  .object({
    title: STR.optional(),
    desc: STR.optional(),
    type: z.enum(["video", "image", "music", "text"]).optional(),
    duration: z.number().optional(),
    author: STR.optional(),
    authorId: STR.optional(),
    authorUrl: STR.optional(),
    avatar: STR.optional(),
    sign: STR.optional(),
    tname: STR.optional(),
    copyright: z.union([z.number(), STR]).optional(),
    stat: ParseStatSchema.optional(),
    cover: STR.optional(),
    /** 主媒体直链（视频/音乐/单图）——渲染层只在结果卡内展示与转交下载，不自行发起网络请求 */
    url: STR.optional(),
    audioUrl: STR.optional(),
    images: z.array(STR).optional(),
    videos: z.array(ParsedVideoItemSchema).optional(),
    videoId: STR.optional(),
    embedUrl: STR.optional(),
    embedOnly: z.boolean().optional(),
    qualityLabel: STR.optional(),
    qualities: z.array(ParsedVideoQualitySchema).optional(),
    /** 频道订阅者数（YouTube，与 B站富信息对齐） */
    subscriberCount: z.number().optional(),
    /** 频道投稿数（YouTube） */
    videoCount: z.number().optional(),
    /** 频道累计播放（YouTube） */
    channelViews: z.number().optional(),
    name: STR.optional(),
    lyrics: STR.optional(),
    /** 音乐高潮片段（汽水音乐等） */
    core: STR.optional(),
    like: z.number().optional(),
    retweets: z.number().optional(),
    replies: z.number().optional(),
    views: z.number().optional(),
    time: z.union([z.number(), STR]).optional(),
    uid: STR.optional(),
    awemeId: STR.optional(),
    followerCount: z.number().optional(),
    followingCount: z.number().optional(),
    totalFavorited: z.number().optional(),
    statsUnreliable: z.boolean().optional(),
    music: z.object({ author: STR, title: STR.optional(), avatar: STR }).optional(),
  })
  .passthrough();

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与线上 API 契约同构） */
export const ParseResultSchema = z.object({
  code: z.number(),
  msg: STR,
  platform: STR.optional(),
  data: ParseDataSchema.optional(),
  /** 失败细分类型，沿用 mediaGet 语义：bot-gated / sources-down / source-unavailable / script-error 等 */
  failType: STR.optional(),
});

// ————————————————————————————————————————————————
// 各通道入参
// ————————————————————————————————————————————————

export const IdentifyInputSchema = z.object({ text: STR.max(4000) });

export const ParseInputSchema = z.object({
  text: STR.max(4000),
  platformHint: STR.max(40).optional(),
  source: STR.max(40).optional(),
  id: STR.max(200).optional(),
  /** 强制走线上回落（跳过本地），内测对比用 */
  forceOnline: z.boolean().optional(),
});

export const DownloadItemSchema = z.object({
  url: z.string().url().max(4000),
  filename: STR.min(1).max(200),
  referer: z.string().url().max(2000).optional(),
  headers: z.record(STR.max(100), STR.max(4000)).optional(),
  kind: z.enum(["video", "image", "audio", "file"]),
});

/**
 * 作者快照：解析那一刻的作者公开信息，随任务/历史一路透传。
 *
 * 为什么是「快照」而不是实时档案：客户端没有任何拉取主页的能力（不加通道），
 * 而历史页要稳定展示粉丝量——展示下载当时的值，比展示「今天点开才知道」的值更诚实。
 * 全字段 optional：老记录（本次改动之前落盘的 history.json）没有这个键，
 * 主进程 loadHistory 没有版本迁移机制，缺字段必须在契约层就合法。
 */
export const AuthorSnapshotSchema = z.object({
  name: STR.max(100).optional(),
  id: STR.max(200).optional(),
  /** 作者主页（公开页面链接，非媒体直链） */
  url: STR.max(2000).optional(),
  avatar: STR.max(2000).optional(),
  sign: STR.max(500).optional(),
  followerCount: z.number().optional(),
  followingCount: z.number().optional(),
  totalFavorited: z.number().optional(),
});

export const EnqueueInputSchema = z.object({
  items: z.array(DownloadItemSchema).min(1).max(200),
  /** 图集等成组下载共用 groupId */
  groupId: STR.max(64).optional(),
  /** 关联展示信息（写历史用，不存媒体直链） */
  meta: z
    .object({
      platform: STR.max(40).optional(),
      title: STR.max(200).optional(),
      sourceUrl: STR.max(2000).optional(),
      author: AuthorSnapshotSchema.optional(),
    })
    .optional(),
});

export const TaskIdInputSchema = z.object({ taskId: STR.min(1).max(64) });

/** 全量生效配置（settings:get / settings:set 的出参） */
export const AppSettingsSchema = z.object({
  /** 下载目录（绝对路径；空串 = 系统下载目录） */
  downloadDir: STR,
  /** 并发上限 */
  maxConcurrent: z.number(),
  /** 本地解析失败回落线上 API */
  fallbackOnline: z.boolean(),
  /** 线上 API 基址（默认站点，可换自建） */
  onlineApiBase: STR,
  /** 用户自配 Cookie（键位沿用 mediaGet；出参侧永远是 "***"/"" 的脱敏视图） */
  cookies: z.record(STR, STR),
  /** 温和节流（毫秒，0=不限） */
  throttleMs: z.number(),
  /** 点 ✕ 关窗时最小化到托盘而非退出 */
  minimizeToTray: z.boolean(),
  /** 开机自启动（随系统登录拉起；打包版写入系统登录项，dev 仅存偏好） */
  launchAtLogin: z.boolean(),
  /** 网络代理：system=跟随系统（默认）/ off=直连 / manual=用 proxyUrl，作用于解析、下载与更新检查 */
  proxyMode: z.enum(["system", "off", "manual"]),
  /** 手动代理地址（manual 模式用；缺 scheme 按 http:// 补，如 127.0.0.1:7897） */
  proxyUrl: STR,
  /** 明暗主题；system = 跟随系统 */
  theme: z.enum(["system", "dark", "light"]),
  /** 主题风格：一套风格 = 一整套色带（底色/线条/焦点色…），与明暗正交 */
  themeStyle: z.enum(["azure", "indigo", "teal", "slate", "violet"]),
  /** 界面正文字号（像素）；其余文字档按它 ±1px 推导 */
  fontSizePx: z.number().int().min(11).max(18),
  /** 界面字体族：值为已安装字体的 family 名（由 app:listFonts 枚举）；"system" = 哨兵，吃基座默认栈。改内联 --font-ui 应用，非枚举 */
  fontFamily: STR.min(1).max(64),
  /** 下载完成自动在资源管理器定位到文件（默认关：并发下载会连环弹窗） */
  openFolderOnDone: z.boolean(),
  /** 失败自动重试次数（0–3；指数退避 1s/2s/4s…） */
  retryTimes: z.number().int().min(0).max(3),
  /** 清晰度预选默认策略：main=内核推荐直链 / highest=最高画质 / lowest=最低画质省流量 */
  defaultQuality: z.enum(["main", "highest", "lowest"]),
  /** 取消任务保留 .part 断点（下次同链接入队可续）；关=取消即删腾磁盘 */
  keepPartials: z.boolean(),
  /** 系统通知：整组文件下载结束后弹一次 Windows 通知（按组聚合，图集不逐张弹） */
  notifyOnDone: z.boolean(),
  /** 系统通知：整组重试用尽仍失败时弹通知（附失败原因） */
  notifyOnError: z.boolean(),
  /** 剪贴板监听：复制到的分享链接自动填入首页输入框（纯本地识别，文本不出本机） */
  clipboardWatch: z.boolean(),
  /** 文件日志门槛（userData/logs/app.log）：off=一行不落，排查问题时再开 */
  logLevel: z.enum(["off", "error", "warn", "info"]),
  /** 日志保留天数（1–90）：每次启动删除更久的轮转文件 */
  logRetentionDays: z.number().int().min(1).max(90),
  /** 更新策略：启动时自动检测更新（仅打包态有发布通道） */
  updateOnStartup: z.boolean(),
  /** 更新策略：检测到新版本后自动下载（静默下载）；关=横幅手动确认，不偷家庭带宽 */
  updateAutoDownload: z.boolean(),
  // 安装策略固定为「手动重启安装」：setup 包做不了无感静默安装，`autoInstallOnAppQuit` 恒 false，
  // 安装只由关于页流式下载弹窗的「立即重启」触发，不作为开关暴露
});

/** 部分字段 set —— strict：未知键直接拒，避免把拼错的键当成「已保存」 */
export const SettingsPatchSchema = AppSettingsSchema.partial().strict();

/** app:listFonts 出参：本机已安装字体的 family 名数组（font-list 枚举，已去引号/去重/排序） */
export const FontListSchema = z.array(STR.max(64));

export const HistoryFilterSchema = z.object({
  platform: STR.max(40).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** 仅主进程持久化格式（store.ts 真源），入参侧复用 */
export const PersistedQueueTaskSchema = z.object({
  taskId: STR,
  groupId: STR,
  url: STR,
  filename: STR,
  referer: STR.optional(),
  headers: z.record(STR, STR).optional(),
  kind: STR,
  received: z.number(),
  total: z.number(),
  createdAt: z.number(),
  platform: STR.optional(),
  title: STR.optional(),
  sourceUrl: STR.optional(),
  author: AuthorSnapshotSchema.optional(),
  status: z.enum(["queued", "downloading", "paused", "done", "error", "canceled"]),
});

// ————————————————————————————————————————————————
// 各通道出参
// ————————————————————————————————————————————————

export const OkFlagSchema = z.object({ ok: z.boolean() });

export const AppMetaSchema = z.object({
  version: STR,
  electron: STR,
  kernelMode: z.enum(["local", "online", "mock"]),
  /** 平台清单来自内核 PLATFORM_INFO，renderer 不复制 */
  platforms: z.array(
    z.object({ key: STR, name: STR, nameEn: STR, supportsIdParse: z.boolean() })
  ),
});

export const IdentifyOutcomeSchema = z.object({
  platform: STR,
  platformName: STR,
  /** 提取出的链接 */
  url: STR.nullable(),
  /** 内容粗类型（链接形态推断） */
  kind: z.enum(["url", "share-text", "unknown"]),
});

export const ParseRunOutcomeSchema = z.object({
  result: ParseResultSchema,
  /** 结果来源 */
  via: z.enum(["local", "online", "mock"]),
  /** 本地失败转线上的原因（via=online 时有值） */
  fallbackReason: STR.optional(),
  durationMs: z.number(),
});

export const EnqueueOutcomeSchema = z.object({
  taskIds: z.array(STR),
  groupId: STR,
});

/** download:progress 事件 / download:list 项 */
export const DownloadTaskViewSchema = z.object({
  taskId: STR,
  groupId: STR,
  url: STR,
  filename: STR,
  kind: STR,
  status: z.enum(["queued", "downloading", "paused", "done", "error", "canceled"]),
  received: z.number(),
  total: z.number(),
  /** 字节/秒 */
  speed: z.number(),
  /** 落地路径（done 后） */
  filePath: STR.optional(),
  error: STR.optional(),
  platform: STR.optional(),
  title: STR.optional(),
  /** 用户输入的分享链接（透传给历史，非直链） */
  sourceUrl: STR.optional(),
  author: AuthorSnapshotSchema.optional(),
  createdAt: z.number(),
  /**
   * 完成时刻（仅 done 有值）。只在本进程存活期内有效：snapshot() 过滤掉 done，
   * 重启后已完成任务不再回队列（落地目录才是真源），所以它不是持久字段。
   */
  finishedAt: z.number().optional(),
});

/** history:list 项 */
export const HistoryEntrySchema = z.object({
  id: STR,
  /** 图集等成组下载共用（聚合一行用） */
  groupId: STR.optional(),
  platform: STR.optional(),
  title: STR.optional(),
  /** 媒体类型（视频/图集/音频/文件） */
  kind: STR.optional(),
  /** 文件字节数（done 时的 received） */
  bytes: z.number().optional(),
  /** 落地文件路径列表 */
  files: z.array(STR),
  /** 分享来源链接（用户自己的输入，非直链） */
  sourceUrl: STR.optional(),
  /** 下载那一刻的作者快照（老记录无此键） */
  author: AuthorSnapshotSchema.optional(),
  createdAt: z.number(),
});

/** probe:engines —— 本地版体检 */
export const EngineHealthSchema = z.object({
  platform: STR,
  name: STR,
  ok: z.boolean(),
  detail: STR.optional(),
  durationMs: z.number().optional(),
});

/**
 * 单个二进制的运行时状态。
 *
 * `integrity` 是「降级可见」的关键字段：`degraded` = 没有完整性基线
 * （dev 自备 / 旧包未带 manifest），此时只定位不校验 —— 不假装有防护。
 */
export const BinaryStatusViewSchema = z.object({
  name: z.enum(["yt-dlp", "ffmpeg"]),
  available: z.boolean(),
  origin: z.enum(["user", "extracted", "packaged"]).optional(),
  path: STR.optional(),
  integrity: z.enum(["verified", "degraded", "rejected", "missing"]),
  /** 期望 SHA-256（有基线时） */
  expected: STR.optional(),
});

export const BinaryStatusReportSchema = z.object({
  /** 本次进程是否带完整性基线（= 随包 manifest.json 被读到） */
  manifestLoaded: z.boolean(),
  /** extraResources 落点（prod）/ MG_BIN_DIR（dev）；null = 无随包目录 */
  packagedDir: STR.nullable(),
  binaries: z.array(BinaryStatusViewSchema),
});

export const UpdateStateSchema = z.object({
  phase: z.enum([
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    /** 用户主动暂停：令牌已 cancel，传输停止；update:resume 从头重新起流（electron-updater 无断点续传） */
    "paused",
    "downloaded",
    "error",
    /** 本机没有更新源：dev 启动、或打包未配 publish。UI 隐藏检查入口 */
    "unsupported",
  ]),
  currentVersion: STR,
  /** available / downloading / downloaded 时的新版本号 */
  availableVersion: STR.optional(),
  /** 0–100（downloading / downloaded） */
  percent: z.number().optional(),
  transferredBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  /** 下载速度（字节/秒，取自 electron-updater 的 bytesPerSecond；仅 downloading 有值） */
  bytesPerSecond: z.number().optional(),
  /**
   * 新版本更新说明（changelog）。GitHub Releases 通道取自 releaseNotes，
   * 归一化为纯文本（多条 note 以空行连接）；无说明时缺省。
   */
  releaseNotes: STR.max(20000).optional(),
  /** error 阶段的说明（原始错误文本，不翻译，便于排查） */
  error: STR.optional(),
  canCheck: z.boolean(),
});

/** 目录选择器结果：null = 用户取消 */
export const PickDirResultSchema = z.union([STR, z.null()]);

/** app:showInFolder 入参：本机绝对路径（renderer 不可信输入，长度封顶即可） */
export const FolderPathSchema = z.string().max(1000);

// ————————————————————————————————————————————————
// 本地缓存 / 日志（设置→通用）
// ————————————————————————————————————————————————

/**
 * 单项占用。`key` 是枚举而不是自由串：UI 的中文名与图标由键在渲染层映射，
 * 主进程只出数字 —— 文案不出 renderer，避免「主进程写 UI 话术」的第二真源。
 * `clearable=false` 的项（本机记录：历史/队列/配置）只报占用，清理永远不碰它们。
 */
export const CacheItemSchema = z.object({
  key: z.enum(["net", "update", "partials", "junk", "logs", "records"]),
  bytes: z.number().int().min(0),
  clearable: z.boolean(),
});

export const CacheStatusSchema = z.object({
  items: z.array(CacheItemSchema),
  totalBytes: z.number().int().min(0),
  /** 一键清理能吃掉的量（= clearable 项之和）；UI 用它决定按钮是否可点 */
  clearableBytes: z.number().int().min(0),
});

/** app:cacheClear 入参：只点名要清的项（空数组无意义，min 1） */
export const CacheClearInputSchema = z.object({
  keys: z.array(CacheItemSchema.shape.key).min(1).max(6),
});

/**
 * 清理结果。`skipped` 是「点了但没清」的键（唯一现役理由：更新包已下载完待重启安装，
 * 清掉等于让用户重下一份）—— 不静默吞掉，UI 必须如实说。
 */
export const CacheClearResultSchema = z.object({
  freed: z.number().int().min(0),
  skipped: z.array(CacheItemSchema.shape.key),
  /** 清理后的重新扫描快照（UI 直接换血，不用再发一次 status） */
  report: CacheStatusSchema,
});

/** app:log 入参：渲染层转发的异常（单行、长度封顶，禁止把整段响应体灌进来） */
export const LogWriteInputSchema = z.object({
  level: z.enum(["error", "warn", "info"]),
  message: STR.min(1).max(2000),
});

// ————————————————————————————————————————————————
// 通道注册表：新增通道只在这里登记 in/out，main 的集中校验与守门测试同时生效
// ————————————————————————————————————————————————

export interface InvokeContract {
  /** 入参 schema；null = 该通道不接受任何入参 */
  in: z.ZodTypeAny | null;
  /** 出参 schema（信封内 data 的形状） */
  out: z.ZodTypeAny;
}

const invoke = (inSchema: z.ZodTypeAny | null, outSchema: z.ZodTypeAny): InvokeContract => ({
  in: inSchema,
  out: outSchema,
});

export const CONTRACT = {
  [IPC.appGetMeta]: invoke(null, AppMetaSchema),
  [IPC.parseIdentify]: invoke(IdentifyInputSchema, IdentifyOutcomeSchema),
  [IPC.parseRun]: invoke(ParseInputSchema, ParseRunOutcomeSchema),
  [IPC.downloadEnqueue]: invoke(EnqueueInputSchema, EnqueueOutcomeSchema),
  [IPC.downloadCancel]: invoke(TaskIdInputSchema, OkFlagSchema),
  [IPC.downloadPause]: invoke(TaskIdInputSchema, OkFlagSchema),
  [IPC.downloadResume]: invoke(TaskIdInputSchema, OkFlagSchema),
  [IPC.downloadList]: invoke(null, z.array(DownloadTaskViewSchema)),
  [IPC.settingsGet]: invoke(null, AppSettingsSchema),
  [IPC.settingsSet]: invoke(SettingsPatchSchema, AppSettingsSchema),
  [IPC.historyList]: invoke(HistoryFilterSchema.optional(), z.array(HistoryEntrySchema)),
  [IPC.historyClear]: invoke(null, OkFlagSchema),
  [IPC.probeEngines]: invoke(null, z.array(EngineHealthSchema)),
  [IPC.appGetBinaryStatus]: invoke(null, BinaryStatusReportSchema),
  [IPC.appPickDownloadDir]: invoke(null, PickDirResultSchema),
  [IPC.appShowInFolder]: invoke(FolderPathSchema, OkFlagSchema),
  [IPC.appListFonts]: invoke(null, FontListSchema),
  [IPC.appCacheStatus]: invoke(null, CacheStatusSchema),
  [IPC.appCacheClear]: invoke(CacheClearInputSchema, CacheClearResultSchema),
  [IPC.appOpenLogDir]: invoke(null, OkFlagSchema),
  [IPC.appLog]: invoke(LogWriteInputSchema, OkFlagSchema),
  [IPC.updateGetState]: invoke(null, UpdateStateSchema),
  [IPC.updateCheck]: invoke(null, UpdateStateSchema),
  [IPC.updateDownload]: invoke(null, UpdateStateSchema),
  [IPC.updatePause]: invoke(null, UpdateStateSchema),
  [IPC.updateResume]: invoke(null, UpdateStateSchema),
  [IPC.updateCancel]: invoke(null, UpdateStateSchema),
  [IPC.updateInstall]: invoke(null, OkFlagSchema),
} as const satisfies Record<string, InvokeContract>;

/** main → renderer 事件载荷（订阅前无需入参校验，出参形状由这里守） */
export const EVENTS = {
  [IPC.evDownloadProgress]: DownloadTaskViewSchema,
  [IPC.evDownloadDone]: DownloadTaskViewSchema,
  [IPC.evDownloadError]: DownloadTaskViewSchema,
  [IPC.evUpdateState]: UpdateStateSchema,
  /** 剪贴板监听命中分享链接（main 端已过内核 identify：platform 非空、url 有值） */
  [IPC.evClipboardLink]: IdentifyOutcomeSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type InvokeChannel = keyof typeof CONTRACT;
export type EventChannel = keyof typeof EVENTS;

/**
 * 入参校验失败 → 稳定错误文案（`bad-input` 信封的 message）。
 *
 * 路径拼进文案是刻意的：设置页要把「哪个字段为什么不对」内联显示，
 * 只给一句「校验失败」等于让 UI 猜（docs/UIUX-DESIGN.md §错误三层）。
 */
export function describeIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
