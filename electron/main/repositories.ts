import type { DatabaseHandle } from "./database";
import type { AppSettings, HistoryEntry, PersistedQueueTask } from "../../types/ipc";

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
