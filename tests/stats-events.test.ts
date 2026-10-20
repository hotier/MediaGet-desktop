import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../electron/main/database";
import { createStatsRepository, type StatsEventInput } from "../electron/main/repositories";
import { createStats } from "../electron/main/stats";

const directories: string[] = [];
const handles: ReturnType<typeof openDatabase>[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-stats-events-"));
  directories.push(dir);
  const database = openDatabase(join(dir, "test.sqlite"));
  handles.push(database);
  return { database, stats: createStatsRepository(database) };
}

function history(database: ReturnType<typeof openDatabase>, workKey: string, name: string, at: number): void {
  const entry = {
    id: workKey,
    groupId: workKey,
    platform: "redbook",
    title: "work",
    files: [],
    author: { name },
    createdAt: at,
  };
  database.run(
    "INSERT INTO history_entries (id, work_key, group_id, created_at, platform, title, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    entry.id,
    workKey,
    workKey,
    at,
    entry.platform,
    entry.title,
    JSON.stringify(entry)
  );
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      // May already be closed by a failure path.
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("queryable statistical events", () => {
  it("counts repeated parses, failures, download outcomes, platforms, kinds, and deduped author works", () => {
    const { database, stats } = setup();
    const at = new Date(2026, 9, 20, 12).getTime();
    history(database, "work-a", "Author A", at);
    const events: StatsEventInput[] = [
      { type: "parse", at, platform: "xhs", via: "local", ok: true, durationMs: 100, workKey: "work-a" },
      { type: "parse", at: at + 1, platform: "redbook", via: "local", ok: true, durationMs: 110, workKey: "work-a" },
      { type: "parse", at: at + 2, platform: "xhs", via: "mock", ok: false, durationMs: 30 },
      { type: "download", at: at + 3, platform: "xhs", kind: "image", outcome: "success", bytes: 2048, transferMs: 200, workKey: "work-a" },
      { type: "download", at: at + 4, platform: "redbook", kind: "video", outcome: "failure", bytes: 0, workKey: "work-a" },
      { type: "cancel", at: at + 5, platform: "xhs", kind: "image", workKey: "work-a" },
    ];
    events.forEach((event) => stats.recordEvent(event));

    const result = stats.query({ from: "2026-10-20", to: "2026-10-20" });

    expect(result.totals).toMatchObject({ downloads: 1, failures: 1, canceled: 1, bytes: 2048, elapsedMs: 200, elapsedCount: 1, parses: 3, parseFailures: 1 });
    expect(result.byPlatform.redbook).toMatchObject({ downloads: 1, failures: 1, bytes: 2048, parses: 3, parseFailures: 1 });
    expect(result.byKind.image).toEqual({ downloads: 1, bytes: 2048 });
    expect(result.byKind.video).toBeUndefined();
    expect(result.authors).toEqual([{ name: "Author A", parsedWorks: 1, downloadedFiles: 1, downloadedBytes: 2048 }]);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM stats_events")?.count).toBe(6);
  });

  it("uses inclusive local calendar days and excludes the next midnight", () => {
    const { stats } = setup();
    const start = new Date(2026, 9, 20).getTime();
    const nextDay = new Date(2026, 9, 21).getTime();
    stats.recordEvent({ type: "parse", at: start, via: "local", ok: true, durationMs: 1 });
    stats.recordEvent({ type: "parse", at: nextDay - 1, via: "local", ok: true, durationMs: 1 });
    stats.recordEvent({ type: "parse", at: nextDay, via: "local", ok: true, durationMs: 1 });

    expect(stats.query({ from: "2026-10-20", to: "2026-10-20" }).totals.parses).toBe(2);
    expect(stats.query({ from: "2026-10-21", to: "2026-10-21" }).totals.parses).toBe(1);
  });

  it("rejects invalid or reversed local date ranges", () => {
    const { stats } = setup();
    expect(() => stats.query({ from: "2026-02-30", to: "2026-03-01" })).toThrow();
    expect(() => stats.query({ from: "2026-10-21", to: "2026-10-20" })).toThrow();
  });

  it("records lifecycle events and their associated history row atomically", () => {
    const { database, stats: repository } = setup();
    const at = new Date(2026, 9, 20, 10).getTime();
    const recorder = createStats({
      load: () => null,
      save: () => {},
      now: () => at,
      recordEvent: (event, entry) => repository.recordEvent(event, entry),
      query: (range) => repository.query(range),
    });
    const entry = {
      id: "work-atomic",
      groupId: "work-atomic",
      platform: "redbook",
      title: "Atomic work",
      files: [],
      author: { name: "Atomic Author" },
      createdAt: at,
    };

    database.exec("CREATE TRIGGER fail_atomic_event BEFORE INSERT ON stats_events BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    recorder.parse({ at, platform: "redbook", via: "local", ok: true, durationMs: 10, workKey: "work-atomic", historyEntry: entry });
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(0);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM stats_events")?.count).toBe(0);
    database.exec("DROP TRIGGER fail_atomic_event");

    recorder.parse({ at, platform: "redbook", via: "local", ok: true, durationMs: 10, workKey: "work-atomic", historyEntry: entry });
    recorder.parse({ at: at + 1, platform: "redbook", via: "local", ok: true, durationMs: 10, workKey: "work-atomic" });
    recorder.failure({ at: at + 2, platform: "redbook", kind: "video", workKey: "work-atomic" });
    recorder.cancel({ at: at + 3, platform: "redbook", kind: "image", workKey: "work-atomic" });
    recorder.done({ at: at + 4, platform: "redbook", kind: "image", bytes: 64, workKey: "work-atomic" });

    const result = recorder.query({ from: "2026-10-20", to: "2026-10-20" });
    expect(result.totals).toMatchObject({ parses: 2, parseFailures: 0, failures: 1, canceled: 1, downloads: 1, bytes: 64 });
    expect(result.authors[0]).toMatchObject({ name: "Atomic Author", parsedWorks: 1, downloadedFiles: 1 });
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM stats_events")?.count).toBe(5);
  });
});
