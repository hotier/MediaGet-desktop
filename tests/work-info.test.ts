/**
 * 作者快照与「复制作品信息」的纯函数。
 * 快照决定了 history.json 里有什么（解析行与下载行共用，住在 shared/author.ts），
 * 复制文本决定了离开应用后用户手里剩下什么（渲染层展示口径，住在 renderer/src/lib/work-info.ts）。
 */
import { describe, expect, it } from "vitest";
import { buildAuthorSnapshot } from "../shared/author";
import { buildWorkInfoText } from "../renderer/src/lib/work-info";
import type { ParseData } from "../types/ipc";

describe("buildAuthorSnapshot", () => {
  it("缺数据 → undefined，而不是一个空对象", () => {
    expect(buildAuthorSnapshot(undefined)).toBeUndefined();
    expect(buildAuthorSnapshot(null)).toBeUndefined();
    expect(buildAuthorSnapshot({} as ParseData)).toBeUndefined();
    // 平台偶尔回空串而不是缺键；空串同样算没有
    expect(buildAuthorSnapshot({ author: "", authorId: "" } as ParseData)).toBeUndefined();
  });

  it("昵称/ID/主页/头像/签名逐项落位", () => {
    expect(
      buildAuthorSnapshot({
        author: "胶片修复所",
        authorId: "19324001",
        authorUrl: "https://space.bilibili.com/19324001",
        avatar: "https://cdn.example/a.png",
        sign: "每周一更",
        followerCount: 1284000,
        followingCount: 312,
        totalFavorited: 8600000,
      } as ParseData)
    ).toEqual({
      name: "胶片修复所",
      id: "19324001",
      url: "https://space.bilibili.com/19324001",
      avatar: "https://cdn.example/a.png",
      sign: "每周一更",
      followerCount: 1284000,
      followingCount: 312,
      totalFavorited: 8600000,
    });
  });

  it("YouTube 的 subscriberCount 归一到 followerCount", () => {
    const snap = buildAuthorSnapshot({ author: "Switch Lab", subscriberCount: 9000 } as ParseData);
    expect(snap?.followerCount).toBe(9000);
    expect(snap?.name).toBe("Switch Lab");
  });

  it("authorId 缺位时退回 uid（抖音形态）", () => {
    const snap = buildAuthorSnapshot({ author: "小满", uid: "MS4wLjAB" } as ParseData);
    expect(snap?.id).toBe("MS4wLjAB");
  });
});

describe("buildWorkInfoText", () => {
  it("整行信息一次复制走：一行一项，含分享链接", () => {
    const text = buildWorkInfoText({
      title: "一分钟讲清楚：为什么地铁上的手机信号会突然掉",
      platformName: "抖音",
      kindLabel: "视频",
      fileCount: 1,
      // 用固定的远过去时刻：相对日（今天/昨天）会随运行日期变化，只有它两侧都稳定
      createdAt: new Date(2026, 0, 5, 8, 9, 10).getTime(),
      sourceUrl: "https://v.douyin.com/abc/",
      author: { name: "信号铺子", id: "9527", url: "https://www.douyin.com/user/9527", followerCount: 12000 },
    });
    expect(text).toBe(
      [
        "标题：一分钟讲清楚：为什么地铁上的手机信号会突然掉",
        "作者：信号铺子（粉丝 1.2万）",
        "作者ID：9527",
        "作者主页：https://www.douyin.com/user/9527",
        "平台：抖音",
        "类型：视频",
        "文件数：1 个",
        "创建时间：2026-01-05 08:09:10",
        "分享链接：https://v.douyin.com/abc/",
      ].join("\n")
    );
  });

  it("缺项不占行：无作者、无链接的老记录只剩标题", () => {
    expect(buildWorkInfoText({ title: "只有一行标题" })).toBe("标题：只有一行标题");
  });

  it("作者有昵称但三个计数全缺 → 不带空括号", () => {
    const text = buildWorkInfoText({ title: "t", author: { name: "只知昵称" } });
    expect(text).toContain("作者：只知昵称");
    expect(text).not.toContain("（");
  });

  it("只有 ID 没有昵称时也进正文（历史页作者列同样退回到 ID）", () => {
    const text = buildWorkInfoText({ title: "t", author: { id: "u-1" } });
    expect(text).toContain("作者ID：u-1");
    expect(text).not.toContain("作者：");
  });
});
