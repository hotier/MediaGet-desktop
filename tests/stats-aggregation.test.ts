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
  TREND_WINDOWS,
  authorTop,
  dayKey,
  downloadHealth,
  heat,
  heatSlotLabel,
  historyScope,
  isEmptyStats,
  kindRank,
  parseStats,
  platformRank,
  sinceLabel,
  sizeHistogram,
  speedStats,
  trendByDay,
  trendTotal,
} from "../renderer/src/lib/stats";
import type { HistoryEntry, StatsSnapshot } from "../types/ipc";

const MB = 1024 * 1024;

/** 渲染层不吃主进程的空档工厂（铁律：renderer 只经 IPC 拿数据），所以这里自己造一份 */
function snap(patch: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    schema: 1,
    since: 0,
    updatedAt: 0,
    totals: { downloads: 0, failures: 0, canceled: 0, bytes: 0, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 },
    parse: { total: 0, failures: 0, local: 0, online: 0, mock: 0, durationMs: 0 },
    byDay: {},
    byPlatform: {},
    byKind: {},
    byHour: new Array<number>(168).fill(0),
    ...patch,
  };
}

/** 固定在 2026-10-16 15:00 本机时间：趋势窗口、补零位置都要可重现 */
const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();
const TODAY = "2026-10-16";
const YESTERDAY = "2026-10-15";

const entry = (patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: patch.id ?? "t1",
  files: ["D:/Downloads/a.mp4"],
  createdAt: 1,
  ...patch,
});

describe("trendByDay", () => {
  it("长度 = 窗口天数，末点是今天，起点在前一天之前连续排开", () => {
    const points = trendByDay(snap(), 7, NOW);
    expect(points).toHaveLength(7);
    expect(points[6].key).toBe(TODAY);
    expect(points[0].key).toBe("2026-10-10");
    expect(points.map((p) => p.label)).toEqual([
      "10-10",
      "10-11",
      "10-12",
      "10-13",
      "10-14",
      "10-15",
      "10-16",
    ]);
    expect(TREND_WINDOWS).toEqual([7, 30, 90, 365]);
  });

  it("没有记录的日子补零而不是跳过（否则周末的空档会把周五和周一接在一起）", () => {
    const s = snap({
      byDay: {
        [TODAY]: { downloads: 2, failures: 1, bytes: 100, parses: 3 },
        "2026-10-10": { downloads: 1, failures: 0, bytes: 50, parses: 0 },
      },
    });
    const points = trendByDay(s, 7, NOW);
    expect(points[0].downloads).toBe(1);
    expect(points[1]).toMatchObject({ key: "2026-10-11", downloads: 0, failures: 0, bytes: 0, parses: 0 });
    expect(points[6]).toMatchObject({ downloads: 2, failures: 1, bytes: 100, parses: 3 });
  });

  it("窗口里的桶只按本机日历命中，跨月跨年不串键", () => {
    const s = snap({ byDay: { "2025-12-31": { downloads: 9, failures: 0, bytes: 1, parses: 0 } } });
    const jan = trendByDay(s, 3, new Date(2026, 0, 1, 8).getTime());
    expect(jan[jan.length - 1]).toMatchObject({ key: "2026-01-01", downloads: 0 });
    expect(trendByDay(s, 3, NOW).some((p) => p.downloads === 9)).toBe(false);
  });

  it("trendTotal 把窗口内合计加出来（卡片右上那句）", () => {
    const points = trendByDay(
      snap({
        byDay: {
          [TODAY]: { downloads: 2, failures: 1, bytes: 100, parses: 3 },
          [YESTERDAY]: { downloads: 5, failures: 0, bytes: 200, parses: 1 },
          "2020-01-01": { downloads: 99, failures: 9, bytes: 999, parses: 9 },
        },
      }),
      7,
      NOW
    );
    expect(trendTotal(points)).toEqual({ downloads: 7, failures: 1, bytes: 300, parses: 4 });
  });
});

describe("排行", () => {
  const s = snap({
    totals: { downloads: 10, failures: 2, canceled: 0, bytes: 1000, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 },
    byPlatform: {
      douyin: { downloads: 6, failures: 1, bytes: 600, parses: 8, parseFailures: 2 },
      bilibili: { downloads: 4, failures: 1, bytes: 400, parses: 2, parseFailures: 0 },
      xhs: { downloads: 4, failures: 0, bytes: 10, parses: 0, parseFailures: 0 },
    },
  });

  it("默认按下载数降序；并列按平台键升序（切换窗口时顺序不该莫名跳动）", () => {
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
    const rows = platformRank(snap(), "downloads");
    expect(rows).toEqual([]);
    const one = platformRank(
      snap({ byPlatform: { douyin: { downloads: 0, failures: 0, bytes: 0, parses: 0, parseFailures: 0 } } }),
      "bytes"
    );
    expect(one[0]).toMatchObject({ downloadShare: 0, byteShare: 0, failureRate: null });
  });

  it("类型榜把契约 kind 换成中文标签，缺类型桶读作「未分类」", () => {
    const rows = kindRank(
      snap({
        totals: { downloads: 3, failures: 0, canceled: 0, bytes: 30, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 },
        byKind: { video: { downloads: 2, bytes: 20 }, unknown: { downloads: 1, bytes: 10 } },
      }),
      "bytes"
    );
    expect(rows.map((r) => r.key)).toEqual(["视频", "未分类"]);
    expect(rows[0].parses).toBe(0); // 这维度对类型不成立，恒 0 而不是 undefined
  });
});

describe("健康度 / 速度 / 解析", () => {
  it("成功率 = done/(done+failed)，一条都没结束过时是 null 而不是 0%", () => {
    expect(downloadHealth(snap())).toMatchObject({ done: 0, failed: 0, successRate: null });
    expect(
      downloadHealth(
        snap({ totals: { downloads: 8, failures: 2, canceled: 1, bytes: 0, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 } })
      )
    ).toEqual({ done: 8, failed: 2, canceled: 1, successRate: 0.8, bytes: 0 });
  });

  it("平均速度只算有耗时样本的那部分字节", () => {
    const s = snap({
      totals: {
        downloads: 10,
        failures: 0,
        canceled: 0,
        bytes: 10 * MB, // 全部字节
        elapsedMs: 2_000,
        elapsedCount: 2,
        elapsedBytes: MB, // 有耗时样本的只有 1 MB
      },
    });
    expect(speedStats(s)).toEqual({ avgBytesPerSec: MB / 2, avgElapsedMs: 1000, sampled: 2 });
    // 用 bytes 去除会得 5 MB/s —— 五倍虚高且看不出来
    expect(speedStats(snap()).avgBytesPerSec).toBeNull();
  });

  it("解析：通道占比按总次数分，成功率和平均耗时各管各的分母", () => {
    const s = snap({
      // 旧档的 online 桶仍在 total 里，但已不是可展示的通道
      parse: { total: 10, failures: 2, local: 7, online: 3, mock: 0, durationMs: 2_500 },
    });
    const p = parseStats(s);
    expect(p.successRate).toBe(0.8);
    expect(p.viaShare).toEqual({ local: 0.7, mock: 0 });
    expect(p.avgDurationMs).toBe(250);
    const empty = parseStats(snap());
    expect(empty).toMatchObject({ total: 0, successRate: null, avgDurationMs: null });
    expect(empty.viaShare).toEqual({ local: 0, mock: 0 }); // 占比是 0，不是「不知道」
  });
});

describe("热力", () => {
  it("峰值给出星期×小时；全 0 时 peak=null", () => {
    const s = snap();
    s.byHour[3 * 24 + 21] = 12;
    s.byHour[3 * 24 + 20] = 5;
    const h = heat(s);
    expect(h.max).toBe(12);
    expect(h.peak).toEqual({ weekday: 3, hour: 21, value: 12 });
    expect(heatSlotLabel(3, 21)).toBe("周三 21:00");
    expect(heat(snap()).peak).toBeNull();
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

describe("卡片辅助", () => {
  it("isEmptyStats：下载、失败、解析三者都为 0 才算空", () => {
    expect(isEmptyStats(snap())).toBe(true);
    expect(isEmptyStats(snap({ totals: { ...snap().totals, failures: 1 } }))).toBe(false);
    expect(isEmptyStats(snap({ parse: { ...snap().parse, total: 1 } }))).toBe(false);
  });

  it("sinceLabel：当天起算就是第 1 天，不是第 0 天", () => {
    expect(sinceLabel(snap({ since: new Date(2026, 9, 16, 1).getTime() }), NOW)).toEqual({
      date: TODAY,
      days: 1,
    });
    expect(sinceLabel(snap({ since: new Date(2026, 9, 14, 23).getTime() }), NOW).days).toBe(3);
    expect(dayKey(NOW)).toBe(TODAY);
  });
});
