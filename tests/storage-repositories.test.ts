import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../types/ipc";
import { openDatabase } from "../electron/main/database";
import { createSettingsRepository } from "../electron/main/repositories";

const directories: string[] = [];
const openHandles: ReturnType<typeof openDatabase>[] = [];

function testDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-settings-test-"));
  directories.push(dir);
  const db = openDatabase(join(dir, "test.sqlite"));
  openHandles.push(db);
  return db;
}

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    try {
      db.close();
    } catch {
      // A test can close the handle before asserting error redaction.
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("settings repository", () => {
  it("round-trips app settings and main-process kernel values", () => {
    const repository = createSettingsRepository(testDatabase());
    const config = {
      settings: { ...DEFAULT_SETTINGS, cookies: { BILIBILI_COOKIE: "cookie-sentinel" } },
      kernel: { BILIBILI_COOKIE: "cookie-sentinel", CUSTOM_KEY: "custom-value" },
    };

    repository.saveConfig(config);

    expect(repository.loadConfig()).toEqual(config);
    expect(repository.getKernelValue("BILIBILI_COOKIE")).toBe("cookie-sentinel");
    expect(repository.getKernelValue("MISSING")).toBeUndefined();
  });

  it("does not include Cookie values in database errors", () => {
    const db = testDatabase();
    const repository = createSettingsRepository(db);
    repository.saveConfig({ settings: DEFAULT_SETTINGS, kernel: { BILIBILI_COOKIE: "never-log-this-cookie" } });
    db.close();
    let errorText = "";
    try {
      repository.saveConfig({ settings: DEFAULT_SETTINGS, kernel: { BILIBILI_COOKIE: "never-log-this-cookie" } });
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
    expect(errorText).toBeTruthy();
    expect(errorText).not.toContain("never-log-this-cookie");
  });
});
