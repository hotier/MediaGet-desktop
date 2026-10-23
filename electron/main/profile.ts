/**
 * 档位（dev / stable / beta）的派生路径分家。
 *
 * 打包版与 `pnpm dev` 共用 `userData` 时，两边的设置库、历史/队列、日志与 Chromium 缓存
 * （cookies、HTTP cache、GPUCache）都是同一份；单实例锁也按 userData 区分，于是后启动的
 * 那个会静默退出——没法并排做 A/B。dev 档在这里改道 `%APPDATA%\MediaGet-dev`；
 * beta 档不改 userData，它靠构建身份里的 productName「MediaGet (Beta)」天然落到
 * `%APPDATA%\MediaGet (Beta)`（见 electron-builder.beta.cjs）。
 *
 * `profileSuffix` 只服务 temp 派生路径（预览合流缓存）。稳定版为空串，老缓存原地不动；
 * dev / beta 各带后缀，否则两个并排实例的启动清理会互删对方正在用的合流产物。
 *
 * **必须在 `requestSingleInstanceLock()` 与任何模块作用域的 `app.getPath("userData")`
 * 之前跑完**：`single-instance.ts` 把它排在自己的锁之前，而 single-instance 又是
 * `index.ts` 的第一条 import（见 `storage-runtime.ts` 的模块求值开库）。
 */
import { app } from "electron";
import { join } from "node:path";
import { releaseChannelOf } from "./release-channel";

const DEV_SUFFIX = "-dev";
const BETA_SUFFIX = "-beta";

export const releaseChannel = releaseChannelOf(app.getVersion());

/** 纯函数，便于单测；打包态才区分 stable/beta，未打包一律 dev 档 */
export function profileSuffixFor(isPackaged: boolean, version: string): string {
  if (!isPackaged) return DEV_SUFFIX;
  return releaseChannelOf(version) === "beta" ? BETA_SUFFIX : "";
}

export const profileSuffix = profileSuffixFor(app.isPackaged, app.getVersion());

/** 纯函数：只拼路径，便于单测。`appData` 在 Windows 是 `%APPDATA%`（Roaming） */
export function devUserDataDir(appData: string, appName: string): string {
  return join(appData, `${appName}${DEV_SUFFIX}`);
}

export function applyProfile(): void {
  if (app.isPackaged) return;
  app.setPath("userData", devUserDataDir(app.getPath("appData"), app.getName()));
}
