/**
 * 解析引擎宿主（docs/ARCHITECTURE.md §2 engine.ts）
 *
 * 职责：装配 core-adapter（cache/config/analytics/ratelimit）+ 解析内核，
 * 暴露 identify(text) / parse(textOrUrl) 两个纯异步方法。不做 HTTP、不碰窗口。
 *
 * 内核三态：
 * - local：只引用上游整解析核心 @mediaget/parse-core 的统一入口（unifiedParseLocal）。
 *   黑名单/识别/平台分发/全部平台解析器/快手兜底/直链验证/ID 模式都在核心内完成，
 *   本仓不再自维护平台解析器表 —— 覆盖清单由核心 localParserKeys() 如实给出。
 * - online：核心未覆盖或本地异常且设置开启回落时，经 fallback.ts 调线上 /api/parse
 *   （上游改版风暴时的逃生通道，不再是主通道）。
 * - mock：离线开发/测试用假内核（MG_KERNEL_MODE=mock 或两者皆不可用时兜底）。
 *
 * 铁律 2（依赖边界）：本文件只 import `@/lib/**`，永不 import `@/app/api/**`。
 *
 * ⚠️ 临时桥（§8 定稿 = `@mediaget/parse-core` 版本化工件）：parse-core 尚未发布
 * npm 工件，当前经 `@ → ../mediaGet/src` 物理链接 + src/lib 薄壳消费
 * `@/lib/unifiedCore`（真源 packages/parse-core/src/lib/unified-core.js）。
 * 工件首发后：本文件 import 换成 `@mediaget/parse-core` 公开入口；tsup 删
 * kernelAlias、tsconfig/vitest 删 `@` 别名、CI 删「Checkout kernel」并列检出。
 */
import { identifyPlatform, getPlatformName, PLATFORM_INFO } from "@/lib/platforms";
import { extractUrlFromShareText } from "@/lib/share-text";
import { isBlockedText } from "@/lib/blockedPlatforms";
import { normalizeResult } from "@/lib/normalize-result";
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
  /** 核心入口加载器覆盖（测试注入假核；缺省惰性 import 真 parse-core） */
  coreLoader?: () => Promise<CoreEntry>;
}

/**
 * 本地解析内核 = 上游整解析核心（parse-core）的统一入口，本仓不再自维护平台解析器表。
 * unifiedParseLocal 内含：黑名单 / 平台识别 / 全 21 平台解析器注册表 / 快手 17change
 * 兜底 / 直链有效性验证 / source+id 模式 —— 覆盖清单由核心 localParserKeys() 给出。
 *
 * ⚠️ 为什么惰性加载（P3-1 原样成立）：
 * 内核多个模块在**模块作用域**读取 process.env（ytDlpClient.js 的 `YTDLP_BIN`、
 * instagram.js 的 `IG_COOKIE`、youtube.js 的 `YOUTUBE_API_KEY`、
 * qqmusic-id.js 的 `QQMUSIC_COOKIE`、xhsCore 的 `XHS_COOKIE`、twitterCore 的
 * `TWITTER_FIXER_SERVICES` …），只在模块首次求值那一刻固化。注册表静态引满全部
 * 平台核，任何一处静态 import 都会把它们的 env 在 require 瞬间定死 —— 那时资源
 * 定位（resources.locate）与用户 Cookie 注入（settings.cookies）都还没铺进
 * process.env。推迟到**第一次真正解析**，此时 index.ts 的 publishKernelEnv()
 * 已执行完毕。esbuild/tsup 的 cjs 产物会把 `await import()` 编译成惰性 thunk，语义一致。
 */
export type CoreEntry = {
  unifiedParseLocal: (
    input: string,
    options?: { source?: string; id?: string }
  ) => Promise<Record<string, unknown>>;
  localParserKeys: () => string[];
};

let coreEntry: Promise<CoreEntry> | null = null;
function loadCore(): Promise<CoreEntry> {
  if (!coreEntry) {
    coreEntry = import("@/lib/unifiedCore") as Promise<CoreEntry>;
  }
  return coreEntry;
}
export function createEngine(deps: EngineDeps) {
  const cache = createResultCache();
  const analytics = createNoopAnalytics();
  const config = createConfigSource({
    read: deps.readKernelConfig,
    allowEnv: process.env.NODE_ENV === "development",
  });
  const throttle = createThrottle({ getIntervalMs: deps.getThrottleMs });
  const coreLoader = deps.coreLoader ?? loadCore;

  /** 平台清单（来自内核 PLATFORM_INFO，renderer 不复制） */
  function platforms() {
    return Object.entries(PLATFORM_INFO).map(([key, info]) => ({
      key,
      name: info.name,
      nameEn: info.nameEn,
      supportsIdParse: info.supportsIdParse,
    }));
  }

  /** 核心注册表平台清单（probe:engines 如实汇报覆盖率用；首次调用会触发内核惰性求值） */
  async function localCoverage(): Promise<string[]> {
    return (await coreLoader()).localParserKeys();
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
        desc: `来源 ${sourceUrl || "（无链接）"} —— 骨架期 mock 输出。本地内核（parse-core 统一入口）与线上回落均不可用时才走到这里。`,
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

    // —— 通道 1：本地内核（parse-core 统一入口，注册表覆盖全平台）——
    if (deps.forceMode !== "mock" && deps.forceMode !== "online" && !opts.forceOnline) {
      const core = await coreLoader();
      const covered = new Set(core.localParserKeys());
      const localEligible = url
        ? covered.has(platform)
        : !!source && covered.has(String(source).toLowerCase());
      if (localEligible) {
        try {
          const raw = url
            ? await core.unifiedParseLocal(url)
            : await core.unifiedParseLocal("", { source, id });
          const result = normalizeResult(raw) as unknown as ParseResult;
          // 核心未给出契约结果（解析器返回 undefined / 异形）= 本地失败，
          // 不能把 null 直接递给 renderer（UI 只会显示空错误）；沿用旧「本地失败 → 回落」语义。
          if (!result || typeof result.code !== "number") {
            const reason = "本地内核未返回有效解析结果";
            if (deps.isFallbackEnabled() && deps.onlineFallback) {
              return await viaOnlineFallback(
                url || input,
                platform,
                reason,
                t0,
                deps,
                cache,
                analytics,
                url ? undefined : { source, id, cacheKey }
              );
            }
            return {
              result: { code: 500, msg: `${reason}（${platform}）`, platform, failType: "script-error" },
              via: "local",
              durationMs: Date.now() - t0,
            };
          }
          if (result.code === 200) {
            result.platform = result.platform || platform;
            cache.set(cacheKey, result);
          } else if (!url && deps.isFallbackEnabled() && deps.onlineFallback) {
            // ID 模式本地未命中（核心解析器未挂 parseVideoId）→ 沿用旧行为给线上兜底
            return await viaOnlineFallback(
              url,
              platform,
              "本地内核 ID 解析未命中",
              t0,
              deps,
              cache,
              analytics,
              { source, id, cacheKey }
            );
          }
          analytics.track("parse", { platform, via: "local", ok: result.code === 200 });
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
          return await viaOnlineFallback(
            url || input,
            platform,
            reason,
            t0,
            deps,
            cache,
            analytics,
            url ? undefined : { source, id, cacheKey }
          );
        }
      }
    }

    if (deps.forceMode === "mock") {
      return { result: mockResult(url, platform || "mock"), via: "mock", durationMs: Date.now() - t0 };
    }

    // —— 通道 2：线上回落（核心未覆盖平台 / 强制线上时的逃生通道；README「失败回落」决策）——
    if (deps.isFallbackEnabled() && deps.onlineFallback) {
      return await viaOnlineFallback(
        url,
        platform,
        url ? "本地内核注册表未覆盖该平台" : "source+id 模式经线上入口解析",
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
