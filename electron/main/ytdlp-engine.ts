/**
 * yt-dlp 引擎（2026-10-21，第三个解析引擎）：`ytdlp-nodejs` 的 ParseEngine 封装。
 *
 * 职责边界（与 parse-core 的分工）：
 * - 取代原先埋在 parse-core 内部、只服务 tiktok 的原生 dlp 通道——那条路仍然在
 *   （parse-core 的 ytDlpClient 共用同一枚随包二进制），但 tiktok 解析失败时现在
 *   真有一个独立引擎接得住，注册表的 `ytdlp` 能力位从 `declared` 升成 `ready`；
 * - 自报覆盖 `YTDLP_PLATFORMS`（yt-dlp 上游提取器真实支持的四家），生效面由注册表
 *   的 ready 位收窄——今天是 tiktok 与 youtube（2026-10-21 YouTube 升 ready，
 *   并声明 `defaultPrimaryEngine: "ytdlp"`，因为内核那条要 YouTube API Key）；
 *   twitter/instagram 升 ready 时同样不用改本文件；
 * - 二进制全部来自 `resources.locate("yt-dlp")` 链路（用户自配 > 随包 SHA-256 校验后
 *   释放），**绝不用 ytdlp-nodejs 的 postinstall 自下载**（pnpm 已拦下该脚本）：那会
 *   绕开 binaries.json 的完整性基线，违反零敏感资产入包的供应链纪律；
 * - 结果一律先映射进 `ParseData` 契约形状再出门，取值全部走防御性 picker——
 *   yt-dlp 的 JSON 是上游提取器的活水，字段随时增删，异形必须给 `ok: false`
 *   而不是把脏形状递进管线。
 *
 * 主直链只挑**渐进式**（视频+音频同文件）：契约的 `url` 会被渲染层直接转交下载，
 * video-only 流没有 ffmpeg 合并就是半截文件——与内核 TikTok 链路「渐进式 mp4 单文件」
 * 同一条哲学。video-only 全量进 `qualities` 供展示，audio-only 最优一档进 `audioUrl`。
 */
import { YtDlp } from "ytdlp-nodejs";
import { ENGINE_INFO, engineCoverage, resolveKey } from "../../shared/platforms";
import type { ParseData, ParseResult, ParsedVideoQuality } from "../../types/ipc";
import { coveredBy, type EngineOutcome, type EngineRequest, type ParseEngine } from "./engines";
import type { CookieFileHandle } from "./ytdlp-cookie-file";

export const YTDLP_ENGINE_ID = "ytdlp" as const;

/** 本引擎自报覆盖的契约键（yt-dlp 提取器真实支持；生效面由注册表 ready 位收窄） */
export const YTDLP_PLATFORMS: readonly string[] = ["tiktok", "youtube", "twitter", "instagram"];

/** getInfoAsync 超时（kernel.YTDLP_TIMEOUT_MS 未配置时的缺省） */
const DEFAULT_TIMEOUT_MS = 30_000;

// ————————————————————————————————————————————————
// 客户端切面：只用 getInfoAsync 一个方法
// ————————————————————————————————————————————————

/**
 * 本引擎实际触达的 ytdlp-nodejs 切面。结构化类型：测试注入假客户端不必背真包类型树。
 *
 * ⚠️ `cookies` 是**cookiefile 路径**，不是 Cookie 头串：库的注释写「a string of cookies」，
 * 但它拼参数时是 `push("--cookies", 值)`，而 yt-dlp 的 `--cookies` 只收文件。
 * 传头串的后果是静默降级回匿名请求（YouTube 照样 "Sign in to confirm"）——
 * 所以引擎这一层要先经 `prepareCookieFile` 落一份临时 Netscape 文件。
 */
export interface YtdlpInfoClient {
  getInfoAsync(url: string, options?: { flatPlaylist?: boolean; cookies?: string }): Promise<unknown>;
}

export interface YtdlpClientOpts {
  binaryPath?: string;
  ffmpegPath?: string;
}

export type YtdlpClientFactory = (opts: YtdlpClientOpts) => YtdlpInfoClient;

export interface YtdlpEngineDeps {
  /**
   * yt-dlp 二进制路径（每次 run/covers 现读）：用户自配（kernel.YTDLP_BIN）>
   * 随包释放（resources.locate 已验 SHA-256）。返回 undefined = 二进制不可用，
   * 本引擎自报「今天解不了」——注册表能力位不因此说谎。
   */
  getBinaryPath?: () => string | undefined;
  /** ffmpeg 路径（可选；渐进式直链不需要，留给上游扩展） */
  getFfmpegPath?: () => string | undefined;
  /** getInfoAsync 超时毫秒（缺省 30s） */
  getTimeoutMs?: () => number;
  /**
   * 该平台用户自配的 Cookie（`settings.cookies` 里按注册表 `cookieKey` 取，每次解析现读）。
   * 返回空串/undefined = 不传，走匿名路径——YouTube 的年龄限制与登录墙内容才需要它。
   */
  getCookie?: (platform: string) => string | undefined;
  /**
   * 把 Cookie 头串落成 yt-dlp 能吃的 cookiefile（见 `ytdlp-cookie-file.ts`）。
   * 返回 null = 这份输入表示不成 cookiefile，按「没配」处理。
   * 缺省不落文件：只有主进程注入了 temp 目录才知道往哪写；测试走注入的假句柄。
   */
  prepareCookieFile?: (platform: string, cookieHeader: string) => Promise<CookieFileHandle | null>;
  /** 客户端工厂覆盖（测试注入离线桩；缺省 = 真 `YtDlp`，测试里绝不允许真跑） */
  makeClient?: YtdlpClientFactory;
}

// ————————————————————————————————————————————————
// 防御性取值（与 amagi-engine 同一套纪律，本地最小复刻）
// ————————————————————————————————————————————————

type Unknown = Record<string, unknown>;

const asObj = (v: unknown): Unknown | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Unknown) : null;

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const isHttpUrl = (v: unknown): v is string =>
  typeof v === "string" && /^https?:\/\//i.test(v);

// ————————————————————————————————————————————————
// VideoInfo → ParseData
// ————————————————————————————————————————————————

const vcodecOf = (f: Unknown): string | undefined => str(f["vcodec"]);
const acodecOf = (f: Unknown): string | undefined => str(f["acodec"]);
const heightOf = (f: Unknown): number => num(f["height"]) ?? 0;

function formatUrl(f: Unknown): string | undefined {
  const u = f["url"];
  return isHttpUrl(u) ? u : undefined;
}

/**
 * 轨道 → MSE 的容器族（契约 v35）。只认 mp4 / webm 两族：
 * yt-dlp 的 `ext` 对纯音频是 m4a/webm、对视频是 mp4/webm；flv/3gp 之类不写，
 * 预览据此退回主进程合流，不会拿一个建不出的 MIME 去试。
 */
function mseMimeOf(f: Unknown, kind: "video" | "audio"): string | undefined {
  const ext = (str(f["ext"]) ?? "").toLowerCase();
  if (ext === "mp4" || ext === "m4v" || ext === "m4a") return `${kind}/mp4`;
  if (ext === "webm") return `${kind}/webm`;
  return undefined;
}

/** 单轨的 codec 元数据；合流档（自带音轨）不给，免得 MSE 把混流塞进 video-only 缓冲 */
function separatedVideoMeta(f: Unknown): { codecs?: string; mimeType?: string } {
  const acodec = acodecOf(f);
  if (acodec !== undefined && acodec !== "none") return {};
  const codecs = vcodecOf(f);
  const mimeType = mseMimeOf(f, "video");
  return codecs && codecs !== "none" && mimeType ? { codecs, mimeType } : {};
}

function audioMeta(f: Unknown): { codecs?: string; mimeType?: string } {
  const codecs = acodecOf(f);
  const mimeType = mseMimeOf(f, "audio");
  return codecs && codecs !== "none" && mimeType ? { codecs, mimeType } : {};
}

/**
 * 一档的显示名：有分辨率就写分辨率。
 *
 * 分辨率缺失时退 `format_note`——YouTube 的 m3u8/合流档会在这里给 `default`/`medium`
 * 这类**本来就说不清清晰度**的词，所以旧版界面上会冒出一个叫「默认」的档位。
 * 现在这种档只在确实没有分辨率时才会带上这个名字，而且主直链那一档还会另写 qualityLabel。
 */
function labelOf(f: Unknown): string {
  const height = heightOf(f);
  if (height) return `${height}P`;
  return str(f["format_note"]) ?? str(f["ext"]) ?? "video";
}

/**
 * 频道头像。
 *
 * YouTube 的头像不在顶层字段里，而是混在 `thumbnails[]` 中、id 为 `avatar_uncropped`
 * 那一条（与视频缩略图 `hqdefault` 之类并列）。取不到就当没有：`AuthorAvatar` 有首字占位，
 * 拿视频封面冒充头像比缺一格更糟。
 */
function avatarUrlOf(info: Unknown): string | undefined {
  const top = str(info["channel_thumbnail"]) ?? str(info["uploader_thumbnail"]);
  if (isHttpUrl(top)) return top;
  const thumbs = asArr(info["thumbnails"])
    .map(asObj)
    .filter((t): t is Unknown => t !== null);
  const named = (id: string) => thumbs.find((t) => str(t["id"]) === id);
  const avatar = named("avatar_uncropped") ?? thumbs.find((t) => (str(t["id"]) ?? "").includes("avatar"));
  const url = avatar ? str(avatar["url"]) : undefined;
  return isHttpUrl(url) ? url : undefined;
}

/** 视频画面的可用直链集合（DRM 档剔除——能解出来也下不动，不冒充能力） */
function videoFormats(formats: Unknown[]): Unknown[] {
  return formats
    .filter((f) => vcodecOf(f) !== undefined && vcodecOf(f) !== "none" && formatUrl(f))
    .filter((f) => f["has_drm"] !== true);
}

function mapVideoInfo(info: Unknown): ParseData | null {
  const formats = asArr(info["formats"]).map(asObj).filter((f): f is Unknown => f !== null);
  const videos = videoFormats(formats).sort((a, b) => heightOf(b) - heightOf(a));

  const qualities: ParsedVideoQuality[] = videos.map((f) => {
    const height = heightOf(f);
    return {
      quality: height || num(f["tbr"]) || 0,
      label: labelOf(f),
      url: formatUrl(f) as string,
      ...separatedVideoMeta(f),
    };
  });

  // 主直链：渐进式（含音频）优先，取清晰度最高的一档；没有渐进式才退 video-only
  const progressive = videos.filter((f) => acodecOf(f) !== undefined && acodecOf(f) !== "none");
  const mainFormat = progressive[0] ?? videos[0];
  const mainUrl = formatUrl(mainFormat ?? {}) ?? formatUrl(videos[0] ?? {});
  const mainMeta = mainFormat ? separatedVideoMeta(mainFormat) : {};

  // 音频最优一档（audio-only，按 abr/tbr 降序）
  const audioFormat = formats
    .filter((f) => acodecOf(f) !== undefined && acodecOf(f) !== "none" && (vcodecOf(f) === "none" || !vcodecOf(f)))
    .sort((a, b) => (num(b["abr"]) ?? num(b["tbr"]) ?? 0) - (num(a["abr"]) ?? num(a["tbr"]) ?? 0))[0];
  const audioUrl = audioFormat ? formatUrl(audioFormat) : undefined;
  const audio = audioFormat ? audioMeta(audioFormat) : {};

  // 契约硬口径：duration 是**毫秒**（yt-dlp 给秒）
  const durationSec = num(info["duration"]);
  const cover = str(info["thumbnail"]);

  const data: ParseData = {
    title: str(info["title"]),
    desc: str(info["description"]),
    type: "video",
    duration: durationSec !== undefined ? Math.round(durationSec * 1000) : undefined,
    author: str(info["uploader"]) ?? str(info["channel"]),
    authorId: str(info["uploader_id"]) ?? str(info["channel_id"]),
    authorUrl: str(info["uploader_url"]) ?? str(info["channel_url"]),
    /** 频道头像：见 `avatarUrlOf`（`thumbnails[]` 里 id 为 `avatar_uncropped` 那条） */
    avatar: avatarUrlOf(info),
    /**
     * YouTube 频道订阅数（作者卡片那三档之一）。契约里这个键本来就是给 YT 留的
     * （`subscriberCount`，与 B站 `followerCount` 同义）；yt-dlp 只有在拿到频道信息时
     * 才给 `channel_follower_count`，缺了就是 undefined——界面上少一档，不拿 0 冒充。
     */
    subscriberCount: num(info["channel_follower_count"]),
    cover,
    url: mainUrl,
    audioUrl,
    videoCodecs: mainMeta.codecs,
    videoMimeType: mainMeta.mimeType,
    audioCodecs: audio.codecs,
    audioMimeType: audio.mimeType,
    videoId: str(info["id"]),
    /**
     * 主直链自己的档位名。`data.url` 是渐进式那一档，分辨率通常比最高档低；
     * 选择器用它给「主链」命名，免得出现一个说不清是什么清晰度的「默认」项。
     * 只在真拿到分辨率时才写：拿 `format_note` 顶上会写出一个叫 `default` 的档。
     */
    qualityLabel: mainFormat && heightOf(mainFormat) > 0 ? labelOf(mainFormat) : undefined,
    qualities: qualities.length > 0 ? qualities : undefined,
    stat: {
      view: num(info["view_count"]),
      like: num(info["like_count"]),
      reply: num(info["comment_count"]),
    },
    // 诊断标记（契约 source 键：内核解析器同样用标来源）
    source: "yt-dlp",
  };
  return mainUrl ? data : null;
}

// ————————————————————————————————————————————————
// 失败归因（failType 沿用内核语义）
// ————————————————————————————————————————————————

function mapYtdlpFailure(raw: unknown, platform: string): ParseResult {
  const msg = (raw instanceof Error ? raw.message : String(raw)).slice(0, 300);
  const m = msg.toLowerCase();
  if (/超时|timed? ?out/.test(m)) {
    return { code: 502, msg: `yt-dlp：${msg}`, platform, failType: "sources-down" };
  }
  if (/sign in|log ?in|cookie|age.?restrict|confirm you|membership|premium/.test(m)) {
    return { code: 403, msg: `yt-dlp：${msg}`, platform, failType: "bot-gated" };
  }
  if (/unavailable|not exist|removed|deleted|private|404|not found/.test(m)) {
    return { code: 404, msg: `yt-dlp：${msg}`, platform, failType: "source-unavailable" };
  }
  if (/unsupported url/.test(m)) {
    return { code: 400, msg: `yt-dlp：${msg}`, platform, failType: "script-error" };
  }
  return { code: 500, msg: `yt-dlp：${msg}`, platform, failType: "script-error" };
}

/** 竞速超时：超时后子进程随 yt-dlp 自身退出，这里只保证调用方不被挂死 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`yt-dlp 超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ————————————————————————————————————————————————
// 频道页 → 作者卡片补全
// ————————————————————————————————————————————————

/**
 * 视频 JSON 里只有「谁的视频」，没有「这个人是谁」：频道简介、头像、粉丝总量都在**频道页**上。
 * 想按 B站/抖音作者卡片的宽度展示，就得再解析一次频道 URL（`--flat-playlist`，只拿元数据，
 * 不展开视频列表）。这次补全是**尽力而为**：失败、超时、撞风控一律静默，绝不让它影响解析结果。
 */
export interface ChannelProfile {
  /** 频道简介（截到 AuthorSnapshot.sign 的 500 上限） */
  sign?: string;
  avatar?: string;
  followerCount?: number;
}

/** 补全请求超时：比主解析短——它是锦上添花，拖不起解析时长 */
const PROFILE_TIMEOUT_MS = 8_000;
/** 同一频道 10 分钟内只问一次（连续解析同一个 UP 的多个视频很常见） */
const PROFILE_TTL_MS = 10 * 60_000;

function readChannelProfile(info: Unknown | null): ChannelProfile | null {
  if (!info) return null;
  // 只认频道页那种形状：视频 JSON 也有 description 与 thumbnails，拿它当频道简介就串味了
  const isChannel = info["_type"] === "playlist" || Array.isArray(info["entries"]);
  if (!isChannel) return null;
  const sign = str(info["description"])?.slice(0, 500);
  const profile: ChannelProfile = {
    sign,
    avatar: avatarUrlOf(info),
    followerCount: num(info["channel_follower_count"]),
  };
  return profile.sign || profile.avatar || profile.followerCount !== undefined ? profile : null;
}

// ————————————————————————————————————————————————
// 引擎装配
// ————————————————————————————————————————————————

export function createYtdlpEngine(deps: YtdlpEngineDeps): ParseEngine {
  const getBinaryPath = deps.getBinaryPath ?? (() => undefined);
  const getFfmpegPath = deps.getFfmpegPath ?? (() => undefined);
  const getCookie = deps.getCookie ?? (() => undefined);
  const timeoutMs = () => {
    const n = deps.getTimeoutMs?.() ?? DEFAULT_TIMEOUT_MS;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  };
  const makeClient: YtdlpClientFactory =
    deps.makeClient ?? ((opts) => new YtDlp(opts) as unknown as YtdlpInfoClient);

  // 二进制路径基本不变（用户自配/随包释放），按路径缓存客户端，构造/进程探活不重复付
  let cached: { binary: string; client: YtdlpInfoClient } | null = null;
  const clientFor = (binary: string): YtdlpInfoClient => {
    if (cached?.binary === binary) return cached.client;
    const client = makeClient({ binaryPath: binary, ffmpegPath: getFfmpegPath() });
    cached = { binary, client };
    return client;
  };

  /** 频道简介缓存（进程内，TTL 10 分钟）：同一个 UP 的连续解析不重复付费 */
  const profiles = new Map<string, { at: number; profile: ChannelProfile | null }>();

  /**
   * 取频道页的作者信息。失败一律 null（解析结果照常返回），原因见 `ChannelProfile` 上方：
   * 这是补全，不是前置条件。
   */
  async function channelProfileOf(
    binary: string,
    channelUrl: string,
    cookiePath?: string
  ): Promise<ChannelProfile | null> {
    const hit = profiles.get(channelUrl);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    try {
      const client = clientFor(binary);
      const options = cookiePath ? { flatPlaylist: true, cookies: cookiePath } : { flatPlaylist: true };
      const raw = await withTimeout(client.getInfoAsync(channelUrl, options), PROFILE_TIMEOUT_MS);
      const profile = readChannelProfile(asObj(raw));
      profiles.set(channelUrl, { at: Date.now(), profile });
      return profile;
    } catch {
      // 不缓存失败：撞风控往往是临时的，缓存下来会让同一个 UP 十分钟内都补不上
      return null;
    }
  }

  /**
   * 把频道页那几档并进结果：只补空位，视频 JSON 里已经有的值优先。
   *
   * 只给 YouTube 做：它的频道页是一份稳定的 playlist 元数据；tiktok 之类的「作者主页」
   * 在 yt-dlp 里没有这层约定，多打一次只会白等一轮超时。
   */
  async function enrichAuthor(
    data: ParseData,
    info: Unknown,
    platform: string,
    binary: string,
    cookiePath?: string
  ): Promise<void> {
    if (resolveKey(platform) !== "youtube") return;
    const channelUrl = str(info["uploader_url"]) ?? str(info["channel_url"]);
    if (!channelUrl || !isHttpUrl(channelUrl)) return;
    // 只说「同一个作者」的话，频道页与视频页给的 URL 会差一个结尾斜杠，缓存键归一一下
    const profile = await channelProfileOf(binary, channelUrl.replace(/\/+$/, ""), cookiePath);
    if (!profile) return;
    data.sign ??= profile.sign;
    data.avatar ??= profile.avatar;
    data.subscriberCount ??= profile.followerCount;
  }

  return {
    id: YTDLP_ENGINE_ID,
    label: ENGINE_INFO.ytdlp.label,

    /** 注册表 ready 位 ∧ 自报覆盖 ∧ 二进制在场——缺二进制时如实说「今天解不了」 */
    async covers(platform: string): Promise<boolean> {
      if (!getBinaryPath()) return false;
      return coveredBy(platform, YTDLP_ENGINE_ID, () =>
        Promise.resolve(new Set(YTDLP_PLATFORMS.map(resolveKey))),
      );
    },

    async run({ platform, url }: EngineRequest): Promise<EngineOutcome> {
      // 失败答复统一走 ok:false + reason（选路器靠 reason 决定「可换下一个引擎」），result 是给用户的最终答复
      const bad = (reason: string, result: ParseResult): EngineOutcome => ({ ok: false, reason, result });
      const notReady = (reason: string): EngineOutcome =>
        bad(reason, {
          code: 500,
          msg: "yt-dlp 二进制不可用（设置 kernel.YTDLP_BIN 或重跑 pnpm fetch:binaries）",
          platform,
          failType: "script-error",
        });

      if (!url) {
        return bad("id-unsupported", {
          code: 400,
          msg: "yt-dlp 只支持分享链接解析，不支持平台 + ID",
          platform,
          failType: "script-error",
        });
      }
      const binary = getBinaryPath();
      if (!binary) return notReady("binary-missing");

      let cookieFile: CookieFileHandle | null = null;
      try {
        // Cookie 只在这一层过一遍：落成临时 cookiefile（用完即删）。值不进日志：错误原文里
        // 本来就没有它（递过去的是路径不是头串），也不主动打——日志一旦被贴出来就是凭据副本。
        // 落不成文件就按「没配」走匿名，别拿头串去喂 --cookies。
        const cookie = getCookie(platform)?.trim();
        if (cookie) cookieFile = (await deps.prepareCookieFile?.(platform, cookie)) ?? null;
        const client = clientFor(binary);
        const raw = await withTimeout(
          cookieFile ? client.getInfoAsync(url, { cookies: cookieFile.path }) : client.getInfoAsync(url),
          timeoutMs()
        );
        const info = asObj(raw);
        if (!info) {
          return bad("not-json", {
            code: 500,
            msg: "yt-dlp：输出不是 JSON 对象",
            platform,
            failType: "script-error",
          });
        }

        // 播放列表（flat 模式条目缺 formats）：取第一条；没有条目就如实失败
        let target = info;
        if (info["_type"] === "playlist" || Array.isArray(info["entries"])) {
          const first = asObj(asArr(info["entries"])[0]);
          if (!first) {
            return bad("empty-playlist", {
              code: 404,
              msg: "yt-dlp：播放列表没有可解析的条目",
              platform,
              failType: "source-unavailable",
            });
          }
          target = first;
        }

        const data = mapVideoInfo(target);
        if (!data) {
          return bad("no-media", {
            code: 404,
            msg: "yt-dlp：未取得可用的媒体直链（可能需要登录或平台已改版）",
            platform,
            failType: "source-unavailable",
          });
        }
        // 作者卡片补全：视频 JSON 只有「谁的视频」，简介/头像在频道页上（见 `ChannelProfile`）。
        // 排在结果成型之后：这一步失败也照样把已经拿到的东西交出去。
        await enrichAuthor(data, target, platform, binary, cookieFile?.path);
        return { ok: true, result: { code: 200, msg: "解析成功（yt-dlp）", platform, data } };
      } catch (e) {
        return bad("exception", mapYtdlpFailure(e, platform));
      } finally {
        // 临时 cookiefile 不留在盘上：成功、失败、超时三条路都走这里
        if (cookieFile) await cookieFile.cleanup();
      }
    },
  };
}

/** 引擎对某平台是否真的有能力（注册表 ready 位 ∧ 自报覆盖；covers 的纯逻辑面，测试用） */
export function ytdlpClaims(platform: string): boolean {
  return (
    engineCoverage(resolveKey(platform), YTDLP_ENGINE_ID) === "ready" &&
    YTDLP_PLATFORMS.includes(resolveKey(platform))
  );
}
