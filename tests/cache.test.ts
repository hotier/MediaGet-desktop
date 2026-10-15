/**
 * 本机占用扫描与清理（electron/main/cache.ts）。
 *
 * 三条红线都在这里钉住：
 * 1. update / records 只报占用 —— 那是更新流程自管的落点和用户数据，不是缓存；
 * 2. 活任务（与 downloader.isTargetClaimed 同一把尺）占用的 .part 不得删，
 *    否则「清一次缓存」会打断进行中的下载、抹掉续传身份；
 * 3. 只删具名文件，绝不对目录递归删除。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCacheProbe, type CacheSessionLike } from "../electron/main/cache";
import { createLogger } from "../electron/main/logger";
import type { CacheItemKey } from "../types/ipc";

let dir: string;
let downloadDir: string;
let logDir: string;
let updateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mg-cache-"));
  downloadDir = join(dir, "downloads");
  logDir = join(dir, "logs");
  updateDir = join(dir, "update-cache");
  for (const d of [downloadDir, logDir, updateDir]) mkdirSync(d);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSession(bytes = 4096): CacheSessionLike & { cleared: number; size: number } {
  const s = {
    size: bytes,
    cleared: 0,
    async getCacheSize(): Promise<number> {
      return s.size;
    },
    async clearCache(): Promise<void> {
      s.cleared++;
      s.size = 0;
    },
  };
  return s;
}

function harness(
  opts: { session?: CacheSessionLike | null; live?: string[]; updatePath?: string | null } = {}
) {
  const session = opts.session === undefined ? fakeSession() : opts.session;
  const logger = createLogger({
    logDir: () => logDir,
    getLevel: () => "info",
    getRetentionDays: () => 7,
  });
  const probe = createCacheProbe({
    session: () => session,
    userDataDir: () => dir,
    downloadDir: () => downloadDir,
    updaterCacheDir: () => (opts.updatePath === undefined ? updateDir : opts.updatePath),
    livePartPaths: () => opts.live ?? [],
    logs: logger,
  });
  return { probe, logger, session };
}

const itemOf = (
  items: { key: CacheItemKey; bytes: number; clearable: boolean }[],
  key: CacheItemKey
): { bytes: number; clearable: boolean } => items.find((i) => i.key === key)!;

describe("status", () => {
  it("各项分账：网络缓存取 session，断点与残留按名字挑，记录/更新包只报不可清", async () => {
    writeFileSync(join(downloadDir, "a.mp4.part"), "x".repeat(1000));
    writeFileSync(join(downloadDir, "a.mp4.part.meta"), "{}");
    writeFileSync(join(downloadDir, "final.mp4"), "成品不能动");
    writeFileSync(join(dir, "config.json"), "settings");
    writeFileSync(join(dir, "history.json.corrupt-1700000000000"), "坏档");
    writeFileSync(join(dir, `config.json.${process.pid}.tmp`), "本次进程正在原子写");
    writeFileSync(join(updateDir, "installer.exe"), "y".repeat(2000));

    const { probe } = harness();
    const st = await probe.status();
    expect(itemOf(st.items, "net")).toMatchObject({ bytes: 4096, clearable: true });
    expect(itemOf(st.items, "partials").bytes).toBe(1002); // .part + 配套 .meta，成品不计
    expect(itemOf(st.items, "junk").bytes).toBe(6); // 坏档；本进程的 .tmp 不算残留
    expect(itemOf(st.items, "records").bytes).toBe(8);
    expect(itemOf(st.items, "update")).toMatchObject({ bytes: 2000, clearable: false });
    expect(itemOf(st.items, "logs")).toMatchObject({ bytes: 0, clearable: true });
    expect(st.totalBytes).toBe(4096 + 1002 + 6 + 8 + 2000);
    expect(st.clearableBytes).toBe(4096 + 1002 + 6);
  });

  it("活任务占用的 .part 与配套 .meta 都不进孤儿断点", async () => {
    writeFileSync(join(downloadDir, "live.mp4.part"), "x".repeat(500));
    writeFileSync(join(downloadDir, "live.mp4.part.meta"), "{}");
    writeFileSync(join(downloadDir, "dead.mp4.part"), "y".repeat(300));

    const { probe } = harness({ live: [join(downloadDir, "live.mp4.part")] });
    const st = await probe.status();
    expect(itemOf(st.items, "partials").bytes).toBe(300);
  });

  it("拿不到 session → 网络缓存报 0 且不可清；更新包目录不存在 → 什么也不猜", async () => {
    const { probe } = harness({ session: null, updatePath: null });
    const st = await probe.status();
    expect(itemOf(st.items, "net")).toMatchObject({ bytes: 0, clearable: false });
    expect(itemOf(st.items, "update").bytes).toBe(0);
  });
});

describe("clear", () => {
  it("点名的可清项真删：断点与坏档消失，成品与用户数据原样留着", async () => {
    writeFileSync(join(downloadDir, "a.part"), "x".repeat(1000));
    writeFileSync(join(downloadDir, "final.mp4"), "成品");
    writeFileSync(join(dir, "config.json"), "记录");
    writeFileSync(join(dir, "config.json.corrupt-1"), "坏档");
    const session = fakeSession();

    const { probe } = harness({ session });
    const r = await probe.clear(["net", "partials", "junk"]);
    expect(session.cleared).toBe(1);
    expect(existsSync(join(downloadDir, "a.part"))).toBe(false);
    expect(existsSync(join(dir, "config.json.corrupt-1"))).toBe(false);
    expect(existsSync(join(downloadDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.freed).toBe(4096 + 1000 + 6);
    expect(itemOf(r.report.items, "partials").bytes).toBe(0);
    expect(r.report.clearableBytes).toBe(0);
  });

  it("不可清项（update / records）一律进 skipped，文件一个不动 —— 入参绕不过红线", async () => {
    writeFileSync(join(dir, "config.json"), "记录");
    writeFileSync(join(updateDir, "installer.exe"), "更新包");

    const { probe } = harness();
    const r = await probe.clear(["update", "records"]);
    expect([...r.skipped].sort()).toEqual(["records", "update"]);
    expect(r.freed).toBe(0);
    expect(readdirSync(updateDir)).toEqual(["installer.exe"]);
    expect(readdirSync(dir)).toContain("config.json");
  });

  it("清 logs 走 logger.clear：日志归零，同目录里非托管名的文件不碰", async () => {
    const { probe, logger } = harness();
    logger.warn("一行日志");
    writeFileSync(join(logDir, "keep.txt"), "不是日志档");

    const before = await probe.status();
    expect(itemOf(before.items, "logs").bytes).toBeGreaterThan(0);

    const r = await probe.clear(["logs"]);
    expect(logger.sizeBytes()).toBe(0);
    expect(readdirSync(logDir)).toEqual(["keep.txt"]);
    expect(r.freed).toBeGreaterThan(0);
    expect(r.skipped).toEqual([]);
  });

  it("本进程正在原子写的 .tmp 不会被顺手删掉", async () => {
    const tmp = basename(join(dir, `config.json.${process.pid}.tmp`));
    writeFileSync(join(dir, tmp), "写一半");
    writeFileSync(join(dir, "config.json.corrupt-9"), "坏档");

    const { probe } = harness();
    await probe.clear(["junk"]);
    expect(readdirSync(dir)).toContain(tmp);
    expect(readdirSync(dir)).not.toContain("config.json.corrupt-9");
  });
});
