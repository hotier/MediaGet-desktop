/**
 * 解析引擎宿主（docs/ARCHITECTURE.md §2 engine.ts）
 *
 * 职责：装配 core-adapter（cache/config/analytics/ratelimit）+ 引擎 runner 层（engines.ts），
 * 暴露 identify(text) / parse(textOrUrl) / health() 三个方法。不做 HTTP、不碰窗口。
 *
 * 两条判定分开放（2026-10-16 业主定调「引擎与供给解耦」）：
 * - **供不供**：`shared/platforms.ts` 注册表 + 用户开关（`settings.platformSwitches`）。
 *   关掉的平台在任何引擎被调用之前就回绝，不落网络请求。
 * - **能不能解**：引擎 runner 的 `covers()`（注册表能力位 ∧ 引擎自报覆盖）。
 *   顺序是本地内核 → 线上 API，前者失败才换后者；yt-dlp 今天仍埋在 parse-core 内部
 *   （只服务 tiktok），所以注册表记它 `declared` 而不是 ready，本文件不为它编一个假 runner。
 *
 * `via` 契约枚举保持 local/online/mock：它答的是「结果从本机还是线上来」，不是「哪个引擎解的」。
 *
 * 铁律 2（依赖边界）：本文件只 import `@mediaget/parse-core` 公开入口，永不跨界 web 侧 route。
 */
import {
  identifyPlatform,
  extractUrlFromShareText,
  isBlockedText,
  setKernelConfig,
  PARSE_CORE_VERSION,
  unifiedParseLocal,
  localParserKeys,
} from "@mediaget/parse-core";
import type { EngineHealth, ParseResult } from "../../types/ipc";
import {
  type PlatformSwitch,
  displayName,
  isEnabled,
  isRegistered,
  platformDef,
} from "../../shared/platforms";
import { createResultCache } from "../../core-adapter/cache";
import { createNoopAnalytics } from "../../core-adapter/analytics";
import { createConfigSource } from "../../core-adapter/config";
import { createThrottle } from "../../core-adapter/ratelimit";
import {
  type CoreEntry,
  type ParseEngine,
  buildHealth,
  createOnlineApiEngine,
  createParseCoreEngine,
  viaOf,
} from "./engines";

export type { CoreEntry } from "./engines";

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
  /** 线上 API 执行器（fallback.ts 注入；缺省视为该引擎不在场） */
  onlineFallback?: (
    url: string,
    opts: { cookie?: string; source?: string; id?: string }
  ) => Promise<ParseResult | null>;
  /** 是否允许线上 API 参与解析（设置页开关） */
  isFallbackEnabled: () => boolean;
  /**
   * 平台供给开关（读持久值，不读渲染层内存）：每次解析与体检各读一次，
   * 所以设置页改完不必重启也不用等 IPC 回灌。缺省（测试）= 全表空 = 跟随注册表默认。
   */
  getPlatformSwitches?: () => Record<string, PlatformSwitch>;
  /** 强制模式（测试/内测），auto 按能力降级 */
  forceMode?: KernelMode;
  /** 核心入口加载器覆盖（测试注入假核；缺省惰性取真 parse-core） */
  coreLoader?: () => Promise<CoreEntry>;
}

const loadRealCore = (): Promise<CoreEntry> => Promise.resolve({ unifiedParseLocal, localParserKeys });

export function createEngine(deps: EngineDeps) {
  console.log(`[engine] parse-core v${PARSE_CORE_VERSION} loaded`);

  const cache = createResultCache();
  const analytics = createNoopAnalytics();
  const config = createConfigSource({
    read: deps.readKernelConfig,
    allowEnv: process.env.NODE_ENV === "development",
  });
  const throttle = createThrottle({ getIntervalMs: deps.getThrottleMs });

  // 注入运行时配置到 parse-core（覆盖模块级 env 读死）
  setKernelConfig({
    bilibiliUserAgent: config.get("bilibiliUserAgent"),
    bilibiliCookie: config.get("bilibiliCookie"),
    douyinCookie: config.get("douyinCookie"),
    igCookie: config.get("igCookie"),
    igTimeoutMs: Number(config.get("igTimeoutMs") || ""),
    qqmusicCookie: config.get("qqmusicCookie"),
    twitterFixerServices: config.get("twitterFixerServices"),
    xhsCookie: config.get("xhsCookie"),
    youtubeSourceTimeoutMs: Number(config.get("youtubeSourceTimeoutMs") || ""),
    youtubeApiKey: config.get("youtubeApiKey"),
    youtubeApiTimeoutMs: Number(config.get("youtubeApiTimeoutMs") || ""),
    ytdlpBin: config.get("ytdlpBin"),
    ytdlpTimeoutMs: Number(config.get("ytdlpTimeoutMs") || ""),
  });

  const parseCoreEngine = createParseCoreEngine(deps.coreLoader ?? loadRealCore);
  const onlineEngine = createOnlineApiEngine({
    call: (url, o) => deps.onlineFallback!(url, o),
  });

  /** 当下在场的引擎，按优先顺序（设置只影响「在不在场」，不影响能力判定） */
  function availableEngines(opts: { forceOnline?: boolean }): ParseEngine[] {
    if (deps.forceMode === "mock") return [];
    const list: ParseEngine[] = [];
    if (deps.forceMode !== "online" && !opts.forceOnline) list.push(parseCoreEngine);
    if (deps.forceMode !== "local" && deps.isFallbackEnabled() && deps.onlineFallback) {
      list.push(onlineEngine);
    }
    return list;
  }

  const switches = (): Record<string, PlatformSwitch> => deps.getPlatformSwitches?.() ?? {};

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
      // 显示名取注册表：内核那份 PLATFORM_INFO 只是 parse-core 一个引擎的自述，
      // 名字的项目边界归注册表（qsmusic 就是内核没登记、我们有登记的那个）
      platformName: platform ? displayName(platform) : "",
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
        desc: `来源 ${sourceUrl || "（无链接）"} —— 骨架期 mock 输出。所有在场引擎都不覆盖这条链接时才走到这里。`,
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
    const fail = (result: ParseResult, via: KernelMode = "local"): ParseOutcomeLite => ({
      result,
      via,
      durationMs: Date.now() - t0,
    });

    // —— 黑名单（本地即时判定，与内核 unified-parser 同源）——
    const blockedName = isBlockedText(input);
    if (blockedName) {
      return fail({
        code: 400,
        msg: `暂不支持解析${blockedName}的内容（会员/付费/DRM 保护）`,
      });
    }

    // —— source+id 模式：supportsIdParse 取注册表（项目边界），不再问内核 ——
    if (!input && source && id) {
      const def = platformDef(source);
      if (!def) {
        return fail({ code: 400, msg: `未知平台: ${source}` });
      }
      if (!def.supportsIdParse) {
        return fail({ code: 400, msg: `${def.name} 平台不支持通过 ID 解析，请使用分享链接` });
      }
    }

    const found = identify(input);
    if (!found.url && !(source && id)) {
      return fail({
        code: 400,
        msg: "未能从分享文案中提取到有效链接，请确认文案中包含视频分享链接",
      });
    }
    const url = found.url ?? "";
    // platformHint 仅在内核识别失败时作为兜底（不覆盖识别结果，避免指鹿为马）
    const platform = found.platform || opts.platformHint || source || "";

    // —— 供给闸门：注册表关掉的平台，在任何引擎被调用之前就回绝 ——
    // 未登记的键不拦（自由串照旧交给引擎判定），注册表不许改写盘上认不出的东西
    if (platform && isRegistered(platform) && !isEnabled(platform, switches())) {
      return fail({
        code: 400,
        msg: `${displayName(platform)}：解析已在设置里关闭（设置 → 引擎）`,
        platform,
      });
    }

    // —— 本地缓存（LRU 24h；key 用归一后的 url 或 source+id）——
    const cacheKey = url || `${source}:${id}`;
    const cached = opts.forceOnline ? undefined : cache.get(cacheKey);
    if (cached && deps.forceMode !== "mock") {
      return { result: cached as ParseResult, via: "local", durationMs: Date.now() - t0 };
    }

    await throttle.acquire();

    // —— 引擎轮询：在场 ∧ 覆盖才调用，失败就带着理由换下一个 ——
    const notes: string[] = [];
    let lastFailed: ParseEngine | undefined;
    let lastResult: ParseResult | undefined;
    for (const engine of availableEngines(opts)) {
      if (!(await engine.covers(platform))) {
        notes.push(`${engine.label}未覆盖该平台`);
        continue;
      }
      const out = await engine.run({ platform, url, source, id });
      if (out.ok) {
        const result = out.result;
        if (result.code === 200) {
          result.platform = result.platform || platform;
          cache.set(cacheKey, result);
        }
        const via = viaOf(engine.id);
        analytics.track("parse", { platform, via, ok: result.code === 200 });
        const reason = notes.join("；") || undefined;
        return { result, via, fallbackReason: reason, durationMs: Date.now() - t0 };
      }
      notes.push(out.reason);
      lastFailed = engine;
      lastResult = out.result;
    }

    if (lastFailed && lastResult) {
      // 没有下一个引擎了：把最后一个引擎的失败答复如实交给 renderer，不拿 mock 冒充成功
      const via = viaOf(lastFailed.id);
      analytics.track("parse", { platform, via, ok: false });
      return { result: lastResult, via, fallbackReason: notes.join("；"), durationMs: Date.now() - t0 };
    }

    // —— 没有引擎在场/覆盖：强制 mock 或 mock 兜底（离线演示，来源如实标注）——
    return fail(mockResult(url, platform || "unknown"), "mock");
  }

  /** 平台能力体检：注册表 × 在场引擎 × 用户开关（probe:engines 与设置页矩阵共用） */
  async function health(): Promise<EngineHealth[]> {
    return buildHealth(availableEngines({}), switches());
  }

  /** 本地内核自报的覆盖清单（保留给测试与将来的引擎对比用） */
  async function localCoverage(): Promise<string[]> {
    return (await (deps.coreLoader ?? loadRealCore)()).localParserKeys();
  }

  return {
    identify,
    parse,
    health,
    localCoverage,
    config,
    cache,
    analytics,
  };
}
