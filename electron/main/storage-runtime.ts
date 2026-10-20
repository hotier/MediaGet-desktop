import { app } from "electron";
import { join } from "node:path";
import { openDatabase } from "./database";
import { migrateJsonStore, type MigrationReport } from "./storage-migration";
import {
  createHistoryRepository,
  createQueueRepository,
  createSettingsRepository,
  createStatsRepository,
  type SettingsRepository,
} from "./repositories";

const userDataDir = app.getPath("userData");
export const database = openDatabase(join(userDataDir, "mediaget.sqlite"));

/**
 * 迁移失败不阻断启动：源 JSON 一个字节都没动，下次启动会重试；库仍可读写，
 * 用户至少能进界面看日志/改设置。错误必须由 index.ts 弹窗 + 落日志，不能静默。
 */
let report: MigrationReport = { imported: {}, skipped: [] };
let error: string | null = null;
try {
  report = migrateJsonStore({ userDataDir, db: database });
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
export const migrationReport = report;
export const migrationError = error;

const liveSettings = createSettingsRepository(database);
let closedConfig: ReturnType<SettingsRepository["loadConfig"]> | null = null;

/**
 * before-quit 关库后，日志级别、下载并发、完成后定位等读取仍会在进程真正退出前触发；
 * 关库那一刻把设置冻成快照继续答读，写一律丢弃，否则主进程在退出时抛「连接未打开」。
 */
export const settingsRepository: SettingsRepository = {
  loadConfig: () => closedConfig ?? liveSettings.loadConfig(),
  saveConfig: (config) => {
    if (!closedConfig) liveSettings.saveConfig(config);
  },
  getKernelValue: (key) => (closedConfig ? closedConfig.kernel[key] : liveSettings.getKernelValue(key)),
};

export const isStorageClosed = (): boolean => closedConfig !== null;

/** 幂等：before-quit 可能触发多次（更新安装、退出被取消后重来）。flush 在关库前跑，最后一批写不丢。 */
export function closeStorage(flush: () => void): void {
  if (closedConfig) return;
  flush();
  closedConfig = liveSettings.loadConfig();
  database.close();
}

export const statsRepository = createStatsRepository(database);
export const historyRepository = createHistoryRepository(database);
export const queueRepository = createQueueRepository(database);
