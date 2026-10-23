/**
 * 解析引擎宿主（docs/ARCHITECTURE.md §2 engine.ts）
 *
 * 职责：装配 core-adapter（cache/config/analytics/ratelimit）+ 引擎 runner 层（engines.ts），
 * 暴露 identify(text) / parse(textOrUrl) / health() 三个方法。不做 HTTP、不碰窗口。
 *
 * 出口另有一层类型收拢（`emit`）：内核只映射字段名、不统一字段类型，脏值会被抄进历史档并让
 * 整次列表过不了出参校验。契约就是那张表，本文件按声明收，不在这里维护平台清单。
 *
 * 两条判定分开放（2026-10-16 业主定调「引擎与供给解耦」）：
 * - **供不供**：`shared/platforms.ts` 注册表 + 用户开关（`settings.platformSwitches`）。
 *   关掉的平台在任何引擎被调用之前就回绝，不落网络请求。
 * - **引擎这一层的供不供**：`settings.engineSwitches`（缺键 = 开）。关掉的引擎不进
 *   在场列表，选路与体检同时看不见它——只在界面上藏起来等于假开关。
 * - **能不能解**：引擎 runner 的 `covers()`（注册表能力位 ∧ 引擎自报覆盖）。
 *   线上回落引擎已于 2026-10-18 移除；amagi（2026-10-21）与 yt-dlp（ytdlp-nodejs，
 *   取代原先埋在 parse-core 内部只服务 tiktok 的原生 dlp 通道）先后接入为回退引擎。
 *
 * `via` 契约枚举只剩 local/mock：它答的是「结果从本机还是演示数据来」，不是「哪个引擎解的」。
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
import { ParseResultSchema } from "../../types/ipc-contract";
import { fitToContract } from "../../shared/coerce";
import {
  type EngineId,
  type EngineSwitch,
  type PlatformSwitch,
  type SwitchableEngineId,
  asSwitchableEngine,
  cookieKeyOf,
  displayName,
  isEnabled,
  isEngineEnabled,
  isRegistered,
  platformDef,
  primaryEngineOf,
} from "../../shared/platforms";
import { createResultCache } from "../../core-adapter/cache";
import { createNoopAnalytics } from "../../core-adapter/analytics";
import { createConfigSource } from "../../core-adapter/config";
import { createThrottle } from "../../core-adapter/ratelimit";
import {
  type CoreEntry,
  type ParseEngine,
  buildHealth,
  createParseCoreEngine,
  orderedFor,
  viaOf,
} from "./engines";
import { createAmagiEngine } from "./amagi-engine";
import { createCookieFile } from "./ytdlp-cookie-file";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createYtdlpEngine, type YtdlpClientFactory } from "./ytdlp-engine";

export type { CoreEntry } from "./engines";

export type KernelMode = "local" | "mock";

export interface IdentifyOutcomeLite {
  platform: string;
  platformName: string;
  url: string | null;
  kind: "url" | "share-text" | "unknown";
}

/** 结果缓存的载荷：结果 + 解出它的引擎（进程内内存 TTL，无跨版本兼容负担） */
interface CachedParse {
  result: ParseResult;
  engine?: EngineId;
}

/**
 * 单次引擎尝试（v32 出参 attempts 的元素）。
 * `msg` 是引擎自己的失败原文（已截断），`failType` 能对上内核的失败归因——
 * 「回退到 mediaget」这条结论之外，必须能回答「amagi 为什么没解出来」。
 */
export interface ParseAttempt {
  engine: SwitchableEngineId;
  ok: boolean;
  code: number;
  msg?: string;
  failType?: string;
}

export interface ParseOutcomeLite {
  result: ParseResult;
  via: KernelMode;
  /** 实际解出这条结果的引擎（v28）：历史与统计按它对账「谁解的」；mock 兜底可缺省 */
  viaEngine?: EngineId;
  /** 这一轮真调用过的引擎（失败在前、成功在后）；缓存命中/mock 兜底不进选路，缺省 */
  attempts?: ParseAttempt[];
  durationMs: number;
}

export interface EngineDeps {
  /** 本地内核配置读取（store 注入，core-adapter/config 第一级） */
  readKernelConfig: (key: string) => string | undefined;
  /** 节流毫秒（设置页实时值） */
  getThrottleMs: () => number;
  /**
   * 平台供给开关（读持久值，不读渲染层内存）：每次解析与体检各读一次，
   * 所以设置页改完不必重启也不用等 IPC 回灌。缺省（测试）= 全表空 = 跟随注册表默认。
   */
  getPlatformSwitches?: () => Record<string, PlatformSwitch>;
  /**
   * 引擎开关（settings.engineSwitches）：每次选路与体检各读一次，与平台开关同一条
   * 「现读持久值」纪律。缺省（测试）= 空表 = 全开。
   */
  getEngineSwitches?: () => Record<string, EngineSwitch>;
  /**
   * 平台主引擎（settings.platformEngines）：缺键 = mediaget。设置页「通道」下拉即写它，
   * 每次选路/体检现读——翻转后不必重启，下一次解析就按新顺序走。
   */
  getPlatformEngines?: () => Record<string, SwitchableEngineId>;
  /** 主引擎失败后是否回退其余可用引擎（settings.engineFallback；缺省 true） */
  getEngineFallback?: () => boolean;
  /** 强制模式（测试/内测），auto 按能力降级 */
  forceMode?: KernelMode;
  /** 核心入口加载器覆盖（测试注入假核；缺省惰性取真 parse-core） */
  coreLoader?: () => Promise<CoreEntry>;
  /**
   * 用户自配 Cookie（settings.cookies，amagi 引擎消费）：每次解析现读，
   * 设置页保存后立即生效。缺省（测试）= 空——amagi 引擎在无 Cookie 下也能跑免登录路径。
   */
  getCookies?: () => Record<string, string>;
  /** amagi 客户端工厂覆盖（测试注入离线桩；缺省 = 真 `amagi()`，测试里绝不允许真网） */
  amagiMakeClient?: import("./amagi-engine").AmagiClientFactory;
  /** amagi 短链展开覆盖（测试注入恒 null 桩；缺省 = 真 fetch 跟随重定向） */
  amagiExpandUrl?: (url: string) => Promise<string | null>;
  /** 代理设置（settings.proxyMode/proxyUrl）：manual 且地址合法时透传给 amagi 的 requestConfig */
  amagiGetProxyConfig?: () => { mode: "system" | "manual" | "direct" | "off"; url: string };
  /**
   * yt-dlp 引擎（ytdlp-nodejs）客户端工厂覆盖（测试注入离线桩；缺省 = 真 `YtDlp`）。
   * 二进制路径不在这里覆盖：缺省走 readKernelConfig("YTDLP_BIN")（用户自配 > 随包
   * SHA-256 校验后释放），与内核 ytDlpClient 共用同一枚验过的二进制。
   */
  ytdlpMakeClient?: YtdlpClientFactory;
  /**
   * 解析失败的落地点（index.ts 注入 userData 日志；测试缺省 = 不写盘）。
   * 结果卡只有一句 msg、历史档也不收失败行，排障的现场只在这里，所以「平台 + 引擎 +
   * 业务码 + failType + 失败原文」五件必须一起投。原文过 `clipForLog` 整形（压单行、
   * 截 300 字），**不做脱敏**：见该函数头部。
   */
  log?: (level: "warn" | "error", message: string) => void;
}

/**
 * 日志文本整形：压成单行、截到 300 字——日志是「一行一条」，多行会把结构打散，
 * 而引擎的失败原文可能带整段堆栈。
 *
 * **不脱敏**（2026-10-21 业主定调）：本项目是无服务器的本地应用，日志只落在用户自己的
 * `userData/logs`，不上传也不外发，所以「日志不写媒体直链」这条不适用——直链留在现场
 * 反倒是排障时唯一能对上「哪条链 403 / 哪条链签错了」的凭据。
 * Cookie 值也进不来，但不是靠这里遮的：引擎递给 yt-dlp 的是 cookiefile **路径**而不是
 * 头串（见 `ytdlp-cookie-file.ts`），错误原文里本来就没有它。
 */
function clipForLog(text: string): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, 300);
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
    kuaishouCookie: config.get("kuaishouCookie"),
    twitterFixerServices: config.get("twitterFixerServices"),
    xhsCookie: config.get("xhsCookie"),
    youtubeSourceTimeoutMs: Number(config.get("youtubeSourceTimeoutMs") || ""),
    youtubeApiKey: config.get("youtubeApiKey"),
    youtubeApiTimeoutMs: Number(config.get("youtubeApiTimeoutMs") || ""),
    ytdlpBin: config.get("ytdlpBin"),
    ytdlpTimeoutMs: Number(config.get("ytdlpTimeoutMs") || ""),
  });

  // —— 引擎注册表（2026-10-21 注册制）——
  // 加引擎在这里登记一项工厂即可：选路顺序（可被平台 enginePriority 覆盖，见 engines.ts
  // 的 orderedFor）、开关判定、体检矩阵、结果归属全部自动跟上。mock 档整体清空走演示结果。
  const ENGINE_FACTORIES: readonly (() => ParseEngine)[] = [
    () => createParseCoreEngine(deps.coreLoader ?? loadRealCore),
    () =>
      createAmagiEngine({
        getCookie: (key) => (deps.getCookies?.() ?? {})[key] ?? "",
        makeClient: deps.amagiMakeClient,
        expandUrl: deps.amagiExpandUrl,
        getProxyConfig: deps.amagiGetProxyConfig,
      }),
    () =>
      createYtdlpEngine({
        // 与 resources.ts 同键：用户自配 kernel.YTDLP_BIN > 随包释放（index.ts 的
        // readKernelConfig 已接 resources.locate；只有随包件做 SHA-256 校验，用户自备路径按设计不校验）
        getBinaryPath: () => deps.readKernelConfig("YTDLP_BIN"),
        getFfmpegPath: () => deps.readKernelConfig("FFMPEG_BIN"),
        // 平台 → Cookie 键名只从注册表查（redbook→XHS_COOKIE、instagram→IG_COOKIE
        // 这种按契约键大写拼不出来），值每次解析现读，设置页保存后立即生效
        getCookie: (platform) => {
          const key = cookieKeyOf(platform);
          return key ? deps.getCookies?.()?.[key] : undefined;
        },
        // yt-dlp 的 `--cookies` 只收文件：头串在这里落成临时 Netscape 文件，用完由引擎删
        prepareCookieFile: (platform, header) => {
          const domain = platformDef(platform)?.domains[0];
          if (!domain) return Promise.resolve(null);
          return createCookieFile(join(tmpdir(), "mediaget-ytdlp"), platform, header, domain);
        },
        getTimeoutMs: () => {
          const n = Number(config.get("ytdlpTimeoutMs") ?? "");
          return Number.isFinite(n) && n > 0 ? n : 30_000;
        },
        makeClient: deps.ytdlpMakeClient,
      }),
  ];
  const registeredEngines: readonly ParseEngine[] = ENGINE_FACTORIES.map((create) => create());

  /** 当下在场的引擎（mock 档清空；用户关掉的引擎不进列表 = 选路与体检都不认它） */
  function availableEngines(): ParseEngine[] {
    if (deps.forceMode === "mock") return [];
    const engineSwitches = deps.getEngineSwitches?.() ?? {};
    return registeredEngines.filter((e) => isEngineEnabled(e.id, engineSwitches));
  }

  const switches = (): Record<string, PlatformSwitch> => deps.getPlatformSwitches?.() ?? {};

  /**
   * 主引擎排第一（其余保持注册表/平台优先级的相对顺序）。
   * 体检用它：下拉选项的先后 = 解析时试的先后，且**不受回退开关影响**——回退关掉时
   * 用户仍要能把某一平台的主引擎改成别的，选项不能只剩一个。
   */
  function primaryFirst(platform: string, engines: ParseEngine[]): ParseEngine[] {
    const ordered = orderedFor(engines, platformDef(platform)?.enginePriority);
    const primary = primaryEngineOf(platform, deps.getPlatformEngines?.() ?? {});
    const idx = ordered.findIndex((e) => e.id === primary);
    // 用户挑的引擎今天不在场（被引擎开关关掉 / 无二进制）→ 不硬排，退回默认顺序
    if (idx <= 0) return ordered;
    return [ordered[idx], ...ordered.filter((_, i) => i !== idx)];
  }

  /**
   * 实际轮询顺序：主引擎在前；回退开关关掉时**只留第一位**——主引擎的失败就是最终答复。
   * 与 primaryFirst 分开，因为两者回答的不是同一个问题（体检报「谁能解」，这里定「试几个」）。
   */
  function routeFor(platform: string, engines: ParseEngine[]): ParseEngine[] {
    const ordered = primaryFirst(platform, engines);
    return deps.getEngineFallback?.() === false ? ordered.slice(0, 1) : ordered;
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
      // 显示名取注册表：内核那份 PLATFORM_INFO 只是 parse-core 一个引擎的自述，
      // 名字的项目边界归注册表（qsmusic 就是内核没登记、我们有登记的那个）
      platformName: platform ? displayName(platform) : "",
      url,
      kind,
    };
  }

  /**
   * 引擎出口的唯一收拢点：内核只做**字段名**映射、不做**类型**归一（逐条源码依据见
   * `shared/coerce.ts` 头部），所以脏值在离开本文件之前收进契约声明的形状。
   *
   * 排在结果缓存之前 —— 缓存里存的必须是干净那份；`ParseDataSchema` 末尾是 `.passthrough()`，
   * 脏值能在 `parse:run` 出参校验里全身而退，却会在下一跳被抄进历史档、让整次 `history:list`
   * 判成 contract-drift（2026-10-18 历史页那次空态就是这么来的）。
   */
  const emit = (result: ParseResult): ParseResult => fitToContract(ParseResultSchema, result);

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
    opts: { platformHint?: string; skipCache?: boolean } = {}
  ): Promise<ParseOutcomeLite> {
    const t0 = Date.now();
    const input = (rawInput ?? "").trim();
    const fail = (result: ParseResult, via: KernelMode = "local"): ParseOutcomeLite => ({
      result: emit(result),
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
    // skipCache 只跳过这份缓存，引擎顺序不动：缓存里存的就是带直链的那份结果，
    // 而直链会到期，下载 403 之后必须绕开它才能拿回新签名的链（见 link-renew.ts）。
    const cacheKey = url || `${source}:${id}`;
    const cached = opts.skipCache ? undefined : (cache.get(cacheKey) as CachedParse | undefined);
    if (cached && deps.forceMode !== "mock") {
      // 进缓存的那一步已经过 `emit`，所以这里直接原样交出，不再重复收拢一次。
      // engine 随缓存一起存：命中的是「谁解的那份」，结果卡上的引擎名不该退化成笼统的「本地内核」
      return {
        result: cached.result,
        via: "local",
        viaEngine: cached.engine,
        durationMs: Date.now() - t0,
      };
    }

    await throttle.acquire();

    // —— 用户把引擎全关了（不是平台没引擎）:如实说「供给关了」，不拿演示数据冒充成功 ——
    // mock 档的「全清空」走下面的演示兜底，不受这条拦。
    const present = availableEngines();
    if (deps.forceMode !== "mock" && present.length === 0) {
      return fail({ code: 400, msg: "所有解析引擎已在设置里关闭（设置 → 引擎）" });
    }

    // —— 引擎轮询：在场 ∧ 覆盖才调用；顺序 = 平台 enginePriority 覆盖后的全局注册顺序 ——
    // 结局规则（2026-10-21 amagi 接入定调）：第一个「跑过且失败」的引擎的答复是给用户的
    // 最终答复 —— 主引擎的失败最值得看（业务码/风控归因都在它手里），回退引擎的失败只是
    // 次级噪音；全部没人跑/没人覆盖才走 mock 兜底。
    let firstFail: { engineId: EngineId; result: ParseResult } | undefined;
    /** 每次真调用都留痕（含失败原因）：结果卡与 toast 靠它说清「为什么不是主引擎」 */
    const attempts: ParseAttempt[] = [];
    for (const engine of routeFor(platform, present)) {
      if (!(await engine.covers(platform))) continue;
      const out = await engine.run({ platform, url, source, id });
      const engineKey = asSwitchableEngine(engine.id);
      if (out.ok) {
        const result = emit(out.result);
        if (result.code === 200) {
          result.platform = result.platform || platform;
          // 连「谁解的」一起缓存（内存 TTL，进程内自洽）：命中时结果卡的引擎名仍然属实
          cache.set(cacheKey, { result, engine: engine.id } satisfies CachedParse);
        }
        const via = viaOf(engine.id);
        analytics.track("parse", { platform, via, ok: result.code === 200 });
        if (engineKey) attempts.push({ engine: engineKey, ok: true, code: result.code });
        // 「引擎跑通了、但业务答复是失败」是**最常见**的一种没解出来（风控 403、链接失效 404）。
        // 这条路直接定案、不落日志的话，用户能看到的就只有结果卡上那一句 msg。
        if (result.code !== 200) {
          deps.log?.(
            "error",
            `[engine] 解析未成功 platform=${platform || "unknown"} engine=${engineKey ?? engine.id} ` +
              `code=${result.code} failType=${result.failType ?? "-"} msg=${clipForLog(result.msg ?? "")}`
          );
        }
        return { result, via, viaEngine: engine.id, attempts, durationMs: Date.now() - t0 };
      }
      if (!firstFail && out.result) firstFail = { engineId: engine.id, result: out.result };
      if (engineKey) {
        attempts.push({
          engine: engineKey,
          ok: false,
          code: out.result?.code ?? 0,
          // 无 result 的失败只有引擎自报的 reason 标签（如 binary-missing），也照样留痕
          msg: (out.result?.msg ?? out.reason).slice(0, 300),
          failType: out.result?.failType,
        });
      }
      // 失败原文落盘：这是「为什么没解出来」唯一的现场（结果卡只留一句 msg，且不进历史）。
      // 无 result 的失败（binary-missing 之类）只有 reason 标签，同样记下来。
      deps.log?.(
        "warn",
        `[engine] 解析失败 platform=${platform || "unknown"} engine=${engineKey ?? engine.id} ` +
          `code=${out.result?.code ?? 0} failType=${out.result?.failType ?? "-"} reason=${out.reason} ` +
          `msg=${clipForLog(out.result?.msg ?? "")}`
      );
    }

    if (firstFail) {
      // 有引擎试过但都失败了：把第一个（主）引擎的失败答复如实交给 renderer，不拿 mock 冒充成功
      const via = viaOf(firstFail.engineId);
      analytics.track("parse", { platform, via, ok: false });
      // 一轮汇总一行：单引擎失败细节在上一段，这里要的是「试过谁、各自什么结论」的轨迹——
      // 回退到底有没有发生，只看结果卡上那枚徽标是分不出「没回退」和「回退也没解出来」的
      deps.log?.(
        "error",
        `[engine] 解析未成功 platform=${platform || "unknown"} via=${firstFail.engineId} ` +
          `轨迹=${attempts.map((a) => `${a.engine}(${a.code}${a.failType ? ` ${a.failType}` : ""})`).join(" → ") || "-"}`
      );
      return {
        result: emit(firstFail.result),
        via,
        viaEngine: firstFail.engineId,
        attempts,
        durationMs: Date.now() - t0,
      };
    }

    // —— 没有引擎在场/覆盖：强制 mock 或 mock 兜底（离线演示，来源如实标注）——
    return fail(mockResult(url, platform || "unknown"), "mock");
  }

  /** 平台能力体检：注册表 × 在场引擎 × 用户开关（probe:engines 与设置页矩阵共用） */
  async function health(): Promise<EngineHealth[]> {
    return buildHealth(availableEngines(), switches(), primaryFirst);
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
    /**
     * 随包内核的版本号（`app:getMeta` 报给设置页「内核版本」）。
     *
     * 只有 engine 敢碰内核模块：`index.ts` 拿它而不是自己 `import` 一次 —— 内核的加载点
     * 留在这里，进程启动顺序与「谁先求值 parse-core」不会因为一处展示需求多出第二条路。
     */
    kernelVersion: PARSE_CORE_VERSION,
  };
}
