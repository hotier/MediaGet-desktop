/**
 * 引擎测试：本地识别（真内核纯模块）、黑名单拦截、mock 兜底、本地通道。
 * 全程无外网：默认注入「零覆盖假核」（localParserKeys=[]，任何平台都不走本地），
 * 本地通道用例用可控假核断言 unifiedParseLocal 的走线与出参。
 */
import { describe, expect, it } from "vitest";
import { createEngine, type CoreEntry } from "../electron/main/engine";
import { PLATFORMS } from "../shared/platforms";
import { ParseResultSchema } from "../types/ipc-contract";

/** 零覆盖假核：本地通道永不 Eligible → 走线只可能 mock */
const emptyCore = (): CoreEntry => ({
  unifiedParseLocal: async () => ({ code: 500, msg: "不应被调用" }),
  localParserKeys: () => [],
});

function makeEngine(overrides: Partial<Parameters<typeof createEngine>[0]> = {}) {
  return createEngine({
    readKernelConfig: () => undefined,
    getThrottleMs: () => 0,
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

  it("注册表未覆盖该平台（假核零覆盖）→ mock 兜底且来源如实标注", async () => {
    const e = makeEngine();
    const r = await e.parse("https://v.douyin.com/xxxx/");
    expect(r.via).toBe("mock");
    expect(r.result.msg).toContain("mock");
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
  it("假核只覆盖 kuaishou：kuaishou 可解、douyin 无引擎、关掉的平台另说", async () => {
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
    expect(by.kuaishou.detail).toContain("本地内核");
    expect(by.douyin.ok).toBe(false);
    expect(by.douyin.detail).toContain("无引擎");
    expect(by.bilibili.detail).toContain("已关闭");
    // 行集 = 注册表全量（内核 PLATFORM_INFO 没有的 qsmusic 也在表上）
    expect(rows.map((r) => r.platform)).toEqual(expect.arrayContaining(["redbook", "qsmusic"]));
    expect(rows.length).toBe(PLATFORMS.length);
  });

  it("本地内核是唯一在场引擎：假核零覆盖时全表不可解，不再有「线上 API」通道", async () => {
    const e = makeEngine({
      coreLoader: async () => ({ unifiedParseLocal: async () => ({}), localParserKeys: () => [] }),
    });
    const rows = await e.health();
    expect(rows.every((r) => !r.ok)).toBe(true);
    expect(rows.every((r) => !(r.detail ?? "").includes("线上 API"))).toBe(true);
    const dy = rows.find((r) => r.platform === "douyin");
    expect(dy?.detail).toContain("无引擎");
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
