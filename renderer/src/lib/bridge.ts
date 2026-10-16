/**
 * 对 preload `window.mg` 的类型化封装（docs/ARCHITECTURE.md §2 bridge.ts）
 *
 * renderer 唯一网络出口：所有跨进程调用经此，禁止直接拼 IPC channel 名。
 * 信封解包 + 错误对象化在这里统一做，页面代码只面对成功值 / BridgeError。
 */
import type {
  AppMeta,
  AppSettings,
  BinaryStatusReport,
  CacheClearResult,
  CacheItemKey,
  CacheStatus,
  ClearTasksResult,
  DownloadTaskView,
  EnqueueInput,
  EnqueueOutcome,
  EngineHealth,
  HistoryEntry,
  HistoryFilter,
  IdentifyOutcome,
  InvokeResult,
  LogSeverity,
  MgBridge,
  ParseInput,
  ParseRunOutcome,
  UpdateState,
} from "../../../types/ipc";

export class BridgeError extends Error {
  code: string;
  failType?: string;
  constructor(code: string, message: string, failType?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.failType = failType;
  }
}

function bridge(): MgBridge {
  if (!window.mg) {
    throw new BridgeError(
      "no-bridge",
      "preload 桥未注入：桌面客户端主进程未运行（浏览器直接打开页面无效）"
    );
  }
  return window.mg;
}

async function unwrap<T>(p: Promise<InvokeResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.data;
  throw new BridgeError(r.error.code, r.error.message, r.error.failType);
}

export const api = {
  getMeta: () => unwrap<AppMeta>(bridge().getMeta()),
  identify: (text: string) =>
    unwrap<IdentifyOutcome>(bridge().identify({ text })),
  parse: (input: ParseInput) =>
    unwrap<ParseRunOutcome>(bridge().parse(input)),
  download: {
    enqueue: (input: EnqueueInput) =>
      unwrap<EnqueueOutcome>(bridge().download.enqueue(input)),
    cancel: (taskId: string) => unwrap(bridge().download.cancel(taskId)),
    pause: (taskId: string) => unwrap(bridge().download.pause(taskId)),
    resume: (taskId: string) => unwrap(bridge().download.resume(taskId)),
    list: () => unwrap<DownloadTaskView[]>(bridge().download.list()),
    clear: (taskIds: string[]) => unwrap<ClearTasksResult>(bridge().download.clear(taskIds)),
    onProgress: (cb: (t: DownloadTaskView) => void) => bridge().download.onProgress(cb),
    onDone: (cb: (t: DownloadTaskView) => void) => bridge().download.onDone(cb),
    onError: (cb: (t: DownloadTaskView) => void) => bridge().download.onError(cb),
  },
  settings: {
    get: () => unwrap<AppSettings>(bridge().settings.get()),
    set: (patch: Partial<AppSettings>) =>
      unwrap<AppSettings>(bridge().settings.set(patch)),
  },
  history: {
    list: (filter?: HistoryFilter) =>
      unwrap<HistoryEntry[]>(bridge().history.list(filter)),
    clear: () => unwrap(bridge().history.clear()),
  },
  probe: {
    engines: () => unwrap<EngineHealth[]>(bridge().probe.engines()),
  },
  app: {
    pickDownloadDir: () => unwrap<string | null>(bridge().app.pickDownloadDir()),
    showInFolder: (path: string) => unwrap(bridge().app.showInFolder(path)),
    getBinaryStatus: () => unwrap<BinaryStatusReport>(bridge().app.getBinaryStatus()),
    listFonts: () => unwrap<string[]>(bridge().app.listFonts()),
    cacheStatus: () => unwrap<CacheStatus>(bridge().app.cacheStatus()),
    clearCache: (keys: CacheItemKey[]) => unwrap<CacheClearResult>(bridge().app.clearCache(keys)),
    openLogDir: () => unwrap(bridge().app.openLogDir()),
    /** 转发失败不该再生出一条转发（上报通道自身故障时无处可报）：静默吞掉 */
    log: async (level: LogSeverity, message: string) => {
      try {
        await bridge().app.log(level, message);
      } catch {
        /* 见上 */
      }
    },
    onClipboardLink: (cb: (o: IdentifyOutcome) => void) => bridge().app.onClipboardLink(cb),
    update: {
      state: () => unwrap<UpdateState>(bridge().app.update.state()),
      check: () => unwrap<UpdateState>(bridge().app.update.check()),
      download: () => unwrap<UpdateState>(bridge().app.update.download()),
      pause: () => unwrap<UpdateState>(bridge().app.update.pause()),
      resume: () => unwrap<UpdateState>(bridge().app.update.resume()),
      cancel: () => unwrap<UpdateState>(bridge().app.update.cancel()),
      install: () => unwrap(bridge().app.update.install()),
      onState: (cb: (s: UpdateState) => void) => bridge().app.update.onState(cb),
    },
  },
};
