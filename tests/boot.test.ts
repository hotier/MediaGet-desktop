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
import { IPC, type UpdateState } from "../types/ipc";
import { CONTRACT } from "../types/ipc-contract";
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
    // 通道集合真源 = CONTRACT；逐条对账，漏注册/多注册都是契约漂移
    for (const channel of Object.keys(CONTRACT)) {
      expect(registered, `channel ${channel} 未注册`).toContain(channel);
    }
    // 注册数不得超过契约表：多出来的通道就是没经 zod 校验的旁路
    expect(registered.length).toBe(Object.keys(CONTRACT).length);
    expect(registered.every((c) => /^[a-z]+:[a-zA-Z]+$/.test(c))).toBe(true);
  });

  it("顶层生命周期挂载（activate 在 whenReady 内，headless 不可达，不在此断言）", () => {
    const listeners = stubApp._listenerNames();
    expect(listeners).toContain("second-instance");
    expect(listeners).toContain("window-all-closed");
    expect(listeners).toContain("before-quit");
    // will-quit 是唯一的全局快捷键回收点：漏了它，退出后键位仍被占着
    expect(listeners).toContain("will-quit");
  });

  it("app:getMeta 端到端（假 ipcMain 直调 handler）返回内核平台清单", async () => {
    const handler = stubIpcMain._handlers.get(IPC.appGetMeta);
    expect(typeof handler).toBe("function");
    const res = (await handler!({}, undefined)) as {
      ok: boolean;
      data: { version: string; platforms: { key: string }[]; kernelMode: string };
      error?: { code: string; message: string };
    };
    expect(res, `getMeta 信封：${JSON.stringify(res?.error)}`).toHaveProperty("ok", true);
    expect(res.data.version).toBe("0.0.0-test");
    expect(res.data.platforms.map((p) => p.key)).toContain("douyin");
    expect(["local", "online", "mock"]).toContain(res.data.kernelMode);
  });

  it("before-quit 触发队列快照落盘路径不抛", () => {
    expect(() => stubApp._emit("before-quit")).not.toThrow();
  });

  it("update:state 端到端：未打包运行如实报 unsupported（不假装有更新源）", async () => {
    const handler = stubIpcMain._handlers.get(IPC.updateGetState);
    expect(typeof handler).toBe("function");
    const res = (await handler!({}, undefined)) as { ok: boolean; data: UpdateState };
    expect(res.ok).toBe(true);
    expect(res.data.phase).toBe("unsupported");
    expect(res.data.canCheck).toBe(false);
    // 无更新源时检查动作必须是空操作，不能产生网络请求
    const checked = (await stubIpcMain._handlers.get(IPC.updateCheck)!({}, undefined)) as {
      ok: boolean;
      data: UpdateState;
    };
    expect(checked.data.phase).toBe("unsupported");
  });

  it("app:getBinaryStatus 端到端：如实汇报两个二进制的完整性档位", async () => {
    const handler = stubIpcMain._handlers.get(IPC.appGetBinaryStatus);
    expect(typeof handler).toBe("function");
    const res = (await handler!({}, undefined)) as {
      ok: boolean;
      data: {
        manifestLoaded: boolean;
        packagedDir: string | null;
        binaries: { name: string; integrity: string }[];
      };
    };
    expect(res.ok).toBe(true);
    // 两个二进制都必须被汇报（缺一个就等于对用户隐瞒）
    expect(res.data.binaries.map((b) => b.name).sort()).toEqual(["ffmpeg", "yt-dlp"]);
    // 档位只能是这四个之一；「无基线」必须体现为 degraded 而不是 verified
    for (const b of res.data.binaries) {
      expect(["verified", "degraded", "rejected", "missing"]).toContain(b.integrity);
      if (!res.data.manifestLoaded) expect(b.integrity).not.toBe("verified");
    }
  });
});
