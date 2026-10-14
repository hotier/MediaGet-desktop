/**
 * 最小 Electron 复现（诊断用，非产品代码）：不 import 本仓任何模块，
 * 只做 app.whenReady → 建窗 → 打日志。用来区分
 * 「electron runtime / 环境问题」 vs 「mediaGet-desktop 应用代码问题」。
 *
 * 用法（项目根目录，二分定位 Insider build 上的原生启动崩）：
 *   ① npx electron scripts/electron-min-repro.cjs                      ← 基线
 *   ② npx electron scripts/electron-min-repro.cjs --disable-gpu        ← 验 GPU/D3D
 *   ③ npx electron scripts/electron-min-repro.cjs --no-sandbox         ← 验 Chromium 沙箱
 * 哪条弹出 "min-repro OK" 窗口，就把同款开关加进 dev:electron（或正式修）。
 */
const { app, BrowserWindow } = require("electron");

console.log("[min-repro] ELECTRON_RUN_AS_NODE =", JSON.stringify(process.env.ELECTRON_RUN_AS_NODE));
console.log("[min-repro] electron =", process.versions.electron, "node =", process.versions.node);
console.log("[min-repro] argv =", process.argv.slice(1).join(" "));

if (process.argv.includes("--disable-gpu")) {
  app.disableHardwareAcceleration();
  console.log("[min-repro] hardware acceleration disabled");
}

if (!app.requestSingleInstanceLock()) {
  console.log("[min-repro] second instance, quitting");
  app.quit();
  process.exit(0);
}

app
  .whenReady()
  .then(() => {
    const win = new BrowserWindow({ width: 480, height: 320, show: true });
    win.loadURL(
      "data:text/html,<h2 style='font-family:sans-serif'>min-repro OK</h2>"
    );
    console.log("[min-repro] window created");
    win.on("closed", () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  })
  .catch((e) => {
    console.error("[min-repro] whenReady failed:", e);
    app.quit();
  });
