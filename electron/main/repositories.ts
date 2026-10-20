import type { DatabaseHandle } from "./database";
import { AppSettingsSchema, PersistedQueueTaskSchema } from "../../types/ipc-contract";
import { randomUUID } from "node:crypto";
import { displayName, resolveKey } from "../../shared/platforms";
import { workKeyOf } from "../../shared/history";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type HistoryEntry,
  type HistoryCursor,
  type HistoryFilter,
  type HistoryPage,
  type HistoryKeysPage,
  type PersistedQueueTask,
  type QueueCursor,
  type QueueFilter,
  type StatsDateRange,
  type StatsQueryResult,
} from "../../types/ipc";

export interface SettingsRepository {
  loadConfig(): { settings: AppSettings; kernel: Record<string, string> };
  saveConfig(config: { settings: AppSettings; kernel: Record<string, string> }): void;
  getKernelValue(key: string): string | undefined;
}

export interface QueueRepository {
  save(task: PersistedQueueTask): void;
  saveMany(tasks: readonly PersistedQueueTask[]): void;
  /** 终态行会从下载器内存退休，重试时靠它把任务取回来 */
  get(taskId: string): PersistedQueueTask | undefined;
  list(filter?: QueueFilter): { rows: PersistedQueueTask[]; nextCursor: QueueCursor | null };
  /** 只取重启后需要继续跑的：排队 / 下载中 / 暂停。终态行留在库里供队列页翻页 */
  loadRecoverable(): PersistedQueueTask[];
  remove(taskIds: string[]): number;
}

export interface HistoryRepository {
  list(filter?: HistoryFilter): HistoryPage;
  listKeys(filter: Omit<HistoryFilter, "limit">, cursor?: HistoryCursor, limit?: number): HistoryKeysPage;
  remove(keys: string[]): number;
}

export interface RepositorySet {
  settings: SettingsRepository;
  queue: QueueRepository;
  history: HistoryRepository;
  database: DatabaseHandle;
}

export type StatsEventInput =
  | { type: "parse"; at: number; platform?: string; via: "local" | "mock"; ok: boolean; durationMs: number; workKey?: string }
  | { type: "download"; at: number; platform?: string; kind: string; outcome: "success" | "failure"; bytes: number; transferMs?: number; workKey?: string }
  | { type: "cancel"; at: number; platform?: string; kind?: string; workKey?: string };

export interface StatsRepository {
  recordEvent(event: StatsEventInput, historyEntry?: HistoryEntry): void;
  query(range: StatsDateRange): StatsQueryResult;
}

export function createSettingsRepository(database: DatabaseHandle): SettingsRepository {
  return {
    loadConfig() {
      const stored = database.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'settings'");
      // 缺键按默认值兜底：契约字段会随版本增加，而库里的设置行只会写入当时的完整快照。
      // 缺键时直接 parse 会在升级后的第一次启动就抛错，等于让新增一个设置项变成破坏性变更。
      const raw = stored ? (JSON.parse(stored.value) as Partial<AppSettings>) : {};
      const settings = AppSettingsSchema.parse({
        ...DEFAULT_SETTINGS,
        ...raw,
        cookies: { ...DEFAULT_SETTINGS.cookies, ...(raw.cookies ?? {}) },
        platformSwitches: { ...(raw.platformSwitches ?? {}) },
        filenameExtra: { ...DEFAULT_SETTINGS.filenameExtra, ...(raw.filenameExtra ?? {}) },
      });
      const kernel = Object.fromEntries(
        database.all<{ key: string; value: string }>("SELECT key, value FROM kernel_config ORDER BY key").map(({ key, value }) => [key, value])
      );
      return { settings, kernel };
    },
    saveConfig(config) {
      database.transaction(() => {
        database.run(
          "INSERT INTO app_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          JSON.stringify(config.settings)
        );
        database.exec("DELETE FROM kernel_config");
        for (const [key, value] of Object.entries(config.kernel)) {
          database.run("INSERT INTO kernel_config (key, value) VALUES (?, ?)", key, value);
        }
      });
    },
    getKernelValue(key) {
      return database.get<{ value: string }>("SELECT value FROM kernel_config WHERE key = ?", key)?.value;
    },
  };
}

function localDateBounds(range: StatsDateRange): { startAt: number; endAt: number } {
  const parse = (key: string): Date => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) throw new Error("Invalid statistics date range");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error("Invalid statistics date range");
    }
    return date;
  };
  const from = parse(range.from);
  const to = parse(range.to);
  if (range.from > range.to) throw new Error("Invalid statistics date range");
  const nextDay = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return { startAt: from.getTime(), endAt: nextDay.getTime() };
}

const dayKey = (at: number): string => {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 队列页状态分段 → SQL 状态集合（`active` 是三个未完成态，不是单数） */
const QUEUE_STATUS_SETS: Record<"active" | "done" | "error" | "canceled", string[]> = {
  active: ["queued", "downloading", "paused"],
  done: ["done"],
  error: ["error"],
  canceled: ["canceled"],
};

/** 状态档的固定顺序：摘要按它排，两次启动的日志才可直接比对（跟着插入序走会漂） */
const QUEUE_STATUS_ORDER = ["queued", "downloading", "paused", "done", "error", "canceled"] as const;

/**
 * 队列快照 → 一行摘要（`5 项（downloading 1 · done 3 · error 1）`）。
 *
 * 只带条数与状态分布两维：隐私红线不让直链进日志，而排查「库里怎么少了一条」要的
 * 恰好也是这两维 —— 一行记录消失必然改变条数或某个状态的计数。进度字节不进摘要，
 * 所以 2 秒一次的进度落盘不会刷屏。
 */
export function queueDigest(tasks: readonly PersistedQueueTask[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const parts = QUEUE_STATUS_ORDER.filter((status) => counts.has(status)).map(
    (status) => `${status} ${counts.get(status)}`
  );
  return `${tasks.length} 项${parts.length === 0 ? "" : `（${parts.join(" · ")}）`}`;
}

const nonNegativeInt = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** 可搜索的公开文本；**不含媒体直链** —— 直链只活在非终态行的 `url` 里，不进长期搜索索引 */
function queueSearchText(task: PersistedQueueTask): string {
  return [task.filename, task.title ?? "", task.platform ? displayName(task.platform) : "", task.sourceUrl ?? ""]
    .join(" ")
    .trim()
    .toLowerCase();
}

function parseQueuePayload(json: string): PersistedQueueTask | null {
  try {
    const parsed = PersistedQueueTaskSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    // 坏行不应该让整页变空：跳过它，其余行照常返回
    return null;
  }
}

function upsertQueueTask(database: DatabaseHandle, input: PersistedQueueTask): void {
  // 直链与请求头（可能带 Cookie）只在「还能续或还能重试」的行上留着，重启续传要原样带上；
  // 完成行两者一起摘掉，不进长期台账。与迁移器同一条规则，在仓储口兜底而不是信任每个调用方。
  const done = input.status === "done";
  const task: PersistedQueueTask = {
    ...input,
    url: done ? "" : input.url,
    headers: done ? undefined : input.headers,
    platform: input.platform ? resolveKey(input.platform) : undefined,
  };
  database.run(
    `INSERT INTO queue_tasks (task_id, group_id, created_at, updated_at, status, platform, search_text, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       group_id = excluded.group_id, created_at = excluded.created_at, updated_at = excluded.updated_at,
       status = excluded.status, platform = excluded.platform, search_text = excluded.search_text,
       payload_json = excluded.payload_json`,
    task.taskId,
    task.groupId,
    task.createdAt,
    Date.now(),
    task.status,
    task.platform ?? null,
    queueSearchText(task),
    JSON.stringify(task)
  );
}

interface QueueGroupRow {
  group_id: string;
  created_at: number;
  task_id: string;
}

/**
 * 选出「命中筛选的作品组」这一页。组内任一任务命中即整组入选，组内全部任务随后一起返回：
 * 组行的聚合（大小/速度/剩余/时间）必须由整组算出，页边界切开一个作品就会报一个假数。
 *
 * 每组只取「命中筛选的最新一行」当代表，沿 (created_at, task_id) 索引倒序走、取满 limit 即停：
 * 一页的代价与总行数无关（GROUP BY 全表再排序在 50 万行时要 100ms+，且同步卡主进程）。
 * 子查询里筛选列前的 `+` 是给规划器的：不许它拿筛选列的索引去找同组行，必须走 group_id 索引。
 */
function queueGroups(
  database: DatabaseHandle,
  filter: QueueFilter,
  limit: number
): QueueGroupRow[] {
  const conditions = (alias: string, inner: boolean): { sql: string; params: (string | number)[] } => {
    const col = (name: string) => `${inner ? "+" : ""}${alias}.${name}`;
    const sql: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      const statuses = QUEUE_STATUS_SETS[filter.status];
      sql.push(`${col("status")} IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (filter.platform) {
      sql.push(`${col("platform")} = ?`);
      params.push(resolveKey(filter.platform));
    }
    if (filter.from && filter.to) {
      const bounds = localDateBounds({ from: filter.from, to: filter.to });
      sql.push(`${col("created_at")} >= ? AND ${col("created_at")} < ?`);
      params.push(bounds.startAt, bounds.endAt);
    }
    if (filter.query?.trim()) {
      sql.push(`${alias}.search_text LIKE ? ESCAPE '\\'`);
      params.push(`%${filter.query.trim().toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
    return { sql: sql.map((s) => ` AND ${s}`).join(""), params };
  };
  const outer = conditions("q", false);
  const inner = conditions("q2", true);
  const cursorSql = filter.cursor ? " AND (q.created_at < ? OR (q.created_at = ? AND q.task_id < ?))" : "";
  const cursorParams = filter.cursor ? [filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.taskId] : [];
  return database.all<QueueGroupRow>(
    `SELECT q.group_id, q.created_at, q.task_id FROM queue_tasks q
     WHERE 1 = 1${outer.sql}${cursorSql}
       AND NOT EXISTS (
         SELECT 1 FROM queue_tasks q2
         WHERE q2.group_id = q.group_id${inner.sql}
           AND (q2.created_at > q.created_at OR (q2.created_at = q.created_at AND q2.task_id > q.task_id))
       )
     ORDER BY q.created_at DESC, q.task_id DESC LIMIT ?`,
    ...outer.params,
    ...cursorParams,
    ...inner.params,
    limit
  );
}

export function createQueueRepository(database: DatabaseHandle): QueueRepository {
  return {
    save(task) {
      upsertQueueTask(database, task);
    },

    saveMany(tasks) {
      if (tasks.length === 0) return;
      database.transaction(() => {
        for (const task of tasks) upsertQueueTask(database, task);
      });
    },

    get(taskId) {
      const row = database.get<{ payload_json: string }>(
        "SELECT payload_json FROM queue_tasks WHERE task_id = ?",
        taskId
      );
      return row ? (parseQueuePayload(row.payload_json) ?? undefined) : undefined;
    },

    list(filter = {}) {
      const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
      const groups = queueGroups(database, filter, limit + 1);
      const selected = groups.slice(0, limit);
      const groupIds = selected.map((group) => group.group_id);
      const rows = groupIds.length === 0
        ? []
        : database.all<{ payload_json: string }>(
            `SELECT payload_json FROM queue_tasks
             WHERE group_id IN (${groupIds.map(() => "?").join(",")})
             ORDER BY created_at DESC, task_id DESC`,
            ...groupIds
          ).flatMap((row) => {
            const task = parseQueuePayload(row.payload_json);
            return task ? [task] : [];
          });
      const last = selected.at(-1);
      return {
        rows,
        nextCursor: groups.length > limit && last
          ? { createdAt: last.created_at, taskId: last.task_id }
          : null,
      };
    },

    loadRecoverable() {
      return database.all<{ payload_json: string }>(
        `SELECT payload_json FROM queue_tasks
         WHERE status IN ('queued', 'downloading', 'paused')
         ORDER BY created_at DESC, task_id DESC`
      ).flatMap((row) => {
        const task = parseQueuePayload(row.payload_json);
        return task ? [task] : [];
      });
    },

    remove(taskIds) {
      if (taskIds.length === 0) return 0;
      return database.run(
        `DELETE FROM queue_tasks WHERE task_id IN (${taskIds.map(() => "?").join(",")})`,
        ...taskIds
      ).changes;
    },
  };
}

interface AggregateRow {
  downloads: number;
  failures: number;
  canceled: number;
  bytes: number;
  elapsedMs: number;
  elapsedCount: number;
  elapsedBytes: number;
  parses: number;
  parseFailures: number;
}

function emptyAggregate(): AggregateRow {
  return { downloads: 0, failures: 0, canceled: 0, bytes: 0, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0, parses: 0, parseFailures: 0 };
}

function aggregateSql(): string {
  return `
    SELECT
      SUM(CASE WHEN event_type = 'download' AND outcome = 'success' THEN 1 ELSE 0 END) AS downloads,
      SUM(CASE WHEN event_type = 'download' AND outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN event_type = 'cancel' THEN 1 ELSE 0 END) AS canceled,
      SUM(CASE WHEN event_type = 'download' AND outcome = 'success' THEN bytes ELSE 0 END) AS bytes,
      SUM(CASE WHEN event_type = 'download' AND outcome = 'success' AND duration_ms > 0 THEN duration_ms ELSE 0 END) AS elapsedMs,
      SUM(CASE WHEN event_type = 'download' AND outcome = 'success' AND duration_ms > 0 THEN 1 ELSE 0 END) AS elapsedCount,
      SUM(CASE WHEN event_type = 'download' AND outcome = 'success' AND duration_ms > 0 THEN bytes ELSE 0 END) AS elapsedBytes,
      SUM(CASE WHEN event_type = 'parse' THEN 1 ELSE 0 END) AS parses,
      SUM(CASE WHEN event_type = 'parse' AND outcome = 'failure' THEN 1 ELSE 0 END) AS parseFailures
    FROM stats_events WHERE event_at >= ? AND event_at < ?`;
}

export function createStatsRepository(database: DatabaseHandle): StatsRepository {
  return {
    recordEvent(event, historyEntry) {
      const platform = event.platform ? resolveKey(event.platform) : null;
      const eventType = event.type;
      const kind = event.type === "download" || event.type === "cancel" ? event.kind ?? null : null;
      const outcome = event.type === "parse"
        ? event.ok ? "success" : "failure"
        : event.type === "download" ? event.outcome : null;
      const bytes = event.type === "download" && event.outcome === "success" ? nonNegativeInt(event.bytes) : 0;
      const duration = event.type === "download"
        ? event.transferMs
        : event.type === "parse" ? event.durationMs : undefined;
      const via = event.type === "parse" ? event.via : null;
      const insertEvent = () => database.run(
          `INSERT INTO stats_events
            (event_id, event_at, event_type, platform, kind, outcome, bytes, duration_ms, work_key, via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          Math.floor(event.at),
          eventType,
          platform,
          kind,
          outcome,
          bytes,
          duration === undefined ? null : nonNegativeInt(duration),
          event.workKey ?? null,
          via
        );
      const insertHistory = () => {
        if (!historyEntry) return;
        // Resolve aliases on write: a row recorded with `xhs` would otherwise keep a platform
        // key that history filters (which resolve the query key) can never match.
        const entry: HistoryEntry = historyEntry.platform
          ? { ...historyEntry, platform: resolveKey(historyEntry.platform) }
          : historyEntry;
        const workKey = entry.groupId ?? workKeyOf(entry.sourceUrl) ?? entry.id;
        database.run(
          `INSERT INTO history_entries (id, work_key, group_id, created_at, platform, title, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET work_key = excluded.work_key, group_id = excluded.group_id,
             created_at = excluded.created_at, platform = excluded.platform, title = excluded.title,
             payload_json = excluded.payload_json`,
          entry.id,
          workKey,
          entry.groupId ?? null,
          entry.createdAt,
          entry.platform ?? null,
          entry.title ?? "",
          JSON.stringify(entry)
        );
      };
      if (historyEntry) database.transaction(() => { insertHistory(); insertEvent(); });
      else insertEvent();
    },

    query(range) {
      const { startAt, endAt } = localDateBounds(range);
      const totals = database.get<AggregateRow>(aggregateSql(), startAt, endAt) ?? emptyAggregate();
      const byDay: StatsQueryResult["byDay"] = {};
      for (const row of database.all<AggregateRow & { day: string }>(
        `${aggregateSql().replace("SELECT", "SELECT strftime('%Y-%m-%d', event_at / 1000, 'unixepoch', 'localtime') AS day,")} GROUP BY day ORDER BY day`,
        startAt,
        endAt
      )) {
        byDay[row.day] = {
          downloads: row.downloads ?? 0,
          failures: row.failures ?? 0,
          canceled: row.canceled ?? 0,
          bytes: row.bytes ?? 0,
          parses: row.parses ?? 0,
          parseFailures: row.parseFailures ?? 0,
        };
      }

      const byPlatform: StatsQueryResult["byPlatform"] = {};
      for (const row of database.all<AggregateRow & { platform: string }>(
        `SELECT platform, ${aggregateSql().slice(aggregateSql().indexOf("SUM("), aggregateSql().lastIndexOf(" FROM stats_events"))}
         FROM stats_events WHERE event_at >= ? AND event_at < ? AND platform IS NOT NULL GROUP BY platform`,
        startAt,
        endAt
      )) {
        byPlatform[row.platform] = {
          downloads: row.downloads ?? 0,
          failures: row.failures ?? 0,
          bytes: row.bytes ?? 0,
          parses: row.parses ?? 0,
          parseFailures: row.parseFailures ?? 0,
        };
      }

      const byKind: StatsQueryResult["byKind"] = {};
      for (const row of database.all<{ kind: string; downloads: number; bytes: number }>(
        `SELECT COALESCE(kind, 'unknown') AS kind, COUNT(*) AS downloads, SUM(bytes) AS bytes
         FROM stats_events WHERE event_at >= ? AND event_at < ? AND event_type = 'download' AND outcome = 'success'
         GROUP BY COALESCE(kind, 'unknown')`,
        startAt,
        endAt
      )) byKind[row.kind] = { downloads: row.downloads, bytes: row.bytes };

      const groupedEvents = database.all<{
        work_key: string;
        event_type: string;
        outcome: string | null;
        count: number;
        bytes: number;
      }>(
        `SELECT work_key, event_type, outcome, COUNT(*) AS count, SUM(bytes) AS bytes
         FROM stats_events WHERE event_at >= ? AND event_at < ? AND work_key IS NOT NULL
         GROUP BY work_key, event_type, outcome`,
        startAt,
        endAt
      );
      const authorByWork = new Map<string, { name: string; avatar?: string }>();
      for (const row of database.all<{ work_key: string; payload_json: string }>(
        `SELECT h.work_key, h.payload_json FROM history_entries h
         JOIN (SELECT DISTINCT work_key FROM stats_events WHERE event_at >= ? AND event_at < ? AND work_key IS NOT NULL) e
           ON e.work_key = h.work_key
         ORDER BY h.created_at DESC`,
        startAt,
        endAt
      )) {
        if (authorByWork.has(row.work_key)) continue;
        try {
          const entry = JSON.parse(row.payload_json) as { author?: { name?: unknown; avatar?: unknown } };
          if (typeof entry.author?.name === "string" && entry.author.name.trim()) {
            // 行按 created_at DESC 遍历：这里取到的是该作品**最新**快照的头像
            const avatar = typeof entry.author.avatar === "string" && entry.author.avatar ? entry.author.avatar : undefined;
            authorByWork.set(row.work_key, { name: entry.author.name.trim(), avatar });
          }
        } catch {
          // A corrupt historical payload has no author attribution; its event totals still count.
        }
      }
      const authorTotals = new Map<string, StatsQueryResult["authors"][number]>();
      const parsedWorks = new Set<string>();
      for (const row of groupedEvents) {
        const info = authorByWork.get(row.work_key);
        if (!info) continue;
        const author = authorTotals.get(info.name) ?? { name: info.name, parsedWorks: 0, downloadedFiles: 0, downloadedBytes: 0 };
        // 头像取这位作者**最新**一条作品快照的；此后不再覆盖，同作者多作品不会来回跳
        if (author.avatar === undefined && info.avatar) author.avatar = info.avatar;
        if (row.event_type === "parse" && row.outcome === "success" && !parsedWorks.has(row.work_key)) {
          author.parsedWorks += 1;
          parsedWorks.add(row.work_key);
        }
        if (row.event_type === "download" && row.outcome === "success") {
          author.downloadedFiles += row.count;
          author.downloadedBytes += row.bytes ?? 0;
        }
        authorTotals.set(info.name, author);
      }
      const authors = [...authorTotals.values()].sort(
        (a, b) => b.downloadedFiles - a.downloadedFiles || b.parsedWorks - a.parsedWorks || a.name.localeCompare(b.name)
      );
      const first = database.get<{ event_at: number }>("SELECT MIN(event_at) AS event_at FROM stats_events")?.event_at;
      return {
        range,
        availableFrom: first == null ? null : dayKey(first),
        totals: {
          downloads: totals.downloads ?? 0,
          failures: totals.failures ?? 0,
          canceled: totals.canceled ?? 0,
          bytes: totals.bytes ?? 0,
          elapsedMs: totals.elapsedMs ?? 0,
          elapsedCount: totals.elapsedCount ?? 0,
          elapsedBytes: totals.elapsedBytes ?? 0,
          parses: totals.parses ?? 0,
          parseFailures: totals.parseFailures ?? 0,
        },
        byDay,
        byPlatform,
        byKind,
        authors,
      };
    },
  };
}

interface HistoryQueryFilter {
  platform?: string;
  from?: string;
  to?: string;
  query?: string;
}

interface HistoryGroupCursorRow {
  work_key: string;
  created_at: number;
}

function historyGroups(
  database: DatabaseHandle,
  filter: HistoryQueryFilter,
  cursor: HistoryCursor | undefined,
  limit: number
): HistoryGroupCursorRow[] {
  // 与 queueGroups 同一套写法：每个作品只取命中筛选的最新一行，沿索引倒序取满 limit 即停
  const conditions = (alias: string, inner: boolean): { sql: string; params: (string | number)[] } => {
    const col = (name: string) => `${inner ? "+" : ""}${alias}.${name}`;
    const sql: string[] = [];
    const params: (string | number)[] = [];
    if (filter.platform) {
      sql.push(`${col("platform")} = ?`);
      params.push(resolveKey(filter.platform));
    }
    if (filter.from && filter.to) {
      const bounds = localDateBounds({ from: filter.from, to: filter.to });
      sql.push(`${col("created_at")} >= ? AND ${col("created_at")} < ?`);
      params.push(bounds.startAt, bounds.endAt);
    }
    if (filter.query?.trim()) {
      sql.push(`lower(${alias}.title || ' ' || ${alias}.payload_json) LIKE ? ESCAPE '\\'`);
      params.push(`%${filter.query.trim().toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
    return { sql: sql.map((s) => ` AND ${s}`).join(""), params };
  };
  const outer = conditions("h", false);
  const inner = conditions("h2", true);
  const cursorSql = cursor ? " AND (h.created_at < ? OR (h.created_at = ? AND h.work_key < ?))" : "";
  const cursorParams = cursor ? [cursor.createdAt, cursor.createdAt, cursor.workKey] : [];
  return database.all<HistoryGroupCursorRow>(
    `SELECT h.work_key, h.created_at FROM history_entries h
     WHERE 1 = 1${outer.sql}${cursorSql}
       AND NOT EXISTS (
         SELECT 1 FROM history_entries h2
         WHERE h2.work_key = h.work_key${inner.sql}
           AND (h2.created_at > h.created_at OR (h2.created_at = h.created_at AND h2.id > h.id))
       )
     ORDER BY h.created_at DESC, h.work_key DESC LIMIT ?`,
    ...outer.params,
    ...cursorParams,
    ...inner.params,
    limit
  );
}

export function createHistoryRepository(database: DatabaseHandle): HistoryRepository {
  return {
    list(filter = {}) {
      const limit = filter.limit ?? 50;
      const groups = historyGroups(database, filter, filter.cursor, limit + 1);
      const selected = groups.slice(0, limit);
      const keys = selected.map((group) => group.work_key);
      const rows: HistoryEntry[] = keys.length === 0
        ? []
        : database.all<{ payload_json: string }>(
            `SELECT payload_json FROM history_entries WHERE work_key IN (${keys.map(() => "?").join(",")})
             ORDER BY created_at DESC, id DESC`,
            ...keys
          ).map((row) => JSON.parse(row.payload_json) as HistoryEntry);
      const last = selected.at(-1);
      return {
        rows,
        nextCursor: groups.length > limit && last ? { createdAt: last.created_at, workKey: last.work_key } : null,
      };
    },

    listKeys(filter = {}, cursor, limit = 5000) {
      const groups = historyGroups(database, filter, cursor, limit + 1);
      const selected = groups.slice(0, limit);
      const last = selected.at(-1);
      return {
        keys: selected.map((group) => group.work_key),
        nextCursor: groups.length > limit && last ? { createdAt: last.created_at, workKey: last.work_key } : null,
      };
    },

    remove(keys) {
      if (keys.length === 0) return 0;
      const placeholders = keys.map(() => "?").join(",");
      return database.transaction(() => {
        const matched = database.all<{ work_key: string }>(
          `SELECT DISTINCT work_key FROM history_entries
           WHERE id IN (${placeholders}) OR work_key IN (${placeholders}) OR group_id IN (${placeholders})`,
          ...keys,
          ...keys,
          ...keys
        ).map((row) => row.work_key);
        if (matched.length > 0) {
          const workPlaceholders = matched.map(() => "?").join(",");
          database.run(`UPDATE stats_events SET work_key = NULL WHERE work_key IN (${workPlaceholders})`, ...matched);
        }
        const groupKeys = [...new Set(matched)];
        const groupPlaceholders = groupKeys.length ? groupKeys.map(() => "?").join(",") : "NULL";
        return database.run(
          `DELETE FROM history_entries WHERE id IN (${placeholders}) OR work_key IN (${placeholders}) OR group_id IN (${placeholders}) OR work_key IN (${groupPlaceholders})`,
          ...keys,
          ...keys,
          ...keys,
          ...groupKeys
        ).changes;
      });
    },
  };
}
