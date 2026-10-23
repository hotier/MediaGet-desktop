import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type PersistedQueueTask } from "../types/ipc";
import { openDatabase } from "../electron/main/database";
import { createSettingsRepository, queueDigest } from "../electron/main/repositories";

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

  it("fills missing keys from defaults when the database predates a settings field", () => {
    const db = testDatabase();
    const { minimizeToTray: _dropped, ...legacy } = DEFAULT_SETTINGS;
    db.run(
      "INSERT INTO app_settings (key, value) VALUES ('settings', ?)",
      JSON.stringify(legacy)
    );
    const loaded = createSettingsRepository(db).loadConfig().settings;
    expect(loaded.minimizeToTray).toBe(DEFAULT_SETTINGS.minimizeToTray);
    expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it("坏设置档回落默认值而不是让启动期读配置抛错", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = testDatabase();
      db.run("INSERT INTO app_settings (key, value) VALUES ('settings', '{\"theme\":')");
      expect(createSettingsRepository(db).loadConfig().settings).toEqual(DEFAULT_SETTINGS);

      const shaped = testDatabase();
      shaped.run(
        "INSERT INTO app_settings (key, value) VALUES ('settings', ?)",
        JSON.stringify({ theme: "neon" })
      );
      expect(createSettingsRepository(shaped).loadConfig().settings).toEqual(DEFAULT_SETTINGS);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
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

describe("queue digest", () => {
  const task = (id: string, status: PersistedQueueTask["status"]): PersistedQueueTask => ({
    taskId: id,
    groupId: "g1",
    url: `https://cdn.example.com/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: "video",
    received: 0,
    total: 1000,
    createdAt: 1,
    status,
  });

  it("按固定状态序排；空档只剩一个数", () => {
    expect(queueDigest([])).toBe("0 项");
    expect(
      queueDigest([task("a", "done"), task("b", "downloading"), task("c", "error")])
    ).toBe("3 项（downloading 1 · done 1 · error 1）");
  });
});
