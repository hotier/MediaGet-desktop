/**
 * 引擎测试：本地识别（真内核纯模块）、黑名单拦截、mock 兜底、线上回落通道。
 * 全程无外网：解析通道用注入 fake fallback。
 */
import { describe, expect, it } from "vitest";
import { createEngine } from "../electron/main/engine";
import type { ParseResult } from "../types/ipc";

function makeEngine(overrides: Partial<Parameters<typeof createEngine>[0]> = {}) {
  return createEngine({
    readKernelConfig: () => undefined,
    getThrottleMs: () => 0,
    isFallbackEnabled: () => true,
    onlineFallback: async () => null,
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

  it("P0 未抽取平台（douyin）→ 线上回落通道 via=online", async () => {
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

  it("回落关闭 + 本地无该解析器 → mock 兜底且来源如实标注", async () => {
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

describe("platforms 清单（来自内核 PLATFORM_INFO，不复制表）", () => {
  it("非空且含主力平台", () => {
    const e = makeEngine();
    const keys = e.platforms().map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["douyin", "bilibili", "kuaishou", "redbook"]));
    expect(e.platforms().length).toBeGreaterThanOrEqual(18);
  });

  it("localCoverage 至少含 kuaishou（P0 已抽取项）", () => {
    const e = makeEngine();
    expect(e.localCoverage()).toContain("kuaishou");
  });
});
