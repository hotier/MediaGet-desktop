import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../electron/main/database";
import { createQueueRepository, type QueueRepository } from "../electron/main/repositories";
import { registerIpc, type IpcRegistryDeps } from "../electron/main/ipc";
import type { Downloader } from "../electron/main/downloader";
import { IPC, type DownloadTaskView, type InvokeResult, type PersistedQueueTask, type QueueFilter } from "../types/ipc";

const directories: string[] = [];
const handles: ReturnType<typeof openDatabase>[] = [];

function setup(): { database: ReturnType<typeof openDatabase>; queue: QueueRepository } {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-queue-pages-"));
  directories.push(dir);
  const database = openDatabase(join(dir, "test.sqlite"));
  handles.push(database);
  return { database, queue: createQueueRepository(database) };
}

let seq = 0;
function makeTask(over: Partial<PersistedQueueTask> = {}): PersistedQueueTask {
  seq += 1;
  return {
    taskId: `task-${String(seq).padStart(5, "0")}`,
    groupId: `group-${seq}`,
    url: "https://cdn.example.com/file.mp4",
    filename: `file-${seq}.mp4`,
    kind: "video",
    received: 0,
    total: 100,
    createdAt: seq,
    status: "queued",
    ...over,
  };
}

function view(t: PersistedQueueTask, over: Partial<DownloadTaskView> = {}): DownloadTaskView {
  return {
    taskId: t.taskId,
    groupId: t.groupId,
    url: t.url,
    filename: t.filename,
    kind: t.kind,
    status: t.status,
    received: t.received,
    total: t.total,
    speed: 0,
    transferMs: 0,
    transferBytes: 0,
    platform: t.platform,
    title: t.title,
    sourceUrl: t.sourceUrl,
    createdAt: t.createdAt,
    ...over,
  };
}

type Handler = (event: unknown, input: unknown) => Promise<InvokeResult<unknown>>;

function ipcCall(queue: QueueRepository, live: DownloadTaskView[]) {
  const handlers = new Map<string, Handler>();
  registerIpc({
    ipcMain: {
      handle(channel: string, listener: Handler) {
        handlers.set(channel, listener);
      },
    },
    downloader: { listLive: () => live } as unknown as Downloader,
    queueRepository: queue,
  } as unknown as IpcRegistryDeps);
  return (input?: unknown): Promise<InvokeResult<unknown>> => {
    const handler = handlers.get(IPC.downloadList);
    if (!handler) throw new Error("download:list handler missing");
    return handler({}, input);
  };
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unlimited queue pagination", () => {
  it("pages beyond 2000 tasks with stable cursors and never splits a group", () => {
    const { queue } = setup();
    const multi = ["m-1", "m-2", "m-3"].map((taskId, i) =>
      makeTask({ taskId, groupId: "work-multi", createdAt: 2005 + i })
    );
    const singles = Array.from({ length: 2004 }, (_, i) =>
      makeTask({ taskId: `s-${String(i).padStart(4, "0")}`, groupId: `work-${i}`, createdAt: i })
    );
    queue.saveMany([...singles, ...multi]);

    let cursor: { createdAt: number; taskId: string } | undefined;
    let tasks = 0;
    let pages = 0;
    const seenTasks = new Set<string>();
    const seenGroups = new Set<string>();
    do {
      const page = queue.list({ cursor, limit: 50 });
      pages += 1;
      const created = page.rows.map((row) => row.createdAt);
      expect(created).toEqual([...created].sort((a, b) => b - a));
      for (const row of page.rows) {
        expect(seenTasks.has(row.taskId)).toBe(false);
        seenTasks.add(row.taskId);
      }
      // A group must stay inside one page: the representative sorts by its newest row.
      for (const groupId of new Set(page.rows.map((row) => row.groupId))) {
        expect(seenGroups.has(groupId)).toBe(false);
        seenGroups.add(groupId);
      }
      tasks += page.rows.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(tasks).toBe(2007);
    expect(seenTasks.size).toBe(2007);
    expect(seenGroups.size).toBe(2005);
    expect(pages).toBe(41);
    // The multi-task group is returned as one indivisible block of three rows.
    expect(queue.list({ limit: 1 }).rows.filter((row) => row.groupId === "work-multi")).toHaveLength(3);
  });

  it("keeps every group row when a filter matches only one member", () => {
    const { queue } = setup();
    queue.saveMany([
      makeTask({ taskId: "a-old", groupId: "work-a", createdAt: 10, status: "done", filename: "old.mp4" }),
      makeTask({ taskId: "a-new", groupId: "work-a", createdAt: 30, status: "queued", filename: "new.mp4" }),
      makeTask({ taskId: "b-1", groupId: "work-b", createdAt: 20, status: "queued" }),
    ]);

    const first = queue.list({ limit: 1 });
    expect(first.rows.map((row) => row.taskId)).toEqual(["a-new", "a-old"]);
    // The cursor is the group's representative row: its newest (createdAt, taskId) pair.
    expect(first.nextCursor).toEqual({ createdAt: 30, taskId: "a-new" });
    expect(queue.list({ limit: 1, cursor: first.nextCursor! }).rows.map((row) => row.taskId)).toEqual(["b-1"]);

    const done = queue.list({ status: "done", limit: 10 });
    expect(done.rows.map((row) => row.taskId)).toEqual(["a-new", "a-old"]);
    expect(done.nextCursor).toBeNull();
  });

  it("filters by every status bucket, platform alias, searchable text and local dates", () => {
    const { queue } = setup();
    const jan = (day: number): number => new Date(2026, 0, day, 12).getTime();
    queue.saveMany([
      makeTask({ taskId: "queued", platform: "xhs", title: "夏天", createdAt: jan(5), status: "queued" }),
      makeTask({ taskId: "downloading", platform: "bilibili", createdAt: jan(6), status: "downloading" }),
      makeTask({ taskId: "paused", platform: "bilibili", createdAt: jan(7), status: "paused" }),
      makeTask({ taskId: "done", platform: "bilibili", createdAt: jan(8), status: "done", url: "" }),
      makeTask({ taskId: "error", platform: "bilibili", createdAt: jan(9), status: "error" }),
      makeTask({ taskId: "canceled", platform: "bilibili", createdAt: jan(10), status: "canceled" }),
      makeTask({
        taskId: "direct",
        platform: "bilibili",
        filename: "ordinary.mp4",
        url: "https://cdn.example.com/secret-token.mp4",
        createdAt: jan(11),
      }),
    ]);
    const ids = (filter: QueueFilter): string[] => queue.list(filter).rows.map((row) => row.taskId);

    expect(ids({ status: "active" }).sort()).toEqual(["direct", "downloading", "paused", "queued"]);
    expect(ids({ status: "done" })).toEqual(["done"]);
    expect(ids({ status: "error" })).toEqual(["error"]);
    expect(ids({ status: "canceled" })).toEqual(["canceled"]);
    // Writes normalize the legacy alias; queries may still arrive with it.
    expect(ids({ platform: "xhs" })).toEqual(["queued"]);
    expect(ids({ platform: "redbook" })).toEqual(["queued"]);
    expect(ids({ query: "夏天" })).toEqual(["queued"]);
    expect(ids({ query: "小红书" })).toEqual(["queued"]);
    // Media URLs never enter the long-lived search index.
    expect(ids({ query: "secret-token" })).toEqual([]);
    expect(ids({ from: "2026-01-06", to: "2026-01-08" }).sort()).toEqual([
      "done",
      "downloading",
      "paused",
    ]);
  });

  it("recovers only unfinished work and removes by explicit task ids", () => {
    const { queue } = setup();
    queue.saveMany(
      (["queued", "downloading", "paused", "done", "error", "canceled"] as const).map((status, i) =>
        makeTask({ taskId: status, groupId: `work-${status}`, status, createdAt: i })
      )
    );

    expect(queue.loadRecoverable().map((task) => task.taskId).sort()).toEqual([
      "downloading",
      "paused",
      "queued",
    ]);
    expect(queue.remove(["done", "error", "missing"])).toBe(2);
    expect(queue.get("done")).toBeUndefined();
    expect(queue.get("queued")?.status).toBe("queued");
  });

  it("keeps URL and headers while a row can resume, drops both once it is done", () => {
    const { database, queue } = setup();
    const headers = { Cookie: "queue-cookie-secret" };
    queue.saveMany([
      makeTask({ taskId: "live", status: "downloading", headers }),
      makeTask({ taskId: "failed", status: "error", headers }),
      makeTask({ taskId: "finished", status: "done", headers }),
    ]);

    expect(queue.get("live")?.url).toBe("https://cdn.example.com/file.mp4");
    expect(queue.get("live")?.headers).toEqual(headers);
    expect(queue.get("failed")?.headers).toEqual(headers);
    expect(queue.get("finished")?.url).toBe("");
    expect(queue.get("finished")?.headers).toBeUndefined();
    const finished = database.get<{ payload_json: string }>("SELECT payload_json FROM queue_tasks WHERE task_id = 'finished'");
    expect(finished?.payload_json).not.toContain("queue-cookie-secret");
  });

  it("overlays live progress on loaded rows and ignores live tasks from groups outside the page", async () => {
    const { queue } = setup();
    const liveRow = makeTask({ taskId: "g1-b", groupId: "work-g1", createdAt: 100, status: "queued" });
    queue.saveMany([
      makeTask({ taskId: "g1-a", groupId: "work-g1", createdAt: 50, status: "done", url: "" }),
      liveRow,
      makeTask({ taskId: "g2-a", groupId: "work-g2", createdAt: 10, status: "queued" }),
    ]);
    const extra = makeTask({ taskId: "g1-c", groupId: "work-g1", createdAt: 101 });
    const outside = makeTask({ taskId: "g9-a", groupId: "work-g9", createdAt: 999 });
    const call = ipcCall(queue, [
      view(liveRow, { status: "downloading", received: 42, speed: 7, transferMs: 6_000, transferBytes: 42 }),
      view(extra),
      view(outside, { status: "downloading" }),
    ]);

    const first = await call({ limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const page = first.data as { rows: DownloadTaskView[]; nextCursor: { createdAt: number; taskId: string } | null };
    expect(page.rows.map((row) => row.taskId).sort()).toEqual(["g1-a", "g1-b", "g1-c"]);
    expect(page.rows.find((row) => row.taskId === "g1-b")).toMatchObject({
      status: "downloading",
      received: 42,
      speed: 7,
      transferBytes: 42,
    });
    // Database rows that carry no live values still answer the full channel shape.
    expect(page.rows.find((row) => row.taskId === "g1-a")).toMatchObject({ speed: 0, transferMs: 0 });
    expect(page.nextCursor).toEqual({ createdAt: 100, taskId: "g1-b" });

    const second = await call({ limit: 1, cursor: page.nextCursor });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const rest = second.data as { rows: DownloadTaskView[]; nextCursor: unknown };
    // The live task from work-g1 must not be appended to a page that only holds work-g2.
    expect(rest.rows.map((row) => row.taskId)).toEqual(["g2-a"]);
    expect(rest.nextCursor).toBeNull();
  });
});
