/**
 * 自动更新状态机（P6）
 *
 * electron-updater 的 `autoUpdater` 是一堆离散事件，renderer 要的是「一个能画出来的
 * 阶段」。本模块把事件收敛成 UpdateState 快照 + 变更回调，index.ts 只负责装配。
 *
 * 为什么默认 `autoDownload = false`：更新包几十 MB，静默吃用户的家庭带宽不合适；
 * 检查到版本后由关于页的流式下载弹窗显式触发（设置里可开静默下载）。
 * `autoInstallOnAppQuit = false`：setup 包做不了无感静默安装，下载完成后不随退出
 * 自动进行，安装统一由更新卡片的「立即重启」显式触发。
 *
 * 为什么不静态 import electron-updater：该包在模块加载时会 require('electron')，
 * headless 测试环境（tests/stubs/electron.ts）拿不到真实 runtime —— index.ts 里
 * 动态 import 成功后再 attach，测试注入假源。
 */
import { CancellationToken } from "builder-util-runtime";
import type { UpdateState } from "../../types/ipc";

/** `autoUpdater` 中被用到的那部分结构（downloadUpdate 收 electron-updater 的取消令牌）。 */
export interface UpdaterSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (payload: unknown) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<unknown>;
  quitAndInstall(): void;
}

/** 更新策略（AppSettings 的「静默下载」落点；启动检查在 index.ts 把关，安装固定手动确认）。 */
export interface UpdaterPolicy {
  autoDownload: boolean;
}

export interface Updater {
  snapshot(): UpdateState;
  /** 挂上真实更新源；未挂上前一律 `unsupported`（dev / 发布源缺失）。 */
  attach(source: UpdaterSource): void;
  /** 设置保存后热更策略；未挂源时先记账，attach 时生效。 */
  setPolicy(policy: Partial<UpdaterPolicy>): void;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** 暂停进行中的下载（cancel 令牌）。仅 `downloading` 有效，其余返回当前快照。 */
  pause(): UpdateState;
  /** 继续下载：electron-updater 无断点续传，实为重新起流从头下载。 */
  resume(): Promise<UpdateState>;
  /** 取消下载：cancel 令牌中断传输（electron-updater 随即清掉已下 part），状态回落 available。 */
  cancel(): UpdateState;
  /** 仅在 `downloaded` 下有效，否则抛错（IPC 层转成错误信封）。 */
  install(): void;
}

interface ProgressPayload {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

interface ReleaseNote {
  version?: string;
  note?: string;
  description?: string;
}

interface VersionPayload {
  version?: string;
  releaseNotes?: string | ReleaseNote[] | null;
}

/** releaseNotes 归一化为纯文本：GitHub 给 ReleaseNote[]，generic 可能是 string；空则缺省。 */
function normalizeNotes(raw: string | ReleaseNote[] | null | undefined): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((r) => (r?.note ?? r?.description ?? "").trim())
      .filter(Boolean);
    return parts.length ? parts.join("\n\n") : undefined;
  }
  return undefined;
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
  // 不静默下载为默认（省带宽）；安装不随退出自动进行 —— setup 包做不了无感静默安装，
  // 统一由更新卡片「立即重启」显式触发
  let policy: UpdaterPolicy = { autoDownload: false };
  // 当前下载传输的取消令牌；pause 即 cancel 它，electron-updater 无断点续传，
  // resume 只能重新起流从头下载（见 types/ipc-contract.ts paused 阶段注释）。
  let dlToken: CancellationToken | null = null;
  // 已完整下载好的版本号：装好前一直是它。再次检测更新时，若发布的还是同一个版本，
  // 直接回到 downloaded（可安装）而非 available，避免重复起流/让用户误以为要重下
  // （electron-updater 命中缓存其实不会重取字节，但 UI 不该给「再下载」的错觉）。
  let downloadedVersion: string | null = null;

  function applyPolicy(target: UpdaterSource): void {
    target.autoDownload = policy.autoDownload;
    target.autoInstallOnAppQuit = false;
  }

  function commit(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch };
    opts.onChange(state);
  }

  function bind(target: UpdaterSource): void {
    applyPolicy(target);
    target.on("checking-for-update", () => commit({ phase: "checking", error: undefined }));
    target.on("update-available", (payload) => {
      const p = (payload ?? {}) as VersionPayload;
      const notes = normalizeNotes(p.releaseNotes);
      // 同一个版本已经下好 → 直接恢复「已下载完成」，不退回 available 诱导重复下载
      if (p.version && p.version === downloadedVersion) {
        commit({ phase: "downloaded", availableVersion: p.version, percent: 100, releaseNotes: notes });
        return;
      }
      commit({ phase: "available", availableVersion: p.version, releaseNotes: notes });
    });
    target.on("update-not-available", () =>
      commit({ phase: "up-to-date", availableVersion: undefined, error: undefined })
    );
    target.on("download-progress", (payload) => {
      // 暂停/完成/主动取消后残留的迟到进度事件一律丢弃（用 cancelled 令牌兜底取消态）
      if (state.phase === "paused" || state.phase === "downloaded") return;
      if (dlToken?.cancelled) return;
      const p = (payload ?? {}) as ProgressPayload;
      commit({
        phase: "downloading",
        percent: Math.max(0, Math.min(100, Math.round(p.percent ?? 0))),
        transferredBytes: p.transferred ?? 0,
        totalBytes: p.total ?? 0,
        bytesPerSecond: Math.max(0, Math.round(p.bytesPerSecond ?? 0)),
      });
    });
    target.on("update-downloaded", (payload) => {
      const version = (payload as VersionPayload)?.version ?? state.availableVersion;
      dlToken = null;
      downloadedVersion = version ?? downloadedVersion;
      commit({
        phase: "downloaded",
        availableVersion: version,
        percent: 100,
        bytesPerSecond: undefined,
      });
    });
    // 源播报取消（cancel 令牌后 electron-updater 触发）：仅在仍处 downloading 时兜底迁 paused；
    // 若已由 pause()/cancel() 显式落态则不覆盖
    target.on("update-cancelled", () => {
      if (state.phase === "downloading") commit({ phase: "paused", bytesPerSecond: undefined });
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

  async function run(
    action: (s: UpdaterSource) => Promise<unknown>,
    token?: CancellationToken
  ): Promise<UpdateState> {
    if (!source) return state;
    try {
      await action(source);
    } catch (e) {
      // pause()/cancel() 会 cancel 令牌，downloadUpdate 随即以 CancellationError reject；
      // electron-updater 的取消路径已清掉已下的 part —— 这是用户主动中断，不是故障，别覆写成 error。
      if (token?.cancelled) return state;
      // 事件通道之外的 rejection（如发布源 404）也要落到状态里，否则弹窗停在旧阶段。
      const err = e as { message?: string };
      commit({ phase: "error", error: err.message || String(e) });
    }
    return state;
  }

  function startDownload(): Promise<UpdateState> {
    if (!source) return Promise.resolve(state);
    const token = new CancellationToken();
    dlToken = token;
    commit({
      phase: "downloading",
      percent: 0,
      transferredBytes: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    });
    return run((s) => s.downloadUpdate(token), token);
  }

  return {
    snapshot: () => state,
    attach,
    setPolicy(next) {
      policy = { ...policy, ...next };
      if (source) applyPolicy(source);
    },
    check() {
      if (!source || state.phase === "checking") return Promise.resolve(state);
      // 乐观置位：真实事件是异步补发的，点了「检查更新」要立刻有反馈
      commit({ phase: "checking", error: undefined });
      return run((s) => s.checkForUpdates());
    },
    download() {
      if (!source) return Promise.resolve(state);
      // 已在下载中：返回当前快照，不重复起流
      if (state.phase === "downloading") return Promise.resolve(state);
      // 该版本已下载完成：直接返回「可安装」态，绝不重复下载（再次检测更新回到 available 时的兜底）
      if (state.phase === "downloaded" || (state.availableVersion && state.availableVersion === downloadedVersion)) {
        if (state.phase !== "downloaded") commit({ phase: "downloaded", percent: 100 });
        return Promise.resolve(state);
      }
      return startDownload();
    },
    pause() {
      // 仅 downloading 可暂停；cancel 令牌停止传输（electron-updater 会清掉当前 part），
      // 进度冻结在当前显示值。保留已 cancel 的令牌用于滤掉迟到事件，不置 null。
      if (state.phase !== "downloading") return state;
      dlToken?.cancel();
      commit({ phase: "paused", bytesPerSecond: undefined });
      return state;
    },
    resume() {
      if (!source) return Promise.resolve(state);
      if (state.phase !== "paused") return Promise.resolve(state);
      // 无断点续传：从头重新起流；percent 归零由新的 download-progress 事件重建
      return startDownload();
    },
    cancel() {
      // downloading / paused 都中止；cancel 令牌后 electron-updater 的取消路径清掉已下 part，
      // 状态回落 available（保留版本号与 changelog 以便重新下载），进度清零。
      if (state.phase !== "downloading" && state.phase !== "paused") return state;
      dlToken?.cancel();
      commit({
        phase: "available",
        percent: undefined,
        transferredBytes: undefined,
        totalBytes: undefined,
        bytesPerSecond: undefined,
      });
      return state;
    },
    install() {
      if (!source) throw new Error("当前环境没有可用的更新源");
      if (state.phase !== "downloaded") throw new Error("更新尚未下载完成");
      source.quitAndInstall();
    },
  };
}
