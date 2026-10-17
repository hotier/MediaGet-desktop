/**
 * 作者快照与「复制作品信息」的纯函数。
 * 快照决定了 history.json 里有什么（解析行与下载行共用，住在 shared/author.ts），
 * 复制文本决定了离开应用后用户手里剩下什么（渲染层展示口径，住在 renderer/src/lib/work-info.ts）。
 */
import { describe, expect, it } from "vitest";
import { buildAuthorSnapshot } from "../shared/author";
import { buildWorkInfoText } from "../renderer/src/lib/work-info";
import { EXPORT_COLUMNS } from "../renderer/src/lib/history-selection";
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
        videoCount: 148,
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
      videoCount: 148,
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
  it("整行信息一次复制走：一行一项，含大小、计数、两个时间与链接", () => {
    const text = buildWorkInfoText({
      title: "一分钟讲清楚：为什么地铁上的手机信号会突然掉",
      platformName: "抖音",
      kindLabel: "视频",
      fileCount: 1,
      bytes: 34096000,
      // 用固定的远过去时刻：相对日（今天/昨天）会随运行日期变化，只有它两侧都稳定
      createdAt: new Date(2026, 0, 5, 8, 9, 10).getTime(),
      publishedAt: new Date(2025, 9, 21, 19, 30, 0).getTime(),
      stat: { view: 520000, like: 12300, reply: 400 },
      sourceUrl: "https://v.douyin.com/abc/",
      dir: "D:\\下载\\信号铺子",
      author: {
        name: "信号铺子",
        id: "9527",
        url: "https://www.douyin.com/user/9527",
        followerCount: 12000,
        followingCount: 88,
        totalFavorited: 3400,
        videoCount: 12,
      },
    });
    expect(text).toBe(
      [
        "标题：一分钟讲清楚：为什么地铁上的手机信号会突然掉",
        "作者：信号铺子（粉丝 1.2万 · 关注 88 · 获赞 3,400 · 投稿 12）",
        "作者ID：9527",
        "作者主页：https://www.douyin.com/user/9527",
        "平台：抖音",
        "类型：视频",
        "文件数：1 个",
        // 大小走 fmtBytes 的量级缩写（表格档那一列是原始字节，两边同字段不同排版）
        "大小：32.5 MB",
        // 「数据」按 WORK_STAT_SLOTS 的顺序，缺的档不占位（这条没有收藏/投币/分享）
        "数据：播放 52.0万 · 点赞 1.2万 · 评论 400",
        "发布时间：2025-10-21 19:30:00",
        // 与上一行成对：标签必须说得出「作品发的」与「本机记的」是两件事
        "解析时间：2026-01-05 08:09:10",
        "分享链接：https://v.douyin.com/abc/",
        "落地目录：D:\\下载\\信号铺子",
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

  it("未下载的行不写「大小：0 B」——那一档的意思是「还没下」，不是「下坏了」", () => {
    // 「文件数：0 个」照写（那是真话），只有字节这一档因为 fmtBytes(0)="0 B" 会被读成下载过
    expect(buildWorkInfoText({ title: "t", fileCount: 0, bytes: 0 })).toBe("标题：t\n文件数：0 个");
  });
});

/**
 * 业主指令 2026-10-17「作品详情的复制按钮复制的内容字段也和导出的信息一样」：
 * 表格档（xlsx/csv/json）与复制正文（txt 同源）是两套**排版**、一套**字段**。
 * 这条守卫盯的就是「给表格加一列，忘了复制那边也有这一项」——它不会编译报错，
 * 只会让用户粘出来的东西比导出的少一格，而少的那格要到用的时候才发现。
 */
describe("复制正文与表格档的字段集", () => {
  /** 两边不必同字：「大小(字节)」那一串括号是表格的单位说明，粘进聊天框只写「大小」；
   *  作者四项在正文里挂在昵称后的括号内（粉丝 / 关注 / 获赞 / 投稿）。 */
  const TEXT_LABEL: Record<string, string> = {
    "大小(字节)": "大小",
    作者昵称: "作者",
    粉丝数: "粉丝",
    关注数: "关注",
    获赞数: "获赞",
    投稿数: "投稿",
  };

  it("EXPORT_COLUMNS 的每一列在复制正文里都占一项", () => {
    const text = buildWorkInfoText({
      title: "t",
      platformName: "哔哩哔哩",
      kindLabel: "视频",
      fileCount: 2,
      bytes: 4096,
      createdAt: 1760000000000,
      publishedAt: 1759000000000,
      stat: { view: 8, danmaku: 7, like: 6, retweet: 5, reply: 4, favorite: 3, coin: 2, share: 1 },
      sourceUrl: "https://b23.tv/abc",
      dir: "D:\\下载",
      author: { name: "a", id: "i", url: "https://space.bilibili.com/i", followerCount: 1, followingCount: 2, totalFavorited: 3, videoCount: 4 },
    });
    const missing = EXPORT_COLUMNS.map((c) => c.header).filter((header) => {
      const label = TEXT_LABEL[header] ?? header;
      return !(text.includes(`${label}：`) || text.includes(`${label} `));
    });
    expect(missing).toEqual([]);
  });
});
