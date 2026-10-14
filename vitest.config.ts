import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 单测：适配层、下载器、IPC 校验（README「开发命令」test 条目）。
 * 纯本地无外网：解析通道用注入的 fake fetch / mock 模式，不打真实平台。
 *
 * alias：
 * - `@` → 上游 mediaGet src（内核纯模块直接参与测试，验证「单一代码源」真的可 import）
 * - `~` → renderer/src（shadcn 组件用 `~/lib/utils` 相对根导入，与 vite/tsconfig 三处一致）
 * - `electron` → 测试桩（ipc.ts 静态 import { shell }）
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../mediaGet/src", import.meta.url)),
      "~": fileURLToPath(new URL("./renderer/src", import.meta.url)),
      electron: fileURLToPath(new URL("./tests/stubs/electron.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
