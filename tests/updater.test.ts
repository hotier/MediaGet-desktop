/**
 * 自动更新状态机（P6）单测：假更新源驱动全阶段迁移，全程离线。
 *
 * 关心的是三件事：
 *  1. 阶段迁移与快照字段（UI 只读这一个对象）；
 *  2. autoDownload 必须关 —— 静默吃用户带宽不是可接受的默认；
 *  3. 守卫：无更新源不能检查，未下载完不能安装。
 */
import { describe, expect, it, vi } from "vitest";
import { createUpdater, type UpdaterSource } from "../electron/main/updater";
import type { UpdateState } from "../types/ipc";

class FakeSource implements UpdaterSource {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  quitAndInstall = vi.fn();
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  private listeners: Record<string, ((p: unknown) => void)[]> = {};

  on(event: string, cb: (payload: unknown) => void): void {
    (this.listeners[event] ||= []).push(cb);
  }

  fire(event: string, payload?: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(payload);
  }
}

function harness() {
  const seen: UpdateState[] = [];
  const updater = createUpdater({
    currentVersion: "0.1.0",
    onChange: (s) => seen.push(s),
  });
  const source = new FakeSource();
  return { updater, source, seen, latest: () => updater.snapshot() };
}

describe("createUpdater 初始态", () => {
  it("未挂更新源 = unsupported，且 check/download 不外呼", async () => {
    const { updater, source, latest } = harness();
    expect(latest()).toEqual({ phase: "unsupported", currentVersion: "0.1.0", canCheck: false });
    expect(await updater.check()).toEqual(latest());
    expect(await updater.download()).toEqual(latest());
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(source.downloadUpdate).not.toHaveBeenCalled();
  });

  it("挂上更新源：可检查，且不自动下载", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    expect(latest().phase).toBe("idle");
    expect(latest().canCheck).toBe(true);
    expect(source.autoDownload).toBe(false);
    expect(source.autoInstallOnAppQuit).toBe(true);
  });

  it("attach 只认第一次（重复挂不产生第二组事件监听）", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    updater.attach(new FakeSource());
    source.fire("update-available", { version: "0.2.0" });
    expect(latest().availableVersion).toBe("0.2.0");
  });
});

describe("阶段迁移", () => {
  it("available → downloading → downloaded → install", async () => {
    const { updater, source, seen, latest } = harness();
    updater.attach(source);
    await updater.check();
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(latest().phase).toBe("checking");

    source.fire("update-available", { version: "0.2.0" });
    expect(latest()).toMatchObject({ phase: "available", availableVersion: "0.2.0" });

    void updater.download();
    expect(latest().phase).toBe("downloading");
    source.fire("download-progress", { percent: 37.6, transferred: 376, total: 1000 });
    expect(latest()).toMatchObject({ percent: 38, transferredBytes: 376, totalBytes: 1000 });
    source.fire("update-downloaded", { version: "0.2.0" });
    expect(latest()).toMatchObject({ phase: "downloaded", percent: 100 });

    updater.install();
    expect(source.quitAndInstall).toHaveBeenCalledTimes(1);
    // 每次变更都对外广播，UI 不需要轮询
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it("update-not-available 落到 up-to-date 并清掉旧版本号", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    source.fire("update-not-available");
    expect(latest().phase).toBe("up-to-date");
    expect(latest().availableVersion).toBeUndefined();
  });

  it("进度百分比钳在 0–100（上游偶发 NaN/超界不画歪）", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("download-progress", { percent: 140 });
    expect(latest().percent).toBe(100);
    source.fire("download-progress", { percent: -3 });
    expect(latest().percent).toBe(0);
    source.fire("download-progress", {});
    expect(latest().percent).toBe(0);
  });
});

describe("错误与守卫", () => {
  it("事件通道的 error 进快照，error 后可重新检查", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("error", { message: "404 Cannot find latest.yml" });
    expect(latest()).toMatchObject({ phase: "error", error: "404 Cannot find latest.yml" });
    source.fire("checking-for-update");
    expect(latest().phase).toBe("checking");
  });

  it("事件通道之外的 rejection 也收敛为 error，横幅不会停在旧阶段", async () => {
    const { updater, source, latest } = harness();
    source.checkForUpdates = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    updater.attach(source);
    const state = await updater.check();
    expect(state).toMatchObject({ phase: "error", error: "socket hang up" });
    expect(latest().phase).toBe("error");
  });

  it("同阶段重复触发不发二次外呼（连点检查/下载）", async () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.checkForUpdates = vi.fn(() => new Promise<undefined>(() => {}));
    void updater.check();
    expect(latest().phase).toBe("checking");
    await updater.check();
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("未下载完成不能安装", () => {
    const { updater, source } = harness();
    expect(() => updater.install()).toThrow(/没有可用的更新源/);
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    expect(() => updater.install()).toThrow(/尚未下载完成/);
  });
});
