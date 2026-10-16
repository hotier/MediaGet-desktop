/**
 * JsonStore 测试：原子写 / 坏档自愈 / 配置缓存 / 脱敏导出 / 队列节流落盘 / 历史写合并 / 计数档落盘。
 *
 * 队列那组是**回归测试**：早先 saveQueueThrottled 在节流窗口内直接 return，
 * 落盘的是窗口开始时的旧快照，且 flush() 只清定时器不落盘 —— 退出路径上
 * 最后一次快照被整段丢掉，违反 P2 验收「重启后队列/历史完整」。
 * 历史那两组是同一条纪律的第二次落地：追加不再每次全量重写整档，
 * 但「窗口内以内存为准 + 退出必补写 + 外部改档不吞追加」三件都得有判据。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_MAX, JsonStore } from "../electron/main/store";
import { emptyStats } from "../electron/main/stats";
import type { HistoryEntry, PersistedQueueTask, StatsSnapshot } from "../types/ipc";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mg-store-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function task(id: string, received: number, status: PersistedQueueTask["status"] = "downloading"): PersistedQueueTask {
  return {
    taskId: id,
    groupId: "g1",
    url: `https://cdn.example.com/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: "video",
    received,
    total: 1000,
    createdAt: 1,
    status,
  };
}

describe("配置：读写 / 缓存 / 缺省合并", () => {
  it("缺省值与用户值深合并，cookies 深拷不写穿 DEFAULT_SETTINGS", () => {
    const s = new JsonStore(dir);
    const cfg = s.loadConfig();
    cfg.settings.cookies.DOUYIN_COOKIE = "leak?";
    // 再取一次（force 绕缓存）应从盘上读，而不是拿到被改过的模块级常量
    const fresh = s.loadConfig(true);
    expect(fresh.settings.cookies.DOUYIN_COOKIE).toBeUndefined();
  });

  it("saveConfig 写穿缓存：紧接着的 loadConfig 不需读盘", () => {
    const s = new JsonStore(dir);
    const cur = s.loadConfig();
    s.saveConfig({ settings: { ...cur.settings, maxConcurrent: 7 }, kernel: { X: "1" } });
    expect(s.loadConfig().settings.maxConcurrent).toBe(7);
    expect(s.loadConfig().settings.fallbackOnline).toBe(true); // 未动字段保留
  });

  it("getKernelValue 读内核键", () => {
    const s = new JsonStore(dir);
    const cur = s.loadConfig();
    s.saveConfig({ settings: cur.settings, kernel: { BILIBILI_COOKIE: "v" } });
    expect(s.getKernelValue("BILIBILI_COOKIE")).toBe("v");
    expect(s.getKernelValue("NOPE")).toBeUndefined();
  });

  it("exportRedacted 剔除秘密键与全部 cookies（§6.2 凭据红线）", () => {
    const s = new JsonStore(dir);
    const cur = s.loadConfig();
    s.saveConfig({
      settings: { ...cur.settings, cookies: { DOUYIN_COOKIE: "secret" } },
      kernel: { DOUYIN_COOKIE: "secret", YOUTUBE_PIPED_HOSTS: "a,b" },
    });
    const out = s.exportRedacted(["DOUYIN_COOKIE"]) as {
      settings: { cookies: Record<string, string> };
      kernel: Record<string, string>;
    };
    expect(out.kernel.DOUYIN_COOKIE).toBe("<REDACTED>");
    expect(out.kernel.YOUTUBE_PIPED_HOSTS).toBe("a,b");
    expect(out.settings.cookies).toEqual({});
  });
});

describe("坏档自愈：不让坏 JSON 阻断启动", () => {
  it("config.json 坏 JSON → 回落缺省并备份原文件", () => {
    const s = new JsonStore(dir);
    writeFileSync(join(dir, "config.json"), "{ not json");
    const cfg = s.loadConfig();
    expect(cfg.settings.maxConcurrent).toBe(3);
    expect(readdirSync(dir).some((f) => f.startsWith("config.json.corrupt-"))).toBe(true);
  });

  it("history.json 坏 JSON → 回落空数组", () => {
    const s = new JsonStore(dir);
    writeFileSync(join(dir, "history.json"), "]]]");
    expect(s.loadHistory()).toEqual([]);
  });
});

describe("历史：追加序与上限", () => {
  const entry = (id: string): HistoryEntry => ({ id, files: [`/tmp/${id}.mp4`], createdAt: 1 });

  // 历史写是合并窗口的（追加只动内存，落盘等窗口），用例一律用假定时器：
  // 真定时器会在 afterEach 删掉 temp 目录之后才触发，把目录又 mkdirSync 出来。
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("新记录在前", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("h1"));
    const list = s.appendHistory(entry("h2"));
    expect(list.map((h) => h.id)).toEqual(["h2", "h1"]);
    expect(s.loadHistory().map((h) => h.id)).toEqual(["h2", "h1"]);
  });

  it("作者快照原样往返；盘上的老记录（无 author 键）读得出、不炸", () => {
    const s = new JsonStore(dir);
    const withAuthor: HistoryEntry = {
      ...entry("h-author"),
      author: { name: "胶片修复所", id: "19324001", followerCount: 1284000 },
    };
    s.appendHistory(withAuthor);
    expect(s.loadHistory()[0]?.author).toEqual(withAuthor.author);
    s.flush(); // 让这次追加真落到盘上，下面的新实例才读得到

    // 本版本之前写的 history.json 根本没有 author 键 —— 无迁移机制，只能读侧容错。
    // 用「新实例读旧档」表达这个场景：同实例追加后再读会把未落盘的追加并回来，
    // 那是合并窗口的语义（外部改档不吞自己的追加），不是旧档兼容。
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify([{ id: "h-legacy", platform: "bilibili", title: "老记录", files: [], createdAt: 1 }])
    );
    const legacy = new JsonStore(dir).loadHistory();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.author).toBeUndefined();
  });

  it("盘上的老键读进来归一成契约键：历史页按新键筛选认得出老记录", () => {
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify([
        { id: "h-xhs", platform: "xhs", title: "老小红书", files: [], createdAt: 1 },
        { id: "h-ppxia", platform: "ppxia", title: "老皮皮虾", files: [], createdAt: 2 },
        // 注册表外的键原样回吐：归一是为了对上契约键，不是为了把不认识的东西改掉
        { id: "h-free", platform: "brandNewPlatform", title: "没登记的", files: [], createdAt: 3 },
      ])
    );
    const list = new JsonStore(dir).loadHistory();
    expect(list.map((h) => h.platform)).toEqual(["redbook", "pipixia", "brandNewPlatform"]);
  });

  it("超过 HISTORY_MAX 条截断，丢的是最旧的", () => {
    const s = new JsonStore(dir);
    for (let i = 0; i < HISTORY_MAX + 5; i++) s.appendHistory(entry(`h${i}`));
    const list = s.loadHistory();
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0].id).toBe(`h${HISTORY_MAX + 4}`); // 新在前
    expect(list[list.length - 1].id).toBe("h5"); // h0..h4 已出局
  });

  it("clearHistory 真正落盘", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("h1"));
    expect(s.clearHistory()).toEqual([]);
    expect(s.loadHistory()).toEqual([]);
    // 清空是用户动作：不等合并窗口，盘上当下就是空的
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toEqual([]);
  });
});

/**
 * 历史写合并（性能改动的判据）。
 *
 * 改之前每次 appendHistory 都「读整档 + 前置 + 全量重写 + fsync」，本机实测
 * 500 条档位单次 4.4 ms，批量下载连环落盘就是在主进程上一颗一颗钉。
 * 现在内存为准、窗口内只重写一次，代价是崩溃最多丢 1 秒内的追加 ——
 * 所以退出路径的 flush() 必须把这段补上，下面的用例钉的就是这两头。
 * 顺带一提：上面那条截断用例一次 append 5005 条只花 0.4 s，靠的正是「窗口内不写盘」；
 * 逐条落盘一旦回来它会变回几十秒，所以它同时也是这条性能改动的回归哨兵。
 */
describe("历史落盘合并窗口", () => {
  const entry = (id: string): HistoryEntry => ({ id, files: [`/tmp/${id}.mp4`], createdAt: 1 });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("窗口内几十次追加只重写一次整档", () => {
    const s = new JsonStore(dir);
    for (let i = 0; i < 30; i++) s.appendHistory(entry(`h${i}`));
    expect(existsSync(join(dir, "history.json"))).toBe(false); // 还没落盘
    vi.advanceTimersByTime(1000);
    const saved = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as HistoryEntry[];
    expect(saved).toHaveLength(30);
    expect(saved[0].id).toBe("h29"); // 写的是窗口结束时的状态，不是开始时的
  });

  it("flush() 同步补齐未落盘的追加（退出路径不丢历史）", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("a"));
    s.appendHistory(entry("b"));
    s.flush();
    const saved = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as HistoryEntry[];
    expect(saved.map((h) => h.id)).toEqual(["b", "a"]);
    // 已落盘 → 再推进定时器不该重复写
    vi.advanceTimersByTime(5000);
    expect(
      (JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as HistoryEntry[]).length
    ).toBe(2);
  });

  it("无待写追加时 flush() 不创建空 history.json", () => {
    const s = new JsonStore(dir);
    s.flush();
    expect(existsSync(join(dir, "history.json"))).toBe(false);
  });

  it("外部改档后以盘为准，但没落盘的追加不被吃掉", () => {
    const s = new JsonStore(dir);
    writeFileSync(join(dir, "history.json"), JSON.stringify([entry("on-disk")]));
    expect(s.loadHistory().map((h) => h.id)).toEqual(["on-disk"]);
    s.appendHistory(entry("pending")); // 进内存，窗口未到
    writeFileSync(join(dir, "history.json"), JSON.stringify([entry("external")])); // 别的进程写了
    expect(s.loadHistory().map((h) => h.id)).toEqual(["pending", "external"]);
    vi.advanceTimersByTime(1000);
    const saved = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as HistoryEntry[];
    expect(saved.map((h) => h.id)).toEqual(["pending", "external"]);
  });

  it("落盘失败不抛进主进程，但留痕（合并窗口的失败不会在用户眼前重现）", () => {
    const errors: string[] = [];
    const s = new JsonStore(dir, (m) => errors.push(m));
    s.appendHistory(entry("boom")); // 内存为准，窗口未到
    // 落盘时刻到之前把目标名占成目录：tmp→rename 的收尾必然失败
    mkdirSync(join(dir, "history.json"), { recursive: true });
    vi.advanceTimersByTime(1000);
    expect(errors.some((m) => m.includes("history.json 落盘失败"))).toBe(true);
    expect(s.loadHistory().map((h) => h.id)).toEqual(["boom"]); // 写失败不牵连下载与队列
  });
});

describe("队列节流落盘（P2「重启后队列完整」回归）", () => {
  it("节流窗口内多次调用 → 落盘的是最后一次快照（不是第一次）", () => {
    vi.useFakeTimers();
    const s = new JsonStore(dir);
    s.saveQueueThrottled([task("a", 10)]);
    s.saveQueueThrottled([task("a", 50)]);
    s.saveQueueThrottled([task("a", 99)]);
    // 窗口未到：还没落盘
    expect(existsSync(join(dir, "queue.json"))).toBe(false);
    vi.advanceTimersByTime(2000);
    const saved = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as PersistedQueueTask[];
    expect(saved[0].received).toBe(99);
  });

  it("flush() 取消定时器并同步落盘最后快照（退出路径不丢写）", () => {
    vi.useFakeTimers();
    const s = new JsonStore(dir);
    s.saveQueueThrottled([task("a", 10)]);
    s.saveQueueThrottled([task("a", 77)]);
    s.flush(); // before-quit 的收尾
    expect(existsSync(join(dir, "queue.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as PersistedQueueTask[];
    expect(saved[0].received).toBe(77);
    // 定时器已取消：推进时间不会再写（也不应抛）
    vi.advanceTimersByTime(5000);
    expect((JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as PersistedQueueTask[])[0].received).toBe(77);
  });

  it("flush() 无待写快照时是 no-op（不创建空 queue.json）", () => {
    const s = new JsonStore(dir);
    s.flush();
    expect(existsSync(join(dir, "queue.json"))).toBe(false);
  });

  it("saveQueue 立即落盘（非节流路径）", () => {
    const s = new JsonStore(dir);
    s.saveQueue([task("b", 5)]);
    expect((s.loadQueue() as PersistedQueueTask[])[0].received).toBe(5);
  });

  it("saveQueue 超过 QUEUE_MAX 丢的是最旧的（快照已是新在前，截断即尾部出局）", () => {
    const s = new JsonStore(dir);
    const many = Array.from({ length: 250 }, (_, i) => task(`t${i}`, i, "paused"));
    s.saveQueue(many);
    const saved = s.loadQueue() as PersistedQueueTask[];
    expect(saved).toHaveLength(200);
    expect(saved[0].taskId).toBe("t0");
    expect(saved[saved.length - 1].taskId).toBe("t199");
  });

  it("loadQueue 往返保持字段（含 referer/headers/status）", () => {
    const s = new JsonStore(dir);
    const t: PersistedQueueTask = {
      ...task("c", 3, "paused"),
      referer: "https://douyin.com/",
      headers: { "User-Agent": "UA" },
      platform: "douyin",
      title: "t",
    };
    s.saveQueue([t]);
    expect(s.loadQueue()[0]).toEqual(t);
  });
});

/**
 * 计数档落盘（userData/stats.json）。
 *
 * recorder 每次累加都投一次节流口，所以「窗口内只写一次、写的是当下这份」
 * 是这里的核心判据 —— 与队列不同，它交回的一直是同一个对象引用，
 * 定时器到点读到的天然是最后一次状态，不需要 pending 变量兜住快照。
 * 另一头是「什么都没发生过就别建文件」：新用户只打开统计页不该多出一个 stats.json。
 */
describe("计数档落盘", () => {
  const snapshot = (downloads: number): StatsSnapshot => ({
    ...emptyStats(1),
    totals: { ...emptyStats(1).totals, downloads },
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("窗口内几十次累加只重写一次，且写的是最后一次状态", () => {
    const s = new JsonStore(dir);
    for (let i = 1; i <= 30; i++) s.saveStatsThrottled(snapshot(i));
    expect(existsSync(join(dir, "stats.json"))).toBe(false);
    vi.advanceTimersByTime(1000);
    const saved = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8")) as StatsSnapshot;
    expect(saved.totals.downloads).toBe(30);
  });

  it("flush() 同步补齐待写计数（退出路径不丢最后一段）", () => {
    const s = new JsonStore(dir);
    s.saveStatsThrottled(snapshot(3));
    s.flush();
    const saved = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8")) as StatsSnapshot;
    expect(saved.totals.downloads).toBe(3);
    vi.advanceTimersByTime(5000); // 定时器已取消：不再重复写
    expect(
      (JSON.parse(readFileSync(join(dir, "stats.json"), "utf8")) as StatsSnapshot).totals.downloads
    ).toBe(3);
  });

  it("没发生任何累加时不落盘：loadStats 读空 → flush() 不创建 stats.json", () => {
    const s = new JsonStore(dir);
    expect(s.loadStats()).toBeNull();
    s.flush();
    expect(existsSync(join(dir, "stats.json"))).toBe(false);
  });

  it("loadStats 往返整份快照，并把坏档让给上层从零起算（不阻断启动）", () => {
    const s = new JsonStore(dir);
    s.saveStatsThrottled(snapshot(9));
    vi.advanceTimersByTime(1000);
    const reopened = new JsonStore(dir);
    expect(reopened.loadStats()?.totals.downloads).toBe(9);
    writeFileSync(join(dir, "stats.json"), "{ 这不是 JSON");
    expect(new JsonStore(dir).loadStats()).toBeNull();
    expect(readdirSync(dir).some((n) => n.startsWith("stats.json.corrupt-"))).toBe(true);
  });

  it("落盘失败不抛，只留痕", () => {
    const errors: string[] = [];
    const s = new JsonStore(dir, (m) => errors.push(m));
    s.saveStatsThrottled(snapshot(1));
    mkdirSync(join(dir, "stats.json"), { recursive: true }); // 占名 → rename 必失败
    vi.advanceTimersByTime(1000);
    expect(errors.some((m) => m.includes("stats.json 落盘失败"))).toBe(true);
  });
});
