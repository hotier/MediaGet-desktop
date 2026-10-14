/**
 * 自动更新状态机（P6）
 *
 * electron-updater 的 `autoUpdater` 是一堆离散事件，renderer 要的是「一个能画出来的
 * 阶段」。本模块把事件收敛成 UpdateState 快照 + 变更回调，index.ts 只负责装配。
 *
 * 为什么默认 `autoDownload = false`：更新包几十 MB，静默吃用户的家庭带宽不合适；
 * 检查到版本后由横幅上的「下载更新」按钮显式触发。
 * `autoInstallOnAppQuit = true`：下载完成后用户正常退出即安装，横幅的「重启安装」
 * 只是提前生效的快捷方式。
 *
 * 为什么不静态 import electron-updater：该包在模块加载时会 require('electron')，
 * headless 测试环境（tests/stubs/electron.ts）拿不到真实 runtime —— index.ts 里
 * 动态 import 成功后再 attach，测试注入假源。
 */
import type { UpdateState } from "../../types/ipc";

/** `autoUpdater` 中被用到的那部分结构。 */
export interface UpdaterSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (payload: unknown) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface Updater {
  snapshot(): UpdateState;
  /** 挂上真实更新源；未挂上前一律 `unsupported`（dev / 发布源缺失）。 */
  attach(source: UpdaterSource): void;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** 仅在 `downloaded` 下有效，否则抛错（IPC 层转成错误信封）。 */
  install(): void;
}

interface ProgressPayload {
  percent?: number;
  transferred?: number;
  total?: number;
}

interface VersionPayload {
  version?: string;
}

export function createUpdater(opts: {
  currentVersion: string;
  onChange: (state: UpdateState) => void;
  source?: UpdaterSource;
}): Updater {
  let state: UpdateState = {
    phase: "unsupported",
    currentVersion: opts.currentVersion,
    canCheck: false,
  };
  let source: UpdaterSource | null = null;

  function commit(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch };
    opts.onChange(state);
  }

  function bind(target: UpdaterSource): void {
    target.autoDownload = false;
    target.autoInstallOnAppQuit = true;
    target.on("checking-for-update", () => commit({ phase: "checking", error: undefined }));
    target.on("update-available", (payload) =>
      commit({ phase: "available", availableVersion: (payload as VersionPayload)?.version })
    );
    target.on("update-not-available", () =>
      commit({ phase: "up-to-date", availableVersion: undefined, error: undefined })
    );
    target.on("download-progress", (payload) => {
      const p = (payload ?? {}) as ProgressPayload;
      commit({
        phase: "downloading",
        percent: Math.max(0, Math.min(100, Math.round(p.percent ?? 0))),
        transferredBytes: p.transferred ?? 0,
        totalBytes: p.total ?? 0,
      });
    });
    target.on("update-downloaded", (payload) => {
      const version = (payload as VersionPayload)?.version ?? state.availableVersion;
      commit({ phase: "downloaded", availableVersion: version, percent: 100 });
    });
    target.on("error", (payload) => {
      const err = (payload ?? {}) as { message?: string };
      commit({ phase: "error", error: err.message || String(payload) });
    });
  }

  function attach(target: UpdaterSource): void {
    if (source) return;
    source = target;
    bind(target);
    commit({ phase: "idle", canCheck: true });
  }

  if (opts.source) attach(opts.source);

  async function run(action: (s: UpdaterSource) => Promise<unknown>): Promise<UpdateState> {
    if (!source) return state;
    try {
      await action(source);
    } catch (e) {
      // 事件通道之外的 rejection（如发布源 404）也要落到状态里，否则横幅停在旧阶段。
      const err = e as { message?: string };
      commit({ phase: "error", error: err.message || String(e) });
    }
    return state;
  }

  return {
    snapshot: () => state,
    attach,
    check() {
      if (!source || state.phase === "checking") return Promise.resolve(state);
      // 乐观置位：真实事件是异步补发的，点了「检查更新」要立刻有反馈
      commit({ phase: "checking", error: undefined });
      return run((s) => s.checkForUpdates());
    },
    download() {
      if (!source || state.phase === "downloading") return Promise.resolve(state);
      commit({ phase: "downloading" });
      return run((s) => s.downloadUpdate());
    },
    install() {
      if (!source) throw new Error("当前环境没有可用的更新源");
      if (state.phase !== "downloaded") throw new Error("更新尚未下载完成");
      source.quitAndInstall();
    },
  };
}
