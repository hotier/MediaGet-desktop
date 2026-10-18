/**
 * 来源链接归一（v16）：历史/结果卡/下载 meta 的 `sourceUrl` 必须是真实资源页，
 * 不是分享短链。纯口径与跟跳分别守两头：
 * - `pageUrlFromData` / `isShortLink` 是纯函数；
 * - `createSourceUrlResolver` 注入假 fetch，验「作品 ID 不发请求、短链跟到哪存哪、
 *   跟不动回落原文」—— 本仓测试禁真网络。
 */
import { describe, expect, it, vi } from "vitest";
import { isShortLink, pageUrlFromData } from "../shared/source-url";
import { createSourceUrlResolver } from "../electron/main/source-url";

describe("pageUrlFromData：解析结果里的作品 ID → 官方资源页", () => {
  it("抖音视频落 /video，图文落 /note；缺 type 按视频处理", () => {
    expect(
      pageUrlFromData("douyin", { awemeId: "7412000000000000000", type: "video" })
    ).toBe("https://www.douyin.com/video/7412000000000000000");
    expect(
      pageUrlFromData("douyin", { awemeId: "7412000000000000000", type: "image" })
    ).toBe("https://www.douyin.com/note/7412000000000000000");
    expect(pageUrlFromData("douyin", { awemeId: "7412000000000000000" })).toBe(
      "https://www.douyin.com/video/7412000000000000000"
    );
  });

  it("小红书 noteId、YouTube videoId 各拼各的页面；平台别名按注册表归一", () => {
    expect(pageUrlFromData("redbook", { noteId: "66f0c1d2000000001e012345" })).toBe(
      "https://www.xiaohongshu.com/explore/66f0c1d2000000001e012345"
    );
    // 上游路由目录名 xhs 是注册表里的 legacyKey，不能因为叫法不同就拼不出页面
    expect(pageUrlFromData("xhs", { noteId: "abc123" })).toBe(
      "https://www.xiaohongshu.com/explore/abc123"
    );
    expect(pageUrlFromData("youtube", { videoId: "dQw4w9WgXcQ" })).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
  });

  it("没有 ID、平台对不上、ID 带脏字符 → 不猜（undefined）", () => {
    expect(pageUrlFromData("douyin", { title: "没有 awemeId" })).toBeUndefined();
    expect(pageUrlFromData("bilibili", { awemeId: "7412" })).toBeUndefined();
    expect(pageUrlFromData("douyin", undefined)).toBeUndefined();
    // 内核带来脏串时不许直接拼进 URL（路径穿越/参数注入）
    expect(pageUrlFromData("douyin", { awemeId: "../../etc/passwd" })).toBeUndefined();
    expect(pageUrlFromData("youtube", { videoId: "a b" })).toBeUndefined();
  });
});

describe("isShortLink：只认注册表登记的短链入口", () => {
  it("登记的短链主机（含子域）都是", () => {
    expect(isShortLink("https://v.douyin.com/iAbCdEf/")).toBe(true);
    expect(isShortLink("https://b23.tv/abc")).toBe(true);
    expect(isShortLink("https://youtu.be/abc")).toBe(true);
    expect(isShortLink("https://www.v.douyin.com/abc")).toBe(true);
  });

  it("长链、相似域名与非 http(s) 都不是", () => {
    expect(isShortLink("https://www.douyin.com/video/7412")).toBe(false);
    expect(isShortLink("https://notv.douyin.com/abc")).toBe(false);
    expect(isShortLink("ftp://v.douyin.com/abc")).toBe(false);
    expect(isShortLink("v.douyin.com/abc")).toBe(false);
    expect(isShortLink("")).toBe(false);
    expect(isShortLink(undefined)).toBe(false);
  });
});

function fakeResponse(finalUrl: string): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(async () => {});
  return {
    response: { url: finalUrl, body: { cancel } } as unknown as Response,
    cancel,
  };
}

describe("resolveSourceUrl：作品 ID 优先，短链跟跳，失败回落原文", () => {
  it("解析结果已有作品 ID 时不发请求", async () => {
    const fetchImpl = vi.fn();
    const resolve = createSourceUrlResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    const url = await resolve({
      raw: "https://v.douyin.com/abc/",
      platform: "douyin",
      data: { awemeId: "7412000000000000000", type: "video" },
    });
    expect(url).toBe("https://www.douyin.com/video/7412000000000000000");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("短链跟到最终地址，且只要地址、立刻取消正文", async () => {
    const { response, cancel } = fakeResponse("https://www.bilibili.com/video/BV1xx411c7mD");
    const fetchImpl = vi.fn(async () => response);
    const resolve = createSourceUrlResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    const url = await resolve({ raw: "https://b23.tv/abc", platform: "bilibili" });
    expect(url).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("跟跳失败 / 仍落在短链 → 保留用户给的那条（历史不能少一格）", async () => {
    const offline = createSourceUrlResolver({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(offline({ raw: "https://b23.tv/abc" })).resolves.toBe("https://b23.tv/abc");

    const { response } = fakeResponse("https://b23.tv/still-short");
    const looped = createSourceUrlResolver({
      fetchImpl: (async () => response) as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(looped({ raw: "https://b23.tv/abc" })).resolves.toBe("https://b23.tv/abc");
  });

  it("长链与空输入都不发请求", async () => {
    const fetchImpl = vi.fn();
    const resolve = createSourceUrlResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(resolve({ raw: "https://www.douyin.com/video/7412" })).resolves.toBe(
      "https://www.douyin.com/video/7412"
    );
    await expect(resolve({ raw: "   " })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
