/**
 * 「来源链接」的真实资源页口径（v16，业主指令 2026-10-18：来源应当是真实资源链接，
 * 而不是供分享码跳转的短链）。
 *
 * 用户从 App 复制出来的是分享入口（`v.douyin.com/...`、`b23.tv/...`、`xhslink.com/...`），
 * 不是作品的地址：同一作品每次分享的短码都可能不同，历史页上既认不出、点开也只是再跳一次。
 * 落进历史/结果卡/下载 meta 的 `sourceUrl` 改成作品的官方页面：
 *
 * - 解析结果已经带作品 ID 的（抖音 `awemeId`、小红书 `noteId`、YouTube `videoId`）→
 *   直接拼官方地址，零网络、可复算；
 * - 其余短链（bilibili / 快手 / Twitter / TikTok / Instagram 等）→ 主进程跟一次跳转，
 *   落在哪个长链就存哪个（`electron/main/source-url.ts`）；
 * - 认不出、跟不动 → 原样保留。宁可留一条短链，也不许编一个打不开的地址。
 *
 * 零依赖（只 import 注册表与类型）：主进程与 dev mock 共用同一份，预览里的「来源」列
 * 与真版本不会各显示一套。
 */
import type { ParseData } from "../types/ipc";
import { platformDef, PLATFORMS } from "./platforms";

/** 作品 ID 只允许 URL path 段里的安全字符；别把内核带来的脏串拼进地址 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeId(value: string | undefined): string | undefined {
  return value && SAFE_ID.test(value) ? value : undefined;
}

/**
 * 解析结果 → 作品官方页面。只认**ID 与页面形态确定**的三家：
 * - 抖音：视频落 `/video/<awemeId>`，图文落 `/note/<awemeId>`（`data.type === "image"`）；
 * - 小红书：`/explore/<noteId>`；
 * - YouTube：`/watch?v=<videoId>`（含 `youtu.be` 短链解析出来的结果）。
 *
 * 其余平台不猜：bilibili 的 bvid、快手的 photoId 内核没有稳定出口，
 * 交给短链跟跳或原样保留。
 */
export function pageUrlFromData(
  platform: string | undefined,
  data: ParseData | undefined
): string | undefined {
  if (!data) return undefined;
  const key = platformDef(platform ?? "")?.key ?? platform ?? "";
  switch (key) {
    case "douyin": {
      const id = safeId(data.awemeId);
      if (!id) return undefined;
      return `https://www.douyin.com/${data.type === "image" ? "note" : "video"}/${id}`;
    }
    case "redbook": {
      const id = safeId(data.noteId);
      return id ? `https://www.xiaohongshu.com/explore/${id}` : undefined;
    }
    case "youtube": {
      const id = safeId(data.videoId);
      return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 是不是注册表登记过的短链入口（`shortDomains` 是唯一真源）。
 * 只认 http/https 与整段主机名：`notv.douyin.com` 不是 `v.douyin.com`，不能拿去跟跳。
 */
export function isShortLink(raw?: string | null): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  let host: string;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    host = url.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return false;
  }
  return PLATFORMS.some((p) => p.shortDomains.some((d) => host === d || host.endsWith(`.${d}`)));
}
