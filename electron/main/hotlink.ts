/**
 * 防盗链身份（docs/ARCHITECTURE.md §4）：一条媒体直链要带上「哪来的」和「用什么客户端来的」。
 *
 * 下载链路早就带这对头，预览链路也必须带 —— 两处各自抄一份域名表或 UA 就是第二真源，
 * 平台改名或内核换 UA 口径时只会改到一半，症状是「能下载不能预览」这种最难归因的组合。
 */
import { PLATFORM_INFO } from "@mediaget/parse-core";
import { resolveKey } from "../../shared/platforms";

/**
 * 桌面 UA：照抄内核 `lib/http.ts` 的口径，不私自加码（伪装成浏览器版本更新的内核
 * 只会让 CDN 判定更飘）。下载器与预览代理共用这一枚常量。
 */
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 平台 → 站点源 Referer 的覆盖表：只登记「按内核域名首项拼会被图床拒发」的那几档。
 *
 * 为什么不能一律用 `PLATFORM_INFO.domains[0]`：内核那张表答的是「哪些域名算这个平台」
 * （识别用），而防盗链认的是**站点源**。`redbook` 的图床对裸域名直接 403、只认带 www 的源
 * （2026-10-19 实测：同一路径 none=404 / `https://xiaohongshu.com/`=403 /
 * `https://www.xiaohongshu.com/`=404）——少了 `www` 就是整片图裂，而症状与「直链过期」
 * 同形，只能靠这张表钉住。新增条目必须有实测依据，别凭猜测往这里加。
 */
const REFERER_ORIGIN: Record<string, string> = {
  redbook: "https://www.xiaohongshu.com/",
};

/** 平台 → 防盗链 Referer（域名真源 = 内核 PLATFORM_INFO，站点源差异见上表） */
export function refererFor(platform: string | undefined): string | undefined {
  if (!platform) return undefined;
  // 别名键（`xhs`）先归一到契约键：原样去查表会 miss，而 miss 的表现是「静默不带 Referer」，
  // 正是图床回 403 的那一档（与 AGENTS「写进 history/stats 前一律 resolveKey」同一条纪律）
  const key = resolveKey(platform);
  const origin = REFERER_ORIGIN[key];
  if (origin) return origin;
  const info = (PLATFORM_INFO as Record<string, { domains: string[] }>)[key];
  return info?.domains?.[0] ? `https://${info.domains[0]}/` : undefined;
}
