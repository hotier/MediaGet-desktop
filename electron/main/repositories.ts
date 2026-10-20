import type { DatabaseHandle } from "./database";
import { AppSettingsSchema } from "../../types/ipc-contract";
import { DEFAULT_SETTINGS, type AppSettings, type HistoryEntry, type PersistedQueueTask } from "../../types/ipc";

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
