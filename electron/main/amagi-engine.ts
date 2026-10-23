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
import type { ParseData, ParseResult, ParsedVideoItem, ParsedVideoQuality } from "../../types/ipc";
import type { EngineOutcome, EngineRequest, ParseEngine } from "./engines";
import { DESKTOP_USER_AGENT, refererFor } from "./hotlink";

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
  /** CDN 探测用的 fetch（测试注入，缺省全局 fetch）；只在 B 站取流结果带镜像候选时发请求 */
  fetchImpl?: typeof fetch;
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

// ————————————————————————————————————————————————
// B 站 CDN 候选（2026-10-23 实测）
// ————————————————————————————————————————————————

/**
 * B 站取流给每条轨一串候选链：`baseUrl` 是按运营商/地域调度的主链，`backup_url` 是镜像。
 *
 * 2026-10-23 实测（BV1GJ411x7h7，1080P）：主链落在 `*.mcdn.bilivideo.cn`，单连接只有
 * ~0.5 MB/s，AVC 主链甚至 TLS 握手直接失败；镜像 `edge.*` ~3.5 MB/s。预览是 ffmpeg 把
 * 两条远程轨**整段拉完**才合流，同一份 230 MB 视频在主链上要 8 分钟，必然撞 120s 超时
 * （日志里两条「远程合流失败：ffmpeg 超时被杀」就是它）。下载走同一条链，症状是进度爬得很慢。
 *
 * 所以解析时先量一小段吞吐：主链是 PCDN（mcdn）且存在镜像才探测，几个候选各拉 64 KB 比速度，
 * 选中的下标同时套到所有档位与音轨（B 站各条轨的候选顺序一致，下标不在的条目退回主链）。
 * 探测失败不影响解析——全部拿不到数据就维持主链，行为与改动前一致。
 */
const CDN_PROBE_BYTES = 64 * 1024;
const CDN_PROBE_TIMEOUT_MS = 1200;
const PCDN_HOST = /(^|\.)mcdn\.bilivideo\.cn$/i;

/** 一条轨的可换 CDN：主链在前、镜像在后（`url` 是 durl 分段的键名） */
function cdnCandidates(item: Unknown): string[] {
  const out: string[] = [];
  const push = (u: string | undefined): void => {
    if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  };
  push(strAt(item, "baseUrl"));
  push(strAt(item, "base_url"));
  push(strAt(item, "url"));
  for (const s of asArr(pick(item, "backup_url"))) push(str(s));
  for (const s of asArr(pick(item, "backupUrl"))) push(str(s));
  return out;
}

/** 候选下标 → 直链；该条目没有这个镜像位时退回主链 */
function candidateAt(item: Unknown, slot: number): string | undefined {
  const list = cdnCandidates(item);
  return list[slot] ?? list[0];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** 探测代表条目：视频档位里带镜像且 qn 最高的一条；没有视频则退 durl/音轨 */
function probeEntry(stream: Unknown): Unknown | null {
  const dashVideo = asArr(pick(stream, "dash.video"))
    .map((v) => asObj(v))
    .filter((v): v is Unknown => v !== null);
  let best: Unknown | null = null;
  for (const item of dashVideo) {
    if (cdnCandidates(item).length < 2) continue;
    if (!best || (numAt(item, "id") ?? 0) > (numAt(best, "id") ?? 0)) best = item;
  }
  if (best) return best;
  for (const path of ["durl", "dash.audio"]) {
    for (const raw of asArr(pick(stream, path))) {
      const item = asObj(raw);
      if (item && cdnCandidates(item).length >= 2) return item;
    }
  }
  return null;
}

/**
 * 量一小段吞吐，返回最快的候选下标（0 = 主链）。
 * 超时只中止本次读取，已收到的字节仍参与比较——慢主链往往不是报错而是拖。
 */
async function probeCdnSlot(entry: Unknown, fetchImpl: typeof fetch): Promise<number> {
  const candidates = cdnCandidates(entry);
  if (candidates.length < 2 || !PCDN_HOST.test(hostOf(candidates[0]))) return 0;
  const referer = refererFor("bilibili");

  const measure = async (
    url: string,
    slot: number
  ): Promise<{ slot: number; speed: number } | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CDN_PROBE_TIMEOUT_MS);
    const started = performance.now();
    let got = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const resp = await fetchImpl(url, {
        headers: {
          "User-Agent": DESKTOP_USER_AGENT,
          ...(referer ? { Referer: referer } : {}),
          Range: `bytes=0-${CDN_PROBE_BYTES - 1}`,
        },
        signal: ctrl.signal,
      });
      if (!resp.ok && resp.status !== 206) {
        void resp.body?.cancel().catch(() => undefined);
        return null;
      }
      reader = resp.body?.getReader();
      if (!reader) return null;
      while (got < CDN_PROBE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
      }
      return got > 0 ? { slot, speed: got / Math.max(1, performance.now() - started) } : null;
    } catch {
      return got > 0 ? { slot, speed: got / Math.max(1, performance.now() - started) } : null;
    } finally {
      clearTimeout(timer);
      void reader?.cancel().catch(() => undefined);
    }
  };

  const results = (await Promise.all(candidates.map(measure))).filter(
    (r): r is { slot: number; speed: number } => r !== null
  );
  if (results.length === 0) return 0;
  results.sort((a, b) => b.speed - a.speed);
  return results[0].slot;
}

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
  /** B 站分 P 序号（1 起，链接上的 `?p=N`）；缺省 = 合集首 P */
  page?: number;
}

/**
 * 分 P 序号：B 站链接的 `?p=N`（1 起）。
 *
 * 只认 1–4 位正整数：`?p=0`、`?p=abc`、`?p=` 后面挂着一长串指纹数字都当没写，
 * 由调用方回落 P1 —— 拿一个认不出来的值去夹 pages 下标，等于给用户看不存在的 P。
 */
function pageNumberIn(url: string): number | undefined {
  const raw = /[?&]p=(\d{1,4})(?:[&#/]|$)/.exec(url)?.[1];
  if (!raw) return undefined;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

function extractId(platform: string, url: string): WorkRef | null {
  if (platform === "douyin") {
    return (
      firstMatch(url, [/\/(?:video|note|slides)\/(\d{10,})/i, /[?&](?:aweme_id|modal_id)=(\d{10,})/i])
      ?? null
    );
  }
  if (platform === "bilibili") {
    // 分 P 序号与作品 ID 同源抽出：`?p=` 挂在 BV 号还是 av 号后面都是「要第几 P」
    const page = pageNumberIn(url);
    // av 号（video/av170001、?aid=170001）→ 换算成 bvid 再进稿件通道
    const av = /\/video\/av(\d{6,})/i.exec(url)?.[1] ?? /[?&]aid=(\d{6,})/i.exec(url)?.[1];
    if (av) return { id: "", av: Number(av), page };
    const bvid = firstMatch(url, [/\/video\/(BV[0-9A-Za-z]{8,})/i, /[?&]bvid=(BV[0-9A-Za-z]{8,})/i]);
    return bvid ? { id: bvid.id, page } : null;
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
 * 「一个分 P 就是一份资源」（业主 2026-10-23）里的一个 P：`pages[]` 的那条载荷，
 * 加上**为它单独取到**的那一份流（取流失败 = null，这一 P 在清单里缺席）。
 *
 * 每条自带 stream 是这个模型成立的前提：B 站一次 `playurl` 只回答一个 cid，
 * 顶层那条音轨属于本次取流的那一 P，把它配到别的 P 上就是「画面是 P3、声音是 P2」。
 */
interface BilibiliPage {
  item: Unknown | null;
  no: number;
  stream: Unknown | null;
}

/**
 * 本次解析面对的分 P 合集。
 *
 * 两个值必须一起给：`pages` 决定清单里有几条资源、要不要在名字上标 P，
 * `no` 决定主链（结果卡的主视觉、清晰度档位、下载文件名的 P 号）是其中哪一条。
 */
interface BilibiliPart {
  pages: BilibiliPage[];
  no: number;
}

/** 一次 `playurl` 映射出来的交付面：档位、主链、音轨与各自的 MSE 身份 */
interface BilibiliStreams {
  qualities: ParsedVideoQuality[];
  url?: string;
  audioUrl?: string;
  videoCodecs?: string;
  videoMimeType?: string;
  audioCodecs?: string;
  audioMimeType?: string;
  /** 本次取流那条媒体的实际毫秒数；取流失败或形状异样时缺省 */
  timelength?: number;
}

/**
 * 一份 `playurl` 响应 → 这一 P 能交付的东西。
 *
 * 单独成函数是为了让「每一 P 都走同一套映射」：档位归并与音轨挑选里踩过的坑
 * （同一个 qn 按编码回两条 → 结果卡摆两个「1080P」；未登录 `accept_description[0]`
 * 不是当前档 → 360P 虚标成 720P；`durl` 多段只取第一段 → 交付半截视频，
 * 都是 2026-10-21 实测修的）若在分 P 那一份上另写一遍，就会变成「只有主链那条是对的」。
 */
function mapBilibiliStream(stream: Unknown | null, cdnSlot: number): BilibiliStreams {
  if (!stream) return { qualities: [] };
  const supportFormats = asArr(pick(stream, "support_formats"));
  const acceptQuality = asArr(pick(stream, "accept_quality"));
  const qualityUrl = (item: Unknown): string | undefined => candidateAt(item, cdnSlot);

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
  for (const raw of asArr(pick(stream, "dash.video"))) {
    const item = asObj(raw);
    if (!item) continue;
    const qn = numAt(item, "id");
    if (qn === undefined || !qualityUrl(item)) continue;
    const cur = bestByQuality.get(qn);
    if (!cur || betterVideo(item, cur)) bestByQuality.set(qn, item);
  }
  // 降序：主链（qualities[0]）取最高档（服务端数组顺序不保证）
  const qualities: ParsedVideoQuality[] = [...bestByQuality.entries()]
    .map(([qn, item]) => ({
      quality: qn,
      label: qualityLabel(qn),
      url: qualityUrl(item) as string,
      // MSE 预览（契约 v35）：playurl 每条 DASH 档自带 codecs/mimeType，
      // 渲染层建 SourceBuffer 时要用；durl 分支不写，预览自然走合流回退。
      codecs: strAt(item, "codecs"),
      mimeType: strAt(item, "mimeType") ?? strAt(item, "mime_type"),
    }))
    .sort((a, b) => b.quality - a.quality);
  const mainItem = qualities.length > 0 ? bestByQuality.get(qualities[0].quality) : undefined;

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
    const url = seg ? candidateAt(seg, cdnSlot) : undefined;
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
  const audioItem = asArr(pick(stream, "dash.video")).length > 0 ? dashAudio[0] : undefined;

  return {
    qualities,
    url: qualities[0]?.url,
    audioUrl: audioItem ? candidateAt(audioItem, cdnSlot) : undefined,
    videoCodecs: mainItem ? strAt(mainItem, "codecs") : undefined,
    videoMimeType: mainItem ? strAt(mainItem, "mimeType") ?? strAt(mainItem, "mime_type") : undefined,
    audioCodecs: audioItem ? strAt(audioItem, "codecs") : undefined,
    audioMimeType: audioItem ? strAt(audioItem, "mimeType") ?? strAt(audioItem, "mime_type") : undefined,
    timelength: numAt(stream, "timelength"),
  };
}

/**
 * 这一 P 的时长（毫秒）：`timelength` 优先（playurl 对**这次取流的那条媒体**报的实际毫秒数），
 * 其次 `pages[].duration`（秒）。
 */
function partDurationMs(page: BilibiliPage, s: BilibiliStreams): number | undefined {
  const sec = numAt(page.item, "duration");
  return s.timelength ?? (sec !== undefined ? sec * 1000 : undefined);
}

/**
 * @param authorCard UP 主名片（`fetchUserCard` 的 `data`，形状是 `{ card: {...}, archive_count, like_num }`）。
 *   缺省 / 失败时只是少几行作者统计，稿件本身照常出。
 * @param part 这份稿件的全部分 P（各带自己取到的流）与用户链接指向的那一 P 的序号。
 */
function mapBilibili(
  info: Unknown,
  part: BilibiliPart,
  authorCard: Unknown | null = null,
  cdnSlot = 0
): ParseData | null {
  const owner = asObj(pick(info, "owner"));
  const stat = asObj(pick(info, "stat")) ?? {};
  const bvid = strAt(info, "bvid");
  const mid = numAt(info, "owner.mid");
  // 名片把用户资料放在 `card` 里，投稿数与获赞在 data 顶层；两种形状都认
  const cardInfo = asObj(pick(authorCard, "card")) ?? authorCard;

  /**
   * 主链那一 P：`pages[]` 里序号对上的一条。对不上（越界没夹好、上游少了这一条）时
   * 退回首 P——宁可交一份 P1 的答复，也不能让整篇稿件因为没有主链而解不出来。
   */
  const selectedPage = part.pages.find((p) => p.no === part.no) ?? part.pages[0] ?? null;
  const partItem = selectedPage?.item ?? null;
  const streams = mapBilibiliStream(selectedPage?.stream ?? null, cdnSlot);

  /**
   * 这一 P 到底是多长。
   *
   * 优先级：`timelength`（playurl 对**这次取流的那条媒体**的毫秒数）→ `pages[].duration`（秒）
   * → 顶层 `duration`。最后一个是合集的**总时长**，分 P 稿件拿它当交付时长会直接打断预览：
   * MSE 把 `MediaSource.duration` 写成总长，进度条于是比实际流长出一截，用户拖到这一 P
   * 末尾之后一直在等一段永远不会来的缓冲（2026-10-23 业主报「b站分P视频的dash流问题」）。
   */
  const totalSec = numAt(info, "duration");
  const durationMs =
    (selectedPage ? partDurationMs(selectedPage, streams) : undefined) ??
    (totalSec !== undefined ? totalSec * 1000 : undefined);

  /**
   * 分 P 清单：每一 P 一条资源，各带自己的档位、音轨与 MSE 身份。
   *
   * 标题取 `pages[].part`（分 P 名），合集名留给顶层：`page` 已足够让渲染层落
   * `P2-` 文件名前缀，不在标题里重复挂 `P2 ·`——那串会跟着进每一条分 P 的文件名，
   * 于是「P2-P2 · 第一集.mp4」，P 号重复占两次。
   * 取不到直链的 P 不列（`url` 是契约必填项，硬凑一条只会产出一个下不动的条目）。
   */
  const isMulti = part.pages.length > 1;
  const videos: ParsedVideoItem[] = part.pages
    .map((pg) => ({ pg, s: pg === selectedPage ? streams : mapBilibiliStream(pg.stream, cdnSlot) }))
    .filter(({ s }) => s.url)
    .map(({ pg, s }) => ({
      page: pg.no,
      title: strAt(pg.item, "part") ?? strAt(pg.item, "title"),
      duration: partDurationMs(pg, s),
      cover: strAt(pg.item, "pic") ?? strAt(pg.item, "first_frame") ?? strAt(info, "pic"),
      url: s.url as string,
      qualities: s.qualities.length > 0 ? s.qualities : undefined,
      audioUrl: s.audioUrl,
      videoCodecs: s.videoCodecs,
      videoMimeType: s.videoMimeType,
      audioCodecs: s.audioCodecs,
      audioMimeType: s.audioMimeType,
    }));

  const data: ParseData = {
    title: strAt(info, "title"),
    desc: strAt(info, "desc"),
    type: "video",
    duration: durationMs,
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
    // 封面跟主链那一 P 走：合集封面是 P1 的画面，用它当 P3 的主视觉会「图和片子对不上」
    cover: strAt(partItem, "pic") ?? strAt(partItem, "first_frame") ?? strAt(info, "pic"),
    url: streams.url,
    audioUrl: streams.audioUrl,
    videoCodecs: streams.videoCodecs,
    videoMimeType: streams.videoMimeType,
    audioCodecs: streams.audioCodecs,
    audioMimeType: streams.audioMimeType,
    bvid,
    // 只有合集才标 P：单 P 稿件标 `P1` 是白挂（文件名与条目都要多一个没人要的区分位）
    page: isMulti ? selectedPage?.no : undefined,
    qualities: streams.qualities.length > 0 ? streams.qualities : undefined,
    videos: videos.length > 0 ? videos : undefined,
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
  const fetchImpl = deps.fetchImpl ?? fetch;
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
    const ref = expanded ? extractId(platform, expanded) : null;
    // 落点没写 `?p=` 而短链那一份写了，用用户给的那一位：b23 展开出来常是裸 BV 链接，
    // 丢掉序号就等于把用户指的 P2 解成 P1
    if (ref && ref.page === undefined) ref.page = pageNumberIn(url);
    return ref;
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
          // 分 P 稿件的 `cid` 不总在顶层，只在 `pages[]` 里（2026-10-21 实测），而 `?p=N` 决定
          // 主链是第几 P（2026-10-23 业主报「b站分P视频的dash流问题」：永远取 pages[0]，用户指的
          // P2 解出来是 P1 的流）。越界夹到首/末——B 站自己就是这么处理的，给一条真流比报错好。
          const pageItems = asArr(pick(info, "pages"))
            .map((p) => asObj(p))
            .filter((p): p is Unknown => p !== null);
          // 「一个分 P 就是一份资源」（业主 2026-10-23）：每一 P 各取一次流——请求数 = P 数，与内核
          // 同量级（内核还要为每一档再请求一次），而一次 playurl 就带回该 P 的全部档位与音轨。
          // `pages` 缺失（只把 cid 写在顶层的老形状）时按顶层 cid 造一条，取流主干只剩一种形状。
          const pageSources =
            pageItems.length > 0
              ? pageItems.map((item, i) => ({ item, no: numAt(item, "page") ?? i + 1, cid: numAt(item, "cid") }))
              : [{ item: null, no: 1, cid: numAt(info, "cid") }];
          const partNo = Math.min(Math.max(ref.page ?? 1, 1), pageSources.length);
          const fetchPartStream = async (cid: number | undefined): Promise<Unknown | null> => {
            if (avid === undefined || cid === undefined) return null;
            try {
              const env = (await client.bilibili.fetchVideoStreamUrl({ avid, cid })) as AmagiEnvelope;
              return env.success ? unwrapBilibili(env.data) : null;
            } catch {
              // 某一 P 取流失败（加密稿、分 P 风控、接口抖动）只让这一 P 缺席，不能打死整次解析
              return null;
            }
          };
          const pages: BilibiliPage[] = await Promise.all(
            pageSources.map(async (p) => ({
              item: p.item,
              no: p.no,
              stream: await fetchPartStream(p.cid),
            }))
          );
          const part: BilibiliPart = { pages, no: partNo };
          // CDN 探测与名片并行：只在主链是 PCDN 且带镜像时真发请求，最坏多等 1.2s
          // 探测主链那一 P 的节点（用户点开就看到的那条），其余 P 沿用同一个节点偏好
          const mainStream = pages.find((p) => p.no === partNo)?.stream ?? null;
          const probe = mainStream ? probeEntry(mainStream) : null;
          const slotPromise = probe ? probeCdnSlot(probe, fetchImpl) : Promise.resolve(0);
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
          const data = mapBilibili(info, part, authorCard, await slotPromise);
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
