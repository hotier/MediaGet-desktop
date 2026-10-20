/**
 * 统计聚合口径测试（renderer/src/lib/stats.ts）。
 *
 * 这里守的是「数字怎么来的」，不是「数字怎么摆」：
 * - 除零必须现原形：`null`（页面渲染「—」）而不是 0 —— 0% 成功率和「一条都没下过」
 *   在图上看是同一个形状，前者是结论，后者是不知道。
 * - 明细行只用于逐文件粒度（作者榜、大小分布），任何比率都不从它算，
 *   因为 history 只有成功记录，从它算失败率永远是 100%。
 * - 平均速度用 `elapsedBytes / elapsedMs`：拿全部字节除以部分样本的耗时是最难看出来的错。
 */
import { describe, expect, it } from "vitest";
import {
  authorTop,
  downloadHealth,
  heatSlotLabel,
  historyScope,
  kindRank,
  platformRank,
  sizeHistogram,
  speedStats,
} from "../renderer/src/lib/stats";
import type { HistoryEntry, StatsQueryResult } from "../types/ipc";

const MB = 1024 * 1024;

type Totals = StatsQueryResult["totals"];
const ZERO: Totals = {
  downloads: 0,
  failures: 0,
  canceled: 0,
  bytes: 0,
  elapsedMs: 0,
  elapsedCount: 0,
  elapsedBytes: 0,
  parses: 0,
  parseFailures: 0,
};
const totals = (patch: Partial<Totals> = {}): Totals => ({ ...ZERO, ...patch });

const entry = (patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: patch.id ?? "t1",
  files: ["D:/Downloads/a.mp4"],
  createdAt: 1,
  ...patch,
});

describe("排行", () => {
  const s = {
    totals: totals({ downloads: 10, failures: 2, bytes: 1000 }),
    byPlatform: {
      douyin: { downloads: 6, failures: 1, bytes: 600, parses: 8, parseFailures: 2 },
      bilibili: { downloads: 4, failures: 1, bytes: 400, parses: 2, parseFailures: 0 },
      xhs: { downloads: 4, failures: 0, bytes: 10, parses: 0, parseFailures: 0 },
    },
  };

  it("默认按下载数降序；并列按平台键升序（切换范围时顺序不该莫名跳动）", () => {
    const rows = platformRank(s);
    expect(rows.map((r) => r.key)).toEqual(["douyin", "bilibili", "xhs"]);
    expect(rows[0]).toMatchObject({ downloadShare: 0.6, byteShare: 0.6 });
    // 每个平台自己的失败率：1/(6+1)，不是全局 2/12
    expect(rows[0].failureRate).toBeCloseTo(1 / 7, 6);
    expect(rows[2].failureRate).toBe(0); // 有分母、零失败：是真的 0%，不是「不知道」
  });

  it("切到 bytes 榜时顺序跟着字节走（tiny 文件多的平台不该压过大文件平台）", () => {
    expect(platformRank(s, "bytes").map((r) => r.key)).toEqual(["douyin", "bilibili", "xhs"]);
    expect(platformRank(s, "failures").map((r) => r.key)).toEqual(["bilibili", "douyin", "xhs"]);
  });

  it("空榜不炸：份额 0、失败率 null，而不是 NaN", () => {
    expect(platformRank({ totals: totals(), byPlatform: {} })).toEqual([]);
    const one = platformRank(
      { totals: totals(), byPlatform: { douyin: { downloads: 0, failures: 0, bytes: 0, parses: 0, parseFailures: 0 } } },
      "bytes"
    );
    expect(one[0]).toMatchObject({ downloadShare: 0, byteShare: 0, failureRate: null });
  });

  it("类型榜把契约 kind 换成中文标签，缺类型桶读作「未分类」", () => {
    const rows = kindRank(
      {
        totals: totals({ downloads: 3, bytes: 30 }),
        byKind: { video: { downloads: 2, bytes: 20 }, unknown: { downloads: 1, bytes: 10 } },
      },
      "bytes"
    );
    expect(rows.map((r) => r.key)).toEqual(["视频", "未分类"]);
    expect(rows[0].parses).toBe(0); // 这维度对类型不成立，恒 0 而不是 undefined
  });
});

describe("健康度 / 速度", () => {
  it("成功率 = done/(done+failed)，一条都没结束过时是 null 而不是 0%", () => {
    expect(downloadHealth({ totals: totals() })).toMatchObject({ done: 0, failed: 0, successRate: null });
    expect(downloadHealth({ totals: totals({ downloads: 8, failures: 2, canceled: 1 }) })).toEqual({
      done: 8,
      failed: 2,
      canceled: 1,
      successRate: 0.8,
      bytes: 0,
    });
  });

  it("平均速度只算有耗时样本的那部分字节", () => {
    const t = totals({ downloads: 10, bytes: 10 * MB, elapsedMs: 2_000, elapsedCount: 2, elapsedBytes: MB });
    expect(speedStats({ totals: t })).toEqual({ avgBytesPerSec: MB / 2, avgElapsedMs: 1000, sampled: 2 });
    // 用 bytes 去除会得 5 MB/s —— 五倍虚高且看不出来
    expect(speedStats({ totals: totals() }).avgBytesPerSec).toBeNull();
  });

  it("热力格文案：星期 × 整点", () => {
    expect(heatSlotLabel(3, 21)).toBe("周三 21:00");
  });
});

describe("历史明细口径", () => {
  it("historyScope 报行数、字节合计与跨度；空表 span=null", () => {
    const rows = [
      entry({ id: "a", createdAt: 300, bytes: 10 }),
      entry({ id: "b", createdAt: 100, bytes: 20 }),
      entry({ id: "c", createdAt: 200 }), // 老记录没有 bytes 键
    ];
    expect(historyScope(rows)).toEqual({ files: 3, bytes: 30, span: { from: 100, to: 300 } });
    expect(historyScope([])).toEqual({ files: 0, bytes: 0, span: null });
  });

  it("大小分布：边界归上一档（恰好 10 MB 算 10–50），缺字节的行进 skipped", () => {
    const rows = [
      entry({ id: "1", bytes: 9 * MB }),
      entry({ id: "2", bytes: 10 * MB }),
      entry({ id: "3", bytes: 60 * MB }),
      entry({ id: "4", bytes: 300 * MB }),
      entry({ id: "5", bytes: 2_000 * MB }),
      entry({ id: "6" }),
      entry({ id: "7", bytes: 0 }),
      entry({ id: "8", bytes: Number.NaN }),
    ];
    const h = sizeHistogram(rows);
    expect(h.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1]);
    expect(h.counted).toBe(5);
    expect(h.skipped).toBe(3);
    expect(h.buckets.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 6);
    expect(sizeHistogram([]).buckets.every((b) => b.count === 0 && b.share === 0)).toBe(true);
  });

  it("作者榜：图集一个组算一件作品，匿名不参与排名", () => {
    const rows = [
      entry({ id: "f1", groupId: "g1", bytes: 10, author: { id: "u1", name: "甲" } }),
      entry({ id: "f2", groupId: "g1", bytes: 10, author: { id: "u1", name: "甲" } }),
      entry({ id: "f3", groupId: "g2", bytes: 10, author: { id: "u1", name: "甲" } }),
      entry({ id: "f4", groupId: "g3", bytes: 5, author: { name: "乙" } }),
      entry({ id: "f5", bytes: 5 }), // 匿名（早期记录没有作者快照）
      entry({ id: "f6", bytes: 5, author: {} }), // 有对象但无名无 id，也算匿名
    ];
    const { list, anonymous } = authorTop(rows);
    expect(list).toEqual([
      { name: "甲", works: 2, files: 3, bytes: 30 },
      { name: "乙", works: 1, files: 1, bytes: 5 },
    ]);
    expect(anonymous).toBe(2);
    expect(authorTop(rows, 1).list).toEqual([{ name: "甲", works: 2, files: 3, bytes: 30 }]);
  });

  it("同分先按作品数、再按名字排；只给 id 的作者用 id 兜名（榜上不能出现空行）", () => {
    const rows = [
      entry({ id: "a", groupId: "g1", author: { name: "Bee" } }),
      entry({ id: "b", groupId: "g2", author: { name: "Ant" } }),
      entry({ id: "c", groupId: "g3", author: { name: "Ant" } }),
      entry({ id: "d", groupId: "g4", author: { name: "Cow" } }),
      entry({ id: "e", groupId: "g5", author: { name: "Cow" } }),
      entry({ id: "f", groupId: "g6", author: { id: "u7" } }),
    ];
    // 文件数 2 的两位在前，同分时按名字升序（Ant/Cow）；文件数 1 的两位同理（Bee/u7）
    expect(authorTop(rows).list.map((r) => r.name)).toEqual(["Ant", "Cow", "Bee", "u7"]);
  });
});

