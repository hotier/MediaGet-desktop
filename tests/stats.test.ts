/**
 * 生命周期记录口测试：回调 → 事件账本 → 范围聚合。
 *
 * 两组值得单独钉：
 * - **失败率的分母**：done 与 failure 各自只加自己那一格。若 failure 误增 downloads，
 *   统计页的成功率会悄悄变成 100%，而库里完全看不出发生过什么。
 * - **写失败不反咬调用方**：记录口挂在下载器/解析器的生命周期上，账本故障只能留痕，
 *   不能把一次成功的下载变成异常。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../electron/main/database";
import { createStatsRepository } from "../electron/main/repositories";
import { createStats } from "../electron/main/stats";

/** 2026-10-16 14:30 本机时区 —— 范围按本地自然日解释 */
const AT = new Date(2026, 9, 16, 14, 30, 0).getTime();
const DAY = "2026-10-16";
const RANGE = { from: DAY, to: DAY };

const directories: string[] = [];
const handles: ReturnType<typeof openDatabase>[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-stats-"));
  directories.push(dir);
  const database = openDatabase(join(dir, "test.sqlite"));
  handles.push(database);
  const repository = createStatsRepository(database);
  let errors = 0;
  const stats = createStats({
    recordEvent: (event, entry) => repository.recordEvent(event, entry),
    query: (range) => repository.query(range),
    onEventError: () => (errors += 1),
  });
  return { stats, database, errors: () => errors };
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      // A test may close the handle to inject a write failure.
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("done：下载成功", () => {
  it("totals / byKind / byPlatform / byDay 同时进账", () => {
    const { stats } = harness();
    stats.done({ at: AT, platform: "douyin", kind: "video", bytes: 4096, elapsedMs: 2000 });
    const s = stats.query(RANGE);
    expect(s.totals).toMatchObject({ downloads: 1, bytes: 4096, elapsedMs: 2000, elapsedCount: 1, elapsedBytes: 4096 });
    expect(s.byKind.video).toEqual({ downloads: 1, bytes: 4096 });
    expect(s.byPlatform.douyin).toMatchObject({ downloads: 1, bytes: 4096 });
    expect(s.byDay[DAY]).toMatchObject({ downloads: 1, bytes: 4096 });
  });

  it("缺 kind 归入 unknown，缺 platform 不进平台榜", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: 10 });
    const s = stats.query(RANGE);
    expect(s.byKind.unknown).toEqual({ downloads: 1, bytes: 10 });
    expect(Object.keys(s.byPlatform)).toHaveLength(0);
  });

  it("脏值折成 0；缺耗时或 0 耗时不进平均耗时的分母", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: Number.NaN, elapsedMs: -5 });
    stats.done({ at: AT, bytes: 100.9, elapsedMs: 0 });
    stats.done({ at: AT, bytes: 9_000 });
    const s = stats.query(RANGE);
    expect(s.totals).toMatchObject({ downloads: 3, bytes: 9_100, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 });
  });

  it("bytes 与 elapsedBytes 是两条总线：平均速度不拿缺耗时的字节当分子", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: 1000, elapsedMs: 1000 });
    stats.done({ at: AT, bytes: 9_000 });
    const { totals } = stats.query(RANGE);
    expect(totals.bytes).toBe(10_000);
    expect(totals.elapsedBytes / (totals.elapsedMs / 1000)).toBe(1000);
  });
});

describe("failure / cancel：只加自己那一格", () => {
  it("失败不增 downloads —— 否则成功率被自己算成 100%", () => {
    const { stats } = harness();
    stats.failure({ at: AT, platform: "bilibili" });
    const s = stats.query(RANGE);
    expect(s.totals).toMatchObject({ failures: 1, downloads: 0, bytes: 0 });
    expect(s.byPlatform.bilibili).toMatchObject({ failures: 1, downloads: 0 });
  });

  it("取消只动 canceled", () => {
    const { stats } = harness();
    stats.cancel({ at: AT, platform: "douyin", kind: "video" });
    expect(stats.query(RANGE).totals).toMatchObject({ canceled: 1, downloads: 0, failures: 0 });
  });
});

describe("parse：解析统计", () => {
  it("失败单独计数、平台按契约键归并", () => {
    const { stats } = harness();
    stats.parse({ at: AT, platform: "douyin", via: "local", ok: true, durationMs: 120 });
    stats.parse({ at: AT, platform: "douyin", via: "mock", ok: false, durationMs: 800 });
    stats.parse({ at: AT, platform: "xhs", via: "local", ok: true, durationMs: Number.NaN });
    const s = stats.query(RANGE);
    expect(s.totals).toMatchObject({ parses: 3, parseFailures: 1 });
    expect(s.byPlatform.douyin).toMatchObject({ parses: 2, parseFailures: 1 });
    expect(s.byPlatform.redbook).toMatchObject({ parses: 1, parseFailures: 0 });
    expect(s.byPlatform.xhs).toBeUndefined();
  });
});

describe("故障与隐私面", () => {
  it("账本写失败不向调用方抛，但经 onEventError 留痕", () => {
    const { stats, database, errors } = harness();
    database.close();
    expect(() => stats.done({ at: AT, bytes: 1 })).not.toThrow();
    expect(errors()).toBe(1);
  });

  it("事件行里看不见 url / 文件名 / Cookie 类内容", () => {
    const { stats, database } = harness();
    stats.done({ at: AT, platform: "douyin", kind: "video", bytes: 1024, elapsedMs: 10, workKey: "douyin:123" });
    stats.failure({ at: AT, platform: "douyin" });
    stats.parse({ at: AT, platform: "douyin", via: "local", ok: false, durationMs: 5 });
    const json = JSON.stringify(database.all("SELECT * FROM stats_events"));
    expect(json).not.toMatch(/https?:/);
    for (const key of ["filename", "title", "author", "cookie", "sourceurl", "filepath"]) {
      expect(json.toLowerCase()).not.toContain(key);
    }
    expect(json).toContain("douyin");
  });
});
