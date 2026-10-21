/**
 * 直链续取器（403 之后由下载器调用；业主指令 2026-10-17「这类情况静默重试会不会好一点」）。
 *
 * 这里只做一件事：**同一个作品在短时间内只再解析一次**。
 * 一次下载通常带着好几条任务（图集 20 张、多 P 若干），它们的直链是同一次解析发的、
 * 也就会一起过期。逐任务各解析一次等于在用户已经等了一会儿之后，再拿 N 倍请求去打平台
 * （抖音那类还会因高频返回 -412 风控）。所以按分享链接合并：并发任务共用同一个在飞请求，
 * 已完成的結果在 TTL 内直接复用。
 *
 * 再解析必须绕开结果缓存：主进程那份 24 小时缓存（`core-adapter/cache.ts`）存的正是
 * 带过期直链的那份结果，不绕开就永远拿回同一条死链，用户怎么重试都是同一个 403。
 * 用的是 `engine.parse(..., { skipCache: true })`：主进程那份 24 小时缓存存的正是
 * 带过期直链的那份结果，不绕开就永远拿回同一条死链，用户怎么重试都是同一个 403。
 * 换回来的新结果照常回写缓存，同一条作品接下来的解析也跟着换上活链。
 *
 * 直链不进历史与队列（§6 第 11 条）；日志本身可以带直链（§6 第 7 条），但这里**只报条数**——
 * 本模块每次 403 都会跑，逐条打链只会把 app.log 冲淡，而「拿到 0 条」与
 * 「拿到 N 条但认不出这一份」是两种完全不同的故障（前者是引擎/风控没给结果，后者是判据太严），
 * 只打一句「续链无结果」分不清，排查时只能靠猜。
 */
import type { ParseData } from "../../types/ipc";
import { collectMediaUrls, pickRenewedUrl } from "../../shared/link-identity";

/** 同一作品多久内只再解析一次（图集/多 P 的连环 403 共用一份新链） */
const DEFAULT_TTL_MS = 60_000;
/** 合并表上限：桌面单机一次会话不会同时有几十个工作日在续链，超了丢最旧的 */
const MAX_ENTRIES = 24;

export interface LinkRenewerDeps {
  /** 绕开结果缓存再解析一次，失败/无结果时返回 undefined */
  reparse: (sourceUrl: string) => Promise<ParseData | undefined>;
  ttlMs?: number;
  now?: () => number;
}

export interface LinkRenewer {
  (failedUrl: string, sourceUrl?: string): Promise<string | null>;
}

interface Entry {
  at: number;
  urls: Promise<string[]>;
}

export function createLinkRenewer(deps: LinkRenewerDeps): LinkRenewer {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const memo = new Map<string, Entry>();

  function freshUrls(sourceUrl: string): Promise<string[]> {
    const hit = memo.get(sourceUrl);
    if (hit && now() - hit.at < ttlMs) return hit.urls;
    if (memo.size >= MAX_ENTRIES) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    // 失败也进表：TTL 内不再重复捶平台，那批任务照原样报错就是正确答案
    const urls = deps
      .reparse(sourceUrl)
      .then((data) => collectMediaUrls(data))
      .catch(() => [] as string[]);
    memo.set(sourceUrl, { at: now(), urls });
    return urls;
  }

  return async (failedUrl, sourceUrl) => {
    const key = (sourceUrl ?? "").trim();
    if (!key) return null;
    const urls = await freshUrls(key);
    const next = pickRenewedUrl(failedUrl, urls);
    if (!next) {
      // 0 条 = 重解析没拿到任何直链（引擎失败/风控）；>=1 条 = 拿到了但没认出同一条资源（判据/换了资源形态）
      console.warn(`[download] 续链未命中：新结果 ${urls.length} 条直链，未认出同一条资源`);
    }
    return next;
  };
}
