/**
 * amagi 引擎（2026-10-21，第二个解析引擎）：`@ikenxuan/amagi` v7 SDK 的 ParseEngine 封装。
 *
 * 职责边界（与 parse-core 的分工）：
 * - parse-core 是主引擎（引擎注册表全局顺序第一），amagi 作回退——parse-core 自报
 *   `ok: false` 的平台交到这里再试一遍，提高成功率；
 * - 本引擎只覆盖注册表里标了 `amagi: "ready"` 的四家：douyin / bilibili / kuaishou / redbook；
 * - Cookie 全部来自用户自配（settings.cookies），不打包任何站点资产（隐私红线 §零敏感资产入包）；
 * - 结果一律先映射进 `ParseData` 契约形状再出门，取值全部走防御性 picker——
 *   amagi 的响应类型是「实测快照 + 全层索引签名」，未声明字段读出来是 unknown，
 *   平台改版时本引擎必须给 `ok: false` 而不是把脏形状递进管线。
 *
 * 短链（v.douyin.com / b23.tv / v.kuaishou.com / xhslink）：展开一次 30x 重定向拿真实链接再抽 ID。
 * 客户端按次创建（Cookie 是设置页实时值），构造很轻，不值得为了省一次 new 做缓存失效。
 */
import amagi from "@ikenxuan/amagi";
import { ENGINE_INFO, type EngineId } from "../../shared/platforms";
import type { ParseData, ParseResult, ParsedVideoQuality } from "../../types/ipc";
import type { EngineOutcome, EngineRequest, ParseEngine } from "./engines";

// ————————————————————————————————————————————————
// amagi 信封（按 contracts：success 唯一判别；失败分支只有 error）
// ————————————————————————————————————————————————

/**
 * 上游失败信封的 `error`（`@ikenxuan/amagi` 的 `AmagiError`，2026-10-21 按 d.ts 对齐）：
 * - `kind` 是跨平台大类，`code` 才是稳定的细码（LOGIN_REQUIRED / NOT_FOUND / …）；
 * - `message` 取平台原文优先，`platform.code` 是平台自己的数字码（如 B 站 -101）；
 * - `http.status` 有请求才有。三者都要进「失败原因」，只报 kind 等于把答案丢了。
 */
interface AmagiErrorShape {
  kind?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  platform?: { code?: string | number; message?: string };
  http?: { status?: number; statusText?: string };
}

interface AmagiEnvelope<T = unknown> {
  success?: boolean;
  data?: T;
  error?: AmagiErrorShape;
  message?: string;
}

/**
 * 本引擎实际触达的 amagi 客户端切面——只用这五个方法。
 * 结构化类型（而不是 `ReturnType<typeof amagi>`）：测试注入假客户端时不必背真包的完整类型树。
 */
export interface AmagiFetchers {
  douyin: { parseWork(req: { aweme_id: string }): Promise<unknown> };
  bilibili: {
    fetchVideoInfo(req: { bvid: string }): Promise<unknown>;
    fetchVideoStreamUrl(req: { avid: number; cid: number }): Promise<unknown>;
    /** av↔bv 本地换算（amagi 侧 zero-network compute），av 号链接靠它进 BV 通道 */
    convertAvToBv(req: { avid: number }): Promise<unknown>;
    /**
     * UP 主名片（2026-10-21）：稿件详情的 `owner` 只有昵称/头像/签名，
     * 粉丝、关注、投稿数、获赞只在名片里（`card.fans` / `card.attention` / `archive_count`）。
     */
    fetchUserCard(req: { host_mid: number }): Promise<unknown>;
  };
  kuaishou: { fetchVideoWork(req: { photoId: string }): Promise<unknown> };
  xiaohongshu: { fetchNoteDetail(req: { note_id: string; xsec_token?: string }): Promise<unknown> };
}

/** 请求级配置（v28 补齐：设置页代理透传；其余留给上游扩展） */
export interface AmagiRequestConfig {
  proxy?: { host: string; port: number };
}

export type AmagiClientFactory = (
  cookies: Record<string, string>,
  requestConfig?: AmagiRequestConfig
) => AmagiFetchers;

/** 引擎需要的用户配置（Cookie 档位键 = shared/cookie-login.ts 的四家） */
export interface AmagiEngineDeps {
  /** settings.cookies 的当前值（每次 run 现读，设置页保存后无需重启） */
  getCookie: (key: "BILIBILI_COOKIE" | "XHS_COOKIE" | "DOUYIN_COOKIE" | "KUAISHOU_COOKIE") => string;
  /** 短链展开（30x 跟随；测试注入假实现，缺省用全局 fetch） */
  expandUrl?: (url: string) => Promise<string | null>;
  /** 客户端工厂覆盖（测试注入假 amagi；缺省 = 真 `amagi()`） */
  makeClient?: AmagiClientFactory;
  /**
   * 代理设置（settings.proxyMode/proxyUrl，每次 run 现读）：manual 且地址可解析时
   * 转成 amagi 的 requestConfig.proxy；system/direct 或地址非法 = 不传（按直连，
   * 与设置页代理地址 hint 的口径一致）。
   */
  getProxyConfig?: () => { mode: "system" | "manual" | "direct" | "off"; url: string };
}

export const AMAGI_ENGINE_ID: EngineId = "amagi";
/** 本引擎声明覆盖的契约键（与注册表 `amagi: "ready"` 的平台一一对应，测试对账） */
export const AMAGI_PLATFORMS: readonly string[] = ["douyin", "bilibili", "kuaishou", "redbook"];

// ————————————————————————————————————————————————
// 防御性取值：amagi 响应类型的索引签名是 any，脏值必须在这里收口
// ————————————————————————————————————————————————

type Unknown = Record<string, unknown>;

const asObj = (v: unknown): Unknown | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Unknown) : null;

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  return undefined;
};

const pick = (v: unknown, path: string): unknown => {
  let cur: unknown = v;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) {
      const i = Number(key);
      cur = Number.isInteger(i) && i >= 0 ? cur[i] : undefined;
      continue;
    }
    const obj = asObj(cur);
    cur = obj ? obj[key] : undefined;
  }
  return cur;
};

const strAt = (v: unknown, path: string): string | undefined => str(pick(v, path));
const numAt = (v: unknown, path: string): number | undefined => num(pick(v, path));

/** url_list / cdn 数组里挑第一条像 URL 的 */
const firstUrl = (v: unknown, path: string): string | undefined => {
  for (const item of asArr(pick(v, path))) {
    const s = str(item);
    if (s && /^https?:\/\//i.test(s)) return s;
  }
  return undefined;
};

/**
 * amagi 的取数信封**有的端点双层、有的单层**（2026-10-21 实测 `BV1GJ411x7h7`）：
 * B 站 `env.data = { code, message, ttl, data: <稿件 / 取流 / 名片> }`，小红书
 * `env.data = { code, data: { items }, msg, success }`；抖音 `parseWork` 与快手
 * `videoWork` 则是**单层**（`{ aweme_detail, … }` / `{ counts, photo, … }`）。
 *
 * 分水岭是端点有没有 `normalize`：框架只对声明了 normalize 的端点改写载荷（目前仅快手
 * `userProfile` 一处），其余原样交出 HTTP body，所以「有没有多一层」只能按平台逐个认。
 * 两种形状都收：内层确实出现目标载荷的特征键才下钻，否则按原样用。
 *
 * 不下钻的后果是静默的：`mapBilibili` 读到的字段全是 undefined → `unmapped-detail`
 * → 整个通道退化为「amagi 永远失败，靠回退」。这正是 2026-10-21 那条实测的根因。
 *
 * 名片走的是同一个信封（`UserCard_V0 = { code, data: { card, archive_count, like_num }, message, ttl }`）
 * 但载荷键完全不同，所以嗅探键要连名片那几个一起名单化——只认稿件键的话名片会被判成「不是内层」，
 * 原样交出去后粉丝/关注/投稿数全读不到，界面上就是「作者卡片有名字、没有统计」。
 */
function unwrapDataLayer(payload: unknown, sniffKeys: readonly string[]): Unknown | null {
  const outer = asObj(payload);
  if (!outer) return null;
  const inner = asObj(outer["data"]);
  if (!inner) return outer;
  return sniffKeys.some((k) => k in inner) ? inner : outer;
}

/** B 站：稿件 / 取流 / 名片三种内层各自的特征键，混在一张名单里按存在性嗅探 */
function unwrapBilibili(payload: unknown): Unknown | null {
  return unwrapDataLayer(payload, [
    "bvid",
    "title",
    "cid",
    "pages",
    "durl",
    "dash",
    "accept_quality",
    // 名片内层的识别键：`card` 是资料主体，`archive_count`/`like_num` 只在这一层出现
    "card",
    "archive_count",
    "like_num",
  ]);
}

/** “字符串计数”（"1.2万" 这类平台文案）尽力转数，转不动就放弃这一格 */
const countAt = (v: unknown, path: string): number | undefined => {
  const raw = pick(v, path);
  const n = num(raw);
  if (n !== undefined) return n;
  const s = str(raw);
  if (s && s.endsWith("万")) {
    const base = Number(s.slice(0, -1));
    if (Number.isFinite(base)) return Math.round(base * 10_000);
  }
  return undefined;
};

// ————————————————————————————————————————————————
// 链接 → 作品 ID
// ————————————————————————————————————————————————

const SHORT_LINK = /(?:v\.douyin\.com|b23\.tv|v\.kuaishou\.com|xhslink\.(?:com|cn))\//i;

interface WorkRef {
  id: string;
  xsecToken?: string;
  /** av 号链接专用：先经 convertAvToBv 换算成 bvid 再走稿件通道 */
  av?: number;
}

function extractId(platform: string, url: string): WorkRef | null {
  if (platform === "douyin") {
    return (
      firstMatch(url, [/\/(?:video|note|slides)\/(\d{10,})/i, /[?&](?:aweme_id|modal_id)=(\d{10,})/i])
      ?? null
    );
  }
  if (platform === "bilibili") {
    // av 号（video/av170001、?aid=170001）→ 换算成 bvid 再进稿件通道
    const av = /\/video\/av(\d{6,})/i.exec(url)?.[1] ?? /[?&]aid=(\d{6,})/i.exec(url)?.[1];
    if (av) return { id: "", av: Number(av) };
    return firstMatch(url, [/\/video\/(BV[0-9A-Za-z]{8,})/i, /[?&]bvid=(BV[0-9A-Za-z]{8,})/i]) ?? null;
  }
  if (platform === "kuaishou") {
    return firstMatch(url, [
      /\/short-video\/([0-9A-Za-z]+)/i,
      /\/photo\/([0-9A-Za-z]+)/i,
      /[?&](?:photoId|pid)=([0-9A-Za-z]+)/i,
    ]) ?? null;
  }
  if (platform === "redbook") {
    const token = /[?&]xsec_token=([A-Za-z0-9_-]+)/i.exec(url)?.[1];
    const ref = firstMatch(url, [
      /\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i,
      /[?&]note_id=([0-9a-f]{24})/i,
    ]);
    return ref ? { id: ref.id, xsecToken: token } : null;
  }
  return null;
}

function firstMatch(url: string, patterns: RegExp[]): WorkRef | null {
  for (const re of patterns) {
    const m = re.exec(url);
    if (m?.[1]) return { id: m[1] };
  }
  return null;
}

const defaultExpandUrl = async (url: string): Promise<string | null> => {
  try {
    // redirect: follow 由 undici 跟完 30x，res.url 即最终落地页；失败按「展开不了」处理
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return res.url && res.url !== url ? res.url : null;
  } catch {
    return null;
  }
};

// ————————————————————————————————————————————————
// amagi 失败信封 → ParseResult（failType 沿用内核语义）
// ————————————————————————————————————————————————

/**
 * 上游细码（`error.code`）→ 业务码 + failType。**优先于 kind**：kind 只分「风控」这一大类，
 * 里面还混着「没配 Cookie」「验证码」「签名被拒」——用户该做的事完全不同。
 */
const FAIL_BY_CODE: Record<string, { code: number; failType: string }> = {
  PARAM_INVALID: { code: 400, failType: "script-error" },
  PARAM_MISSING: { code: 400, failType: "script-error" },
  COOKIE_MISSING: { code: 403, failType: "bot-gated" },
  COOKIE_EXPIRED: { code: 403, failType: "bot-gated" },
  LOGIN_REQUIRED: { code: 403, failType: "bot-gated" },
  RATE_LIMITED: { code: 403, failType: "bot-gated" },
  RISK_CONTROL: { code: 403, failType: "bot-gated" },
  CAPTCHA_REQUIRED: { code: 403, failType: "bot-gated" },
  ANTIBOT_PAGE: { code: 403, failType: "bot-gated" },
  SIGNATURE_REFUSED: { code: 403, failType: "bot-gated" },
  NOT_FOUND: { code: 404, failType: "source-unavailable" },
  DELETED: { code: 404, failType: "source-unavailable" },
  PRIVATE: { code: 404, failType: "source-unavailable" },
  GEO_RESTRICTED: { code: 403, failType: "source-unavailable" },
  PAID_CONTENT: { code: 403, failType: "source-unavailable" },
  PLATFORM_ERROR: { code: 502, failType: "sources-down" },
  PLATFORM_UNAVAILABLE: { code: 502, failType: "sources-down" },
  NETWORK_ERROR: { code: 502, failType: "sources-down" },
  TIMEOUT: { code: 502, failType: "sources-down" },
  EMPTY_RESPONSE: { code: 502, failType: "sources-down" },
  DECODE_FAILED: { code: 500, failType: "script-error" },
  INTERNAL_ERROR: { code: 500, failType: "script-error" },
  UNKNOWN_ERROR: { code: 500, failType: "script-error" },
};

/** 细码缺失时的退路（kind 是跨平台大类，粒度粗但不会空手） */
const FAIL_BY_KIND: Record<string, { code: number; failType: string }> = {
  validation: { code: 400, failType: "script-error" },
  risk: { code: 403, failType: "bot-gated" },
  rate_limit: { code: 403, failType: "bot-gated" },
  forbidden: { code: 403, failType: "source-unavailable" },
  auth: { code: 403, failType: "source-unavailable" },
  not_found: { code: 404, failType: "source-unavailable" },
  unavailable: { code: 502, failType: "sources-down" },
  network: { code: 502, failType: "sources-down" },
  timeout: { code: 502, failType: "sources-down" },
  parse: { code: 500, failType: "script-error" },
  internal: { code: 500, failType: "script-error" },
  unknown: { code: 500, failType: "script-error" },
};

/**
 * 失败原因串：`上游文案（细码 · 平台码 · HTTP 状态）`。
 * 只写一句「amagi 解析失败」对用户零信息量——「缺 Cookie」与「稿件已删除」该做的事完全不同，
 * 而这两种在上游那边是 LOGIN_REQUIRED 与 DELETED，只有细码分得开。
 */
function failureReason(err: AmagiErrorShape | undefined, fallbackMessage?: string): string {
  const code = str(err?.code);
  const platformCode = err?.platform?.code;
  const httpStatus = err?.http?.status;
  const detail = [
    code,
    platformCode !== undefined ? `平台码 ${platformCode}` : undefined,
    httpStatus !== undefined ? `HTTP ${httpStatus}` : undefined,
  ].filter((s): s is string => Boolean(s));

  const human =
    str(err?.message) ??
    str(err?.platform?.message) ??
    fallbackMessage ??
    (code ? `amagi：${code}` : "amagi：解析失败");
  return detail.length > 0 ? `${human}（${detail.join(" · ")}）` : human;
}

function envelopeFailure(env: AmagiEnvelope, platform: string): ParseResult {
  const kind = str(env.error?.kind) ?? "unknown";
  const code = str(env.error?.code);
  const slot =
    (code ? FAIL_BY_CODE[code] : undefined) ??
    FAIL_BY_KIND[kind] ??
    { code: 500, failType: "script-error" };
  return {
    code: slot.code,
    // 失败原文截断到契约上限：attempts.msg 也吃这一条，别把整段 HTML 反爬页递进界面
    msg: failureReason(env.error, str(env.message)).slice(0, 300),
    platform,
    failType: slot.failType,
  };
}

/** 选路器/日志用的短标签：细码优先（LOGIN_REQUIRED 比 auth 有用得多），没有才退回 kind */
function failureTag(env: AmagiEnvelope): string {
  return `amagi:${str(env.error?.code) ?? str(env.error?.kind) ?? "unknown"}`;
}

const okResult = (platform: string, data: ParseData): ParseResult => ({
  code: 200,
  msg: "解析成功（amagi）",
  platform,
  data,
});

// ————————————————————————————————————————————————
// 四平台映射
// ————————————————————————————————————————————————

function mapDouyin(detail: Unknown, awemeId: string): ParseData | null {
  const images = asArr(pick(detail, "images"))
    .map((im) => {
      const urls = asArr(pick(im, "url_list")).map((u) => str(u)).filter((u): u is string => Boolean(u));
      return urls.length > 0 ? urls[urls.length - 1] : undefined;
    })
    .filter((u): u is string => Boolean(u));

  const playAddr = firstUrl(detail, "video.play_addr.url_list");
  const videoUrl = playAddr?.replace("/playwm/", "/play/");

  const statSource = asObj(pick(detail, "statistics")) ?? {};
  const data: ParseData = {
    title: strAt(detail, "desc"),
    type: images.length > 0 ? "image" : "video",
    duration: numAt(detail, "video.duration"),
    author: strAt(detail, "author.nickname"),
    authorId: strAt(detail, "author.uid") ?? strAt(detail, "author.sec_uid"),
    authorUrl: strAt(detail, "author.sec_uid")
      ? `https://www.douyin.com/user/${strAt(detail, "author.sec_uid")}`
      : undefined,
    avatar: firstUrl(detail, "author.avatar_thumb.url_list"),
    sign: strAt(detail, "author.signature"),
    // 抖音的作者统计就挂在作品详情的 author 上，不需要再发一次请求；
    // 部分版本只给 `mplatform_followers_count`（多端合并后的粉丝数），一并兜住
    followerCount: numAt(detail, "author.follower_count") ?? numAt(detail, "author.mplatform_followers_count"),
    followingCount: numAt(detail, "author.following_count"),
    totalFavorited: numAt(detail, "author.total_favorited"),
    videoCount: numAt(detail, "author.aweme_count"),
    cover: firstUrl(detail, "video.cover.url_list") ?? firstUrl(detail, "video.origin_cover.url_list"),
    url: images.length > 0 ? undefined : videoUrl,
    images: images.length > 0 ? images : undefined,
    awemeId,
    stat: {
      like: num(statSource["digg_count"]),
      reply: num(statSource["comment_count"]),
      favorite: num(statSource["collect_count"]),
      share: num(statSource["share_count"]),
      view: num(statSource["play_count"]),
    },
  };
  return images.length > 0 || videoUrl ? data : null;
}

/**
 * @param authorCard UP 主名片（`fetchUserCard` 的 `data`，形状是 `{ card: {...}, archive_count, like_num }`）。
 *   缺省 / 失败时只是少几行作者统计，稿件本身照常出。
 */
function mapBilibili(info: Unknown, stream: Unknown | null, authorCard: Unknown | null = null): ParseData | null {
  const owner = asObj(pick(info, "owner"));
  const stat = asObj(pick(info, "stat")) ?? {};
  const bvid = strAt(info, "bvid");
  const mid = numAt(info, "owner.mid");
  const durationSec = numAt(info, "duration");
  // 名片把用户资料放在 `card` 里，投稿数与获赞在 data 顶层；两种形状都认
  const cardInfo = asObj(pick(authorCard, "card")) ?? authorCard;

  // 取流失败或形状异样时仍交出稿件信息（无直链，结果卡只剩元数据），不让整次解析白跑
  const dashVideo = asArr(pick(stream, "dash.video"));
  const supportFormats = asArr(pick(stream, "support_formats"));
  const acceptQuality = asArr(pick(stream, "accept_quality"));
  const qualityUrl = (item: Unknown): string | undefined =>
    strAt(item, "baseUrl") ?? strAt(item, "base_url") ?? firstUrl(item, "backup_url");
  /**
   * 档位显示名：**先按 `support_formats[].quality` 匹配，不按下标**。
   *
   * 2026-10-21 用户报「有的视频有 2 个 1080P」：`accept_quality` 与 `support_formats` 是两个
   * 独立清单，真机上顺序不保证一致，按下标索引会让不同 qn 取到同一个 `display_desc`，
   * 于是两档顶着同一个名字出现在下拉里。每条 `support_formats` 自己就带 `quality`，
   * 直接对上它就是唯一正确的口径；只有老形状缺这个字段时才退回下标。
   */
  const qualityLabel = (qn: number): string => {
    const byQuality = supportFormats
      .map((f) => asObj(f))
      .find((f) => f !== null && numAt(f, "quality") === qn);
    const fmtIndex = acceptQuality.findIndex((q) => num(q) === qn);
    const fmt = byQuality ?? (fmtIndex >= 0 ? asObj(supportFormats[fmtIndex]) : null);
    return strAt(fmt, "display_desc") ?? strAt(fmt, "new_description") ?? `${qn}`;
  };

  // 同一个 qn 会按编码各回一条（codecid 7=AVC / 12=HEVC / 13=AV1），`mimeType` 三者都是
  // `video/mp4`——只能靠 codecid 分辨。不归并就会让结果卡为同一个「1080P」摆两个选项，
  // 用户选谁都没依据；同编码多条再比带宽。AVC 兼容性最好（Windows 播放器与合并都最稳）。
  const codecRank = (item: Unknown): number => {
    const codecid = numAt(item, "codecid");
    if (codecid === 7) return 0;
    if (codecid === undefined) return 1;
    if (codecid === 12) return 2;
    return 3;
  };
  const betterVideo = (a: Unknown, b: Unknown): boolean =>
    codecRank(a) < codecRank(b) ||
    (codecRank(a) === codecRank(b) && (numAt(a, "bandwidth") ?? 0) > (numAt(b, "bandwidth") ?? 0));

  const bestByQuality = new Map<number, Unknown>();
  for (const raw of dashVideo) {
    const item = asObj(raw);
    if (!item) continue;
    const qn = numAt(item, "id");
    if (qn === undefined || !qualityUrl(item)) continue;
    const cur = bestByQuality.get(qn);
    if (!cur || betterVideo(item, cur)) bestByQuality.set(qn, item);
  }
  // 降序：主链取 qualities[0] 才是最高档（服务端数组顺序不保证）
  const qualities: ParsedVideoQuality[] = [...bestByQuality.entries()]
    .map(([qn, item]) => ({ quality: qn, label: qualityLabel(qn), url: qualityUrl(item) as string }))
    .sort((a, b) => b.quality - a.quality);

  // 未登录时 B 站不下发 dash，只回 `durl`（渐进式 mp4，含音轨）：主链与唯一档位都取它，
  // `audioUrl` 留空——把整段视频当「音频流」交出去，下载侧会落一个文件名骗人的文件。
  //
  // 两个 2026-10-21 实测出来的坑：
  // ① `accept_description[0]` 不是「当前这一档」：未登录 html5 只给 `quality: 16`（360P），
  //    而清单是 ["高清 720P","流畅 360P"]——取 [0] 等于把 360P 虚标成 720P，用户会觉得
  //    「画面比标签小一整档」。必须按 `quality` 在 `accept_quality` 里的下标去取。
  // ② `durl` 可能是多段（旧式稿件）：只取第一段会交付半截视频，预览也只播开头。
  //    分不清怎么合就不给直链、照常交元数据，别递残缺文件。
  const durls = asArr(pick(stream, "durl"));
  if (qualities.length === 0 && durls.length === 1) {
    const seg = asObj(durls[0]);
    const url = seg ? (strAt(seg, "url") ?? firstUrl(seg, "backup_url")) : undefined;
    if (url) {
      const qn = numAt(stream, "quality") ?? 0;
      const descIndex = acceptQuality.findIndex((q) => num(q) === qn);
      const desc = descIndex >= 0 ? strAt(stream, `accept_description.${descIndex}`) : undefined;
      qualities.push({ quality: qn, label: desc ?? `${qn}`, url });
    }
  }

  // 音轨同样可能是多条（不同码率/编码）：按带宽最高取，同带宽优先 mp4a；
  // 拿数组第 0 条等于赌上游顺序，可能落最低音质。
  const audioRank = (a: Unknown): number =>
    (strAt(a, "mimeType") ?? strAt(a, "mime_type") ?? "").toLowerCase().includes("mp4") ? 0 : 1;
  const dashAudio = asArr(pick(stream, "dash.audio"))
    .map((a) => asObj(a))
    .filter((a): a is Unknown => a !== null && Boolean(strAt(a, "baseUrl") ?? strAt(a, "base_url")))
    .sort(
      (a, b) =>
        audioRank(a) - audioRank(b) || (numAt(b, "bandwidth") ?? 0) - (numAt(a, "bandwidth") ?? 0)
    );
  const audioUrl = dashVideo.length > 0
    ? (strAt(dashAudio[0], "baseUrl") ?? strAt(dashAudio[0], "base_url"))
    : undefined;

  const data: ParseData = {
    title: strAt(info, "title"),
    desc: strAt(info, "desc"),
    type: "video",
    duration: durationSec !== undefined ? durationSec * 1000 : undefined,
    author: strAt(info, "owner.name") ?? (owner ? str(owner["name"]) : undefined),
    authorId: mid !== undefined ? String(mid) : undefined,
    authorUrl: mid !== undefined ? `https://space.bilibili.com/${mid}` : undefined,
    avatar: strAt(info, "owner.face") ?? (owner ? str(owner["face"]) : undefined),
    // 签名优先取稿件详情（owner.sign 与名片一致），名片补上稿件侧没有的计数
    sign: strAt(info, "owner.sign") ?? (owner ? str(owner["sign"]) : undefined) ?? strAt(cardInfo, "sign"),
    followerCount: numAt(cardInfo, "fans") ?? numAt(authorCard, "follower"),
    followingCount: numAt(cardInfo, "attention"),
    totalFavorited: numAt(authorCard, "like_num"),
    videoCount: numAt(authorCard, "archive_count"),
    cover: strAt(info, "pic"),
    url: qualities[0]?.url,
    audioUrl,
    bvid,
    qualities: qualities.length > 0 ? qualities : undefined,
    stat: {
      view: num(stat["view"]),
      danmaku: num(stat["danmaku"]),
      reply: num(stat["reply"]),
      favorite: num(stat["favorite"]),
      coin: num(stat["coin"]),
      share: num(stat["share"]),
      like: num(stat["like"]),
    },
  };
  return bvid ? data : null;
}

function mapKuaishou(payload: Unknown): ParseData | null {
  const photo = asObj(pick(payload, "photo"));
  if (!photo) return null;
  // 作者统计就在同一份载荷的 `counts` 里（`VideoWork_V0 = { counts, photo, result, serialInfo }`）：
  // 与 B 站要去另发名片不同，这几档不发请求也拿得到，不读就只是白丢
  const counts = asObj(payload["counts"]) ?? {};
  const atlas = asObj(payload["atlas"]);
  const atlasImages = asArr(pick(atlas, "list"))
    .map((u) => str(u))
    .filter((u): u is string => typeof u === "string" && /^https?:/.test(u));

  // 多档 manifest（只有视频作品返回）：representation 按清晰度排序，最高档作主链、全量进 qualities
  const reps = asArr(pick(photo, "manifest.adaptationSet"))
    .flatMap((set) => asArr(pick(set, "representation")))
    .map((rep) => {
      const url = strAt(rep, "url");
      if (!url) return null;
      const height = numAt(rep, "height");
      const bitrate = numAt(rep, "avgBitrate");
      return {
        quality: height ?? bitrate ?? 0,
        label: strAt(rep, "qualityLabel") ?? (height !== undefined ? `${height}P` : `${bitrate ?? 0}kbps`),
        url,
      };
    })
    .filter((x): x is ParsedVideoQuality => x !== null)
    .sort((a, b) => b.quality - a.quality);

  const videoUrl = reps[0]?.url ?? strAt(photo, "mainMvUrls.0.url");
  const cover = strAt(photo, "coverUrls.0.url") ?? strAt(photo, "webpCoverUrls.0.url");

  const data: ParseData = {
    title: strAt(photo, "caption"),
    type: atlasImages.length > 0 ? "image" : "video",
    duration: numAt(photo, "duration"),
    author: strAt(photo, "userName"),
    authorId: numAt(photo, "userId") !== undefined ? String(numAt(photo, "userId")) : undefined,
    authorUrl: strAt(photo, "userEid") ? `https://www.kuaishou.com/profile/${strAt(photo, "userEid")}` : undefined,
    avatar: strAt(photo, "headUrl") ?? strAt(photo, "headUrls.0.url"),
    followerCount: numAt(counts, "fanCount"),
    followingCount: numAt(counts, "followCount"),
    videoCount: numAt(counts, "photoCount"),
    cover,
    url: atlasImages.length > 0 ? undefined : videoUrl,
    images: atlasImages.length > 0 ? atlasImages : undefined,
    viewCount: numAt(photo, "viewCount"),
    likeCount: numAt(photo, "likeCount"),
    commentCount: numAt(photo, "commentCount"),
    forwardCount: numAt(photo, "forwardCount"),
    shareCount: numAt(photo, "shareCount"),
    retweets: numAt(photo, "forwardCount"),
    qualities: reps.length > 0 ? reps : undefined,
    stat: {
      like: numAt(photo, "likeCount"),
      reply: numAt(photo, "commentCount"),
      view: numAt(photo, "viewCount"),
      share: numAt(photo, "shareCount"),
    },
  };
  return atlasImages.length > 0 || videoUrl ? data : null;
}

function mapXiaohongshu(noteCard: Unknown, noteId: string): ParseData | null {
  const images = asArr(pick(noteCard, "image_list"))
    .map((im) => strAt(im, "url_default") ?? firstUrl(im, "info_list.2.url") ?? firstUrl(im, "info_list.1.url") ?? strAt(im, "url"))
    .filter((u): u is string => Boolean(u));

  const videoUrl =
    strAt(noteCard, "video.media.stream.h264.0.master_url") ??
    strAt(noteCard, "video.media.stream.h265.0.master_url") ??
    firstUrl(noteCard, "video.media.stream.h264.0.backup_urls");

  const liked = countAt(noteCard, "interact_info.liked_count");
  const userId = strAt(noteCard, "user.userid") ?? strAt(noteCard, "user.user_id");

  const data: ParseData = {
    title: strAt(noteCard, "title"),
    desc: strAt(noteCard, "desc"),
    type: strAt(noteCard, "type") === "video" && videoUrl ? "video" : "image",
    duration: numAt(noteCard, "video.capa.duration"),
    noteId,
    author: strAt(noteCard, "user.nickname"),
    authorId: userId,
    authorUrl: userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : undefined,
    avatar: strAt(noteCard, "user.avatar"),
    cover: images[0],
    url: videoUrl,
    images: videoUrl ? undefined : images,
    ipRegion: strAt(noteCard, "ip_location"),
    like: liked,
    stat: { like: liked },
  };
  return images.length > 0 || videoUrl ? data : null;
}

/** 代理地址 → amagi 的 { host, port }；解析不了返回 null（按直连，与设置页 hint 同口径）。
 *  主机名收紧成 ASCII 域名 / IPv4 / [IPv6]：`new URL` 会把中文等非法域名编成 punycode 混过，
 *  那种地址发出去只会得到一个连不上的代理，不如当非法处理。 */
function parseProxyUrl(raw: string): { host: string; port: number } | null {
  const s = raw.trim();
  if (!s) return null;
  // 非 ASCII 可打印字符一律判非法：`new URL` 会把中文域名编成 punycode 混过正则，
  // 那种地址连出去只会得到一个连不上的代理，不如当非法处理（同形字域名也一并挡掉）
  if (/[^\x21-\x7e]/.test(s)) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withProto);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(u.hostname)) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

// ————————————————————————————————————————————————
// 引擎装配
// ————————————————————————————————————————————————

export function createAmagiEngine(deps: AmagiEngineDeps): ParseEngine {
  const expandUrl = deps.expandUrl ?? defaultExpandUrl;
  const makeClient: AmagiClientFactory =
    deps.makeClient ??
    ((cookies, requestConfig) => {
      const client = amagi({
        cookies: {
          bilibili: cookies.bilibili ?? "",
          douyin: cookies.douyin ?? "",
          kuaishou: cookies.kuaishou ?? "",
          xiaohongshu: cookies.xiaohongshu ?? "",
        },
        // 选项名是 `request`（axios 配置面）；`proxy` 走 axios 的 Node 代理形态，直接兼容
        request: requestConfig,
      });
      // 本引擎只消费取数方法，按 fetcher 切面暴露（client 本体还挂着 sign/passport 等无关面）
      return {
        douyin: client.douyin.fetcher,
        bilibili: client.bilibili.fetcher,
        kuaishou: client.kuaishou.fetcher,
        xiaohongshu: client.xiaohongshu.fetcher,
      };
    });

  const clientFor = (): AmagiFetchers => {
    const cfg = deps.getProxyConfig?.();
    const proxy = cfg?.mode === "manual" ? parseProxyUrl(cfg.url) : null;
    // 只在真解出代理时才构造对象：{ proxy: undefined } 会被下游当成「配了代理」处理
    const requestConfig: AmagiRequestConfig | undefined = proxy ? { proxy } : undefined;
    return makeClient(
      {
        bilibili: deps.getCookie("BILIBILI_COOKIE"),
        douyin: deps.getCookie("DOUYIN_COOKIE"),
        kuaishou: deps.getCookie("KUAISHOU_COOKIE"),
        xiaohongshu: deps.getCookie("XHS_COOKIE"),
      },
      requestConfig
    );
  };

  async function resolveRef(platform: string, url: string, id?: string): Promise<WorkRef | null> {
    if (id) return { id };
    if (!url) return null;
    const direct = extractId(platform, url);
    if (direct) return direct;
    if (!SHORT_LINK.test(url)) return null;
    const expanded = await expandUrl(url);
    return expanded ? extractId(platform, expanded) : null;
  }

  const noRef = (platform: string): ParseResult => ({
    code: 400,
    msg: "未能从链接中提取作品 ID（短链展开失败或链接形态不在支持范围）",
    platform,
    failType: "script-error",
  });

  return {
    id: AMAGI_ENGINE_ID,
    label: ENGINE_INFO.amagi.label,
    covers: async (platform) => AMAGI_PLATFORMS.includes(platform),

    async run({ platform, url, id }: EngineRequest): Promise<EngineOutcome> {
      const key = platform;
      // 失败答复统一走 ok:false + reason（选路器靠 reason 决定「可换下一个引擎」），result 是给用户的最终答复
      const bad = (reason: string, result: ParseResult): EngineOutcome => ({ ok: false, reason, result });
      if (!AMAGI_PLATFORMS.includes(key)) return bad("platform-not-covered", { code: 400, msg: `amagi 不覆盖 ${platform}` });
      const client = clientFor();
      try {
        if (key === "douyin") {
          const ref = await resolveRef(key, url, id);
          if (!ref) return bad("id-not-found", noRef(key));
          const env = (await client.douyin.parseWork({ aweme_id: ref.id })) as AmagiEnvelope;
          if (!env.success) return bad(failureTag(env), envelopeFailure(env, key));
          const detail = asObj(pick(env.data, "aweme_detail"));
          if (!detail) return bad("empty-detail", { code: 404, msg: "amagi：响应里没有作品详情", platform: key, failType: "source-unavailable" });
          const data = mapDouyin(detail, ref.id);
          return data ? { ok: true, result: okResult(key, data) } : bad("unmapped-detail", noRef(key));
        }

        if (key === "bilibili") {
          const ref = await resolveRef(key, url, id);
          if (!ref) return bad("id-not-found", noRef(key));
          // av 号链接：先经本地换算拿 bvid（amagi 的 zero-network compute），再进稿件通道
          let bvid = ref.id;
          if (!bvid && ref.av !== undefined) {
            const avEnv = (await client.bilibili.convertAvToBv({ avid: ref.av })) as AmagiEnvelope;
            if (!avEnv.success) return bad(failureTag(avEnv), envelopeFailure(avEnv, key));
            bvid = strAt(avEnv.data, "bvid") ?? "";
          }
          if (!bvid) return bad("id-not-found", noRef(key));
          const infoEnv = (await client.bilibili.fetchVideoInfo({ bvid })) as AmagiEnvelope;
          if (!infoEnv.success) return bad(failureTag(infoEnv), envelopeFailure(infoEnv, key));
          const info = unwrapBilibili(infoEnv.data);
          if (!info) return bad("empty-detail", { code: 404, msg: "amagi：响应里没有稿件详情", platform: key, failType: "source-unavailable" });
          const avid = numAt(info, "aid");
          // 稿件详情里 `cid` 不总在顶层：正片分 P 时只在 `pages[].cid`（2026-10-21 实测）
          const cid = numAt(info, "cid") ?? numAt(info, "pages.0.cid");
          let stream: Unknown | null = null;
          if (avid !== undefined && cid !== undefined) {
            const streamEnv = (await client.bilibili.fetchVideoStreamUrl({ avid, cid })) as AmagiEnvelope;
            if (streamEnv.success) stream = unwrapBilibili(streamEnv.data);
          }
          // 作者资料：稿件详情只有 owner{name,face,sign}，粉丝/关注/投稿数在名片里。
          // 这次请求是「锦上添花」——失败就交一份缺作者统计的结果，不能让整次解析白跑。
          const ownerMid = numAt(info, "owner.mid");
          let authorCard: Unknown | null = null;
          if (ownerMid !== undefined) {
            try {
              const cardEnv = (await client.bilibili.fetchUserCard({ host_mid: ownerMid })) as AmagiEnvelope;
              // 与稿件/取流同一个双层信封：不拆这一层，`card.fans` / `archive_count` 永远读不到
              if (cardEnv.success) authorCard = unwrapBilibili(cardEnv.data);
            } catch {
              /* 名片失败不影响稿件本身 */
            }
          }
          const data = mapBilibili(info, stream, authorCard);
          return data ? { ok: true, result: okResult(key, data) } : bad("unmapped-detail", noRef(key));
        }

        if (key === "kuaishou") {
          const ref = await resolveRef(key, url, id);
          if (!ref) return bad("id-not-found", noRef(key));
          const env = (await client.kuaishou.fetchVideoWork({ photoId: ref.id })) as AmagiEnvelope;
          if (!env.success) return bad(failureTag(env), envelopeFailure(env, key));
          const payload = asObj(env.data);
          if (!payload) return bad("empty-detail", { code: 404, msg: "amagi：响应里没有作品详情", platform: key, failType: "source-unavailable" });
          const data = mapKuaishou(payload);
          return data ? { ok: true, result: okResult(key, data) } : bad("unmapped-detail", noRef(key));
        }

        // redbook
        const ref = await resolveRef(key, url, id);
        if (!ref) return bad("id-not-found", noRef(key));
        const env = (await client.xiaohongshu.fetchNoteDetail({
          note_id: ref.id,
          xsec_token: ref.xsecToken,
        })) as AmagiEnvelope;
        if (!env.success) return bad(failureTag(env), envelopeFailure(env, key));
        // 小红书与 B 站同一族：body 是 `{ code, data: { items }, msg, success }`，笔记在 `data.items`
        const noteBody = unwrapDataLayer(env.data, ["items"]);
        const noteCard = asObj(pick(noteBody, "items.0.note_card"));
        if (!noteCard) return bad("empty-detail", { code: 404, msg: "amagi：响应里没有笔记详情", platform: key, failType: "source-unavailable" });
        const data = mapXiaohongshu(noteCard, ref.id);
        return data ? { ok: true, result: okResult(key, data) } : bad("unmapped-detail", noRef(key));
      } catch (e) {
        return bad("exception", {
          code: 500,
          msg: `amagi 引擎异常：${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          platform: key,
          failType: "script-error",
        });
      }
    },
  };
}
