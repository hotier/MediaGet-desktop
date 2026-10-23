/**
 * 单实例锁必须比任何有副作用的模块先求值。
 *
 * 为什么单独一个模块并排在 index.ts 的 import 首位：`kernel-env` 会经 `storage-runtime`
 * 开库并跑首次 JSON 迁移。若第二个实例先完成了这些，再走到 index.ts 函数体里的锁，
 * 它会和第一个实例争同一个 WAL 库（busy / 迁移标记竞态），然后才安静退出。
 * ESM 的求值顺序 = import 顺序，所以锁只能靠「第一个 import」抢在开库之前。
 */
import { app } from "electron";
import { applyProfile } from "./profile";

// 先分档再抢锁：单实例锁按 userData 区分，dev 与打包版才能同时跑（A/B 测试），
// 也让 dev 永远不碰用户正式版的设置库/历史/日志。
applyProfile();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
