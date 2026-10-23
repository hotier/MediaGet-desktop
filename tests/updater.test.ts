/**
 * 自动更新状态机（P6）单测：假更新源驱动全阶段迁移，全程离线。
 *
 * 关心的是三件事：
 *  1. 阶段迁移与快照字段（UI 只读这一个对象）；
 *  2. autoDownload 必须关 —— 静默吃用户带宽不是可接受的默认；
 *  3. 守卫：无更新源不能检查，未下载完不能安装。
 */
import { describe, expect, it, vi } from "vitest";
import { CancellationError, CancellationToken } from "builder-util-runtime";
import { createUpdater, pickAutoUpdater, type UpdaterSource } from "../electron/main/updater";
import type { UpdateState } from "../types/ipc";

class FakeSource implements UpdaterSource {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  channel = "latest";
  allowPrerelease = false;
  quitAndInstall = vi.fn();
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn<UpdaterSource["downloadUpdate"]>(async () => undefined);
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

/** 让 downloadUpdate 真正理会取消令牌：cancel 即以 CancellationError reject（贴近 electron-updater）。 */
function tokenAwareDownload(source: FakeSource): void {
  source.downloadUpdate = vi.fn((token?: CancellationToken) =>
    new Promise<unknown>((_resolve, reject) => {
      token?.on("cancel", () => reject(new CancellationError()));
    })
  );
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

  it("挂上更新源：可检查，且不自动下载、不随退出自动安装", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    expect(latest().phase).toBe("idle");
    expect(latest().canCheck).toBe(true);
    expect(source.autoDownload).toBe(false);
    expect(source.autoInstallOnAppQuit).toBe(false);
  });

  it("attach 只认第一次（重复挂不产生第二组事件监听）", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    updater.attach(new FakeSource());
    source.fire("update-available", { version: "0.2.0" });
    expect(latest().availableVersion).toBe("0.2.0");
  });

  it("beta 通道铺到更新源：channel=beta + allowPrerelease=true；稳定版不覆盖源默认", () => {
    const beta = createUpdater({
      currentVersion: "0.3.0-beta.1",
      channel: "beta",
      allowPrerelease: true,
      onChange: () => {},
    });
    const betaSource = new FakeSource();
    beta.attach(betaSource);
    expect(betaSource.channel).toBe("beta");
    expect(betaSource.allowPrerelease).toBe(true);

    const stable = createUpdater({ currentVersion: "0.2.1", onChange: () => {} });
    const stableSource = new FakeSource();
    stable.attach(stableSource);
    expect(stableSource.channel).toBe("latest");
    expect(stableSource.allowPrerelease).toBe(false);
  });

  it("setPolicy：attach 前记账、attach 后热更；安装固定手动确认", () => {
    const { updater } = harness();
    updater.setPolicy({ autoDownload: true });
    // attach 前设置的策略要在挂载时一次性铺到 source 上
    const s2 = new FakeSource();
    updater.attach(s2);
    expect(s2.autoDownload).toBe(true);
    expect(s2.autoInstallOnAppQuit).toBe(false);
    // 已挂载后改策略立即回写（设置保存即生效，不等重启）
    updater.setPolicy({ autoDownload: false });
    expect(s2.autoDownload).toBe(false);
    // setup 包做不了无感静默安装：autoInstallOnAppQuit 恒为 false，安装只走「立即重启」
    updater.setPolicy({});
    expect(s2.autoInstallOnAppQuit).toBe(false);
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

describe("暂停与续下（流式下载弹窗依赖）", () => {
  it("downloading → pause：cancel 令牌停传输迁到 paused，取消 rejection 不覆写成 error", async () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    tokenAwareDownload(source);
    const p = updater.download();
    expect(latest().phase).toBe("downloading");
    const token = source.downloadUpdate.mock.calls[0]?.[0] as CancellationToken;
    expect(token).toBeInstanceOf(CancellationToken);
    expect(token.cancelled).toBe(false);
    updater.pause();
    expect(latest().phase).toBe("paused");
    expect(token.cancelled).toBe(true);
    // run() 守卫：识别 paused 主动取消，不把 CancellationError 收敛成 error 阶段
    const after = await p;
    expect(after.phase).toBe("paused");
    expect(latest().phase).toBe("paused");
  });

  it("paused → resume：重新起流从头下载（electron-updater 无断点续传）", async () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    tokenAwareDownload(source);
    void updater.download();
    updater.pause();
    expect(latest().phase).toBe("paused");
    void updater.resume();
    expect(latest().phase).toBe("downloading");
    expect(latest().percent).toBe(0);
    expect(source.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it("暂停后迟到的进度事件不会把状态冲回 downloading", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    updater.pause();
    expect(latest().phase).toBe("paused");
    source.fire("download-progress", { percent: 60 });
    expect(latest().phase).toBe("paused");
  });

  it("源播报 update-cancelled：downloading 兜底迁到 paused", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    expect(latest().phase).toBe("downloading");
    source.fire("update-cancelled");
    expect(latest().phase).toBe("paused");
  });

  it("cancel：中断传输回落 available 并清进度，取消 rejection 不覆写成 error", async () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    tokenAwareDownload(source);
    const p = updater.download();
    expect(latest().phase).toBe("downloading");
    const token = source.downloadUpdate.mock.calls[0]?.[0] as CancellationToken;
    const s = updater.cancel();
    expect(s.phase).toBe("available");
    expect(latest().percent).toBeUndefined();
    expect(latest().availableVersion).toBe("0.2.0"); // 版本/说明保留以便重新下载
    expect(token.cancelled).toBe(true);
    const after = await p;
    expect(after.phase).toBe("available");
    // 取消后残留进度事件（令牌已 cancel）不得把状态冲回 downloading
    source.fire("download-progress", { percent: 55 });
    expect(latest().phase).toBe("available");
  });

  it("cancel 也可从 paused 触发；非 downloading/paused 时无效", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    expect(updater.cancel().phase).toBe("idle"); // 未挂动作前 idle，取消无效
    source.fire("update-available", { version: "0.2.0" });
    expect(updater.cancel().phase).toBe("available"); // available 无进行中下载，取消无效
    void updater.download();
    updater.pause();
    expect(latest().phase).toBe("paused");
    expect(updater.cancel().phase).toBe("available"); // paused 可取消
  });
});

describe("changelog 与下载速度采集", () => {
  it("update-available 的 releaseNotes（数组）归一化为文本入快照", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", {
      version: "0.2.0",
      releaseNotes: [{ version: "0.2.0", note: "新增 A" }, { version: "0.1.9", note: "修复 B" }],
    });
    expect(latest()).toMatchObject({ phase: "available", availableVersion: "0.2.0" });
    expect(latest().releaseNotes).toBe("新增 A\n\n修复 B");
  });

  it("releaseNotes 为字符串时原样入快照；缺省则 undefined", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0", releaseNotes: "单行说明" });
    expect(latest().releaseNotes).toBe("单行说明");
    source.fire("update-available", { version: "0.3.0" });
    expect(latest().releaseNotes).toBeUndefined();
  });

  it("download-progress 采集 bytesPerSecond 落到 speed，进度事件建立 downloading", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    source.fire("download-progress", { percent: 40, transferred: 400, total: 1000, bytesPerSecond: 3_600_000 });
    expect(latest()).toMatchObject({ phase: "downloading", percent: 40, bytesPerSecond: 3_600_000 });
  });
});

describe("下载完成后不重复下载（再次检测/下载幂等）", () => {
  it("已 downloaded 后同版本 update-available 直接回 downloaded，不退回 available", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    source.fire("update-downloaded", { version: "0.2.0" });
    expect(latest().phase).toBe("downloaded");
    // 再次检测：同一版本发布回来 → 应保持「已下载完成」而非 available
    source.fire("update-available", { version: "0.2.0", releaseNotes: "again" });
    expect(latest().phase).toBe("downloaded");
    expect(latest().percent).toBe(100);
  });

  it("downloaded 后点下载不再起新流（downloadUpdate 不被二次调用）", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    source.fire("update-downloaded", { version: "0.2.0" });
    expect(source.downloadUpdate).toHaveBeenCalledTimes(1);
    void updater.download(); // 已下载完 → 直接返回可安装态
    expect(source.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(latest().phase).toBe("downloaded");
  });

  it("更高版本照常走 available（不被幂等误吞）", () => {
    const { updater, source, latest } = harness();
    updater.attach(source);
    source.fire("update-available", { version: "0.2.0" });
    void updater.download();
    source.fire("update-downloaded", { version: "0.2.0" });
    source.fire("update-available", { version: "0.3.0" }); // 版本不同
    expect(latest().phase).toBe("available");
    expect(latest().availableVersion).toBe("0.3.0");
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

/**
 * 事故回归（2026-10-21 安装版）：electron-updater 的 autoUpdater 是 defineProperty getter，
 * 打包后 cjs-module-lexer 探测不到它，`await import()` 的命名空间里只有 default 上有。
 * 旧代码直接解构 → undefined → attach 抛错被吞 → 界面永远「当前运行环境没有更新源」。
 */
describe("pickAutoUpdater（动态 import 命名空间取源）", () => {
  it("命名导出存在时直接取（dev/打包 CJS 均如此时优先）", () => {
    const named = { marker: "named" };
    expect(pickAutoUpdater({ autoUpdater: named, default: { autoUpdater: { marker: "default" } } })).toBe(named);
  });

  it("命名导出被 cjs-module-lexer 漏掉时回落到 default.autoUpdater", () => {
    const fallback = { marker: "default" };
    expect(pickAutoUpdater({ default: { autoUpdater: fallback } })).toBe(fallback);
  });

  it("两处都没有 = undefined（由调用方抛错并留痕，而不是拿 undefined 去 attach）", () => {
    expect(pickAutoUpdater({})).toBeUndefined();
    expect(pickAutoUpdater({ default: null })).toBeUndefined();
  });
});
