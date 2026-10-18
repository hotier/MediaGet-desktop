/**
 * 计数与发布时间的归一（`shared/work-stat.ts`）。
 *
 * 这一层是「导出表里那个数字到底是不是真的」的唯一关口，三条必须钉住的判据：
 * ① 已缩水的计数字符串（小红书 `interactInfo` 的 `"1.2万"`）绝不能当成 1.2 写进 Excel；
 * ② 三套发布时间单位（秒 / 毫秒 / ISO 串）都要归一到本地毫秒，且未来时刻判为不可信；
 * ③ 档位标签与顺序只有 `WORK_STAT_SLOTS` 一份（txt、结果卡、表格三档都读它）。
 */
import { describe, expect, it } from "vitest";
import { toCount } from "../shared/coerce";
import { pickPublishedAt, pickWorkStat, WORK_STAT_SLOTS, workStatItems } from "../shared/work-stat";
import type { ParseData, WorkStat } from "../types/ipc";

/** 现在固定在 2026-01-05：单位换算的用例要的是「相对今天的量级」，不能让用例跟着日历漂 */
const NOW = new Date(2026, 0, 5, 8, 9, 10).getTime();
const SEC = Math.floor(NOW / 1000) - 3 * 86_400;
const MS = NOW - 3 * 86_400_000;

describe("toCount", () => {
  it("只收正数有限数字与纯数字串", () => {
    expect(toCount(1234)).toBe(1234);
    expect(toCount("1234")).toBe(1234);
    expect(toCount(" 1234 ")).toBe(1234);
    expect(toCount("12.5")).toBe(12.5);
  });

  it("缩水的写法一律留空，而不是近似值进表；0 也算没统计（结果卡不占位）", () => {
    expect(toCount("1.2万")).toBeUndefined();
    expect(toCount("5.6亿")).toBeUndefined();
    expect(toCount("")).toBeUndefined();
    expect(toCount("  ")).toBeUndefined();
    expect(toCount("abc")).toBeUndefined();
    expect(toCount(0)).toBeUndefined();
    expect(toCount(-1)).toBeUndefined();
    expect(toCount(Number.NaN)).toBeUndefined();
    expect(toCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toCount(undefined)).toBeUndefined();
    expect(toCount(null)).toBeUndefined();
    expect(toCount({})).toBeUndefined();
  });
});

describe("pickWorkStat", () => {
  it("stat 里的规范位优先，平铺字段兜底", () => {
    const snap = pickWorkStat({
      stat: { view: 100, like: 20, danmaku: 3 },
      views: 99999,
      like: 99999,
      retweets: 7,
      channelViews: 88888,
    } as ParseData);
    expect(snap).toEqual({ view: 100, danmaku: 3, like: 20, retweet: 7 });
  });

  it("stat 缺位时按平铺字段补齐（推特 / YouTube 频道形态）", () => {
    expect(pickWorkStat({ views: 1200, like: 40, retweets: 5, replies: 6, share: 2 } as ParseData)).toEqual({
      view: 1200,
      like: 40,
      retweet: 5,
      reply: 6,
      share: 2,
    });
    expect(pickWorkStat({ channelViews: 4500 } as ParseData)).toEqual({ view: 4500 });
  });

  it("平铺的 likeCount 一档也进表（kuaishou 分支不写 stat，2026-10-19 核对）", () => {
    // 内核 `extractVideoFromPhoto` 把五个计数原样平铺在 data 上，`stat` 一个都没有。
    // 这条漏读时，结果卡与导出整排空白，而解析本身是成功的。
    const snap = pickWorkStat({
      likeCount: 1200,
      commentCount: 88,
      shareCount: 12,
      viewCount: 45000,
      forwardCount: 7,
    } as ParseData);
    expect(snap).toEqual({ like: 1200, reply: 88, share: 12, view: 45000, retweet: 7 });
  });

  it("stat 与平铺同场时 stat 优先，不因别名重复计数", () => {
    const snap = pickWorkStat({ stat: { like: 20 }, likeCount: 999 } as ParseData);
    expect(snap).toEqual({ like: 20 });
  });

  it("一档都没有 → undefined，而不是往历史里塞空对象", () => {
    expect(pickWorkStat(undefined)).toBeUndefined();
    expect(pickWorkStat(null)).toBeUndefined();
    expect(pickWorkStat({} as ParseData)).toBeUndefined();
    expect(pickWorkStat({ stat: {} } as ParseData)).toBeUndefined();
  });
});

describe("pickPublishedAt", () => {
  it("秒 / 毫秒 / ISO 串 / 数字串都归一到本地毫秒", () => {
    expect(pickPublishedAt({ time: SEC } as ParseData, NOW)).toBe(MS);
    expect(pickPublishedAt({ time: MS } as ParseData, NOW)).toBe(MS);
    expect(pickPublishedAt({ time: String(SEC) } as ParseData, NOW)).toBe(MS);
    // 微博形态直接给 ISO 字符串
    expect(pickPublishedAt({ time: new Date(MS).toISOString() } as ParseData, NOW)).toBe(MS);
  });

  it("按量级判单位：1e12 以上只可能是毫秒", () => {
    expect(pickPublishedAt({ time: 1_700_000_000 } as ParseData, NOW)).toBe(1_700_000_000_000);
    expect(pickPublishedAt({ time: 1_700_000_000_000 } as ParseData, NOW)).toBe(1_700_000_000_000);
  });

  it("0、空串、瞎话与未来时刻一律不写", () => {
    expect(pickPublishedAt({ time: 0 } as ParseData, NOW)).toBeUndefined();
    expect(pickPublishedAt({ time: -5 } as ParseData, NOW)).toBeUndefined();
    expect(pickPublishedAt({ time: "" } as ParseData, NOW)).toBeUndefined();
    expect(pickPublishedAt({ time: "not a date" } as ParseData, NOW)).toBeUndefined();
    // 一天宽限之内算可信（本机时钟略慢时发布时间可能比现在晚一点点），超了就整档不写
    expect(pickPublishedAt({ time: NOW + 3_600_000 } as ParseData, NOW)).toBe(NOW + 3_600_000);
    expect(pickPublishedAt({ time: NOW + 2 * 86_400_000 } as ParseData, NOW)).toBeUndefined();
  });
});

describe("workStatItems", () => {
  it("档位顺序即 WORK_STAT_SLOTS 的顺序，缺的档不占位", () => {
    expect(workStatItems({ favorite: 9, view: 1 }).map((s) => s.label)).toEqual(["收藏", "播放"]);
    expect(workStatItems(undefined)).toEqual([]);
    expect(workStatItems({})).toEqual([]);
  });

  it("八档齐全时按那张表的顺序全出（标签只有一份真源）", () => {
    const full: WorkStat = { view: 8, danmaku: 7, like: 6, retweet: 5, reply: 4, favorite: 3, coin: 2, share: 1 };
    expect(workStatItems(full).map((s) => s.label)).toEqual(WORK_STAT_SLOTS.map((s) => s.label));
  });
});
