import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./lib/bridge";
import "./styles.css";

/**
 * 渲染层异常转发到主进程文件日志（设置→通用→日志）。
 *
 * 为什么需要：打包版没有控制台，界面「卡了一下」若不落盘就永久失踪；主进程又看不见
 * renderer 的运行时。两条限制都是这条链路的理由 ——
 * ① 只送一行摘要（含首个栈帧），长度在客户端先截：契约上限 2000 字符，
 *    超了会被入参校验整条拒掉，等于白报；
 * ② 限量 50 条：渲染循环里反复抛错的应用，不设闸门就是拿 IPC 往日志里灌水。
 */
function forwardErrors(): void {
  let sent = 0;
  const report = (message: string): void => {
    if (sent >= 50) return;
    sent += 1;
    void api.app.log("error", message.slice(0, 1800));
  };
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    report(`${e.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const frame = r instanceof Error ? r.stack?.split("\n")[1]?.trim() ?? "" : "";
    report(
      `未处理的 Promise 异常: ${r instanceof Error ? `${r.message}${frame ? ` (${frame})` : ""}` : String(r)}`
    );
  });
}

async function boot(): Promise<void> {
  // 浏览器直开（无 preload）时装假桥做可视化评审；Electron 里 window.mg 已存在，
  // 且 PROD 构建该分支恒假、动态 import 不进包。
  if (import.meta.env.DEV && !window.mg) {
    const { installMockBridge } = await import("./dev/mock-bridge");
    installMockBridge();
  }
  forwardErrors();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void boot();
