import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * renderer 构建（纯 Vite + React 新壳，不含 Next.js —— README「渲染层」决策）。
 * base 用相对路径：产物经 loadFile(file://) 加载。
 */
export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./renderer/src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5432,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-renderer", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
