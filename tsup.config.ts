import { defineConfig } from "tsup";

/**
 * 主进程 / preload 编译配置（docs/ARCHITECTURE.md §7：全 TS，走 tsup/esbuild）。
 * - main：bundle 打包。解析内核经 `@mediaget/parse-core` 工件消费（§8），
 *   不再需要 kernelAlias esbuild 插件。
 *   `electron` / `electron-updater` / `builder-util-runtime`（更新下载取消令牌须与
 *   electron-updater 同一模块实例）/ Node 内置保持 external。
 * - preload：contextIsolation 下单独产物，输出 cjs 供 `webPreferences.preload`
 *   直接引用（沙箱 world 只保证 require("electron") 可用）。
 */
export default defineConfig([
  {
    entry: { "main/index": "electron/main/index.ts" },
    outDir: "dist-electron",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["electron", "electron-updater", "builder-util-runtime", "font-list", "undici", "better-sqlite3", "@mediaget/parse-core", "@ikenxuan/amagi", "ytdlp-nodejs"],
  },
  {
    entry: { "preload/index": "electron/preload/index.ts" },
    outDir: "dist-electron",
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    external: ["electron"],
    sourcemap: true,
  },
]);
