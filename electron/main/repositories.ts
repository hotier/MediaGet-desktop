import type { DatabaseHandle } from "./database";
import { AppSettingsSchema } from "../../types/ipc-contract";
import { randomUUID } from "node:crypto";
import { resolveKey } from "../../shared/platforms";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type HistoryEntry,
  type PersistedQueueTask,
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
  loadRecoverable(): PersistedQueueTask[];
}

export interface HistoryRepository {
  list(filter: unknown): { rows: HistoryEntry[]; nextCursor: unknown | null };
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
      const settings = stored
        ? AppSettingsSchema.parse(JSON.parse(stored.value))
        : AppSettingsSchema.parse({
            ...DEFAULT_SETTINGS,
            cookies: { ...DEFAULT_SETTINGS.cookies },
            platformSwitches: { ...DEFAULT_SETTINGS.platformSwitches },
            filenameExtra: { ...DEFAULT_SETTINGS.filenameExtra },
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
      const bytes = event.type === "download" && event.outcome === "success" ? Math.max(0, Math.floor(event.bytes)) : 0;
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
          duration === undefined ? null : Math.max(0, Math.floor(duration)),
          event.workKey ?? null,
          via
        );
      const insertHistory = () => {
        if (!historyEntry) return;
        const workKey = historyEntry.groupId ?? historyEntry.id;
        database.run(
          `INSERT INTO history_entries (id, work_key, group_id, created_at, platform, title, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET work_key = excluded.work_key, group_id = excluded.group_id,
             created_at = excluded.created_at, platform = excluded.platform, title = excluded.title,
             payload_json = excluded.payload_json`,
          historyEntry.id,
          workKey,
          historyEntry.groupId ?? null,
          historyEntry.createdAt,
          historyEntry.platform ?? null,
          historyEntry.title ?? "",
          JSON.stringify(historyEntry)
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
      const authorByWork = new Map<string, string>();
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
          const entry = JSON.parse(row.payload_json) as { author?: { name?: unknown } };
          if (typeof entry.author?.name === "string" && entry.author.name.trim()) {
            authorByWork.set(row.work_key, entry.author.name.trim());
          }
        } catch {
          // A corrupt historical payload has no author attribution; its event totals still count.
        }
      }
      const authorTotals = new Map<string, StatsQueryResult["authors"][number]>();
      const parsedWorks = new Set<string>();
      for (const row of groupedEvents) {
        const name = authorByWork.get(row.work_key);
        if (!name) continue;
        const author = authorTotals.get(name) ?? { name, parsedWorks: 0, downloadedFiles: 0, downloadedBytes: 0 };
        if (row.event_type === "parse" && row.outcome === "success" && !parsedWorks.has(row.work_key)) {
          author.parsedWorks += 1;
          parsedWorks.add(row.work_key);
        }
        if (row.event_type === "download" && row.outcome === "success") {
          author.downloadedFiles += row.count;
          author.downloadedBytes += row.bytes ?? 0;
        }
        authorTotals.set(name, author);
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
