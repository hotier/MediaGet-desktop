import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | Buffer | null;
export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DatabaseHandle {
  readonly schemaVersion: number;
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): SqlRunResult;
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE kernel_config (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE queue_tasks (
        task_id TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        platform TEXT,
        search_text TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL
      );
      CREATE INDEX queue_tasks_page ON queue_tasks(created_at DESC, task_id DESC);
      CREATE INDEX queue_tasks_status_page ON queue_tasks(status, created_at DESC, task_id DESC);
      CREATE TABLE history_entries (
        id TEXT PRIMARY KEY NOT NULL,
        work_key TEXT NOT NULL,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        platform TEXT,
        title TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL
      );
      CREATE INDEX history_entries_work ON history_entries(work_key, created_at DESC);
      CREATE INDEX history_entries_page ON history_entries(created_at DESC, work_key DESC);
      CREATE INDEX history_entries_platform_page ON history_entries(platform, created_at DESC, work_key DESC);
      CREATE TABLE stats_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        event_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        platform TEXT,
        kind TEXT,
        outcome TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        work_key TEXT
      );
      CREATE INDEX stats_events_at ON stats_events(event_at);
      CREATE INDEX stats_events_type_at ON stats_events(event_type, event_at);
      CREATE INDEX stats_events_platform_at ON stats_events(platform, event_at);
      CREATE INDEX stats_events_kind_at ON stats_events(kind, event_at);
      CREATE INDEX stats_events_work_at ON stats_events(work_key, event_at);
      CREATE TABLE legacy_stats (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE storage_migrations (
        source TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        row_count INTEGER NOT NULL
      );
    `,
  },
];

function migrate(db: BetterSqlite3.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  let current = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
    })();
    current = migration.version;
  }
  return current;
}

/** Open the main-process database. The caller owns its lifetime and passes `app.getPath("userData")/mediaget.sqlite`. */
export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const native = new BetterSqlite3(path);
  native.pragma("foreign_keys = ON");
  native.pragma("busy_timeout = 5000");
  if (path !== ":memory:") native.pragma("journal_mode = WAL");
  const schemaVersion = migrate(native);

  return {
    schemaVersion,
    exec(sql) {
      native.exec(sql);
    },
    run(sql, ...params) {
      return native.prepare(sql).run(...params) as SqlRunResult;
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      return native.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return native.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T) {
      return native.transaction(fn)();
    },
    close() {
      if (native.open && path !== ":memory:") native.pragma("wal_checkpoint(TRUNCATE)");
      native.close();
    },
  };
}
