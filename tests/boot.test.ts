/**
 * 主进程入口装配冒烟（headless 可验证的全部）：
 * 真实 GUI 启动需要桌面会话（本环境无），但「import index.js 不崩、
 * IPC 全 channel 注册、顶层生命周期挂齐、getMeta 直通内核」是纯 Node 可测的。
 * electron 走 tests/stubs 桩：whenReady 永不 resolve → 不建窗口。
 *
 * 机制说明：index.ts 顶层装配只跑一次（不做 resetModules —— 重 import 会拿到
 * 新桩实例，测试与产物各说各话）。用例共享这一份注册状态，全部只读。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { IPC } from "../types/ipc";
import { app as stubApp, ipcMain as stubIpcMain } from "./stubs/electron";

const dir = mkdtempSync(join(tmpdir(), "mg-boot-"));
process.env.MG_TEST_USERDATA = dir;

let bootError: unknown = null;
beforeAll(async () => {
  try {
    await import("../electron/main/index");
  } catch (e) {
    bootError = e;
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MG_TEST_USERDATA;
});

describe("main/index.ts 装配冒烟", () => {
  it("加载不崩", () => {
    expect(bootError).toBeNull();
  });

  it("全部 IPC channel 注册（单一真源，无拼写漂移）", () => {
    const registered = [...stubIpcMain._handlers.keys()];
    for (const channel of [
      IPC.appGetMeta,
      IPC.parseIdentify,
      IPC.parseRun,
      IPC.downloadEnqueue,
      IPC.downloadCancel,
      IPC.downloadPause,
      IPC.downloadResume,
      IPC.downloadList,
      IPC.settingsGet,
      IPC.settingsSet,
      IPC.historyList,
      IPC.historyClear,
      IPC.probeEngines,
      "app:pickDownloadDir",
      "app:showInFolder",
    ]) {
      expect(registered, `channel ${channel} 未注册`).toContain(channel);
    }
    expect(registered.every((c) => /^[a-z]+:[a-zA-Z]+$/.test(c))).toBe(true);
  });

  it("顶层生命周期挂载（activate 在 whenReady 内，headless 不可达，不在此断言）", () => {
    const listeners = stubApp._listenerNames();
    expect(listeners).toContain("second-instance");
    expect(listeners).toContain("window-all-closed");
    expect(listeners).toContain("before-quit");
  });

  it("app:getMeta 端到端（假 ipcMain 直调 handler）返回内核平台清单", async () => {
    const handler = stubIpcMain._handlers.get(IPC.appGetMeta);
    expect(typeof handler).toBe("function");
    const res = (await handler!({}, undefined)) as {
      ok: boolean;
      data: { version: string; platforms: { key: string }[]; kernelMode: string };
    };
    expect(res.ok).toBe(true);
    expect(res.data.version).toBe("0.0.0-test");
    expect(res.data.platforms.map((p) => p.key)).toContain("douyin");
    expect(["local", "online", "mock"]).toContain(res.data.kernelMode);
  });

  it("before-quit 触发队列快照落盘路径不抛", () => {
    expect(() => stubApp._emit("before-quit")).not.toThrow();
  });
});
