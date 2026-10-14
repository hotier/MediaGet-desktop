#!/usr/bin/env node
/**
 * dev:electron 启动器 —— 用「干净的进程环境」拉起 Electron。
 *
 * 为什么需要这一层（实测根因，非猜测）：
 *   Electron 判定 `ELECTRON_RUN_AS_NODE` 用的是**存在性**而不是真值 —— 只要这个变量
 *   出现在环境里（哪怕值是空字符串），electron.exe 就以「纯 Node 模式」启动：
 *   `require("electron")` 返回**可执行文件路径字符串**而不是 API 对象，于是
 *   `app` 是 undefined，主进程第一行 `app.requestSingleInstanceLock()` 抛
 *   `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，
 *   进程以 code 1 退出。表现酷似「沙箱崩溃 / 原生崩」，但根本不是沙箱问题。
 *
 *   实测矩阵（scripts/.crash-markers.log + .cache/ab 探针输出）：
 *     ELECTRON_RUN_AS_NODE 未设置      → 窗口正常打开（whenReady resolved）
 *     ELECTRON_RUN_AS_NODE=""          → exit 1，TypeError
 *     ELECTRON_RUN_AS_NODE="1"         → exit 1，TypeError
 *     以上三组加不加 --no-sandbox 结果完全相同 → 沙箱无关，排除 ACL/IDD 类崩溃
 *
 *   污染源：某些终端/IDE/父进程（含在 Electron 内嵌终端、或从 Node 脚本 spawn
 *   时继承）会预设这个变量。开发者本地环境不可控，所以由启动器统一清洗，
 *   而不是要求每个人手工 `Remove-Item Env:`。
 *
 * 为什么不在 main/index.ts 里兜底：那个变量在 **electron.exe 启动前**就已经决定
 * 了运行模式，JS 根本没机会执行 —— 进程内的任何检查都太晚了。
 *
 * 用法：node scripts/launch-electron.cjs [electron 参数…]
 *   npm run dev:electron 已接好；直接 `node scripts/launch-electron.cjs .` 亦可。
 */
"use strict";

const { spawn } = require("node:child_process");

/** 必须清洗的变量：存在即让 electron 走 Node 模式（实测空串同样触发） */
const POISONED_ENV_KEYS = ["ELECTRON_RUN_AS_NODE"];

function resolveElectronBinary() {
  // 从普通 node 进程 require("electron") 返回的是二进制绝对路径（这正是
  // 被污染时 electron 内部拿到的那个字符串 —— 此处是「正常用法」）。
  const mod = require("electron");
  if (typeof mod === "string" && mod.length > 0) return mod;
  throw new Error(
    "require('electron') 未返回二进制路径：Electron 未安装或安装不完整（试试 pnpm install）"
  );
}

function sanitizeEnv(env) {
  const next = { ...env };
  const removed = [];
  for (const key of POISONED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      removed.push(`${key}=${JSON.stringify(env[key])}`);
    }
  }
  return { next, removed };
}

function main() {
  const binary = resolveElectronBinary();
  const { next: env, removed } = sanitizeEnv(process.env);

  if (removed.length > 0) {
    process.stdout.write(
      `[launch-electron] 已清洗污染变量（否则 electron 会以 Node 模式启动并立即 TypeError）：${removed.join(", ")}\n`
    );
  }

  const args = process.argv.slice(2);
  const child = spawn(binary, args, { stdio: "inherit", env, windowsHide: false });

  child.on("error", (e) => {
    process.stderr.write(`[launch-electron] 启动 ${binary} 失败：${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    // 透传退出码：dev 脚本里 electron 被 Ctrl-C 杀掉时 signal 有值、code 为 null
    process.exit(signal ? 0 : (code ?? 0));
  });
}

// 作为脚本直接跑才启动 electron；被 require（测试）时只导出纯函数，
// 避免测试进程被真的拉起一个 GUI 窗口。
if (require.main === module) {
  main();
}

module.exports = { POISONED_ENV_KEYS, sanitizeEnv, resolveElectronBinary };
