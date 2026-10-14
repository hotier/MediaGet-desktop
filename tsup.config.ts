import { defineConfig } from "tsup";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";

/**
 * 主进程 / preload 编译配置（docs/ARCHITECTURE.md §7：全 TS，走 tsup/esbuild）。
 * - main：bundle 打包。解析内核经物理链接（方案 A）参与打包：本仓与内核文件里的
 *   `@/xxx` import 都解析到 `../mediaGet/src/xxx`（esbuild 插件实现：tsup Options
 *   无 alias 字段，esbuild.alias 又不支持 `@/` 前缀通配）。
 *   `electron` / `electron-updater` / Node 内置保持 external。
 * - preload：contextIsolation 下单独产物，输出 cjs 供 `webPreferences.preload`
 *   直接引用（沙箱 world 只保证 require("electron") 可用）。
 */
const kernelSrc = fileURLToPath(new URL("../mediaGet/src", import.meta.url));

/** `@/…` → `../mediaGet/src/…`（内核单一代码源的跨界 import 桥；含扩展名探测） */
function kernelAlias(): Plugin {
  return {
    name: "mediaget-kernel-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const rel = args.path.slice(2).replace(/\//g, "/");
        const cand = `${kernelSrc}/${rel}`;
        for (const suffix of ["", ".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"]) {
          const p = cand + suffix;
          if (existsSync(p)) return { path: p };
        }
        return undefined; // 未命中交默认解析（会报清晰错误而不是静默）
      });
    },
  };
}

export default defineConfig([
  {
    entry: { "main/index": "electron/main/index.ts" },
    outDir: "dist-electron",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["electron", "electron-updater"],
    esbuildPlugins: [kernelAlias()],
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
