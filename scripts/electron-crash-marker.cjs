/**
 * 崩溃定位探针（诊断用，非产品代码）：每个里程碑同步写文件，避免
 * 崩溃时 stdout 管道缓冲丢失导致「日志一条都没有 → 误判为 JS 未执行」。
 *
 * 用法：npx electron scripts/electron-crash-marker.cjs [--no-sandbox]
 * 输出：scripts/.crash-markers.log（追加），最后一行即崩溃前到达的位置。
 */
const { appendFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const LOG = join(__dirname, ".crash-markers.log");
if (process.argv.includes("--fresh")) {
  try {
    rmSync(LOG);
  } catch {}
}

let step = 0;
function mark(label) {
  step += 1;
  appendFileSync(LOG, `${String(step).padStart(2, "0")} ${label}\n`);
}

mark(`START argv=${process.argv.slice(1).join(" ")} runAsNode=${process.env.ELECTRON_RUN_AS_NODE}`);

let electron;
try {
  electron = require("electron");
  mark(`require("electron") ok; type=${typeof electron}`);
} catch (e) {
  mark(`require("electron") FAILED: ${e.message}`);
  process.exit(9);
}

const { app, BrowserWindow } = electron;
mark(`destructured app=${typeof app} BrowserWindow=${typeof BrowserWindow}`);

if (!app || typeof app.requestSingleInstanceLock !== "function") {
  mark("app 不可用（大概率 ELECTRON_RUN_AS_NODE 污染）→ 退出");
  process.exit(9);
}

const got = app.requestSingleInstanceLock();
mark(`requestSingleInstanceLock=${got}`);
if (!got) process.exit(0);

app.on("ready", () => mark("event: ready"));
app.on("window-all-closed", () => mark("event: window-all-closed"));
process.on("uncaughtException", (e) => mark(`uncaughtException: ${e && e.message}`));

mark("before whenReady()");
app
  .whenReady()
  .then(() => {
    mark("whenReady resolved");
    const win = new BrowserWindow({ width: 480, height: 320, show: true });
    mark("BrowserWindow constructed");
    win.loadURL("data:text/html,<h2>marker OK</h2>");
    mark("loadURL called");
    win.on("closed", () => {
      mark("event: closed");
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  })
  .catch((e) => {
    mark(`whenReady REJECTED: ${e && e.message}`);
    app.quit();
  });
