/**
 * 历史记录的身份规则（业主指令 2026-10-17：历史页是**解析历史**，不是下载台账）。
 *
 * 「解析一次就有一条记录」之后，同一个作品必然同时存在一条解析行（没有文件）与若干
 * 下载行（每个落地文件一条）。它们必须是界面里的**一行**，所以行身份不能由写入方各自编，
 * 得由链接算出来 —— 这就是 `workKeyOf`：解析侧与下载侧分别写行、却算出同一个键。
 *
 * 零依赖：不 import zod / electron / node:crypto，主进程、渲染进程与 dev mock 共用同一份，
 * 所以 dev 预览里的历史形状与真版本一致（漂移 = 拿预览评审了一个不存在的界面）。
 */
import type { AuthorSnapshot, HistoryEntry, WorkStat } from "../types/ipc";

/** FNV-1a 32 位：纯算术、跨进程可复算，不需要 crypto */
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 追踪/分享参数：同一个作品从不同入口复制出来，这些参数每次都不一样
 * （`spm_id_from`、`vd_source`、`xsec_token`、`si`、`igsh`…），留在键里就是重复行。
 * 只删**认得出**的；认不出的参数仍参与身份 —— 宁可多一行，不可把两个作品合成一行。
 */
const TRACKING_QUERY_KEYS = new Set([
  "appuid",
  "apptime",
  "author_share",
  "band_rank",
  "bbid",
  "buvid",
  "cc",
  "did",
  "display",
  "end",
  "enter_from",
  "enter_method",
  "exsource",
  "extra_params",
  "feature",
  "from",
  "from_ssr",
  "from_source",
  "from_spmid",
  "iid",
  "img_index",
  "is_copy_url",
  "is_from_webapp",
  "is_story_h5",
  "kpn",
  "msource",
  "plat_id",
  "pp",
  "previous_page",
  "ref",
  "ref_src",
  "ref_url",
  "refer_flag",
  "region",
  "sec_user_id",
  "sender_device",
  "share_android_em_id",
  "share_from",
  "share_from_user_hidden",
  "share_id",
  "share_link_id",
  "share_medium",
  "share_plat",
  "share_refer",
  "share_scene",
  "share_session_id",
  "share_sign",
  "share_source",
  "share_tag",
  "share_times",
  "share_token",
  "sharesign",
  "sharesource",
  "sharetoken",
  "si",
  "start",
  "sudaref",
  "t",
  "timestamp",
  "titletype",
  "trackid",
  "ts",
  "u_code",
  "unique_k",
  "up_id",
  "vd_source",
  "web_id",
  "with_sec_did",
  "xsec_source",
  "xsec_token",
  "xhsshare",
]);

// 前缀同时覆盖 snake_case 与分享参数常见的 camelCase（`shareSource` / `refSrc` / `fromSpmid`）
const TRACKING_QUERY_PREFIXES = ["from", "igsh", "ref", "share", "spm", "track", "utm", "xsec"];

function isTrackingQueryKey(key: string): boolean {
  return (
    TRACKING_QUERY_KEYS.has(key) ||
    TRACKING_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** `www.` / `m.` / `mobile.` 只是同一站点的入口形态，不进身份 */
function cleanHost(hostname: string): string {
  let host = hostname.toLowerCase().replace(/\.+$/, "");
  while (/^(?:www|m|mobile)\./.test(host)) host = host.replace(/^(?:www|m|mobile)\./, "");
  return host;
}

/** 百分号编码只统一写法：非保留字符解出来，其余十六进制大写（`%2f` 与 `%2F` 同键） */
function cleanPath(pathname: string): string {
  const decoded = pathname.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => {
    const code = parseInt(hex, 16);
    const unreserved =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e;
    return unreserved ? String.fromCharCode(code) : `%${hex.toUpperCase()}`;
  });
  return decoded.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/**
 * 查询串：剔除追踪参数、丢掉空值、按键值排序 —— 顺序不同、参数多寡不同都算同一个作品。
 * `p=1` 是 b 站分 P 的默认值，与不带 `p` 等价；`p=2` 才是另一个分 P，必须留住。
 */
function cleanSearch(search: string): string {
  const kept: Array<[string, string]> = [];
  for (const [rawKey, value] of new URLSearchParams(search)) {
    const key = rawKey.toLowerCase();
    if (!key || !value) continue;
    if (isTrackingQueryKey(key)) continue;
    if (key === "p" && value === "1") continue;
    kept.push([rawKey, value]);
  }
  kept.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1
  );
  return kept.length > 0 ? new URLSearchParams(kept).toString() : "";
}

/**
 * 链接归一：身份只看「主机 + 路径 + 有意义的查询参数」，不看协议、`www`/移动前缀、
 * 片段、尾部斜杠、参数顺序与分享追踪参数。
 *
 * 两处**刻意保留**：
 * - 协议不参与（http/https 指向同一作品），但主机、路径大小写原样保留（`BV1xx` 是大小写敏感的 ID）；
 * - 认不出的查询参数保留（见 `TRACKING_QUERY_KEYS`），避免把两个不同作品合成一行。
 *
 * 短链与长链（`b23.tv` vs `bilibili.com`）无法在离线层互认，仍会各算一个键 —— 那需要真解析。
 */
export function canonicalSourceUrl(sourceUrl?: string | null): string | undefined {
  const raw = (sourceUrl ?? "").trim().replace(/^[\u200b-\u200d\ufeff]+|[\u200b-\u200d\ufeff]+$/g, "");
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 抽出来的不是合法 URL（理论上到不了这里）：只做最保守的收尾，不猜结构
    return raw.replace(/[，。！？、；：.,!?;]+$/, "").replace(/\/+$/, "");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return raw;
  const host = cleanHost(parsed.hostname) + (parsed.port ? `:${parsed.port}` : "");
  const path = cleanPath(parsed.pathname);
  const query = cleanSearch(parsed.search);
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * 作品键 = 归一后链接的 64 位摘要（两段 32 位 FNV 拼起来）。
 *
 * 为什么是摘要而不是链接原文：它要当 `id`/`groupId` 用，而 `history:remove` 的键宽上限 64；
 * 为什么要 64 位而不是 32 位：撞上一次的后果是两个不相干的作品在历史页合成一行、
 * 文件数与作者互相污染，这类错在界面上永远查不出来。5000 条窗口下 32 位的碰撞概率已不可忽略。
 *
 * 键的来源必须是**归一后的链接**：同一条作品从不同入口复制会有尾部斜杠、分享参数、
 * 参数顺序等差异（本机实测 `BV1VTYT6tEV2` 与 `BV1VTYT6tEV2/` 落成了两行）。
 */
export function workKeyOf(sourceUrl?: string | null): string | undefined {
  const url = canonicalSourceUrl(sourceUrl);
  if (!url) return undefined;
  const a = fnv1a(url, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a(`${url}#mediaget`, 0x9e3779b9).toString(16).padStart(8, "0");
  return `w-${a}${b}`;
}

/**
 * 读侧补算作品键（幂等，不回写文件）。
 *
 * 键算法改为「归一后再摘要」之前落盘的行，`id`/`groupId` 还是原始链接的摘要；
 * 但 `sourceUrl` 一直在档里，所以能就地重算。两类行分开处理：
 * - 解析行（files 空且 id === groupId）：`id` 与 `groupId` 一起换；同作品因链接形态
 *   不同留下的多条旧解析行按「最新在前」只留第一条；
 * - 下载行（id 是任务 id）：只换 `groupId`，每条文件行一条不少。
 *
 * 不重写文件与平台键迁移同一条口径：读时归一，下一次写盘自然带上新键。
 */
export function normalizeHistoryKeys(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const seenParse = new Set<string>();
  for (const entry of entries) {
    const key = workKeyOf(entry.sourceUrl);
    if (!key) {
      out.push(entry);
      continue;
    }
    const isParseRow = (entry.files?.length ?? 0) === 0 && entry.id === entry.groupId;
    if (!isParseRow) {
      out.push(entry.groupId === key ? entry : { ...entry, groupId: key });
      continue;
    }
    if (seenParse.has(key)) continue;
    seenParse.add(key);
    out.push(entry.id === key ? entry : { ...entry, id: key, groupId: key });
  }
  return out;
}

/**
 * 这一行有没有落地文件。
 * 「解析过但没下载」就是 files 为空 —— 不另设标志位：文件数既是历史页那一列，也就是事实本身。
 */
export const isLanded = (entry: { files: string[] }): boolean => entry.files.length > 0;

/**
 * 解析成功 → 一条历史行（未下载态）。
 *
 * 只取标题、平台、作者快照、发布时间与计数快照：**媒体直链一概不进这里**（隐私红线，
 * `data.url` / `images[]` / `qualities[].url` 都是直链）。放在共享层而不是主进程内联，是因为
 * dev mock 要写出同一形状的行，两处各写一遍迟早漏掉某个字段，而漏掉的字段在界面上只是
 * 「少了一块」，不会有人报错。
 *
 * `stat` / `publishedAt` 由 `shared/work-stat.ts` 归一后再进来 —— 写入方不许自己挑内核字段，
 * 否则主进程与 mock 会各挑一套，导出里的「点赞」在两处含义不同。
 */
export function parseHistoryEntry(input: {
  /** 用户输入的分享链接（identify 归一后的那条），非直链 */
  sourceUrl?: string;
  platform?: string;
  title?: string;
  author?: AuthorSnapshot;
  /** 作品在平台上的发布时刻（本地毫秒），归一见 shared/work-stat.ts */
  publishedAt?: number;
  /** 解析那一刻的公开互动数 */
  stat?: WorkStat;
  /** 链接算不出作品键时（ID 直解模式）由调用方给一次性 id */
  fallbackId: string;
  at: number;
}): HistoryEntry {
  const key = workKeyOf(input.sourceUrl);
  return {
    id: key ?? input.fallbackId,
    // 有作品键时 groupId 与 id 同值：聚合按 groupId，重复解析覆盖按 id，两条规则指向同一个作品
    groupId: key,
    platform: input.platform,
    title: input.title,
    sourceUrl: input.sourceUrl,
    author: input.author,
    publishedAt: input.publishedAt,
    stat: input.stat,
    files: [],
    createdAt: input.at,
  };
}
