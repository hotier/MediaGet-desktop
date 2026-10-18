/**
 * JsonStore 测试：原子写 / 坏档自愈 / 配置缓存 / 脱敏导出 / 队列节流落盘 / 历史写合并 / 计数档落盘 / 解析行去重。
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
import { HISTORY_MAX, JsonStore, queueDigest } from "../electron/main/store";
import { emptyStats } from "../electron/main/stats";
import { parseHistoryEntry, workKeyOf } from "../shared/history";
import { HistoryEntrySchema } from "../types/ipc-contract";
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
    expect(s.loadConfig().settings.downloadDir).toBe(""); // 未动字段保留
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
    // ppxia 的平台已随内核 1.0.0 下线，别名不存在了 → 与未登记键同一条出路（原样回吐）
    expect(list.map((h) => h.platform)).toEqual(["redbook", "ppxia", "brandNewPlatform"]);
  });

  /**
   * 事故回归（2026-10-18）：bilibili 内核把 `uid` 填成数字，旧口径下它被抄进
   * `author.id` 落盘。`AuthorSnapshotSchema.id` 是 STR，而 dev 下 `history:list` 的**出参**
   * 也过校验 —— 一个脏字段让整次调用判成 contract-drift，渲染层 `.catch(() => {})` 再把它
   * 读成「暂无历史记录」。满盘 21 行在屏幕上凭空消失，盘上一个字节都没少。
   * 所以读侧必须自己把这类存量洗成契约形状：数字 mid 收成字符串（信息留着），而不是等下一行把它冲掉。
   */
  it("盘上的脏作者快照读侧归一：整表仍过得出契约（一行脏字段不许锁死一整页）", () => {
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify([
        {
          id: "h-clean",
          platform: "douyin",
          title: "干净的一行",
          files: [],
          author: { name: "小满", id: "MS4wLjAB", followerCount: 12 },
          createdAt: 1,
        },
        {
          id: "h-dirty",
          platform: "bilibili",
          title: "数字 mid 那一行",
          files: [],
          author: { name: "王刚", id: 290526283, followerCount: 6787452 },
          createdAt: 2,
        },
      ])
    );
    const list = new JsonStore(dir).loadHistory();
    expect(list[1]?.author?.id).toBe("290526283");
    expect(list[1]?.author?.name).toBe("王刚"); // 归一只改形状，不牵连同行好字段
    expect(() => HistoryEntrySchema.array().parse(list)).not.toThrow();
  });

  it("超过 HISTORY_MAX 条截断，丢的是最旧的", () => {
    const s = new JsonStore(dir);
    for (let i = 0; i < HISTORY_MAX + 5; i++) s.appendHistory(entry(`h${i}`));
    const list = s.loadHistory();
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0].id).toBe(`h${HISTORY_MAX + 4}`); // 新在前
    expect(list[list.length - 1].id).toBe("h5"); // h0..h4 已出局
  });

  it("removeHistory 传全部键 = 整表清空，且当下降落盘（「清空历史」撤掉后这是唯一的全清路径）", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("h1"));
    s.appendHistory(entry("h2"));
    expect(s.removeHistory(["h1", "h2"])).toEqual([]);
    expect(s.loadHistory()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toEqual([]);
  });
});

/**
 * v8「历史 = 解析历史」的两个写入口（业主指令 2026-10-17）。
 *
 * 同一作品现在有两类行：解析行（files 空，来自 parse:run）与下载行（来自落地文件）。
 * 它们必须是历史页的**一行**，所以解析行按可复算的作品键 upsert，下载行照旧 append。
 * 这两个语义一旦混用就同时坏：改成 append 会让重试解析堆成一屏重复行，改成 upsert
 * 会让图集的第二、三个文件互相顶掉 —— 所以下面第 4 条专门钉「append 不许去重」。
 */
describe("历史：解析行按作品键刷新（upsertHistory）", () => {
  const url = "https://v.kuaishou.com/abc";
  // 兜底值只为过类型（作品键算不出就等于 shared/history 坏了，用例自然红）
  const key = workKeyOf(url) ?? "w-broken";
  const parseRow = (at: number): HistoryEntry =>
    parseHistoryEntry({ sourceUrl: url, platform: "kuaishou", title: "作品", fallbackId: "p-x", at });
  const fileRow = (id: string): HistoryEntry => ({
    id,
    groupId: key,
    platform: "kuaishou",
    title: "作品",
    kind: "video",
    files: [`/tmp/${id}.mp4`],
    createdAt: 2,
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("同一条链接重复解析只留一行，且时刻是最新的", () => {
    const s = new JsonStore(dir);
    s.upsertHistory(parseRow(100));
    s.upsertHistory(parseRow(300)); // 直链过期后「重新解析并下载」也走这条
    const list = s.loadHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: key, createdAt: 300, files: [] });
  });

  it("解析行与同作品的下载行共存：两行都在，按作品键一次删净", () => {
    const s = new JsonStore(dir);
    s.upsertHistory(parseRow(100));
    s.appendHistory(fileRow("d1"));
    s.appendHistory(fileRow("d2"));
    expect(s.loadHistory()).toHaveLength(3);
    // 历史页聚合按 groupId：这三行在界面上就是作品「abc」的一行
    expect(new Set(s.loadHistory().map((h) => h.groupId))).toEqual(new Set([key]));
    expect(s.removeHistory([key])).toHaveLength(0);
  });

  it("重复解析刷新后落盘的是最新时刻，档里仍只有一行", () => {
    const s = new JsonStore(dir);
    s.upsertHistory(parseRow(100));
    s.upsertHistory(parseRow(200));
    expect(existsSync(join(dir, "history.json"))).toBe(false); // 与 append 同一条合并窗口
    vi.advanceTimersByTime(1000);
    const saved = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as HistoryEntry[];
    expect(saved).toHaveLength(1);
    expect(saved[0].createdAt).toBe(200);
  });

  it("appendHistory 对同 id 不去重（下载行的每落地一个文件 = 一行，不许被解析语义污染）", () => {
    const s = new JsonStore(dir);
    s.appendHistory(fileRow("d1"));
    s.appendHistory(fileRow("d1"));
    expect(s.loadHistory()).toHaveLength(2);
  });

  it("读侧补算作品键：旧键 + 尾部斜杠变体加载时合成一行，按新键能删整组", () => {
    const rows: HistoryEntry[] = [
      {
        id: "w-old-slash",
        groupId: "w-old-slash",
        platform: "bilibili",
        title: "同一个作品",
        files: [],
        sourceUrl: "https://www.bilibili.com/video/BV1VTYT6tEV2/",
        createdAt: 300,
      },
      {
        id: "w-old-bare",
        groupId: "w-old-bare",
        platform: "bilibili",
        title: "同一个作品",
        files: [],
        sourceUrl: "https://www.bilibili.com/video/BV1VTYT6tEV2",
        createdAt: 100,
      },
      {
        id: "dl-1",
        groupId: "w-old-slash",
        platform: "bilibili",
        title: "同一个作品",
        kind: "video",
        files: ["/tmp/BV1VTYT6tEV2.mp4"],
        sourceUrl: "https://www.bilibili.com/video/BV1VTYT6tEV2/",
        createdAt: 200,
      },
    ];
    writeFileSync(join(dir, "history.json"), JSON.stringify(rows));
    const s = new JsonStore(dir);
    const key = workKeyOf("https://www.bilibili.com/video/BV1VTYT6tEV2") ?? "w-broken";
    const list = s.loadHistory();
    expect(list.map((e) => e.id)).toEqual([key, "dl-1"]);
    expect(new Set(list.map((e) => e.groupId))).toEqual(new Set([key]));
    expect(s.removeHistory([key])).toEqual([]);
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
 * 队列落盘留痕（业主指令 2026-10-18：「队列落盘也写日志吧，需要保证队列数据能够正确存储和读取」）。
 *
 * 起因是一次「谁在 00:57 把 queue.json 写成了 []」的排查：那条链路上只有启动时的一行
 * 「队列恢复 N 项」，写失败被 catch 静默吞掉、坏档自愈也不出声，最后只能靠两个 mtime 反推。
 * 所以这里钉五件事：形状变了必留痕、同形状不刷屏、写失败出声、坏档/异形出声且读回空、截断出声。
 * 日志只投「条数 + 状态分布」两维：文件日志与 config 同处 userData，直链与文件名一律不进（§6）。
 */
describe("队列落盘留痕", () => {
  it("摘要按固定状态序排；空档只剩一个数", () => {
    expect(queueDigest([])).toBe("0 项");
    expect(
      queueDigest([task("a", 1, "done"), task("b", 2, "downloading"), task("c", 3, "error")])
    ).toBe("3 项（downloading 1 · done 1 · error 1）");
  });

  it("形状变了才留痕：进度 tick 不刷屏，一行消失看得见", () => {
    const infos: string[] = [];
    const s = new JsonStore(dir, () => {}, (m) => infos.push(m));
    s.saveQueue([task("a", 10)]);
    s.saveQueue([task("a", 999)]); // 只有 received 变了，状态分布没动
    expect(infos).toEqual(["[store] 队列落盘 1 项（downloading 1）"]);
    s.saveQueue([task("a", 999, "done"), task("b", 1)]);
    expect(infos[1]).toBe("[store] 队列落盘 2 项（downloading 1 · done 1）");
  });

  it("摘要里没有直链、文件名与落地路径（隐私红线）", () => {
    const infos: string[] = [];
    const s = new JsonStore(dir, () => {}, (m) => infos.push(m));
    s.saveQueue([
      {
        ...task("secret-id", 1, "done"),
        url: "https://cdn.example.com/a.mp4?sign=abc",
        filename: "秘密作品.mp4",
        filePath: "D:\\Downloads\\秘密作品.mp4",
      },
    ]);
    expect(infos[0]).not.toContain("secret-id");
    expect(infos[0]).not.toContain("cdn.example.com");
    expect(infos[0]).not.toContain("秘密");
  });

  it("写失败必须出声（旧版是静默 catch：它丢的是「重启后那条还没下完的任务」）", () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const s = new JsonStore(dir, (m) => errors.push(m));
    s.saveQueueThrottled([task("a", 10)]);
    // 窗口到点之前把目标名占成目录：tmp→rename 的收尾必然失败
    mkdirSync(join(dir, "queue.json"), { recursive: true });
    vi.advanceTimersByTime(2000);
    expect(errors.some((m) => m.includes("队列落盘失败"))).toBe(true);
  });

  it("坏档自愈也出声：原档留成备份，读回空", () => {
    const errors: string[] = [];
    writeFileSync(join(dir, "queue.json"), "{ 半截的", "utf8");
    const s = new JsonStore(dir, (m) => errors.push(m));
    expect(s.loadQueue()).toEqual([]);
    expect(errors.some((m) => m.includes("queue.json 读取失败，按空处理"))).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith("queue.json.corrupt-"))).toBe(true);
  });

  it("queue.json 是异形对象时按空队列处理并出声（不把非数组交给 downloader.restore）", () => {
    const errors: string[] = [];
    writeFileSync(join(dir, "queue.json"), JSON.stringify({ tasks: [] }), "utf8");
    const s = new JsonStore(dir, (m) => errors.push(m));
    expect(s.loadQueue()).toEqual([]);
    expect(errors.some((m) => m.includes("不是数组"))).toBe(true);
  });

  it("截断超上限要说出声（用户不清理时的丢档动作不能无声）", () => {
    const errors: string[] = [];
    const s = new JsonStore(dir, (m) => errors.push(m));
    s.saveQueue(Array.from({ length: 205 }, (_, i) => task(`t${i}`, i, "paused")));
    expect(errors.some((m) => m.includes("丢弃最旧的 5 条"))).toBe(true);
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
