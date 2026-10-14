/**
 * 线上 API 回落（docs/ARCHITECTURE.md §2 fallback.ts）
 *
 * 本地解析失败 / 内核未覆盖的平台 → 转发线上 `GET {base}/api/parse?url=`。
 * 站点侧有 24h 结果缓存与全平台解析器，作为 P0 抽取完成前的主通道与最坏情况兜底。
 *
 * 超时与错误归类：网络错=source-unavailable；非 2xx=按状态归 failType；
 * 返回体保持线上契约 `{ code, msg, data, platform, failType }` 原样透传。
 */
import type { ParseResult } from "../../types/ipc";

export interface FallbackOptions {
  /** 线上 API 基址（设置页可改，默认 get.hotier.cc.cd） */
  getBase: () => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createOnlineFallback(options: FallbackOptions) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function onlineFallback(
    url: string,
    opts: { cookie?: string; source?: string; id?: string } = {}
  ): Promise<ParseResult | null> {
    const base = (options.getBase() || "").replace(/\/+$/, "");
    if (!base) return null;
    const fetchImpl = options.fetchImpl ?? fetch;
    // source+id 模式（无 url）原样转发参数；有 url 走主参数
    const qs = url
      ? `url=${encodeURIComponent(url)}`
      : opts.source && opts.id
        ? `source=${encodeURIComponent(opts.source)}&id=${encodeURIComponent(opts.id)}`
        : "";
    if (!qs) return null;
    const target = `${base}/api/parse?${qs}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-MediaGet-Desktop": "1",
    };
    // Cookie 透传通道：默认休眠（engine 从不传 opts.cookie）——README「用户
    // Cookie 不经过任何第三方服务器」是硬承诺；未来若要启用「用户知情增强」，
    // 必须先改 README/§6 口径，二者只能保一个。
    if (opts.cookie) headers["Cookie"] = opts.cookie;

    const resp = await fetchImpl(target, {
      headers,
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const err = new Error(`线上回落网络错误: ${msg}`) as Error & { failType?: string };
      err.failType = /timeout|abort/i.test(msg) ? "source-unavailable" : "sources-down";
      throw err;
    });

    if (!resp.ok && resp.status !== 200) {
      return {
        code: resp.status,
        msg: `线上 API HTTP ${resp.status}`,
        failType: resp.status === 429 ? "sources-down" : "source-unavailable",
      };
    }
    try {
      return (await resp.json()) as ParseResult;
    } catch {
      return { code: 502, msg: "线上 API 返回非 JSON", failType: "script-error" };
    }
  };
}
