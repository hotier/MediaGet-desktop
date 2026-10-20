import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppSettingsSchema,
  HistoryEntrySchema,
  PersistedQueueTaskSchema,
  StatsSnapshotSchema,
} from "../../types/ipc-contract";
import { DEFAULT_SETTINGS, type AppSettings, type HistoryEntry, type PersistedQueueTask } from "../../types/ipc";
import { resolveKey } from "../../shared/platforms";
import { normalizeAuthorSnapshot } from "../../shared/author";
import { workKeyOf } from "../../shared/history";
import type { DatabaseHandle } from "./database";
import { LEGACY_JSON_STORE_FILES } from "./store";

type SourceName = "config" | "queue" | "history" | "stats";
type SourceFile = (typeof LEGACY_JSON_STORE_FILES)[number];

interface ParsedSource {
  name: SourceName;
  fingerprint: string;
  rows: number;
  apply(db: DatabaseHandle): void;
}

export interface MigrationReport {
  imported: Partial<Record<SourceName, number>>;
  skipped: SourceName[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceName(file: SourceFile): SourceName {
  return file.slice(0, -".json".length) as SourceName;
}

function readSource(dir: string, file: SourceFile): { name: SourceName; fingerprint: string; value: unknown } | null {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  const name = sourceName(file);
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readFileSync(path);
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Unable to migrate ${file}: source is unreadable or malformed; the original file was preserved`);
  }
  return { name, fingerprint: createHash("sha256").update(bytes).digest("hex"), value };
}

function parseConfig(value: unknown, fingerprint: string): ParsedSource {
  if (!isRecord(value) || (value.settings !== undefined && !isRecord(value.settings)) || (value.kernel !== undefined && !isRecord(value.kernel))) {
    throw new Error("Unable to migrate config.json: unsupported configuration shape; the original file was preserved");
  }
  const rawSettings = (value.settings ?? {}) as Partial<AppSettings>;
  const settings = AppSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...rawSettings,
    cookies: { ...DEFAULT_SETTINGS.cookies, ...(rawSettings.cookies ?? {}) },
    platformSwitches: Object.fromEntries(
      Object.entries(rawSettings.platformSwitches ?? {}).map(([key, row]) => [key, { ...row }])
    ),
    filenameExtra: { ...DEFAULT_SETTINGS.filenameExtra, ...(rawSettings.filenameExtra ?? {}) },
  });
  const kernel = value.kernel ?? {};
  if (!isRecord(kernel) || Object.values(kernel).some((item) => typeof item !== "string")) {
    throw new Error("Unable to migrate config.json: unsupported kernel configuration shape; the original file was preserved");
  }

  return {
    name: "config",
    fingerprint,
    rows: 1,
    apply(db) {
      db.exec("DELETE FROM app_settings; DELETE FROM kernel_config;");
      db.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", "settings", JSON.stringify(settings));
      for (const [key, secret] of Object.entries(kernel)) {
        db.run("INSERT INTO kernel_config (key, value) VALUES (?, ?)", key, secret as string);
      }
    },
  };
}

function parseQueue(value: unknown, fingerprint: string): ParsedSource {
  if (!Array.isArray(value)) {
    throw new Error("Unable to migrate queue.json: expected a task array; the original file was preserved");
  }
  const tasks = value.map((row) => {
    try {
      return PersistedQueueTaskSchema.parse(row);
    } catch {
      throw new Error("Unable to migrate queue.json: a task has an unsupported shape; the original file was preserved");
    }
  });
  return {
    name: "queue",
    fingerprint,
    rows: tasks.length,
    apply(db) {
      db.exec("DELETE FROM queue_tasks;");
      for (const task of tasks) {
        // Media URLs and request headers are ephemeral transport credentials. Keep the task metadata, but never import them.
        const safeTask: PersistedQueueTask = { ...task, url: "", referer: undefined, headers: undefined };
        db.run(
          `INSERT INTO queue_tasks
            (task_id, created_at, updated_at, status, platform, search_text, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          task.taskId,
          task.createdAt,
          task.finishedAt ?? task.createdAt,
          task.status,
          task.platform ? resolveKey(task.platform) : null,
          `${task.filename} ${task.title ?? ""}`.trim(),
          JSON.stringify(safeTask)
        );
      }
    },
  };
}

function normalizeHistoryRow(value: unknown): HistoryEntry {
  if (!isRecord(value)) throw new Error("Unable to migrate history.json: a row has an unsupported shape; the original file was preserved");
  const raw = {
    ...value,
    platform: typeof value.platform === "string" ? resolveKey(value.platform) : value.platform,
    author: normalizeAuthorSnapshot(value.author as Parameters<typeof normalizeAuthorSnapshot>[0]),
  };
  let entry: HistoryEntry;
  try {
    entry = HistoryEntrySchema.parse(raw);
  } catch {
    throw new Error("Unable to migrate history.json: a row has an unsupported shape; the original file was preserved");
  }
  const workKey = workKeyOf(entry.sourceUrl);
  if (!workKey) return entry;
  const isParseRow = (entry.files?.length ?? 0) === 0 && entry.id === entry.groupId;
  return isParseRow ? { ...entry, id: workKey, groupId: workKey } : { ...entry, groupId: workKey };
}

function parseHistory(value: unknown, fingerprint: string): ParsedSource {
  if (!Array.isArray(value)) {
    throw new Error("Unable to migrate history.json: expected a history array; the original file was preserved");
  }
  const entries = value.map(normalizeHistoryRow);
  return {
    name: "history",
    fingerprint,
    rows: entries.length,
    apply(db) {
      db.exec("DELETE FROM history_entries;");
      for (const entry of entries) {
        const key = entry.groupId ?? workKeyOf(entry.sourceUrl) ?? entry.id;
        db.run(
          `INSERT INTO history_entries (id, work_key, group_id, created_at, platform, title, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          entry.id,
          key,
          entry.groupId ?? null,
          entry.createdAt,
          entry.platform ?? null,
          entry.title ?? "",
          JSON.stringify(entry)
        );
      }
    },
  };
}

function parseStats(value: unknown, fingerprint: string): ParsedSource {
  let snapshot: unknown;
  try {
    snapshot = value === null ? null : StatsSnapshotSchema.parse(value);
  } catch {
    throw new Error("Unable to migrate stats.json: unsupported statistics shape; the original file was preserved");
  }
  return {
    name: "stats",
    fingerprint,
    rows: snapshot === null ? 0 : 1,
    apply(db) {
      db.run(
        "INSERT INTO legacy_stats (key, value) VALUES ('snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(snapshot)
      );
    },
  };
}

function parseSource(source: NonNullable<ReturnType<typeof readSource>>): ParsedSource {
  switch (source.name) {
    case "config":
      return parseConfig(source.value, source.fingerprint);
    case "queue":
      return parseQueue(source.value, source.fingerprint);
    case "history":
      return parseHistory(source.value, source.fingerprint);
    case "stats":
      return parseStats(source.value, source.fingerprint);
  }
}

/** Import all present legacy files atomically. Source files remain untouched for recovery. */
export function migrateJsonStore(input: { userDataDir: string; db: DatabaseHandle }): MigrationReport {
  const sources: ParsedSource[] = [];
  for (const file of LEGACY_JSON_STORE_FILES) {
    const raw = readSource(input.userDataDir, file);
    if (raw) sources.push(parseSource(raw));
  }
  const report: MigrationReport = { imported: {}, skipped: [] };
  const pending = sources.filter((source) => {
    const applied = input.db.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM storage_migrations WHERE source = ?",
      `${source.name}.json`
    );
    if (applied?.fingerprint === source.fingerprint) {
      report.skipped.push(source.name);
      return false;
    }
    return true;
  });

  if (pending.length === 0) return report;
  try {
    input.db.transaction(() => {
      for (const source of pending) {
        source.apply(input.db);
        const actualRows = source.name === "queue"
          ? input.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM queue_tasks")?.count
          : source.name === "history"
            ? input.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")?.count
            : source.rows;
        if (actualRows !== source.rows) throw new Error("row count validation failed");
        input.db.run(
          `INSERT INTO storage_migrations (source, fingerprint, imported_at, row_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at, row_count = excluded.row_count`,
          `${source.name}.json`,
          source.fingerprint,
          Date.now(),
          source.rows
        );
        report.imported[source.name] = source.rows;
      }
    });
  } catch {
    throw new Error("SQLite import failed validation or transaction; all legacy JSON sources were preserved");
  }
  return report;
}
