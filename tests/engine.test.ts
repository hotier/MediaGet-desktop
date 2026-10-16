/**
 * 引擎测试：本地识别（真内核纯模块）、黑名单拦截、mock 兜底、核心本地通道、线上回落通道。
 * 全程无外网：默认注入「零覆盖假核」（localParserKeys=[]，任何平台都不走本地），
 * 本地通道用例用可控假核断言 unifiedParseLocal 的走线与出参。
 */
import { describe, expect, it } from "vitest";
import { createEngine, type CoreEntry } from "../electron/main/engine";
import { PLATFORMS } from "../shared/platforms";
import type { ParseResult } from "../types/ipc";

/** 零覆盖假核：本地通道永不 Eligible → 走线只可能 online/mock */
const emptyCore = (): CoreEntry => ({
  unifiedParseLocal: async () => ({ code: 500, msg: "不应被调用" }),
  localParserKeys: () => [],
});

function makeEngine(overrides: Partial<Parameters<typeof createEngine>[0]> = {}) {
  return createEngine({
    readKernelConfig: () => undefined,
    getThrottleMs: () => 0,
    isFallbackEnabled: () => true,
    onlineFallback: async () => null,
    coreLoader: async () => emptyCore(),
    ...overrides,
  });
}

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
    let fallbackCalls = 0;
    const e = makeEngine({
      onlineFallback: async () => {
        fallbackCalls++;
        return null;
      },
    });
    const r = await e.parse("https://v.qq.com/x/cover/abc.html");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("腾讯视频");
    expect(fallbackCalls).toBe(0);
    expect(r.via).toBe("local");
  });

  it("注册表未覆盖该平台（假核零覆盖）→ 线上回落通道 via=online", async () => {
    const online: ParseResult = {
      code: 200,
      msg: "解析成功",
      platform: "douyin",
      data: { title: "t", url: "https://cdn.douyin.com/a.mp4", type: "video" },
    };
    const e = makeEngine({ onlineFallback: async () => online });
    const r = await e.parse("https://v.douyin.com/xxxx/");
    expect(r.via).toBe("online");
    expect(r.result.code).toBe(200);
    expect(r.result.data?.url).toBe("https://cdn.douyin.com/a.mp4");
    expect(r.fallbackReason).toBeTruthy();
  });

  it("回落关闭 + 假核零覆盖 → mock 兜底且来源如实标注", async () => {
    const e = makeEngine({ isFallbackEnabled: () => false });
    const r = await e.parse("https://v.douyin.com/xxxx/");
    expect(r.via).toBe("mock");
    expect(r.result.msg).toContain("mock");
  });

  it("结果缓存：第二次 parse 命中缓存（fallback 只调一次）", async () => {
    let calls = 0;
    const e = makeEngine({
      onlineFallback: async () => {
        calls++;
        return { code: 200, msg: "ok", platform: "douyin", data: { url: "https://x/y.mp4" } };
      },
    });
    await e.parse("https://v.douyin.com/cache-me/");
    await e.parse("https://v.douyin.com/cache-me/");
    expect(calls).toBe(1);
  });

  it("forceOnline 跳过缓存与本地通道", async () => {
    let calls = 0;
    const e = makeEngine({
      onlineFallback: async () => {
        calls++;
        return { code: 200, msg: "ok", platform: "douyin", data: { url: "https://x/y.mp4" } };
      },
    });
    await e.parse("https://v.douyin.com/fo/");
    const r = await e.parse("https://v.douyin.com/fo/", undefined, undefined, { forceOnline: true });
    expect(calls).toBe(2);
    expect(r.via).toBe("online");
  });

  it("source+id 不支持平台给出明确提示", async () => {
    const e = makeEngine({ isFallbackEnabled: () => false });
    const r = await e.parse("", "kuaishou", "123");
    expect(r.result.code).toBe(400);
    expect(r.result.msg).toContain("不支持通过 ID 解析");
  });

  it("线上失败结果透传 failType", async () => {
    const e = makeEngine({
      onlineFallback: async () => ({
        code: 403,
        msg: "需登录",
        failType: "bot-gated",
      }),
    });
    const r = await e.parse("https://www.xiaohongshu.com/explore/abc");
    expect(r.via).toBe("online");
    expect(r.result.failType).toBe("bot-gated");
    expect(r.result.code).toBe(403);
  });
});

describe("本地通道（注入可控假核，零网络）", () => {
  /** 覆盖 douyin 的假核；unifiedParseLocal 出参由用例给定 */
  const coreReturning = (out: unknown): CoreEntry => ({
    unifiedParseLocal: async () => out as Record<string, unknown>,
    localParserKeys: () => ["douyin"],
  });

  it("核心 200 → via=local，平台字段补齐并进缓存", async () => {
    let online = 0;
    const e = makeEngine({
      coreLoader: async () => coreReturning({ code: 200, msg: "解析成功", data: { url: "https://x/a.mp4" } }),
      onlineFallback: async () => {
        online++;
        return null;
      },
    });
    const r = await e.parse("https://v.douyin.com/loc/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(200);
    expect(r.result.platform).toBe("douyin");
    await e.parse("https://v.douyin.com/loc/");
    expect(online).toBe(0);
  });

  it("核心给出业务失败码（201）→ 如实透传，不降级线上", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning({ code: 201, msg: "视频已删除" }),
      onlineFallback: async () => ({ code: 200, msg: "线上不该被调用" }),
    });
    const r = await e.parse("https://v.douyin.com/gone/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(201);
    expect(r.result.msg).toBe("视频已删除");
  });

  it("核心返回异形结果（null）+ 回落开 → 按本地失败降级线上", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning(null),
      onlineFallback: async () => ({ code: 200, msg: "ok", data: { url: "https://x/b.mp4" } }),
    });
    const r = await e.parse("https://v.douyin.com/weird/");
    expect(r.via).toBe("online");
    expect(r.fallbackReason).toContain("未返回有效解析结果");
  });

  it("核心返回异形结果 + 回落关 → 明确 500，不把 null 递给 renderer", async () => {
    const e = makeEngine({
      coreLoader: async () => coreReturning(undefined),
      isFallbackEnabled: () => false,
    });
    const r = await e.parse("https://v.douyin.com/weird2/");
    expect(r.via).toBe("local");
    expect(r.result.code).toBe(500);
    expect(r.result.msg).toContain("本地内核未返回有效解析结果");
  });

  it("source+id 模式走本地核心且未命中时兜底线上", async () => {
    const seen: unknown[] = [];
    const e = makeEngine({
      coreLoader: async () => ({
        unifiedParseLocal: async (input: string, opts?: { source?: string; id?: string }) => {
          seen.push([input, opts]);
          return { code: 404, msg: "ID 未命中" };
        },
        localParserKeys: () => ["douyin"],
      }),
      onlineFallback: async () => ({ code: 200, msg: "ok", data: { url: "https://x/c.mp4" } }),
    });
    const r = await e.parse("", "douyin", "1234567890123456789");
    expect(seen[0]).toEqual(["", { source: "douyin", id: "1234567890123456789" }]);
    expect(r.via).toBe("online");
  });
});

describe("供给闸门（注册表开关在引擎被调用之前生效）", () => {
  it("关掉的平台：任何引擎都不许被调用，答复里给出去哪儿开", async () => {
    let online = 0;
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
      onlineFallback: async () => {
        online++;
        return { code: 200, msg: "ok" };
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
    expect(online).toBe(0);
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
    const e = makeEngine({ isFallbackEnabled: () => false });
    const r = await e.parse("https://nowhere.example/v/1", undefined, undefined, {
      platformHint: "brandNewPlatform",
    });
    expect(r.via).toBe("mock");
    expect(r.result.platform).toBe("brandNewPlatform");
  });
});

describe("health 矩阵（注册表 × 在场引擎 × 开关）", () => {
  it("假核只覆盖 kuaishou + 回落关：kuaishou 可解、douyin 无引擎、关掉的平台另说", async () => {
    const e = makeEngine({
      isFallbackEnabled: () => false,
      coreLoader: async () => ({
        unifiedParseLocal: async () => ({}),
        localParserKeys: () => ["kuaishou"],
      }),
      getPlatformSwitches: () => ({ bilibili: { enabled: false } }),
    });
    const rows = await e.health();
    const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
    expect(by.kuaishou.ok).toBe(true);
    expect(by.kuaishou.detail).toContain("本地内核");
    expect(by.douyin.ok).toBe(false);
    expect(by.douyin.detail).toContain("无引擎");
    expect(by.bilibili.detail).toContain("已关闭");
    // 行集 = 注册表全量（内核 PLATFORM_INFO 没有的 qsmusic 也在表上）
    expect(rows.map((r) => r.platform)).toEqual(expect.arrayContaining(["redbook", "qsmusic"]));
    expect(rows.length).toBe(PLATFORMS.length);
  });

  it("回落在场时线上 API 计入可解引擎（注册表 onlineApi=ready 的平台）", async () => {
    const e = makeEngine({
      coreLoader: async () => ({ unifiedParseLocal: async () => ({}), localParserKeys: () => [] }),
    });
    const rows = await e.health();
    const dy = rows.find((r) => r.platform === "douyin");
    expect(dy?.ok).toBe(true);
    expect(dy?.detail).toContain("线上 API");
    const qsm = rows.find((r) => r.platform === "qsmusic");
    // 汽水音乐：本地有 parser（假核没覆盖所以这里不算），线上通道注册表是 unknown → 不可解
    expect(qsm?.ok).toBe(false);
  });

  it("localCoverage 至少含 kuaishou（真核注册表冒烟，导入不发网络）", async () => {
    // 不注入假核：走 engine 默认惰性 import，验证 parse-core 统一入口真实可用
    const e = createEngine({
      readKernelConfig: () => undefined,
      getThrottleMs: () => 0,
      isFallbackEnabled: () => false,
    });
    const keys = await e.localCoverage();
    expect(keys).toContain("kuaishou");
    // 桌面化一致：识别面 20 平台全部本地覆盖，不再依赖线上回落补全
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys).toEqual(
      expect.arrayContaining(["douyin", "bilibili", "redbook", "twitter", "qqmusic"])
    );
  });
});
