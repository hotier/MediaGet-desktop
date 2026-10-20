import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../electron/main/database";
import { createHistoryRepository } from "../electron/main/repositories";
import type { HistoryEntry } from "../types/ipc";

const directories: string[] = [];
const handles: ReturnType<typeof openDatabase>[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-history-pages-"));
  directories.push(dir);
  const database = openDatabase(join(dir, "test.sqlite"));
  handles.push(database);
  return { database, history: createHistoryRepository(database) };
}

function addEntry(database: ReturnType<typeof openDatabase>, input: {
  id: string; workKey?: string; platform?: string; title?: string; createdAt: number; files?: string[];
}): void {
  const entry: HistoryEntry = {
    id: input.id,
    groupId: input.workKey,
    platform: input.platform ?? "bilibili",
    title: input.title ?? input.id,
    files: input.files ?? [],
    createdAt: input.createdAt,
  };
  const workKey = input.workKey ?? input.id;
  database.run(
    "INSERT INTO history_entries (id, work_key, group_id, created_at, platform, title, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    entry.id,
    workKey,
    input.workKey ?? null,
    entry.createdAt,
    entry.platform ?? null,
    entry.title ?? "",
    JSON.stringify(entry)
  );
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unlimited history pagination", () => {
  it("orders by latest group row, never splits groups, and filters by matching row fields", () => {
    const { database, history } = setup();
    addEntry(database, { id: "a-parse", workKey: "work-a", platform: "xhs", title: "ordinary", createdAt: 10 });
    addEntry(database, { id: "a-file", workKey: "work-a", platform: "redbook", title: "special result", createdAt: 30, files: ["a.jpg"] });
    addEntry(database, { id: "b", workKey: "work-b", platform: "bilibili", title: "another", createdAt: 20 });
    addEntry(database, { id: "c", workKey: "work-c", platform: "xhs", title: "other platform", createdAt: 15 });

    const page = history.list({ limit: 1 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((row) => row.id)).toEqual(["a-file", "a-parse"]);
    expect(page.nextCursor).toEqual({ createdAt: 30, workKey: "work-a" });
    expect(history.list({ query: "special result", limit: 10 }).rows.map((row) => row.id)).toEqual(["a-file", "a-parse"]);
    expect(history.list({ platform: "redbook", from: "1970-01-01", to: "1970-01-01", limit: 10 }).rows.map((row) => row.id)).toEqual(["a-file", "a-parse"]);
  });

  it("pages beyond 5000 works with stable cursors and returns key pages capped at 5000", () => {
    const { database, history } = setup();
    database.transaction(() => {
      for (let i = 0; i < 5005; i++) addEntry(database, { id: `row-${i}`, workKey: `work-${i}`, createdAt: i });
    });
    let cursor: { createdAt: number; workKey: string } | undefined;
    let count = 0;
    const seen = new Set<string>();
    do {
      const page = history.list({ cursor, limit: 100 });
      const keys = page.rows.map((row) => row.groupId ?? row.id);
      keys.forEach((key) => seen.add(key));
      count += page.rows.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBe(5005);
    expect(seen.size).toBe(5005);
    const firstKeys = history.listKeys({}, undefined, 5000);
    expect(firstKeys.keys).toHaveLength(5000);
    expect(firstKeys.nextCursor).not.toBeNull();
    const secondKeys = history.listKeys({}, firstKeys.nextCursor ?? undefined, 5000);
    expect(secondKeys.keys).toHaveLength(5);
    expect(secondKeys.nextCursor).toBeNull();
  });

  it("removes an explicit row or group and detaches retained statistics events", () => {
    const { database, history } = setup();
    addEntry(database, { id: "a-parse", workKey: "work-a", createdAt: 1 });
    addEntry(database, { id: "a-file", workKey: "work-a", createdAt: 2, files: ["a.mp4"] });
    database.run(
      "INSERT INTO stats_events (event_id, event_at, event_type, work_key) VALUES ('event-a', 2, 'parse', 'work-a')"
    );

    expect(history.remove(["a-parse"])).toBe(2);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count).toBe(0);
    expect(database.get<{ work_key: string | null }>("SELECT work_key FROM stats_events WHERE event_id = 'event-a'")?.work_key).toBeNull();
    expect(history.remove(["missing"])).toBe(0);
  });
});
