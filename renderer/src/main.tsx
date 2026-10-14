import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function boot(): Promise<void> {
  // 浏览器直开（无 preload）时装假桥做可视化评审；Electron 里 window.mg 已存在，
  // 且 PROD 构建该分支恒假、动态 import 不进包。
  if (import.meta.env.DEV && !window.mg) {
    const { installMockBridge } = await import("./dev/mock-bridge");
    installMockBridge();
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void boot();
