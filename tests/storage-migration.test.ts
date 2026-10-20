import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../electron/main/database";
import { migrateJsonStore } from "../electron/main/storage-migration";

/** 旧 stats.json 的冻结形状（v1）：运行时已不再产出它，这里只造迁移输入 */
function legacyStats(downloads: number, failures: number) {
  const zero = { downloads: 0, failures: 0, canceled: 0, bytes: 0, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 };
  return {
    schema: 1,
    since: 1,
    updatedAt: 1,
    totals: { ...zero, downloads, failures },
    parse: { total: 0, failures: 0, local: 0, online: 0, mock: 0, durationMs: 0 },
    byDay: {},
    byPlatform: {},
    byKind: {},
    byHour: new Array<number>(168).fill(0),
  };
}

const directories: string[] = [];
const databases: DatabaseHandle[] = [];

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-migration-test-"));
  directories.push(dir);
  return dir;
}

function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(value), "utf8");
}

function openTestDatabase(path: string): DatabaseHandle {
  const db = openDatabase(path);
  databases.push(db);
  return db;
}

function historyRow(i: number) {
  return {
    id: `id-${i}`,
    groupId: `group-${i}`,
    platform: "xhs",
    title: `work ${i}`,
    files: [],
    sourceUrl: `https://www.xiaohongshu.com/explore/${i}`,
    author: { name: "author", id: 123 },
    createdAt: i,
  };
}

function queueTask(i: number) {
  return {
    taskId: `task-${i}`,
    groupId: `group-${i}`,
    url: `https://cdn.example/media/${i}?token=secret`,
    referer: "https://source.example/work",
    headers: { Cookie: "queue-cookie-secret" },
    filename: `file-${i}.mp4`,
    kind: "video",
    received: 0,
    total: 100,
    createdAt: i,
    status: "queued",
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // A test may already have closed its handle.
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JSON storage migration", () => {
  it("imports settings, every queue/history row, and legacy stats without retaining request credentials", () => {
    const dir = userData();
    const history = Array.from({ length: 5000 }, (_, i) => historyRow(i));
    const queue = Array.from({ length: 205 }, (_, i) => queueTask(i));
    const stats = legacyStats(17, 2);
    writeJson(dir, "config.json", { settings: { cookies: { bilibili: "cookie-sentinel" } }, kernel: { BILI_COOKIE: "kernel-cookie-sentinel" } });
    writeJson(dir, "queue.json", queue);
    writeJson(dir, "history.json", history);
    writeJson(dir, "stats.json", stats);
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));

    const report = migrateJsonStore({ userDataDir: dir, db });

    expect(report.imported).toEqual({ config: 1, queue: 205, history: 5000, stats: 1 });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM queue_tasks")?.count).toBe(205);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(5000);
    expect(db.get<{ value: string }>("SELECT value FROM kernel_config WHERE key = 'BILI_COOKIE'")?.value).toBe("kernel-cookie-sentinel");
    expect(db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'settings'")?.value).toContain("cookie-sentinel");
    expect(db.get<{ value: string }>("SELECT value FROM legacy_stats WHERE key = 'snapshot'")?.value).toContain('"downloads":17');
    const queued = db.get<{ payload_json: string }>("SELECT payload_json FROM queue_tasks WHERE task_id = 'task-0'")?.payload_json ?? "";
    // A queued row must keep URL and headers or restart recovery cannot replay the request.
    expect(queued).toContain("cdn.example");
    expect(queued).toContain("queue-cookie-secret");
    expect(readFileSync(join(dir, "history.json"), "utf8")).toContain('"id":"id-0"');
    expect(readFileSync(join(dir, "queue.json"), "utf8")).toContain("cdn.example");
  });

  it("keeps media URLs and headers only on queue rows that can still resume", () => {
    const dir = userData();
    writeJson(dir, "queue.json", [
      queueTask(1),
      { ...queueTask(2), taskId: "task-done", status: "done", finishedAt: 2 },
    ]);
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));

    expect(migrateJsonStore({ userDataDir: dir, db }).imported.queue).toBe(2);

    const payload = (taskId: string): { url: string; headers?: unknown } =>
      JSON.parse(db.get<{ payload_json: string }>("SELECT payload_json FROM queue_tasks WHERE task_id = ?", taskId)?.payload_json ?? "{}");
    expect(payload("task-1").url).toContain("cdn.example");
    expect(payload("task-done").url).toBe("");
    expect(payload("task-1").headers).toEqual({ Cookie: "queue-cookie-secret" });
    expect(payload("task-done").headers).toBeUndefined();
  });

  it("is idempotent when the same source fingerprints are imported again", () => {
    const dir = userData();
    writeJson(dir, "history.json", [historyRow(1)]);
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));
    expect(migrateJsonStore({ userDataDir: dir, db }).imported.history).toBe(1);
    expect(migrateJsonStore({ userDataDir: dir, db }).skipped).toContain("history");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(1);
  });

  it("imports each source only once, so a rewritten legacy file cannot resurrect deleted rows", () => {
    const dir = userData();
    writeJson(dir, "history.json", [historyRow(1)]);
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));
    expect(migrateJsonStore({ userDataDir: dir, db }).imported.history).toBe(1);

    // The transitional store still rewrites history.json; a user deleting a row must not
    // see it come back on the next launch.
    db.run("DELETE FROM history_entries");
    writeJson(dir, "history.json", [historyRow(2)]);
    const second = migrateJsonStore({ userDataDir: dir, db });

    expect(second.skipped).toContain("history");
    expect(second.imported.history).toBeUndefined();
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(0);
  });

  it("collapses legacy parse rows that normalize to the same work key", () => {
    const dir = userData();
    const base = historyRow(1);
    writeJson(dir, "history.json", [
      { ...base, id: "old-a", groupId: "old-a" },
      { ...base, id: "old-b", groupId: "old-b", sourceUrl: "https://www.xiaohongshu.com/explore/1/?xsec_token=rotated" },
    ]);
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));

    expect(migrateJsonStore({ userDataDir: dir, db }).imported.history).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(1);
  });

  it("rolls back a failed import and can retry without changing source files", () => {
    const dir = userData();
    writeJson(dir, "history.json", [historyRow(1)]);
    const sourceBefore = readFileSync(join(dir, "history.json"), "utf8");
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON history_entries BEGIN SELECT RAISE(ABORT, 'injected'); END;");

    expect(() => migrateJsonStore({ userDataDir: dir, db })).toThrow();
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations")?.count).toBe(0);
    expect(readFileSync(join(dir, "history.json"), "utf8")).toBe(sourceBefore);
    db.exec("DROP TRIGGER fail_history");

    expect(migrateJsonStore({ userDataDir: dir, db }).imported.history).toBe(1);
  });

  it("rejects malformed input without moving or rewriting the source", () => {
    const dir = userData();
    const source = "{\"BILI_COOKIE\":\"never print this secret\",oops";
    writeFileSync(join(dir, "config.json"), source, "utf8");
    const db = openTestDatabase(join(dir, "mediaget.sqlite"));

    let message = "";
    try {
      migrateJsonStore({ userDataDir: dir, db });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("config.json");
    expect(message).not.toContain("never print this secret");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(source);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM storage_migrations")?.count).toBe(0);
  });
});
