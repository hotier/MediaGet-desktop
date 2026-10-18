/**
 * 来源链接跟跳（主进程专用；纯口径在 `shared/source-url.ts`）。
 *
 * 只在解析成功、且解析结果里拼不出官方页面时才发这一次请求：
 * - `b23.tv` → `www.bilibili.com/video/BV…`、`v.kuaishou.com` → `www.kuaishou.com/short-video/…`、
 *   `t.co` → `x.com/…`、`vm.tiktok.com` → `www.tiktok.com/@…/video/…`；
 * - 只要 `response.url`，正文立刻 cancel —— 这里不是抓页面，是问「短码最终指向哪」。
 *
 * 失败不是解析失败：超时、断网、反爬一律回落到用户给的那条链接（历史不能因为一次探测
 * 少一格）。URL 不进日志（隐私红线与 `AGENTS.md` §6 同一条）。
 */
import type { ParseData } from "../../types/ipc";
import { isShortLink, pageUrlFromData } from "../../shared/source-url";

const FOLLOW_TIMEOUT_MS = 2500;

const SHORT_LINK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface SourceUrlInput {
  /** 用户输入里抽出的原始链接（可能是短链） */
  raw?: string | null;
  platform?: string;
  /** 解析结果：有作品 ID 时不必发请求 */
  data?: ParseData;
}

export type SourceUrlResolver = (input: SourceUrlInput) => Promise<string | undefined>;

/**
 * 造一个解析器。`fetchImpl` / `timeoutMs` 只为测试注入 —— 本仓测试禁真网络，
 * 生产走默认单例。
 */
export function createSourceUrlResolver(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): SourceUrlResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FOLLOW_TIMEOUT_MS;

  return async ({ raw, platform, data }) => {
    // 作品 ID 优先：官方页面比跟跳更准，也不必再发一次网络请求
    const derived = pageUrlFromData(platform, data);
    if (derived) return derived;

    const trimmed = (raw ?? "").trim();
    if (!trimmed) return undefined;
    if (!isShortLink(trimmed)) return trimmed;

    try {
      const response = await fetchImpl(trimmed, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": SHORT_LINK_UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const finalUrl = response.url;
      // 只问落点，不读正文；不 cancel 会白白把整页 HTML 拉进内存
      void response.body?.cancel().catch(() => {});
      if (/^https?:\/\//i.test(finalUrl) && !isShortLink(finalUrl)) return finalUrl;
    } catch {
      // 断网/超时/反爬：保持原链接
    }
    return trimmed;
  };
}

/** 主进程单例（index.ts / ipc.ts 用这一份） */
export const resolveSourceUrl: SourceUrlResolver = createSourceUrlResolver();
