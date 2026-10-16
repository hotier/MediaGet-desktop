/**
 * 生命周期计数器测试：累加维度 / 保留窗口 / 老档兼容 / 隐私面。
 *
 * 两组值得单独钉：
 * - **失败率的分母**：done 与 failure 各自只加自己那一格。若 failure 误增 downloads，
 *   统计页的成功率会悄悄变成 100%，而盘上完全看不出发生过什么。
 * - **老档续用而非清空**：`ensure()` 遇到形状缺桶必须补齐后接着算；
 *   一把清空等于用户升级一次就把历史计数归零，那是数据损坏不是初始化。
 */
import { describe, expect, it } from "vitest";
import {
  STATS_DAY_RETENTION,
  STATS_HOUR_SLOTS,
  createStats,
  emptyStats,
  type StatsOptions,
} from "../electron/main/stats";
import type { StatsSnapshot } from "../types/ipc";

/** 2026-10-16 14:30 本机时区 —— 断言用的日键/时段都从它现算，不写死星期 */
const AT = new Date(2026, 9, 16, 14, 30, 0).getTime();
const DAY = "2026-10-16";
const SLOT = new Date(AT).getDay() * 24 + new Date(AT).getHours();

function harness(loaded: StatsSnapshot | null = null) {
  const saved: StatsSnapshot[] = [];
  const resets: string[] = [];
  let t = AT;
  const opts: StatsOptions = {
    load: () => loaded,
    save: (s) => saved.push(s),
    now: () => t,
    onReset: (reason) => resets.push(reason),
  };
  const stats = createStats(opts);
  return { stats, saved, resets, setNow: (v: number) => (t = v) };
}

describe("done：下载成功累加", () => {
  it("五个维度同时进账：totals / byKind / byPlatform / byDay / byHour", () => {
    const { stats, saved } = harness();
    stats.done({ at: AT, platform: "douyin", kind: "video", bytes: 4096, elapsedMs: 2000 });
    const s = stats.snapshot();
    expect(s.totals).toMatchObject({
      downloads: 1,
      bytes: 4096,
      elapsedMs: 2000,
      elapsedCount: 1,
      elapsedBytes: 4096,
    });
    expect(s.byKind.video).toEqual({ downloads: 1, bytes: 4096 });
    expect(s.byPlatform.douyin.downloads).toBe(1);
    expect(s.byPlatform.douyin.bytes).toBe(4096);
    expect(s.byDay[DAY]).toMatchObject({ downloads: 1, bytes: 4096 });
    expect(s.byHour[SLOT]).toBe(1);
    expect(s.byHour).toHaveLength(STATS_HOUR_SLOTS);
    // 每次变更都投一次节流口（落盘几次由 JsonStore 决定，这里只保证不漏投）
    expect(saved).toHaveLength(1);
  });

  it("缺 kind 归入 unknown，缺 platform 不进平台榜（而不是造一个空键）", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: 10 });
    const s = stats.snapshot();
    expect(s.byKind.unknown).toEqual({ downloads: 1, bytes: 10 });
    expect(Object.keys(s.byPlatform)).toHaveLength(0);
  });

  it("bytes / elapsedMs 的脏值折成 0：NaN 不许污染累计，缺耗时不进分母", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: Number.NaN, elapsedMs: -5 });
    stats.done({ at: AT, bytes: 100.9 });
    const s = stats.snapshot();
    expect(s.totals.bytes).toBe(100); // 第一笔 NaN → 0；第二笔向下取整
    expect(s.totals.elapsedMs).toBe(0);
    expect(s.totals.elapsedCount).toBe(0); // 平均耗时的分母仍是 0，统计页据此显示「—」
    expect(s.totals.downloads).toBe(2);
  });

  it("elapsedMs 为 0 的样本不计入耗时（下载瞬间完成≠真的 0 ms）", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: 1, elapsedMs: 0 });
    expect(stats.snapshot().totals.elapsedCount).toBe(0);
  });

  it("bytes 与 elapsedBytes 是两条总线：缺耗时的记录只进前者", () => {
    const { stats } = harness();
    stats.done({ at: AT, bytes: 1000, elapsedMs: 1000 }); // 有耗时样本
    stats.done({ at: AT, bytes: 9_000 }); // 老任务没有 finishedAt
    const s = stats.snapshot();
    expect(s.totals.bytes).toBe(10_000);
    expect(s.totals.elapsedBytes).toBe(1000);
    // 平均速度取 1000 B/s 而不是 10000 B/s —— 后者是拿两条总线相除造出来的假数
    expect(s.totals.elapsedBytes / (s.totals.elapsedMs / 1000)).toBe(1000);
  });
});

describe("failure / cancel：只加自己那一格", () => {
  it("失败不增 downloads —— 否则成功率被自己算成 100%", () => {
    const { stats } = harness();
    stats.failure({ at: AT, platform: "bilibili" });
    const s = stats.snapshot();
    expect(s.totals.failures).toBe(1);
    expect(s.totals.downloads).toBe(0);
    expect(s.totals.bytes).toBe(0);
    expect(s.byPlatform.bilibili).toMatchObject({ failures: 1, downloads: 0 });
    expect(s.byDay[DAY]).toMatchObject({ failures: 1, downloads: 0 });
    expect(s.byHour[SLOT]).toBe(0); // 热力图只画下载时刻，失败不占格
  });

  it("取消只动 canceled，不记时间维度（取消点没有「哪天」的意义）", () => {
    const { stats } = harness();
    stats.cancel();
    const s = stats.snapshot();
    expect(s.totals.canceled).toBe(1);
    expect(Object.keys(s.byDay)).toHaveLength(0);
    expect(s.totals.downloads).toBe(0);
  });
});

describe("parse：解析统计", () => {
  it("按通道分桶，code≠200 记失败，时长累加", () => {
    const { stats } = harness();
    stats.parse({ at: AT, platform: "douyin", via: "local", ok: true, durationMs: 120 });
    stats.parse({ at: AT, platform: "douyin", via: "online", ok: false, durationMs: 800 });
    stats.parse({ at: AT, platform: "kuaishou", via: "mock", ok: true, durationMs: Number.NaN });
    const s = stats.snapshot();
    expect(s.parse).toEqual({
      total: 3,
      failures: 1,
      local: 1,
      online: 1,
      mock: 1,
      durationMs: 920,
    });
    expect(s.byPlatform.douyin).toMatchObject({ parses: 2, parseFailures: 1 });
    expect(s.byPlatform.kuaishou).toMatchObject({ parses: 1, parseFailures: 0 });
    expect(s.byDay[DAY]).toMatchObject({ parses: 3, downloads: 0 });
  });
});

describe("保留窗口", () => {
  it(`byDay 超过 ${STATS_DAY_RETENTION} 天丢最旧的（键是 YYYY-MM-DD，字典序即时间序）`, () => {
    const { stats } = harness();
    const total = STATS_DAY_RETENTION + 10;
    for (let i = 0; i < total; i++) {
      stats.done({ at: new Date(2020, 0, 1 + i).getTime(), bytes: 1 });
    }
    const s = stats.snapshot();
    expect(Object.keys(s.byDay)).toHaveLength(STATS_DAY_RETENTION);
    expect(s.byDay["2020-01-01"]).toBeUndefined();
    expect(s.byDay["2020-01-10"]).toBeUndefined();
    expect(s.byDay["2020-01-11"]).toMatchObject({ downloads: 1 });
    // 总数不受窗口影响：窗口只管明细，累计是「从我装到你那天起」
    expect(s.totals.downloads).toBe(total);
  });

  it("since 记录首次落账的时刻，后续累加不改写它", () => {
    const { stats, setNow } = harness();
    stats.done({ at: AT, bytes: 1 });
    setNow(AT + 86_400_000);
    stats.done({ at: AT + 86_400_000, bytes: 1 });
    const s = stats.snapshot();
    expect(s.since).toBe(AT);
    expect(s.updatedAt).toBe(AT + 86_400_000);
  });
});

describe("老档兼容", () => {
  it("无档 → 从零起算且 byHour 是满格 0", () => {
    const { stats, resets } = harness(null);
    const s = stats.snapshot();
    expect(s.since).toBe(AT);
    expect(s.byHour).toHaveLength(STATS_HOUR_SLOTS);
    expect(s.byHour.every((n) => n === 0)).toBe(true);
    expect(resets).toHaveLength(0); // 档不存在不是异常，不必留痕
  });

  it("结构版本不认识 → 按空档起算并留痕（不拿 v2 的语义解释 v1 的数）", () => {
    const old = { ...emptyStats(AT), schema: 2 } as unknown as StatsSnapshot;
    const { stats, resets } = harness(old);
    expect(stats.snapshot().totals.downloads).toBe(0);
    expect(resets.join(" ")).toContain("结构版本");
  });

  it("byHour 缺失（半残档）→ 同样从零起算并留痕", () => {
    const broken = { ...emptyStats(AT), byHour: undefined } as unknown as StatsSnapshot;
    const { stats, resets } = harness(broken);
    expect(stats.snapshot().byHour).toHaveLength(STATS_HOUR_SLOTS);
    expect(resets).toHaveLength(1);
  });

  it("缺维度的老档补齐后续用：已有计数一位不丢", () => {
    const partial = {
      schema: 1,
      since: AT - 1000,
      updatedAt: AT,
      totals: { downloads: 7, failures: 0, canceled: 0, bytes: 999, elapsedMs: 0, elapsedCount: 0 },
      byHour: emptyStats(AT).byHour, // 热力格是硬形状，缺了走上面那条重置路径
      byDay: { "2020-01-01": { downloads: 1, failures: 0, bytes: 1, parses: 0 } },
      // 故意缺 parse / byKind / byPlatform：补成零值而不是把整份计数丢掉
    } as unknown as StatsSnapshot;
    const { stats } = harness(partial);
    stats.done({ at: AT, platform: "douyin", kind: "video", bytes: 1, elapsedMs: 10 });
    const s = stats.snapshot();
    expect(s.since).toBe(AT - 1000);
    expect(s.totals.downloads).toBe(8);
    expect(s.totals.bytes).toBe(1000);
    expect(s.byPlatform.douyin.downloads).toBe(1);
    expect(s.byDay["2020-01-01"]).toMatchObject({ downloads: 1 });
    expect(s.byDay[DAY]).toMatchObject({ downloads: 1 });
    expect(s.parse).toEqual(emptyStats(AT).parse);
  });

  it("盘上的老键并到契约键：xhs 与 redbook 是同一个平台，计数相加而不是摆两行", () => {
    const row = (n: number) => ({
      downloads: n,
      failures: 0,
      bytes: n * 10,
      parses: n,
      parseFailures: 0,
    });
    const old = {
      ...emptyStats(AT),
      byPlatform: { xhs: row(3), redbook: row(2), ppxia: row(1), nowhere: row(4) },
    };
    const s = createStats({ load: () => old, save: () => {} }).snapshot();
    expect(s.byPlatform.redbook).toEqual(row(5));
    expect(s.byPlatform.pipixia).toEqual(row(1));
    // 注册表认不出的键原样留着：注册表不许改写盘上看不懂的东西
    expect(s.byPlatform.nowhere).toEqual(row(4));
    expect(Object.keys(s.byPlatform)).not.toContain("xhs");
  });

  it("byHour 长度不合（老版本桶数不同）→ 截断或补零到 168", () => {
    const short = { ...emptyStats(AT), byHour: [1, 2, 3] };
    expect(createStats({ load: () => short, save: () => {} }).snapshot().byHour).toHaveLength(
      STATS_HOUR_SLOTS
    );
    const long = { ...emptyStats(AT), byHour: new Array(200).fill(1) };
    const s = createStats({ load: () => long, save: () => {} }).snapshot();
    expect(s.byHour).toHaveLength(STATS_HOUR_SLOTS);
    expect(s.byHour[0]).toBe(1);
  });

  it("load 只发生一次：snapshot() 反复调不重读盘", () => {
    let loads = 0;
    const stats = createStats({
      load: () => {
        loads += 1;
        return null;
      },
      save: () => {},
      now: () => AT,
    });
    stats.done({ at: AT, bytes: 1 });
    stats.snapshot();
    stats.snapshot();
    expect(loads).toBe(1);
  });
});

describe("隐私面", () => {
  it("序列化后看不见 url / 文件名 / Cookie 类字段", () => {
    const { stats } = harness();
    stats.done({ at: AT, platform: "douyin", kind: "video", bytes: 1024, elapsedMs: 10 });
    stats.failure({ at: AT, platform: "douyin" });
    stats.parse({ at: AT, platform: "douyin", via: "local", ok: false, durationMs: 5 });
    const json = JSON.stringify(stats.snapshot());
    expect(json).not.toMatch(/https?:/);
    for (const key of ["url", "filename", "title", "author", "cookie", "sourceUrl", "filePath"]) {
      expect(json.toLowerCase()).not.toContain(key);
    }
    expect(json).toContain("douyin"); // 平台维度是允许的最小暴露面
  });
});
