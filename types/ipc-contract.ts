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
import { COOKIE_LOGIN_KEYS, type CookieLoginKey } from "../shared/cookie-login";
import { SWITCHABLE_ENGINE_IDS } from "../shared/platforms";
import { isSecretKey } from "../shared/secret-keys";

const STR = z.string();
export const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}, "Expected a local calendar date");

// ————————————————————————————————————————————————
// 镜像自 mediaGet src/types/api.ts（上游为单一真源，此处声明客户端消费面）
// ————————————————————————————————————————————————

/** 单个清晰度直链 */
export const ParsedVideoQualitySchema = z.object({
  quality: z.number(),
  label: STR,
  url: STR,
  /**
   * MSE 预览用的轨道身份（v35）：`codecs` 形如 `avc1.640032` / `mp4a.40.2`，
   * `mimeType` 是 `video/mp4` / `audio/mp4`。上游给了才写——缺它只是预览走合流回退，
   * 不影响下载。B站 playurl 与 yt-dlp 的 format 都自带这两项。
   */
  codecs: STR.optional(),
  mimeType: STR.optional(),
});

/** 多分 P / 多清晰度视频项 */
export const ParsedVideoItemSchema = z.object({
  title: STR.optional(),
  url: STR,
  duration: z.number().optional(),
  durationFormat: STR.optional(),
  /** 本档直链的清晰度展示（微博每 P 一行） */
  qualityLabel: STR.optional(),
  accept: z.array(STR).optional(),
  qualities: z.array(ParsedVideoQualitySchema).optional(),
  cover: STR.optional(),
  /** 原始键并存（非契约）：B站 `video_url`，新消费方读 `url` */
  video_url: STR.optional(),
  /** 原始键并存：B站 `pic`，新消费方读 `cover` */
  pic: STR.optional(),
  /**
   * 这一条是第几 P（1 起，B站 `pages[].page`）。
   *
   * 不能用数组下标代替：某一 P 取流失败时它会整条缺席（内核与 amagi 都是 `filter(Boolean)`），
   * 下标就整体前移——「分 P 2」标签与 `_P2` 文件名会贴到真正的第三 P 上，
   * 用户按名字找片找到的是另一条。缺键（其他平台、单 P）才退回下标。
   */
  page: z.number().int().min(1).optional(),
  /**
   * 这一 P 自己的 DASH 音轨（v36）：一条分 P 就是一份独立资源，音轨不能去借顶层那条
   * ——借来的音轨配的是别的 P 的声音，比无声更难发现（v33「一律合流」的前提是音画同一次取流）。
   * 缺键 = 该条是渐进式单文件（自带声音）或内核没补这一字段，按单流下载。
   */
  audioUrl: STR.optional(),
  /** 这一 P 的双轨 MSE 身份（与 `ParseData` 顶层同名四键同一语义）：缺键 = 预览走合流回退 */
  videoCodecs: STR.optional(),
  videoMimeType: STR.optional(),
  audioCodecs: STR.optional(),
  audioMimeType: STR.optional(),
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
    /**
     * 视频时长，**毫秒**（内核硬口径：抖音/YouTube/tiktok/B站顶层与分P/X 均已在归一化时换算）。
     * 消费方一律 `/1000`，不许再按量级猜单位——短片毫秒值会落在任何「大数才当毫秒」的阈值之下。
     */
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
    /**
     * 主链与音轨的 MSE 身份（v35）：双轨 DASH 预览要在渲染层建两个 SourceBuffer，
     * 创建时必须给出精确的 `mimeType; codecs=…`。主链是渐进式单文件时不写 codecs，
     * 预览继续走 `<video>` 直读。缺任一项 = 该条预览回退到主进程合流。
     */
    videoCodecs: STR.optional(),
    videoMimeType: STR.optional(),
    audioCodecs: STR.optional(),
    audioMimeType: STR.optional(),
    images: z.array(STR).optional(),
    videos: z.array(ParsedVideoItemSchema).optional(),
    /**
     * 主链（`url` + `qualities` + 顶层音轨）是第几 P（v36，1 起）。
     *
     * 多篇稿件里「用户点开的那一条」和「合集的第一条」不是同一个东西：主链要带上自己的
     * P 号，否则同一合集的 P1 与 P2 各自解析一次会落成同一个文件名（下第二遍就覆盖第一遍）。
     * 单 P 稿件与没报这一位的内核缺键，按「不需要 P 标记」处理。
     */
    page: z.number().int().min(1).optional(),
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
    /** 作品数平铺位（`kuaishou` 的 `worksCount`；与 `videoCount` 同义，读侧归并） */
    worksCount: z.number().optional(),
    /** 作者简介平铺位（`kuaishou` 的 `authorSign`；与 `sign` 同义，读侧归并） */
    authorSign: STR.optional(),
    name: STR.optional(),
    lyrics: STR.optional(),
    /** 音乐高潮片段（汽水音乐等） */
    core: STR.optional(),
    /** 解析来源标记（快手 init-state / json-fragment、YouTube yt-dlp…，诊断用） */
    source: STR.optional(),
    like: z.number().optional(),
    favorite: z.union([z.number(), STR]).optional(),
    reply: z.union([z.number(), STR]).optional(),
    share: z.union([z.number(), STR]).optional(),
    playCount: z.union([z.number(), STR]).optional(),
    likeCount: z.union([z.number(), STR]).optional(),
    commentCount: z.union([z.number(), STR]).optional(),
    shareCount: z.union([z.number(), STR]).optional(),
    collectionCount: z.union([z.number(), STR]).optional(),
    /** 播放数（`kuaishou` 的 `photo.viewCount` 平铺位；与 `stat.view` 是同一档，读侧归并） */
    viewCount: z.union([z.number(), STR]).optional(),
    /** 转发数（`kuaishou` 的 `photo.forwardCount`；与 `retweets` 是同一档，读侧归并） */
    forwardCount: z.union([z.number(), STR]).optional(),
    /** 格式化时长，如 "00:02:59"（`duration` 的展示伴生字段） */
    durationFormat: STR.optional(),
    /** 笔记 / 帖子 ID（小红书等） */
    noteId: STR.optional(),
    retweets: z.number().optional(),
    replies: z.number().optional(),
    views: z.number().optional(),
    time: z.union([z.number(), STR]).optional(),
    /** IP 属地（微博等，发布时所在地） */
    ipRegion: STR.optional(),
    uid: STR.optional(),
    awemeId: STR.optional(),
    followerCount: z.number().optional(),
    followingCount: z.number().optional(),
    totalFavorited: z.number().optional(),
    /** 认证说明（微博桌面作者接口 `verified_reason`） */
    verifiedReason: STR.optional(),
    /** 作者微博总条数（微博桌面作者接口 `statuses_count`） */
    statusesCount: z.number().optional(),
    statsUnreliable: z.boolean().optional(),
    music: z.object({ author: STR, title: STR.optional(), avatar: STR }).optional(),
  })
  .passthrough();

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与解析内核输出同构） */
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
  /** 跳过 24h 结果缓存（重试取新签名直链用：缓存里存的正是会过期的那份） */
  skipCache: z.boolean().optional(),
});

export const DownloadItemSchema = z.object({
  url: z.string().url().max(4000),
  /**
   * DASH 音频轨（v33）：有它就必须合流，交付的必须是音画合一的完整文件。
   *
   * 产品规则（业主 2026-10-21「预览和下载都是需要完整的视频，保证视频和音频都是融合的」）：
   * B站登录态只回 video-only 分片，单独落盘就是无声视频。缺该键 = 单流，按老路径走。
   */
  audioUrl: z.string().url().max(4000).optional(),
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
  /** 投稿数（YouTube 频道；B站/抖音不给，故只在有值时出现） */
  videoCount: z.number().optional(),
});

/**
 * 作品计数快照 —— 解析那一刻的公开互动数，随解析行进历史。
 *
 * 为什么不直接把整份 `ParseData` 存进历史：内核那份是 passthrough 的活水，里面既有
 * `url` / `images[]` / `qualities[].url` 这类**媒体直链**（隐私红线，绝不落盘），
 * 也有要留的公开数字。所以只挑计数、按语义归并成固定八档 —— 各平台的填法不一样
 * （B站给 `stat.view`、抖音给 `stat.view`、推特给平铺 `retweets`、YouTube 给 `channelViews`），
 * 归并口径只有一个出口：`shared/work-stat.ts`，结果卡与导出共用它。
 *
 * 全字段 optional：改动之前落盘的记录没这个键，而 `loadHistory` 没有版本迁移机制，
 * 缺字段必须在契约层就合法（与上面作者快照同一条理由）。
 */
export const WorkStatSchema = z.object({
  view: z.number().optional(),
  danmaku: z.number().optional(),
  like: z.number().optional(),
  /** 转发（推特等；与 B站的 `share`「分享」是两档，不并成一档） */
  retweet: z.number().optional(),
  reply: z.number().optional(),
  favorite: z.number().optional(),
  coin: z.number().optional(),
  share: z.number().optional(),
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

/**
 * 单平台开关覆盖。
 * 只有 `enabled`：引擎优先级是 P2 的事，届时加 `engineOrder` 是纯新增可选键，不必再升契约号。
 */
export const PlatformSwitchSchema = z.object({ enabled: z.boolean() }).strict();

/** 单引擎开关覆盖（与平台开关同形；缺键 = 开，见 shared/platforms 的 isEngineEnabled） */
export const EngineSwitchSchema = z.object({ enabled: z.boolean() }).strict();

/** 全量生效配置（settings:get / settings:set 的出参） */
export const AppSettingsSchema = z.object({
  /** 下载目录（绝对路径；空串 = 系统下载目录） */
  downloadDir: STR,
  /** 并发上限 */
  maxConcurrent: z.number(),
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
  /** 下载文件名主体组合（连接符统一为下划线）：title=仅标题 / authorTitle=作者_标题 /
   *  titleAuthor=标题_作者 / titleDate=标题_日期 / authorTitleDate=作者_标题_日期 */
  filenamePreset: z.enum(["title", "authorTitle", "titleAuthor", "titleDate", "authorTitleDate"]),
  /** 追加开关（在预设主体之后）：quality=清晰度后缀、index=多文件序号 */
  filenameExtra: z.object({ quality: z.boolean(), index: z.boolean() }),
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
  /**
   * 平台解析能力开关（真源 = 本仓 `shared/platforms.ts` 注册表，这里只存用户覆盖）。
   * 缺键 = 跟随该平台 `enabledByDefault`；写进档的只有用户明确改过的平台，
   * 所以注册表增删平台不需要动存档形状。键是契约键（别名在写入侧已归一）。
   */
  platformSwitches: z.record(STR, PlatformSwitchSchema),
  /**
   * 引擎开关（v30，2026-10-21）：引擎这一层的「供不供」，与平台开关同一套语义——
   * 缺键 = 开（`isEngineEnabled`），只有用户关掉时才落显式 false；
   * 关掉的引擎在主进程选路与体检里都不再出现（不是只在界面上藏起来）。
   * 键 = 可切换引擎 id（`SWITCHABLE_ENGINE_IDS`，mock 兜底不在其中）。
   */
  engineSwitches: z.record(z.enum(SWITCHABLE_ENGINE_IDS), EngineSwitchSchema),
  /**
   * 平台主引擎（v31，2026-10-21）：每个平台先试哪个引擎。缺键 = mediaget
   * （`DEFAULT_PRIMARY_ENGINE`）；只存用户改过的平台，注册表增删平台不用写迁移。
   * 键是契约键（别名在写入侧已归一），值是可切换引擎 id。
   */
  platformEngines: z.record(STR, z.enum(SWITCHABLE_ENGINE_IDS)),
  /**
   * 引擎失败回退（v31）：主引擎失败后是否按顺序再试其余可用引擎。
   * 缺省 true；关掉 = 只用主引擎，它的失败就是最终答复。
   */
  engineFallback: z.boolean(),
  // 安装策略固定为「手动重启安装」：setup 包做不了无感静默安装，`autoInstallOnAppQuit` 恒 false，
  // 安装只由关于页流式下载弹窗的「立即重启」触发，不作为开关暴露
});

/**
 * `settings:set` 的 Cookie 入参：键只认登记过的机密键（`shared/secret-keys.ts`）。
 *
 * 出参/存档仍用宽松的 `z.record`（`AppSettingsSchema`）：旧盘上的键要能读出来、能删。
 * 但**写**必须收窄——handler 会把每个非掩码键同时写进 `settings.cookies` 与 kernel_config，
 * 而 kernel_config 里的 `YTDLP_BIN` / `FFMPEG_BIN` 是下一轮解析要 spawn 的路径。
 */
const SecretCookieMapSchema = z.record(STR, STR).superRefine((map, ctx) => {
  for (const key of Object.keys(map)) {
    if (!isSecretKey(key)) {
      ctx.addIssue({ code: "custom", message: `未登记的 Cookie 键：${key}`, path: [key] });
    }
  }
});

/** 部分字段 set —— strict：未知键直接拒，避免把拼错的键当成「已保存」 */
export const SettingsPatchSchema = AppSettingsSchema.extend({ cookies: SecretCookieMapSchema })
  .partial()
  .strict();

/**
 * settings:cookieLogin（v19）：打开登录窗口 → 登录后自动抓 Cookie。
 *
 * 入参只认 `shared/cookie-login.ts` 登记过的四个键：这条通道会在主进程开窗、读会话 Cookie
 * 并直接写档，权限面比 settings:set 大，不能让它接受任意键名。
 * 出参只有「抓到没有 + 原因」——**值永远不出主进程**（与 settings:get 的掩码同一条隐私契约）。
 */
export const CookieLoginInputSchema = z.object({
  cookieKey: z.enum([...COOKIE_LOGIN_KEYS] as [CookieLoginKey, ...CookieLoginKey[]]),
});

export const CookieLoginResultSchema = z.object({
  captured: z.boolean(),
  reason: z.enum(["captured", "no-login", "timeout", "busy", "error"]),
});

/** app:listFonts 出参：本机已安装字体的 family 名数组（font-list 枚举，已去引号/去重/排序） */
export const FontListSchema = z.array(STR.max(64));

export const HistoryCursorSchema = z.object({ createdAt: z.number().int(), workKey: STR.max(128) });

const HistoryFilterBaseSchema = z.object({
  platform: STR.max(40).optional(),
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  query: STR.max(200).optional(),
  cursor: HistoryCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const HistoryFilterSchema = HistoryFilterBaseSchema.refine(
  ({ from, to }) => (from === undefined) === (to === undefined),
  "Provide both history dates or neither"
);

export const HistoryPageSchema = z.object({
  rows: z.array(z.lazy(() => HistoryEntrySchema)),
  nextCursor: HistoryCursorSchema.nullable(),
});

export const HistoryKeysInputSchema = HistoryFilterBaseSchema.omit({ limit: true }).extend({
  limit: z.number().int().min(1).max(5000).optional(),
}).refine(({ from, to }) => (from === undefined) === (to === undefined), "Provide both history dates or neither");

export const HistoryKeysPageSchema = z.object({
  keys: z.array(STR.max(128)).max(5000),
  nextCursor: HistoryCursorSchema.nullable(),
});

export const HistoryRemoveResultSchema = z.object({
  removed: z.number().int().min(0),
});

/**
 * history:remove 入参 —— 行键集合（条目 id 或 groupId，store 侧双命中删整组）。
 * 键宽对齐既有口径：id/groupId 在 enqueue/队列侧都是 STR.max(64)；
 * 集合限 1–5000，与 `history:list` 的窗口上界成对（v5 把窗口从 500 提到 5000，这里跟着走，
 * 否则「全选可见行删除」撞上旧上限会被判 bad-input）；空集合拒绝 —— 「删 0 条」不是合法请求，
 * 误触也不该走到落盘写；超上限说明 UI 状态坏了，宁可 bad-input 也不整表重写。
 */
export const HistoryRemoveInputSchema = z.object({
  keys: z.array(STR.max(128)).min(1).max(5000),
});

/** 仅主进程持久化格式（SQLite `queue_tasks.payload_json` 的行内形状），入参侧复用 */
/**
 * 队列快照（队列台账的行内形状，不是任何通道的载荷）。
 *
 * v13 起「进过队列的行全部留档」：业主指令 2026-10-17——重启后队列页应当是完整台账，
 * 而不是只剩没干完的活。于是终态三件套必须跟着落盘，否则重启后的「已完成」行是坏的：
 * 缺 `filePath` 就没有「打开所在文件夹」与「复制文件路径」（那两处都按 `status === "done" && filePath` 渲染），
 * 缺 `error` 就是一条不知道为什么失败的「失败」（旧实现连原因都不写盘）。
 * `finishedAt` 落盘后，完成时刻不再只是本进程内存里的临时值。
 */
export const PersistedQueueTaskSchema = z.object({
  taskId: STR,
  groupId: STR,
  /**
   * 媒体直链。**只有还能续/重试的状态才写盘**：done 行落盘时剥成空串（直链到期后没有价值，
   * 而队列从此是长期档，把带签名的 URL 永久留在盘上违反隐私红线「队列不保留直链」）。
   */
  url: STR,
  /** DASH 音频轨（v33）：删除时机与 `url` 完全一致——done 行同样剥成空串，不把签名链留盘 */
  audioUrl: STR.optional(),
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
  /**
   * 暂停那一刻的下载速度（字节/秒）。**只有 paused 行会写这个键**（契约 v17，业主指令 2026-10-18）：
   * 它是快照而不是实时值，落盘是为了让暂停行的「速度」与「剩余」挺过重启 —— 队列从 v13 起是
   * 跨重启的台账，一重启就把暂停行说成「速度未知」等于台账缺一页。其余状态不写（实时速度不落盘）。
   */
  speed: z.number().optional(),
  /**
   * 实际传输时长（毫秒）与这段时长里收到的字节（契约 v18）。落盘是为了让暂停行、失败行
   * 在下次续传并完成后仍然算得出平均速度 —— 分母跨会话累积，暂停多久都不算进去。
   * 旧档没有这两个键 → 该行「速度」列显示「—」，不拿墙钟时间编一个数。
   */
  transferMs: z.number().optional(),
  transferBytes: z.number().optional(),
  /** 实际落地路径（含同名冲突后的最终名）；done 行的「位置」动作靠它 */
  filePath: STR.optional(),
  /** 失败原因文本；上限 300 是因为它来自上游异常，不该把任意长的报文灌进长期档 */
  error: STR.max(300).optional(),
  /** 完成时刻 */
  finishedAt: z.number().optional(),
});

// ————————————————————————————————————————————————
// 各通道出参
// ————————————————————————————————————————————————

export const OkFlagSchema = z.object({ ok: z.boolean() });

export const AppMetaSchema = z.object({
  version: STR,
  electron: STR,
  kernelMode: z.enum(["local", "mock"]),
  // v6 起不再带 `platforms`：平台清单的真源是本仓 `shared/platforms.ts`，
  // 两进程 import 同一模块即可，过 IPC 复制一张表正是这次要消灭的并行真源
});

export const IdentifyOutcomeSchema = z.object({
  platform: STR,
  platformName: STR,
  /** 提取出的链接 */
  url: STR.nullable(),
  /** 内容粗类型（链接形态推断） */
  kind: z.enum(["url", "share-text", "unknown"]),
});

/**
 * 单次引擎尝试（v32）：哪个引擎试过、成没成、失败原因是什么。
 * 「回退」只有结论、没有原因时用户无法判断该去修什么（缺 Cookie？二进制？站方改版？），
 * 所以失败引擎自己的答复要跟着结果一起回渲染层。
 */
export const ParseAttemptSchema = z
  .object({
    engine: z.enum(SWITCHABLE_ENGINE_IDS),
    ok: z.boolean(),
    /** 该引擎给出答复的业务码（不可用时为 0） */
    code: z.number(),
    /** 失败原因原文（引擎自己的 msg，已截断；成功时缺省） */
    msg: STR.max(300).optional(),
    failType: STR.optional(),
  })
  .strict();

export const ParseRunOutcomeSchema = z.object({
  result: ParseResultSchema,
  /** 结果来源（线上回落在 2026-10-18 移除，只剩本地内核与 mock 演示） */
  via: z.enum(["local", "mock"]),
  /** 实际解出这条结果的引擎（v28 注册制；v29 补登记 amagi——它在场却进不了枚举，dev 出参校验会拒掉它的答复）：统计按它对账「谁解的」；mock 兜底与缓存命中可缺省 */
  viaEngine: z.enum(["parseCore", "ytdlp", "amagi", "mock"]).optional(),
  durationMs: z.number(),
  /**
   * 这一轮按顺序真的调用过的引擎（v32）：失败在前、成功在后，各带自己的原因。
   * 缺省 = 没进选路（缓存命中 / mock 兜底 / 平台被关），界面不要凭空编造「回退」。
   */
  attempts: z.array(ParseAttemptSchema).max(8).optional(),
  /**
   * 来源链接的真实资源页（v16）：短链已跟到长链，或由作品 ID 直接拼成官方页面；
   * 跟不动/认不出时就是用户输入的那条。首页拿它写结果卡与下载 meta，主进程拿它写历史，
   * 所以三处的 `sourceUrl` 与作品键不会再各算一套。
   */
  sourceUrl: STR.max(2000).optional(),
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
  /**
   * 字节/秒。下载中是实时采样值；**paused 时是暂停那一刻的快照**（主进程不再刷新它，
   * 界面据此显示「暂停时的速度/剩余」）；done 时主进程清 0 —— 完成行的平均速度按
   * `transferBytes ÷ transferMs` 算，不占这个键。
   */
  speed: z.number(),
  /**
   * 实际传输时长（毫秒，v18）：只累计「正在收字节」的区间，暂停、排队、重试退避、
   * 连接与首字节等待都不计入。**它是完成行平均速度的分母** —— 用 `finishedAt − createdAt`
   * 会暂停一小时就把速度稀释掉，那不是一个能解释的数。
   */
  transferMs: z.number(),
  /**
   * 与 `transferMs` 同一段区间里真正收到的字节（v18）。普通下载等于 `received`；
   * 接着一个更早的半成品（换签名重新入队）继续写时小于 `received` —— 分母只覆盖了后半程，
   * 分子也必须只算后半程，否则平均速度凭空翻倍。
   */
  transferBytes: z.number(),
  /** 落地路径（done 后） */
  filePath: STR.optional(),
  error: STR.optional(),
  /**
   * 一句「这一行刚刚自己动过」的说明（v12）：目前只有 403 自动续链那一条会写。
   * 上限 200 因为它是给人看的短句而不是数据；媒体直链绝不进这里（隐私红线）。
   */
  note: STR.max(200).optional(),
  platform: STR.optional(),
  title: STR.optional(),
  /** 用户输入的分享链接（透传给历史，非直链） */
  sourceUrl: STR.optional(),
  author: AuthorSnapshotSchema.optional(),
  createdAt: z.number(),
  /**
   * 完成时刻。v13 起随队列快照落盘（业主定「进过队列的行全部留档」），
   * 所以它跨重启有效；旧档没这个键 → 重启后完成列留空，不编一个假时刻。
   */
  finishedAt: z.number().optional(),
});

/**
 * download:list 的筛选（契约 v22，统一 SQLite 存储）。
 *
 * 分页单位是**作品组**而不是单条任务：一行的聚合（大小/速度/剩余/时间）必须由整组算出，
 * 组被页边界切开就会显示一个假的半截数。游标里的 `createdAt` 是该组最新的 `createdAt`，
 * `taskId` 是该组内最大的任务 id（稳定代表），排序与游标都按这两键：
 * `createdAt DESC, taskId DESC`。组内全部任务随组返回，界面无需再补请求。
 */
export const QueueStatusFilterSchema = z.enum(["active", "done", "error", "canceled"]);

export const QueueCursorSchema = z.object({
  createdAt: z.number().int(),
  taskId: STR.max(128),
});

const QueueFilterBaseSchema = z.object({
  status: QueueStatusFilterSchema.optional(),
  platform: STR.max(40).optional(),
  query: STR.max(200).optional(),
  /** 创建时间本地日区间（含首尾两天），与历史页同口径 */
  from: DateKeySchema.optional(),
  to: DateKeySchema.optional(),
  cursor: QueueCursorSchema.optional(),
  /** 每组最多返回的任务组数 */
  limit: z.number().int().min(1).max(100).optional(),
});
export const QueueFilterSchema = QueueFilterBaseSchema.refine(
  ({ from, to }) => (from === undefined) === (to === undefined),
  "Provide both queue dates or neither"
);

export const QueuePageSchema = z.object({
  rows: z.array(DownloadTaskViewSchema),
  nextCursor: QueueCursorSchema.nullable(),
});

/**
 * download:clear 入参：点名要移出行列的任务 id。
 * 上限 500 与队列条数上限同量级 —— 一次「清理」最多吃掉整条队列，再多就是异常输入。
 */
export const ClearTasksInputSchema = z.object({
  taskIds: z.array(STR.min(1)).min(1).max(500),
});

/**
 * download:clear 出参：真正被移除的条数。
 * 进行中/排队中的任务由主进程拒绝删除、不计入 removed —— UI 据此如实播报「移除了几条」，
 * 而不是假设点名的都成功了。
 */
export const ClearTasksResultSchema = z.object({ removed: z.number().int().min(0) });

/**
 * history:list 项 —— 一条**解析记录**（业主指令 2026-10-17：历史页不是下载台账）。
 *
 * 写入方有两个，都在主进程：`parse:run` 成功时写一条（`files` 为空），下载落地时每个文件追加一条。
 * 两侧从同一条分享链接算出同一个 `groupId`（`shared/history.ts` 的 workKeyOf），
 * 历史页按它聚合，所以「解析过又下载了的作品」在界面上是一行而不是两行。
 */
export const HistoryEntrySchema = z.object({
  id: STR,
  /** 作品键（解析行与它的下载行共用）；图集等成组下载也共用同一行 */
  groupId: STR.optional(),
  platform: STR.optional(),
  title: STR.optional(),
  /** 媒体类型（视频/图集/音频/文件）：只有落地过的行有值，解析行留空由下载行补上 */
  kind: STR.optional(),
  /** 文件字节数（done 时的 received）；解析行为空 */
  bytes: z.number().optional(),
  /** 落地文件路径列表；**空数组 = 只解析没下载** */
  files: z.array(STR),
  /** 分享来源链接（用户自己的输入，非直链） */
  sourceUrl: STR.optional(),
  /** 解析那一刻的作者快照（本版本之前的老记录无此键） */
  author: AuthorSnapshotSchema.optional(),
  /**
   * 作品在平台上的**发布**时刻（本地毫秒）。与 `createdAt`（本机解析/落地那刻）是两回事，
   * 两个都要：今天解析一条三年前的视频，界面上那行的顺序按解析时刻排，导出里要知道作品什么时候发的。
   * 老记录无此键，各平台也不都给 —— 缺就是缺，导出留空而不是拿 `createdAt` 冒充。
   */
  publishedAt: z.number().optional(),
  /** 解析那一刻的公开互动数快照（业主指令 2026-10-17：导出要带完整作品信息） */
  stat: WorkStatSchema.optional(),
  createdAt: z.number(),
});

/** probe:engines —— 本地版体检 */
export const EngineHealthSchema = z.object({
  platform: STR,
  name: STR,
  ok: z.boolean(),
  /** 实际可解该平台的引擎名（选路顺序；空 = 今天没有引擎声明可解） */
  engines: z.array(STR),
  /**
   * 与 `engines` 一一对应的引擎 id（v31）：平台表的「通道」下拉用它做选项值与提交值。
   * 显示名留给人看、id 留给机器判——别让渲染层拿 label 反查 id。
   */
  engineIds: z.array(z.enum(SWITCHABLE_ENGINE_IDS)),
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
  /**
   * 本运行环境有无更新源（`app.isPackaged` 且挂上 electron-updater）。
   * 它管无源时「检查更新」怎么应答（点击以 toast 说明环境），不管按钮存在性——按钮常驻（业主指令 2026-10-17）。
   */
  canCheck: z.boolean(),
});

/** 目录选择器结果：null = 用户取消 */
export const PickDirResultSchema = z.union([STR, z.null()]);

/** app:showInFolder 入参：本机绝对路径（renderer 不可信输入，长度封顶即可） */
export const FolderPathSchema = z.string().max(1000);

/**
 * 外链输入：只放行 http/https（openExternal 是提权动作，其他协议一律拒）。
 * 包一层 object：`z.string().refine()` 的类型仍是 string，主进程取不到 .url。
 */
export const UrlInputSchema = z.object({
  url: z
    .string()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "只支持 http/https 链接"),
});

/**
 * app:copyText 入参。上限 200_000 字符：复制正文最长的是历史页「作品信息」（十几行，含
 * 图集文件名与落地目录），量级在千以内，这里给的是两百倍余量 —— 封顶只是防 renderer 被
 * 攻破后拿这条通道往剪贴板灌巨串，不是为了校验业务长度。空串直接拒：点了复制却复制不到
 * 东西，界面无从表达。
 */
export const CopyTextInputSchema = z.object({
  text: STR.min(1).max(200_000),
});

/**
 * app:readClipboard 出参。上限与 `IdentifyInputSchema` / `ParseInputSchema` 对齐（4000）：
 * 粘贴是为了「填进输入面接着识别与解析」，超出解析入参上限的部分粘过来也用不上，
 * 而主进程先截断，比让渲染层粘进一整篇富文本再被 `parse` 拒一次更干净。
 */
export const ReadClipboardOutputSchema = z.object({
  text: STR.max(4000),
});

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
// stats:get —— 事件账本按日期范围聚合（SQLite stats_events）
//
// 隐私红线在这一节最硬：这里**只有计数、字节与时长**，没有 url、没有文件名、
// 没有 Cookie。事件账本只留平台键与作品键，解析历史/下载历史各自另有真源。
// 失败与解析走这里而不是塞进 history：历史是「解析过的作品」，给它加 status 会让
// 历史页冒出没有文件的行、清历史连带把统计抹掉。
// ————————————————————————————————————————————————

const COUNT = z.number().int().min(0);

export const StatsDateRangeSchema = z.object({
  from: DateKeySchema,
  to: DateKeySchema,
}).refine(({ from, to }) => from <= to, "Start date must not be after end date");

const StatsCountSchema = z.object({
  downloads: COUNT,
  failures: COUNT,
  canceled: COUNT,
  bytes: COUNT,
  parses: COUNT,
  parseFailures: COUNT,
});

export const StatsQueryResultSchema = z.object({
  range: StatsDateRangeSchema,
  availableFrom: DateKeySchema.nullable(),
  totals: z.object({
    downloads: COUNT,
    failures: COUNT,
    canceled: COUNT,
    bytes: COUNT,
    elapsedMs: COUNT,
    elapsedCount: COUNT,
    elapsedBytes: COUNT,
    parses: COUNT,
    parseFailures: COUNT,
  }),
  byDay: z.record(DateKeySchema, StatsCountSchema),
  byPlatform: z.record(STR.max(40), z.object({
    downloads: COUNT,
    failures: COUNT,
    bytes: COUNT,
    parses: COUNT,
    parseFailures: COUNT,
  })),
  byKind: z.record(STR.max(20), z.object({ downloads: COUNT, bytes: COUNT })),
  authors: z.array(z.object({
    name: STR.max(100),
    /** 作者头像（取该作者范围内最新一条历史行的快照）；老记录与匿名行为缺省 */
    avatar: STR.max(2000).optional(),
    parsedWorks: COUNT,
    downloadedFiles: COUNT,
    downloadedBytes: COUNT,
  })),
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
  [IPC.downloadList]: invoke(QueueFilterSchema.optional(), QueuePageSchema),
  [IPC.downloadClear]: invoke(ClearTasksInputSchema, ClearTasksResultSchema),
  [IPC.settingsGet]: invoke(null, AppSettingsSchema),
  [IPC.settingsSet]: invoke(SettingsPatchSchema, AppSettingsSchema),
  [IPC.settingsCookieLogin]: invoke(CookieLoginInputSchema, CookieLoginResultSchema),
  [IPC.historyList]: invoke(HistoryFilterSchema.optional(), HistoryPageSchema),
  [IPC.historyKeys]: invoke(HistoryKeysInputSchema, HistoryKeysPageSchema),
  [IPC.historyRemove]: invoke(HistoryRemoveInputSchema, HistoryRemoveResultSchema),
  [IPC.probeEngines]: invoke(null, z.array(EngineHealthSchema)),
  [IPC.appGetBinaryStatus]: invoke(null, BinaryStatusReportSchema),
  [IPC.appPickDownloadDir]: invoke(null, PickDirResultSchema),
  [IPC.appShowInFolder]: invoke(FolderPathSchema, OkFlagSchema),
  [IPC.appListFonts]: invoke(null, FontListSchema),
  [IPC.appCacheStatus]: invoke(null, CacheStatusSchema),
  [IPC.appCacheClear]: invoke(CacheClearInputSchema, CacheClearResultSchema),
  [IPC.appOpenLogDir]: invoke(null, OkFlagSchema),
  [IPC.appLog]: invoke(LogWriteInputSchema, OkFlagSchema),
  [IPC.appOpenExternal]: invoke(UrlInputSchema, OkFlagSchema),
  [IPC.appCopyText]: invoke(CopyTextInputSchema, OkFlagSchema),
  [IPC.appReadClipboard]: invoke(null, ReadClipboardOutputSchema),
  [IPC.statsGet]: invoke(StatsDateRangeSchema, StatsQueryResultSchema),
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
