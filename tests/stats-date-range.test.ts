/**
 * 统计日期范围口径（renderer/src/lib/stats.ts）。
 *
 * 本机自然日、首尾都含；未来日不可选；开始不得晚于结束。
 * 另钉一条最容易骗人的：范围跨过「统计数据覆盖起点」时**不补零** ——
 * 迁移前的日期根本没有事件，画成 0 等于对用户说「那天一条都没下」。
 */
import { describe, expect, it } from "vitest";
import {
  STATS_RANGE_PRESETS,
  activePreset,
  addDays,
  localDayBounds,
  presetRange,
  queryTrend,
  queryTrendYear,
  rangeDays,
  rangeProblem,
  todayKey,
} from "../renderer/src/lib/stats";
import type { StatsQueryResult } from "../types/ipc";

/** 固定在 2026-10-16 15:00 本机时间：预设窗口与跨年边界都要可重现 */
const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();

describe("presetRange", () => {
  it("近 N 天含今天：7 天 = 10-10..10-16，30 天 = 09-17..10-16；365 跨年仍按日历进位", () => {
    expect(presetRange(7, NOW)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
    expect(presetRange(30, NOW)).toEqual({ from: "2026-09-17", to: "2026-10-16" });
    expect(presetRange(365, NOW)).toEqual({ from: "2025-10-17", to: "2026-10-16" });
    expect(STATS_RANGE_PRESETS).toEqual([7, 30, 90]);
  });

  it("单日、闰日与跨月都用本机日历进位（不是 86_400_000 毫秒）", () => {
    expect(rangeDays({ from: "2026-10-16", to: "2026-10-16" })).toBe(1);
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(rangeDays({ from: "2028-02-28", to: "2028-03-01" })).toBe(3);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("本机午夜为界：起始取当天 00:00，结束取次日 00:00（首尾都含）", () => {
    expect(localDayBounds("2026-10-16")).toEqual({
      startAt: new Date(2026, 9, 16).getTime(),
      endAt: new Date(2026, 9, 17).getTime(),
    });
    expect(localDayBounds("2026-02-30")).toBeNull();
    expect(localDayBounds("not-a-date")).toBeNull();
  });

  it("activePreset 只认与今天对齐的范围；自定义范围不冒充预设", () => {
    expect(activePreset(presetRange(30, NOW), NOW)).toBe(30);
    expect(activePreset({ from: "2026-09-16", to: "2026-10-16" }, NOW)).toBeNull();
    expect(todayKey(NOW)).toBe("2026-10-16");
  });
});

describe("queryTrendYear", () => {
  const result = (patch: Partial<StatsQueryResult> = {}): StatsQueryResult => ({
    range: { from: "2026-10-10", to: "2026-10-16" },
    availableFrom: "2026-10-13",
    totals: {
      downloads: 3,
      failures: 0,
      canceled: 0,
      bytes: 300,
      elapsedMs: 0,
      elapsedCount: 0,
      elapsedBytes: 0,
      parses: 2,
      parseFailures: 0,
    },
    byDay: {
      "2026-10-13": { downloads: 1, failures: 0, canceled: 0, bytes: 100, parses: 1, parseFailures: 0 },
      "2026-10-16": { downloads: 2, failures: 0, canceled: 0, bytes: 200, parses: 1, parseFailures: 0 },
    },
    byPlatform: {},
    byKind: {},
    authors: [],
    ...patch,
  });

  it("整段范围逐日出格：不向覆盖起点收缩（年视图撑满窗口）", () => {
    const cells = queryTrendYear(result());
    expect(cells.map((c) => c.key)).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
  });

  it("覆盖起点之前标 missing（画空格），之后缺记录的日子是真 0", () => {
    const cells = queryTrendYear(result());
    expect(cells.slice(0, 3).map((c) => c.missing)).toEqual([true, true, true]);
    expect(cells.slice(3).map((c) => c.missing ?? false)).toEqual([false, false, false, false]);
    expect(cells[0]).toMatchObject({ downloads: 0, bytes: 0, parses: 0 });
    expect(cells[3]).toMatchObject({ key: "2026-10-13", downloads: 1, bytes: 100 });
    expect(cells[4]).toMatchObject({ downloads: 0 });
  });

  it("还没有任何事件时返回空序列", () => {
    expect(queryTrendYear(result({ availableFrom: null }))).toEqual([]);
  });
});

describe("rangeProblem", () => {
  it("未来日期、倒置起止、非法日历日各有自己的拒绝理由", () => {
    expect(rangeProblem("2026-10-16", "2026-10-17", NOW)).toBe("future");
    expect(rangeProblem("2026-10-16", "2026-10-15", NOW)).toBe("order");
    expect(rangeProblem("2026-02-30", "2026-03-01", NOW)).toBe("invalid");
    expect(rangeProblem("", "2026-03-01", NOW)).toBe("invalid");
    expect(rangeProblem("2026-10-16", "2026-10-16", NOW)).toBeNull();
  });
});

describe("queryTrend", () => {
  const result = (patch: Partial<StatsQueryResult> = {}): StatsQueryResult => ({
    range: { from: "2026-10-10", to: "2026-10-16" },
    availableFrom: "2026-10-13",
    totals: {
      downloads: 3,
      failures: 0,
      canceled: 0,
      bytes: 300,
      elapsedMs: 0,
      elapsedCount: 0,
      elapsedBytes: 0,
      parses: 2,
      parseFailures: 0,
    },
    byDay: {
      "2026-10-13": { downloads: 1, failures: 0, canceled: 0, bytes: 100, parses: 1, parseFailures: 0 },
      "2026-10-16": { downloads: 2, failures: 0, canceled: 0, bytes: 200, parses: 1, parseFailures: 0 },
    },
    byPlatform: {},
    byKind: {},
    authors: [],
    ...patch,
  });

  it("从覆盖起点开始画：availableFrom 之前不补零，之后缺记录的日子才是真 0", () => {
    const points = queryTrend(result());
    expect(points.map((p) => p.key)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(points[0]).toMatchObject({ label: "10-13", downloads: 1, bytes: 100, parses: 1 });
    expect(points[1]).toMatchObject({ key: "2026-10-14", downloads: 0, bytes: 0, parses: 0 });
    expect(points[3]).toMatchObject({ downloads: 2, bytes: 200 });
  });

  it("范围整体早于覆盖起点、或还没有任何事件时返回空序列（不是一排 0）", () => {
    expect(queryTrend(result({ range: { from: "2026-10-01", to: "2026-10-09" } }))).toEqual([]);
    expect(queryTrend(result({ availableFrom: null }))).toEqual([]);
  });

  it("覆盖起点早于所选范围时从范围起点画", () => {
    const points = queryTrend(
      result({ availableFrom: "2026-01-01", range: { from: "2026-10-15", to: "2026-10-16" } })
    );
    expect(points.map((p) => p.key)).toEqual(["2026-10-15", "2026-10-16"]);
  });
});
