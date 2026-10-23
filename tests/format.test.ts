/**
 * 列表时间与进度口径（renderer/src/lib/format.ts）。
 * 每个 fmtCreated 用例都显式传 now —— 相对日（今天/昨天）不能依赖测试运行的当天，否则明天就红。
 */
import { describe, expect, it } from "vitest";
import { avgSpeed, fmtBytes, fmtCreated, fmtEta, fmtFileStamp } from "../renderer/src/lib/format";

const at = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, m - 1, d, h, mi, s).getTime();

describe("fmtCreated（历史页解析时间列）", () => {
  it("当天 → 今天，且始终到秒、个位数补零", () => {
    expect(fmtCreated(at(2026, 10, 15, 9, 5, 3), at(2026, 10, 15, 12, 0, 0))).toBe("今天 09:05:03");
    expect(fmtCreated(at(2026, 10, 15, 23, 59, 59), at(2026, 10, 15, 23, 59, 59))).toBe("今天 23:59:59");
  });

  it("上一个日历日 → 昨天（按日历日判定，不按 24 小时）", () => {
    // 只隔了 1 小时，但跨了午夜 —— 用户读到的应该是「昨天 23:30」而不是「今天」
    expect(fmtCreated(at(2026, 1, 4, 23, 30, 0), at(2026, 1, 5, 0, 30, 0))).toBe("昨天 23:30:00");
    // 跨月同理
    expect(fmtCreated(at(2026, 9, 30, 18, 0, 0), at(2026, 10, 1, 8, 0, 0))).toBe("昨天 18:00:00");
  });

  it("前天及更早 → 带年份的绝对日期（历史留 5000 条，跨年记录不能只报 MM-DD）", () => {
    expect(fmtCreated(at(2026, 1, 3, 12, 32, 4), at(2026, 1, 5, 0, 0, 0))).toBe("2026-01-03 12:32:04");
    expect(fmtCreated(at(2025, 12, 31, 23, 59, 59), at(2026, 1, 2, 0, 0, 0))).toBe("2025-12-31 23:59:59");
  });

  it("未来时刻不会退化成「昨天/-1」", () => {
    // 主进程写的是 Date.now()，但机器时钟不同步时差值可能为负 —— 走绝对日期
    expect(fmtCreated(at(2026, 10, 16, 12, 0, 0), at(2026, 10, 15, 9, 0, 0))).toBe("2026-10-16 12:00:00");
  });
});

describe("fmtEta（队列页剩余时间列，一律 HH:mm:ss）", () => {
  it("长短都是同一字宽的时:分:秒", () => {
    expect(fmtEta(500_000, 100_000)).toBe("00:00:05");
    expect(fmtEta(600_000, 10_000)).toBe("00:01:00");
    expect(fmtEta(3 * 3600_000 + 5 * 60_000 + 30_000, 1000)).toBe("03:05:30");
  });

  it("向上取整：差 1 毫秒也算 1 秒，不显示 0 让人以为下完了", () => {
    expect(fmtEta(59_999, 1000)).toBe("00:01:00");
    expect(fmtEta(1, 1000)).toBe("00:00:01");
  });

  it("估不出就一律破折号，不猜", () => {
    expect(fmtEta(0, 100_000)).toBe("—"); // 已下完
    expect(fmtEta(1000, 0)).toBe("—"); // 速度未知（total 未给到的分块响应）
    expect(fmtEta(-1, 1000)).toBe("—"); // received 反超 total
    expect(fmtEta(Number.NaN, 1000)).toBe("—");
  });

  it("超过 99 小时不显示（那已经不是「剩余」而是「别等了」）", () => {
    expect(fmtEta(100 * 3600_000, 1000)).toBe("—");
    expect(fmtEta(99 * 3600_000 + 59 * 60_000 + 59_000, 1000)).toBe("99:59:59");
  });
});

describe("fmtFileStamp（导出文件名里的紧凑时刻）", () => {
  it("年+月+日+时+分+秒，各段补零、无分隔符（进文件名，不能有空格与冒号）", () => {
    expect(fmtFileStamp(at(2026, 10, 19, 0, 0, 47))).toBe("20261019000047");
    expect(fmtFileStamp(at(2026, 1, 2, 3, 4, 5))).toBe("20260102030405");
  });

  it("到秒：同一分钟内的两次导出不再撞名", () => {
    expect(fmtFileStamp(at(2026, 10, 19, 13, 5, 1))).not.toBe(fmtFileStamp(at(2026, 10, 19, 13, 5, 59)));
  });
});

describe("fmtBytes（字节口径）", () => {
  it("小于 1 的刻度不许产出 undefined 单位（图表坐标轴会给出 0.2 / 0.8 这类值）", () => {
    // 曾被渲染成「204.8 undefined」「819.2 undefined」：log 为负 → units[-1]
    expect(fmtBytes(0.2)).toBe("0 B");
    expect(fmtBytes(0.8)).toBe("1 B");
    expect(fmtBytes(819.2)).toBe("819 B");
  });

  it("量级换算与 0 值", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(fmtBytes(-1)).toBe("0 B");
    expect(fmtBytes(Number.NaN)).toBe("0 B");
  });
});

describe("avgSpeed（队列页完成行的平均速度）", () => {
  it("字节 ÷ 秒：与统计页 elapsedMs 同一条尺", () => {
    expect(avgSpeed(10 * 1024 * 1024, 5000)).toBe(2 * 1024 * 1024);
    expect(avgSpeed(100, 1000)).toBe(100);
  });

  it("缺耗时 / 零耗时 / 零字节一律 null（界面「—」，不编 0 或 Infinity）", () => {
    expect(avgSpeed(1024, null)).toBeNull(); // v13 之前的完成行没有 finishedAt
    expect(avgSpeed(1024, 0)).toBeNull(); // 瞬间完成不是「无穷大的速度」
    expect(avgSpeed(1024, -1)).toBeNull(); // 机器时钟回拨
    expect(avgSpeed(0, 5000)).toBeNull();
    expect(avgSpeed(Number.NaN, 5000)).toBeNull();
    expect(avgSpeed(1024, Number.NaN)).toBeNull();
  });
});
