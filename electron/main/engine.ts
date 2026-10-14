/**
 * 解析引擎宿主（docs/ARCHITECTURE.md §2 engine.ts）
 *
 * 职责：装配 core-adapter（cache/config/analytics/ratelimit）+ 解析内核，
 * 暴露 identify(text) / parse(textOrUrl) 两个纯异步方法。不做 HTTP、不碰窗口。
 *
 * 内核三态（README「内核耦合」+ §8「P0 未完成前本仓只实现骨架 + mock 内核」）：
 * - local：直接 import mediaGet `src/lib/**` 纯模块（单一代码源，物理链接方案 A）。
 *   P0 进度决定可用解析面：目前仅 kuaishou（parseKuaishou）完成纯函数化抽取；
 *   识别 / 黑名单 / 归一化 / 文案提取等纯模块全部本地可用。
 * - online：local 面之外（解析器还在 route 层的平台）且设置开启回落时，
 *   经 fallback.ts 调线上 /api/parse —— 这是 P0 未完成期间的**主解析通道**。
 * - mock：离线开发/测试用假内核（MG_KERNEL_MODE=mock 或两者皆不可用时兜底）。
 *
 * 铁律 2（依赖边界）：本文件只 import `@/lib/**`，永不 import `@/app/api/**`。
 *
 * ⚠️ 临时桥（§8 定稿 = `@mediaget/parse-core` 版本化工件）：
 * parse-core 尚未发布，当前用 `@ → ../mediaGet/src` 物理链接顶替。工件首发后
 * 按此清单切换（一次 PR 完成，防误读成违宪）：
 *  1. engine.ts / ipc.ts / core-adapter/cache.ts 的 `@/lib/*`、`@/utils/filename`
 *     import 换成 `@mediaget/parse-core` 对应公开入口；
 *  2. tsup.config.ts 删 kernelAlias 插件；tsconfig/vitest 删 `@` 别名；
 *  3. .github/workflows/ci.yml 删「Checkout kernel」并列检出步骤；
 *  4. LOCAL_PARSERS 表内容改由工件入口导出（上游抽取进度 = 升版本号）。
 */
import { identifyPlatform, getPlatformName, PLATFORM_INFO } from "@/lib/platforms";
import { extractUrlFromShareText } from "@/lib/share-text";
import { isBlockedText } from "@/lib/blockedPlatforms";
import { normalizeResult } from "@/lib/normalize-result";
import { parseKuaishou } from "@/lib/kuaishouCore";
import type { ParseResult } from "../../types/ipc";
import { createResultCache } from "../../core-adapter/cache";
import { createNoopAnalytics } from "../../core-adapter/analytics";
import { createConfigSource } from "../../core-adapter/config";
import { createThrottle } from "../../core-adapter/ratelimit";

export type KernelMode = "local" | "online" | "mock";

export interface IdentifyOutcomeLite {
  platform: string;
  platformName: string;
  url: string | null;
  kind: "url" | "share-text" | "unknown";
}

export interface ParseOutcomeLite {
  result: ParseResult;
  via: KernelMode;
  fallbackReason?: string;
  durationMs: number;
}

export interface EngineDeps {
  /** 本地内核配置读取（store 注入，core-adapter/config 第一级） */
  readKernelConfig: (key: string) => string | undefined;
  /** 节流毫秒（设置页实时值） */
  getThrottleMs: () => number;
  /** 线上回落执行器（fallback.ts 注入；缺省视为关闭） */
  onlineFallback?: (
    url: string,
    opts: { cookie?: string; source?: string; id?: string }
  ) => Promise<ParseResult | null>;
  /** 是否允许线上回落（设置页开关） */
  isFallbackEnabled: () => boolean;
  /** 强制模式（测试/内测），auto 按能力降级 */
  forceMode?: KernelMode;
}

/**
 * 本地已抽取完成（P0 项 1）的平台解析器表。
 * 上游每完成一个平台纯函数化（parseCore 提取进 src/lib/<platform>Core.js），
 * 就在这里加一行 —— 这是两仓之间唯一的、显式的耦合点。
 */
const LOCAL_PARSERS: Record<
  string,
  (url: string) => Promise<Record<string, unknown>>
> = {
  kuaishou: parseKuaishou as unknown as (url: string) => Promise<Record<string, unknown>>,
};

export function createEngine(deps: EngineDeps) {
  const cache = createResultCache();
  const analytics = createNoopAnalytics();
  const config = createConfigSource({
    read: deps.readKernelConfig,
    allowEnv: process.env.NODE_ENV === "development",
  });
  const throttle = createThrottle({ getIntervalMs: deps.getThrottleMs });

  /** 平台清单（来自内核 PLATFORM_INFO，renderer 不复制） */
  function platforms() {
    return Object.entries(PLATFORM_INFO).map(([key, info]) => ({
      key,
      name: info.name,
      nameEn: info.nameEn,
      supportsIdParse: info.supportsIdParse,
    }));
  }

  /** 本地已抽取内核的平台集合（probe:engines 如实汇报覆盖率用） */
  function localCoverage(): string[] {
    return Object.keys(LOCAL_PARSERS);
  }

  /**
   * 线上回落当前是否真的可用（与 parse 的通道 2 判定同源，
   * probe:engines 据此汇报，避免 UI 体检与实际走线不一致）。
   */
  function fallbackAvailable(): boolean {
    return deps.isFallbackEnabled() && !!deps.onlineFallback;
  }

  /** 纯本地识别：不发起任何网络请求 */
  function identify(text: string): IdentifyOutcomeLite {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return { platform: "", platformName: "", url: null, kind: "unknown" };

    const url = extractUrlFromShareText(trimmed);
    const kind: IdentifyOutcomeLite["kind"] = !url
      ? "unknown"
      : trimmed === url
        ? "url"
        : "share-text";
    if (!url) return { platform: "", platformName: "", url: null, kind };

    // 汽水音乐特判与 unified-parser 对齐（.douyin.com 后缀误判防护）
    const platform = /music\.douyin\.com|qishui\.douyin\.com/i.test(url)
      ? "qsmusic"
      : (identifyPlatform(url) ?? "");
    return {
      platform,
      platformName: platform ? getPlatformName(platform) : "",
      url,
      kind,
    };
  }

  /** mock 内核结果：结构上完全符合 normalize-result 契约，供 UI 联调与离线测试 */
  function mockResult(sourceUrl: string, platform: string): ParseResult {
    return {
      code: 200,
      msg: "解析成功（mock 内核）",
      platform,
      data: {
        type: "video",
        title: `mock · ${platform} · 演示结果`,
        desc: `来源 ${sourceUrl || "（无链接）"} —— 骨架期 mock 输出。P0 内核抽取完成后本地解析自动启用；未抽取平台走线上回落。`,
        author: "mock-author",
        cover: "",
        url: "https://example.com/mock/video.mp4",
        images: [],
      },
    };
  }

  async function parse(
    rawInput: string,
    source?: string,
    id?: string,
    opts: { platformHint?: string; forceOnline?: boolean } = {}
  ): Promise<ParseOutcomeLite> {
    const t0 = Date.now();
    const input = (rawInput ?? "").trim();

    // —— 黑名单（本地即时判定，与内核 unified-parser 同源）——
    const blockedName = isBlockedText(input);
    if (blockedName) {
      return {
        result: {
          code: 400,
          msg: `暂不支持解析${blockedName}的内容（会员/付费/DRM 保护）`,
        },
        via: "local",
        durationMs: Date.now() - t0,
      };
    }

    // —— source+id 模式：依赖 supportsIdParse（识别层本地判定）——
    if (!input && source && id) {
      const info = (PLATFORM_INFO as Record<string, { name: string; supportsIdParse: boolean }>)[
        source.toLowerCase()
      ];
      if (!info) {
        return { result: { code: 400, msg: `未知平台: ${source}` }, via: "local", durationMs: Date.now() - t0 };
      }
      if (!info.supportsIdParse) {
        return {
          result: { code: 400, msg: `${info.name} 平台不支持通过 ID 解析，请使用分享链接` },
          via: "local",
          durationMs: Date.now() - t0,
        };
      }
    }

    const found = identify(input);
    if (!found.url && !(source && id)) {
      return {
        result: { code: 400, msg: "未能从分享文案中提取到有效链接，请确认文案中包含视频分享链接" },
        via: "local",
        durationMs: Date.now() - t0,
      };
    }
    const url = found.url ?? "";
    // platformHint 仅在内核识别失败时作为兜底（不覆盖识别结果，避免指鹿为马）
    const platform = found.platform || opts.platformHint || source || "";

    // —— 本地缓存（LRU 24h；key 用归一后的 url 或 source+id）——
    const cacheKey = url || `${source}:${id}`;
    const cached = opts.forceOnline ? undefined : cache.get(cacheKey);
    if (cached && deps.forceMode !== "mock") {
      return {
        result: cached as ParseResult,
        via: "local",
        durationMs: Date.now() - t0,
      };
    }

    await throttle.acquire();

    // —— 通道 1：本地内核（P0 已抽取的平台）——
    const localParser = deps.forceMode === "mock" || opts.forceOnline ? undefined : LOCAL_PARSERS[platform];
    if (localParser && deps.forceMode !== "online") {
      try {
        const raw = await localParser(url);
        const result = normalizeResult(raw) as unknown as ParseResult;
        if (result?.code === 200) {
          result.platform = result.platform || platform;
          cache.set(cacheKey, result);
        }
        analytics.track("parse", { platform, via: "local", ok: result?.code === 200 });
        return { result, via: "local", durationMs: Date.now() - t0 };
      } catch (e) {
        // 本地失败 → 继续走回落，不吞错
        const reason = e instanceof Error ? e.message : String(e);
        if (!deps.isFallbackEnabled() || !deps.onlineFallback) {
          return {
            result: { code: 500, msg: `本地解析失败：${reason}`, platform, failType: "script-error" },
            via: "local",
            durationMs: Date.now() - t0,
          };
        }
        return await viaOnlineFallback(url || input, platform, reason, t0, deps, cache, analytics);
      }
    }

    if (deps.forceMode === "mock") {
      return { result: mockResult(url, platform || "mock"), via: "mock", durationMs: Date.now() - t0 };
    }

    // —— 通道 2：线上回落（P0 未抽取平台的主通道；README「失败回落」决策）——
    if (deps.isFallbackEnabled() && deps.onlineFallback) {
      return await viaOnlineFallback(
        url,
        platform,
        url ? "本地内核尚未支持该平台（P0 抽取进行中）" : "source+id 模式经线上入口解析",
        t0,
        deps,
        cache,
        analytics,
        url ? undefined : { source, id, cacheKey }
      );
    }

    // —— 通道 3：mock 兜底（离线骨架演示，明确标注来源不骗人）——
    return { result: mockResult(url, platform || "unknown"), via: "mock", durationMs: Date.now() - t0 };
  }

  return {
    identify,
    parse,
    platforms,
    localCoverage,
    fallbackEnabled: fallbackAvailable,
    config,
    cache,
    analytics,
  };
}

async function viaOnlineFallback(
  url: string,
  platform: string,
  reason: string,
  t0: number,
  deps: EngineDeps,
  cache: ReturnType<typeof createResultCache>,
  analytics: ReturnType<typeof createNoopAnalytics>,
  sid?: { source?: string; id?: string; cacheKey?: string }
): Promise<ParseOutcomeLite> {
  try {
    const online = await deps.onlineFallback!(url, {
      source: sid?.source,
      id: sid?.id,
    });
    const cacheKey = sid?.cacheKey || url;
    if (online && online.code === 200) {
      const result = normalizeResult(online) as ParseResult;
      result.platform = result.platform || platform;
      cache.set(cacheKey, result);
      analytics.track("parse", { platform, via: "online", ok: true });
      return { result, via: "online", fallbackReason: reason, durationMs: Date.now() - t0 };
    }
    return {
      result: online ?? { code: 502, msg: "线上回落无结果", platform, failType: "sources-down" },
      via: "online",
      fallbackReason: reason,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      result: {
        code: 502,
        msg: `线上回落失败：${msg}`,
        platform,
        failType: "sources-down",
      },
      via: "online",
      fallbackReason: reason,
      durationMs: Date.now() - t0,
    };
  }
}
