/**
 * dev / 打包版数据目录隔离：两边共用一个 userData 时，设置库、历史/队列、日志与
 * Chromium 缓存（含 cookies）全是同一份，单实例锁还会让后启动的那个静默退出。
 * 这里钉住路径规则与「打包版不搬家」。
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
// 直接引桩而不是 "electron"：本用例要翻转 isPackaged，Electron 官方类型把它标成只读
import { app } from "./stubs/electron";
import { applyProfile, devUserDataDir } from "../electron/main/profile";

describe("dev / 打包版数据目录隔离", () => {
  it("dev 目录是 <appData>/<appName>-dev，打包版保持默认 userData", () => {
    expect(devUserDataDir(join("/tmp", "appData"), "MediaGet")).toBe(
      join("/tmp", "appData", "MediaGet-dev")
    );
  });

  it("打包版不挪 userData（装机用户的数据原地不动）", () => {
    const before = app.getPath("userData");
    app.isPackaged = true;
    try {
      applyProfile();
    } finally {
      app.isPackaged = false;
    }
    expect(app.getPath("userData")).toBe(before);
  });

  it("未打包时把 userData 挪到 -dev 档", () => {
    applyProfile();
    expect(app.getPath("userData")).toBe(devUserDataDir(app.getPath("appData"), app.getName()));
  });
});
