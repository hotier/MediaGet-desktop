import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../electron/main/database";

const directories: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-db-test-"));
  directories.push(dir);
  return join(dir, "test.sqlite");
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite database foundation", () => {
  it("applies each schema migration exactly once", () => {
    const path = databasePath();
    const db = openDatabase(path);
    expect(db.schemaVersion).toBe(4);
    db.close();

    const reopened = openDatabase(path);
    expect(reopened.schemaVersion).toBe(4);
    expect(reopened.get<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations")?.count).toBe(4);
    // v4：解析事件记「实际用的引擎」——列在不在，统计落账走不走得通就先红在这里
    expect(reopened.get<{ name: string }>("SELECT name FROM pragma_table_info('stats_events') WHERE name = 'engine'")).toBeTruthy();
    reopened.close();
  });

  it("rolls back a failed transaction", () => {
    const db = openDatabase(databasePath());
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO app_settings (key, value) VALUES ('theme', 'dark')");
        throw new Error("rollback");
      })
    ).toThrow("rollback");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM app_settings")?.count).toBe(0);
    db.close();
  });

  it("persists committed rows across close and reopen", () => {
    const path = databasePath();
    const db = openDatabase(path);
    db.exec("INSERT INTO app_settings (key, value) VALUES ('theme', 'dark')");
    db.close();

    const reopened = openDatabase(path);
    expect(reopened.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'theme'")?.value).toBe("dark");
    reopened.close();
  });
});
