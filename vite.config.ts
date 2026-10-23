import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * renderer 构建（纯 Vite + React 新壳，不含 Next.js —— README「渲染层」决策）。
 * base 用相对路径：产物经 loadFile(file://) 加载。
 * Tailwind v4：CSS-first 配置（@theme 在 styles.css），无 tailwind.config。
 */
export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./renderer/src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    // 别选 5432：PostgreSQL 默认端口，本机常驻服务会抢（实测撞端口报 EACCES 假象）。
    // 也别选 5xxx：WinNAT/WSL2 从系统动态端口范围（本机 1024–15000）里按 100 端口成批
    // 预留，5341–5440 整段被占时 `listen` 直接 EACCES——不是「谁占了这个端口」，
    // netstat 查不到任何占用者（2026-10-23 实测 5433 就这么失效的）。
    // 15433 在动态范围之外，重启与 WSL 变更都不会再把它划走。
    port: 15433,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-renderer", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
