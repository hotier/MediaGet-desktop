/**
 * 引擎测试：本地识别（真内核纯模块）、黑名单拦截、mock 兜底、本地通道。
 * 全程无外网：默认注入「零覆盖假核」（localParserKeys=[]，任何平台都不走本地），
 * 本地通道用例用可控假核断言 unifiedParseLocal 的走线与出参。
 */
import { describe, expect, it } from "vitest";
import { orderedFor } from "../electron/main/engines";
import type { ParseEngine } from "../electron/main/engines";
import { createEngine, type CoreEntry } from "../electron/main/engine";
import { PLATFORMS } from "../shared/platforms";
import { ParseResultSchema } from "../types/ipc-contract";

/** 零覆盖假核：本地通道永不 Eligible → 走线只可能 mock */
const emptyCore = (): CoreEntry => ({
  unifiedParseLocal: async () => ({ code: 500, msg: "不应被调用" }),
  localParserKeys: () => [],
});

/**
 * amagi 的离线桩：全方法一律失败信封。引擎测试零真网是铁律——注册表里 amagi 覆盖
 * 四家平台，假核失败后选路会真进 amagi，没有这个桩就会发起真请求。
 * ytdlp 引擎同在注册表里，但它 covers 先看二进制（readKernelConfig 缺省 undefined），
 * 本文件缺省用例下自报「解不了」，客户端绝不会被构造；真要打它走 withYtdlp 注入离线桩。
 */
const offlineAmagi = () => {
  const fail = async () => ({ success: false, error: { kind: "network", message: "offline-stub" } });
  return {
    douyin: { parseWork: fail },
    bilibili: { fetchVideoInfo: fail, fetchVideoStreamUrl: fail, convertAvToBv: fail, fetchUserCard: fail },
    kuaishou: { fetchVideoWork: fail },
    xiaohongshu: { fetchNoteDetail: fail },
  };
};

function makeEngine(overrides: Partial<Parameters<typeof createEngine>[0]> = {}) {
  return createEngine({
    readKernelConfig: () => undefined,
    getThrottleMs: () => 0,
    coreLoader: async () => emptyCore(),
    amagiMakeClient: offlineAmagi,
    // 短链展开一律「展开不了」：绝不发起真请求
    amagiExpandUrl: async () => null,
    ...overrides,
  });
}

describe("orderedFor：平台优先级覆盖全局声明顺序（v28 注册制）", () => {
  const mk = (id: "parseCore" | "ytdlp"): ParseEngine => ({
    id,
    label: id,
    covers: async () => false,
    run: async () => ({ ok: false, reason: "unused" }),
  });

  it("无优先级 = 全局声明顺序原样透传", () => {
    const engines = [mk("ytdlp"), mk("parseCore")];
    expect(orderedFor(engines).map((e) => e.id)).toEqual(["ytdlp", "parseCore"]);
  });

  it("优先表点名者提前，未点名的按原相对顺序垫底", () => {
    const engines = [mk("ytdlp"), mk("parseCore")];
    expect(orderedFor(engines, ["parseCore"]).map((e) => e.id)).toEqual(["parseCore", "ytdlp"]);
    expect(orderedFor(engines, ["ytdlp"]).map((e) => e.id)).toEqual(["ytdlp", "parseCore"]);
  });

  it("优先表里的未知引擎不影响在场的排序", () => {
    const engines = [mk("parseCore")];
    expect(orderedFor(engines, ["ytdlp", "parseCore"]).map((e) => e.id)).toEqual(["parseCore"]);
  });
});

describe("identify（本地纯识别，零网络）", () => {
  it("整段分享文案提取链接并识别平台（真内核 share-text + platforms）", () => {
    const e = makeEngine();
    const r = e.identify(
      "【测试】看看这个视频 复制打开抖音，看看https://v.douyin.com/iAbCdEf/ 2.13 复制本条信息"
    );
    expect(r.platform).toBe("douyin");
    expect(r.platformName).toBe("抖音");
    expect(r.url).toBe("https://v.douyin.com/iAbCdEf/");
    expect(r.kind).toBe("share-text");
  });

  it("纯链接 = url 形态", () => {
    const e = makeEngine();
    const r = e.identify("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(r.platform).toBe("bilibili");
    expect(r.kind).toBe("url");
  });

  it("汽水音乐特判与 unified-parser 对齐", () => {
    const e = makeEngine();
    expect(e.identify("https://music.douyin.com/foo/bar").platform).toBe("qsmusic");
  });

  it("无链接文案 = unknown", () => {
    const e = makeEngine();
    expect(e.identify("随便一句话没有链接").kind).toBe("unknown");
    expect(e.identify("").platform).toBe("");
  });
});

describe("parse 通道选择", () => {
  it("DRM 黑名单本地即拦截，不发起任何抓取", async () => {
    let coreRuns = 0;
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async () => {
          coreRuns++;
          return { code: 200, msg: "不该被解" };
        },
        localParserKeys: () => ["douyin"],
      }),
    });
    const r = await e.parse("https://v.qq.com/x/cover/abc.html");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("腾讯视频");
    expect(coreRuns).toBe(0);
    expect(r.via).toBe("local");
  });

  it("注册表未覆盖该平台（假核零覆盖、amagi 也不覆盖）→ mock 兜底且来源如实标注", async () => {
    const e = makeEngine();
    // weibo 不在 amagi 的四家覆盖里：parseCore（假核零覆盖）与 amagi 都跑不了 → mock
    const r = await e.parse("https://weibo.com/tv/show/abcdef");
    expect(r.via).toBe("mock");
    expect(r.result.msg).toContain("mock");
  });

  it("parseCore 不覆盖但 amagi 覆盖的平台：amagi 的失败答复是最终答复，不落 mock", async () => {
    const e = makeEngine();
    const r = await e.parse("https://v.douyin.com/xxxx/");
    expect(r.via).toBe("local");
    expect(r.viaEngine).toBe("amagi");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("未能从链接中提取作品 ID");
  });

  it("结果缓存：第二次 parse 命中缓存（内核只调一次）", async () => {
    let calls = 0;
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async () => {
          calls++;
          return { code: 200, msg: "ok", data: { url: "https://x/y.mp4" } };
        },
        localParserKeys: () => ["douyin"],
      }),
    });
    await e.parse("https://v.douyin.com/cache-me/");
    await e.parse("https://v.douyin.com/cache-me/");
    expect(calls).toBe(1);
  });

  it("skipCache 跳过缓存但引擎顺序不动（重试取新签名直链）", async () => {
    let calls = 0;
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async () => {
          calls++;
          return { code: 200, msg: "ok", data: { url: "https://x/y.mp4" } };
        },
        localParserKeys: () => ["douyin"],
      }),
    });
    await e.parse("https://v.douyin.com/fresh/");
    const r = await e.parse("https://v.douyin.com/fresh/", undefined, undefined, { skipCache: true });
    expect(calls).toBe(2);
    expect(r.via).toBe("local");
  });

  it("source+id 不支持平台给出明确提示", async () => {
    const e = makeEngine();
    const r = await e.parse("", "kuaishou", "123");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("不支持通过 ID 解析");
  });

  it("本地内核失败结果透传 failType", async () => {
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async () => ({ code: 403, msg: "需登录", failType: "bot-gated" }),
        localParserKeys: () => ["redbook"],
      }),
    });
    const r = await e.parse("https://www.xiaohongshu.com/explore/abc");
    expect(r.via).toBe("local");
    expect(r.result.failType).toBe("bot-gated");
    expect(r.result.code).toBe(403);
  });
});

describe("失败原因落日志（结果卡只有一句 msg，日志是唯一现场）", () => {
  const sink = () => {
    const lines: { level: "warn" | "error"; message: string }[] = [];
    return { lines, log: (level: "warn" | "error", message: string) => lines.push({ level, message }) };
  };

  /** 覆盖 redbook 的失败假核：主引擎「跑通了但业务答复失败」，这条路直接定案、不走回退 */
  const failingCore = (msg: string, failType?: string, code = 403): CoreEntry => ({
    unifiedParseLocal: async () => ({ code, msg, failType }),
    localParserKeys: () => ["redbook"],
  });

  it("引擎跑通但业务失败：一条 error 带平台/引擎/业务码/归因", async () => {
    const s = sink();
    const e = makeEngine({ log: s.log, coreLoader: async () => failingCore("需登录", "bot-gated") });
    const r = await e.parse("https://www.xiaohongshu.com/explore/log-a");
    expect(r.result.code).toBe(403);

    const errors = s.lines.filter((l) => l.level === "error").map((l) => l.message);
    expect(errors.length).toBe(1);
    // 平台 / 引擎 / 业务码 / 归因四件缺一，日志就答不出「谁没解出来、为什么」
    expect(errors[0]).toContain("platform=redbook");
    // 引擎写 id 而不是 UI 标签（mediaget 是 parseCore 的 label）：日志要能与 attempts 对账
    expect(errors[0]).toContain("engine=parseCore");
    expect(errors[0]).toContain("code=403");
    expect(errors[0]).toContain("failType=bot-gated");
  });

  it("引擎自报失败（ok:false）走回退：每个失败一条 warn，收尾一条轨迹", async () => {
    const s = sink();
    // 假核零覆盖 → 只有 amagi 会真跑；离线桩恒失败 → 回退路径走到 firstFail
    const e = makeEngine({ log: s.log });
    const r = await e.parse("https://v.douyin.com/log-fallback/");
    expect(r.result.code).not.toBe(200);

    const warn = s.lines.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warn.some((m) => m.includes("engine=amagi") && m.includes("platform=douyin"))).toBe(true);

    const errors = s.lines.filter((l) => l.level === "error").map((l) => l.message);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("轨迹=amagi(");
  });

  it("失败原文原样落盘（直链不脱敏）：排障要能对上具体哪条链", async () => {
    const s = sink();
    const e = makeEngine({
      log: s.log,
      coreLoader: async () =>
        failingCore("抓取失败 https://cdn.example.com/v/a.mp4?sign=secret123 后重试"),
    });
    await e.parse("https://www.xiaohongshu.com/explore/log-b");
    const text = s.lines.map((l) => l.message).join("\n");
    // 本地日志不外发（2026-10-21 业主定调），直链留着才是「哪条链签错了」的唯一凭据
    expect(text).toContain("https://cdn.example.com/v/a.mp4?sign=secret123");
  });

  it("多行错误压成一行、截到 300 字（日志一行一条，别被堆栈撑散）", async () => {
    const s = sink();
    const e = makeEngine({
      log: s.log,
      coreLoader: async () => failingCore(`第一行\n第二行\n${"x".repeat(1000)}`),
    });
    await e.parse("https://www.xiaohongshu.com/explore/log-c");
    const line = s.lines.find((l) => l.level === "error")?.message ?? "";
    expect(line).not.toContain("\n");
    expect(line).toContain("第一行 第二行");
    expect(line.length).toBeLessThan(400);
  });

  it("成功与 mock 兜底都不写 warn/error（日志只记失败）", async () => {
    const s = sink();
    const ok = await makeEngine({
      log: s.log,
      coreLoader: async () => ({
        unifiedParseLocal: async () => ({ code: 200, msg: "解析成功", data: { url: "https://x/a.mp4" } }),
        localParserKeys: () => ["douyin"],
      }),
    }).parse("https://v.douyin.com/log-ok/");
    expect(ok.result.code).toBe(200);

    const mock = await makeEngine({ log: s.log }).parse("https://nowhere.example/v/log");
    expect(mock.via).toBe("mock");
    expect(s.lines).toEqual([]);
  });
});

describe("本地通道（注入可控假核，零网络）", () => {
  /** 覆盖 douyin 的假核；unifiedParseLocal 出参由用例给定 */
  const coreReturning = (out: unknown): CoreEntry => ({
    unifiedParseLocal: async () => out as Record<string, unknown>,
    localParserKeys: () => ["douyin"],
  });

  it("核心 200 → via=local，平台字段补齐并进缓存", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning({ code: 200, msg: "解析成功", data: { url: "https://x/a.mp4" } }),
    });
    const r = await e.parse("https://v.douyin.com/loc/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(200);
    expect(r.result.platform).toBe("douyin");
  });

  /**
   * 事故回归（2026-10-18）：内核只映射字段名、不收字段类型（`normalize-result.ts:118` 把
   * bilibili 的数字 mid 写成 `user.uid as string`），脏值于是穿过 `parse:run` 的 passthrough
   * 出参、被抄进历史档，再让整次 `history:list` 判成 contract-drift —— 满盘记录在屏幕上变空态。
   * 收拢点排在 `cache.set` 之前，所以脏值出不了本文件，缓存里也只有干净那份。
   */
  it("假核带脏类型（数字 authorId、字符串计数）→ 出口收进契约形状，缓存里同样是干净的", async () => {
    const e = makeEngine({
      coreLoader: async () =>
        coreReturning({
          code: 200,
          msg: "解析成功",
          data: {
            url: "https://x/a.mp4",
            authorId: 402090056,
            stat: { like: "5000", reply: "1.2万" },
          },
        }),
    });
    const first = await e.parse("https://v.douyin.com/dirty/");
    expect(first.result.data?.authorId).toBe("402090056");
    expect(first.result.data?.stat).toEqual({ like: 5000 });
    expect(() => ParseResultSchema.parse(first.result)).not.toThrow();
    const cached = await e.parse("https://v.douyin.com/dirty/");
    expect(cached.result.data?.authorId).toBe("402090056");
  });

  it("核心给出业务失败码（201）→ 如实透传", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning({ code: 201, msg: "视频已删除" }),
    });
    const r = await e.parse("https://v.douyin.com/gone/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(201);
    expect(r.result.msg).toBe("视频已删除");
  });

  it("核心返回异形结果 → 明确 500，不把 null 递给 renderer", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning(null),
    });
    const r = await e.parse("https://v.douyin.com/weird/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(500);
    expect(r.result.msg).toContain("本地内核未返回有效解析结果");
  });

  it("source+id 模式走本地核心，未命中如实返回失败", async () => {
    const seen: unknown[] = [];
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async (input: string, opts?: { source?: string; id?: string }) => {
          seen.push([input, opts]);
          return { code: 404, msg: "ID 未命中" };
        },
        localParserKeys: () => ["douyin"],
      }),
    });
    const r = await e.parse("", "douyin", "1234567890123456789");
    expect(seen[0]).toEqual(["", { source: "douyin", id: "1234567890123456789" }]);
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(404);
  });
});

describe("供给闸门（注册表开关在引擎被调用之前生效）", () => {
  it("关掉的平台：任何引擎都不许被调用，答复里给出去哪儿开", async () => {
    let coreLoads = 0;
    let coreRuns = 0;
    const e = makeEngine({
      getPlatformSwitches: () => ({ douyin: { enabled: false } }),
      coreLoader: async () => {
        coreLoads++;
        return {
          unifiedParseLocal: async () => {
            coreRuns++;
            return { code: 200, msg: "不该被解", data: { url: "x" } };
          },
          localParserKeys: () => ["douyin"],
        };
      },
    });
    const r = await e.parse("https://v.douyin.com/off/");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("已在设置里关闭");
    expect(r.result.platform).toBe("douyin");
    expect(r.via).toBe("local");
    // 闸门在引擎层之前：内核模块不该被求值，更不该发抓取
    expect(coreLoads).toBe(0);
    expect(coreRuns).toBe(0);
  });

  it("默认开：同一个链接照解（开关表为空 = 跟随注册表）", async () => {
    const e = makeEngine({
      getPlatformSwitches: () => ({}),
      coreLoader: async () => ({
        unifiedParseLocal: async () => ({ code: 200, msg: "解析成功", data: { url: "https://x/a.mp4" } }),
        localParserKeys: () => ["douyin"],
      }),
    });
    expect((await e.parse("https://v.douyin.com/on/")).result.code).toBe(200);
  });

  it("未登记的键不被闸门拦下，也不被注册表改写：交给引擎判定，判定不了就 mock", async () => {
    const e = makeEngine();
    const r = await e.parse("https://nowhere.example/v/1", undefined, undefined, {
      platformHint: "brandNewPlatform",
    });
    expect(r.via).toBe("mock");
    expect(r.result.platform).toBe("brandNewPlatform");
  });
});

describe("health 矩阵（注册表 × 在场引擎 × 开关）", () => {
  it("假核只覆盖 kuaishou：kuaishou 双引擎、douyin 落到 amagi、关掉的平台另说", async () => {
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async () => ({}),
        localParserKeys: () => ["kuaishou"],
      }),
      getPlatformSwitches: () => ({ bilibili: { enabled: false } }),
    });
    const rows = await e.health();
    const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
    expect(by.kuaishou.ok).toBe(true);
    expect(by.kuaishou.detail).toContain("mediaget");
    // 体检按生效选路顺序报引擎：parseCore 在前，amagi（回退引擎）在后
    expect(by.kuaishou.engines).toEqual(["mediaget", "amagi"]);
    // 假核不覆盖 douyin，但 amagi 声明可解：体检如实报出
    expect(by.douyin.ok).toBe(true);
    expect(by.douyin.engines).toEqual(["amagi"]);
    expect(by.bilibili.detail).toContain("已关闭");
    // 行集 = 注册表全量（内核 PLATFORM_INFO 没有的 qsmusic 也在表上）
    expect(rows.map((r) => r.platform)).toEqual(expect.arrayContaining(["redbook", "qsmusic"]));
    expect(rows.length).toBe(PLATFORMS.length);
  });

  it("假核零覆盖：parseCore 全表无份，amagi 四家（douyin/bilibili/kuaishou/redbook）仍可解，不再有「线上 API」通道", async () => {
    const e = makeEngine({
      coreLoader: async () => ({ unifiedParseLocal: async () => ({}), localParserKeys: () => [] }),
    });
    const rows = await e.health();
    const amagiCovered = ["douyin", "bilibili", "kuaishou", "redbook"];
    for (const row of rows) {
      if (amagiCovered.includes(row.platform)) {
        expect(row.ok, row.platform).toBe(true);
        expect(row.engines).toEqual(["amagi"]);
      } else {
        expect(row.ok, row.platform).toBe(false);
        expect(row.detail).toContain("无引擎");
      }
    }
    expect(rows.every((r) => !(r.detail ?? "").includes("线上 API"))).toBe(true);
  });

  it("localCoverage 至少含 kuaishou（真核注册表冒烟，导入不发网络）", async () => {
    // 不注入假核：走 engine 默认惰性 import，验证 parse-core 统一入口真实可用
    const e = createEngine({
      readKernelConfig: () => undefined,
      getThrottleMs: () => 0,
    });
    const keys = await e.localCoverage();
    expect(keys).toContain("kuaishou");
    // 1.0.0 下线 7 平台与 QQ 音乐后，识别面 = 12 平台 + 内核漏登记的 qsmusic
    expect(keys.length).toBe(13);
    expect(keys).toEqual(
      expect.arrayContaining(["douyin", "bilibili", "redbook", "twitter", "qsmusic"])
    );
  });
});

describe("ytdlp 引擎（ytdlp-nodejs 封装，注入离线桩，零真跑）", () => {
  /**
   * yt-dlp 的 VideoInfo 实测形状快照（字段名按上游 d.ts）：离线桩只造本引擎消费的字段。
   * formats 里刻意放了 video-only / 渐进式 / audio-only / DRM 四档，钉住主直链的选择规则。
   */
  const VIDEO = {
    _type: "video",
    id: "v1",
    title: "t",
    description: "d",
    uploader: "u",
    uploader_id: "uid",
    uploader_url: "https://x/u",
    duration: 12,
    view_count: 100,
    like_count: 10,
    comment_count: 2,
    thumbnail: "https://x/c.jpg",
    formats: [
      { format_id: "1", ext: "mp4", url: "https://x/720.mp4", height: 720, vcodec: "avc1", acodec: "none" },
      { format_id: "2", ext: "mp4", url: "https://x/540-prog.mp4", height: 540, vcodec: "avc1", acodec: "mp4a" },
      { format_id: "3", ext: "m4a", url: "https://x/audio.m4a", vcodec: "none", acodec: "mp4a", abr: 128 },
      { format_id: "4", ext: "mp4", url: "https://x/drm.mp4", height: 1080, vcodec: "avc1", acodec: "none", has_drm: true },
    ],
  };

  /** 注入 yt-dlp 离线桩 + 假二进制路径（真客户端在测试里绝不允许构造/真跑） */
  const withYtdlp = (getInfoAsync: (url: string) => Promise<unknown>) =>
    makeEngine({
      ytdlpMakeClient: () => ({ getInfoAsync }),
      readKernelConfig: (k) => (k === "YTDLP_BIN" ? "C:\\fake\\yt-dlp.exe" : undefined),
    });

  it("parseCore / amagi 都不覆盖的 tiktok：yt-dlp 兜底解出，主直链只挑渐进式、时长换算毫秒", async () => {
    const e = withYtdlp(async () => VIDEO);
    const r = await e.parse("https://www.tiktok.com/@u/video/123");
    expect(r.via).toBe("local");
    expect(r.viaEngine).toBe("ytdlp");
    expect(r.result.code).toBe(200);
    expect(r.result.platform).toBe("tiktok");
    const data = r.result.data;
    // 主直链 = 渐进式最高一档（540 含音频）；720 video-only 与 DRM 档不冒充可播
    expect(data?.url).toBe("https://x/540-prog.mp4");
    expect(data?.audioUrl).toBe("https://x/audio.m4a");
    expect(data?.qualities?.[0]).toMatchObject({ quality: 720, label: "720P" });
    // 契约硬口径：yt-dlp 给秒，出门必须换算成毫秒
    expect(data?.duration).toBe(12_000);
    expect(data?.stat).toEqual({ view: 100, like: 10, reply: 2 });
    expect(() => ParseResultSchema.parse(r.result)).not.toThrow();
  });

  it("无二进制（YTDLP_BIN 缺省）：covers 假、不构造客户端，tiktok 落 mock 兜底", async () => {
    const e = makeEngine();
    const r = await e.parse("https://www.tiktok.com/@u/video/1");
    expect(r.via).toBe("mock");
    const rows = await e.health();
    const tiktok = rows.find((row) => row.platform === "tiktok");
    expect(tiktok?.engines).toEqual([]);
    expect(tiktok?.detail).toContain("无引擎");
  });

  it("二进制在场：体检矩阵如实报出 yt-dlp（选路顺序 = parseCore 缺席后紧随）", async () => {
    const e = withYtdlp(async () => VIDEO);
    const rows = await e.health();
    const tiktok = rows.find((row) => row.platform === "tiktok");
    expect(tiktok?.ok).toBe(true);
    expect(tiktok?.engines).toEqual(["yt-dlp"]);
    // amagi 覆盖面不外溢：douyin 不认 yt-dlp
    const douyin = rows.find((row) => row.platform === "douyin");
    expect(douyin?.engines).toEqual(["amagi"]);
  });

  it("需要登录的失败 → 403 bot-gated 如实透传，不落 mock 冒充", async () => {
    const e = withYtdlp(async () => {
      throw new Error("Sign in to confirm you're not a bot");
    });
    const r = await e.parse("https://www.tiktok.com/@u/video/403");
    expect(r.via).toBe("local");
    expect(r.viaEngine).toBe("ytdlp");
    expect(r.result.code).toBe(403);
    expect(r.result.failType).toBe("bot-gated");
  });

  it("播放列表取第一条有格式的条目", async () => {
    const e = withYtdlp(async () => ({ _type: "playlist", entries: [VIDEO] }));
    const r = await e.parse("https://www.tiktok.com/@u/pl/1");
    expect(r.result.code).toBe(200);
    expect(r.result.data?.title).toBe("t");
  });

  it("条目全是空 formats：404 source-unavailable，不给用户半截结果", async () => {
    const e = withYtdlp(async () => ({ _type: "video", id: "v", formats: [] }));
    const r = await e.parse("https://www.tiktok.com/@u/video/empty");
    expect(r.result.code).toBe(404);
    expect(r.result.failType).toBe("source-unavailable");
  });

  it("缓存命中仍报「谁解的」：viaEngine 不因命中退化成笼统的本地内核", async () => {
    const e = withYtdlp(async () => VIDEO);
    const first = await e.parse("https://www.tiktok.com/@u/video/cached");
    expect(first.viaEngine).toBe("ytdlp");
    const hit = await e.parse("https://www.tiktok.com/@u/video/cached");
    expect(hit.via).toBe("local");
    expect(hit.viaEngine).toBe("ytdlp");
    // 缓存命中没进选路：attempts 缺省，界面不许据此编造「回退」
    expect(hit.attempts).toBeUndefined();
    // 真正的缓存命中判别（结果卡上的「缓存命中」徽标同一条阈值）
    expect(hit.durationMs).toBeLessThan(50);
  });
});

describe("主引擎与失败回退（settings.platformEngines / engineFallback）", () => {
  const coreCovering = (platform: string): CoreEntry => ({
    unifiedParseLocal: async () => ({ code: 200, msg: "ok", data: { url: "https://x/a.mp4" } }),
    localParserKeys: () => [platform],
  });
  const douyinUrl = "https://www.douyin.com/video/7300000000000000000";

  it("选 amagi 为主引擎：它先跑，失败后回退到 mediaget；体检顺序也以主引擎打头", async () => {
    const e = makeEngine({
      coreLoader: async () => coreCovering("douyin"),
      getPlatformEngines: () => ({ douyin: "amagi" }),
    });
    const r = await e.parse(douyinUrl);
    // amagi（离线桩）先跑并失败 → 回退 mediaget 解出：证明主引擎真的排在前面
    expect(r.via).toBe("local");
    expect(r.viaEngine).toBe("parseCore");
    expect(r.result.code).toBe(200);

    const douyin = (await e.health()).find((row) => row.platform === "douyin");
    expect(douyin?.engines).toEqual(["amagi", "mediaget"]);
    expect(douyin?.engineIds).toEqual(["amagi", "parseCore"]);

    // v32：回退不能只有结论——每个引擎的尝试与失败原因都要随结果出门口
    expect(r.attempts?.map((a) => [a.engine, a.ok])).toEqual([
      ["amagi", false],
      ["parseCore", true],
    ]);
    // 失败那条要带业务码与原因原文（无 msg 的「原因」等于没回答用户）
    expect(r.attempts?.[0].code).toBe(502);
    expect(r.attempts?.[0].msg?.length).toBeGreaterThan(0);
    expect(r.attempts?.[1].msg).toBeUndefined();
  });

  it("关掉失败回退：只试主引擎，它的失败就是最终答复（体检仍列出可选项供改选）", async () => {
    const e = makeEngine({
      coreLoader: async () => coreCovering("douyin"),
      getPlatformEngines: () => ({ douyin: "amagi" }),
      getEngineFallback: () => false,
    });
    const r = await e.parse(douyinUrl);
    expect(r.viaEngine).toBe("amagi");
    expect(r.result.code).toBe(502);
    // 只跑过主引擎：attempts 只有它一条失败，没有后续成功的引擎
    expect(r.attempts?.map((a) => [a.engine, a.ok])).toEqual([["amagi", false]]);

    // 回退关掉不等于「其它引擎不能解」：下拉得让人还能把主引擎改回 mediaget
    const douyin = (await e.health()).find((row) => row.platform === "douyin");
    expect(douyin?.engineIds).toEqual(["amagi", "parseCore"]);
  });

  it("主引擎今天不在场（被引擎开关关掉）：不硬排，退回默认顺序", async () => {
    const e = makeEngine({
      ytdlpMakeClient: () => ({ getInfoAsync: async () => ({ _type: "video", formats: [] }) }),
      readKernelConfig: (k) => (k === "YTDLP_BIN" ? "C:\\fake\\yt-dlp.exe" : undefined),
      getPlatformEngines: () => ({ tiktok: "ytdlp" }),
      getEngineSwitches: () => ({ ytdlp: { enabled: false } }),
    });
    const tiktok = (await e.health()).find((row) => row.platform === "tiktok");
    expect(tiktok?.engineIds).toEqual([]);
    const r = await e.parse("https://www.tiktok.com/@u/video/1");
    expect(r.via).toBe("mock");
  });
});

describe("引擎开关（settings.engineSwitches：选路与体检同源，缺键=开）", () => {
  const coreCovering = (platform: string): CoreEntry => ({
    unifiedParseLocal: async () => ({ code: 200, msg: "ok", data: { url: "https://x/a.mp4" } }),
    localParserKeys: () => [platform],
  });

  it("关掉 mediaget：该引擎退出选路，平台落到回退引擎（体检同步只报 amagi）", async () => {
    const e = makeEngine({
      coreLoader: async () => coreCovering("douyin"),
      getEngineSwitches: () => ({ parseCore: { enabled: false } }),
    });
    // 带作品 ID 的链接才会走到 amagi 的取数（短链展开桩恒 null，会得到 400 而不是网络失败）
    const r = await e.parse("https://www.douyin.com/video/7300000000000000000");
    // 假核的 200 不该出现：关掉的引擎不参与轮询，amagi 的离线失败才是这一轮的答复
    expect(r.viaEngine).toBe("amagi");
    expect(r.result.code).toBe(502);

    const rows = await e.health();
    const douyin = rows.find((row) => row.platform === "douyin");
    expect(douyin?.engines).toEqual(["amagi"]);
  });

  it("关掉 ytdlp：tiktok 不再有可用引擎，体检报空、解析落 mock 兜底", async () => {
    const e = makeEngine({
      ytdlpMakeClient: () => ({ getInfoAsync: async () => ({ _type: "video", formats: [] }) }),
      readKernelConfig: (k) => (k === "YTDLP_BIN" ? "C:\\fake\\yt-dlp.exe" : undefined),
      getEngineSwitches: () => ({ ytdlp: { enabled: false } }),
    });
    const rows = await e.health();
    const tiktok = rows.find((row) => row.platform === "tiktok");
    expect(tiktok?.engines).toEqual([]);
    expect(tiktok?.ok).toBe(false);

    const r = await e.parse("https://www.tiktok.com/@u/video/1");
    expect(r.via).toBe("mock");
  });

  it("全关：如实回绝（400），不拿演示数据冒充成功；mock 档不受这条拦", async () => {
    const off = {
      getEngineSwitches: () => ({
        parseCore: { enabled: false },
        amagi: { enabled: false },
        ytdlp: { enabled: false },
      }),
    };
    const real = makeEngine({ ...off, coreLoader: async () => coreCovering("douyin") });
    const r = await real.parse("https://v.douyin.com/all-off/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("所有解析引擎已在设置里关闭");

    // mock 档的「清空引擎」是演示兜底，与用户关开关不是一回事
    const demo = makeEngine({ ...off, forceMode: "mock" });
    const d = await demo.parse("https://v.douyin.com/all-off/");
    expect(d.via).toBe("mock");
    expect(d.result.code).toBe(200);
  });
});
