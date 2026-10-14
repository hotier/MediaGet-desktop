/**
 * JsonStore 测试：原子写 / 坏档自愈 / 配置缓存 / 脱敏导出 / 队列节流落盘。
 *
 * 队列那组是**回归测试**：早先 saveQueueThrottled 在节流窗口内直接 return，
 * 落盘的是窗口开始时的旧快照，且 flush() 只清定时器不落盘 —— 退出路径上
 * 最后一次快照被整段丢掉，违反 P2 验收「重启后队列/历史完整」。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "../electron/main/store";
import type { HistoryEntry, PersistedQueueTask } from "../types/ipc";

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

  it("新记录在前", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("h1"));
    const list = s.appendHistory(entry("h2"));
    expect(list.map((h) => h.id)).toEqual(["h2", "h1"]);
    expect(s.loadHistory().map((h) => h.id)).toEqual(["h2", "h1"]);
  });

  it("超过 500 条截断（HISTORY_MAX）", () => {
    const s = new JsonStore(dir);
    for (let i = 0; i < 505; i++) s.appendHistory(entry(`h${i}`));
    expect(s.loadHistory()).toHaveLength(500);
  });

  it("clearHistory 真正落盘", () => {
    const s = new JsonStore(dir);
    s.appendHistory(entry("h1"));
    expect(s.clearHistory()).toEqual([]);
    expect(s.loadHistory()).toEqual([]);
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
