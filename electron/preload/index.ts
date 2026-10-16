/**
 * preload —— contextBridge 白名单（docs/ARCHITECTURE.md §2）
 *
 * 唯一渲染层入口：`window.mg`。禁止原样暴露 ipcRenderer / 通配转发；
 * 事件订阅只暴露三个受控 on* 且返回解绑函数，channel 名不出 preload。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type MgBridge, type UpdateState } from "../../types/ipc";

type Invoke = <T>(channel: string, input?: unknown) => Promise<T>;
const invoke: Invoke = (channel, input) => ipcRenderer.invoke(channel, input);

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const mg: MgBridge = {
  getMeta: () => invoke(IPC.appGetMeta),
  identify: (input) => invoke(IPC.parseIdentify, input),
  parse: (input) => invoke(IPC.parseRun, input),
  download: {
    enqueue: (input) => invoke(IPC.downloadEnqueue, input),
    cancel: (taskId) => invoke(IPC.downloadCancel, { taskId }),
    pause: (taskId) => invoke(IPC.downloadPause, { taskId }),
    resume: (taskId) => invoke(IPC.downloadResume, { taskId }),
    list: () => invoke(IPC.downloadList),
    clear: (taskIds) => invoke(IPC.downloadClear, { taskIds }),
    onProgress: (cb) => on(IPC.evDownloadProgress, cb),
    onDone: (cb) => on(IPC.evDownloadDone, cb),
    onError: (cb) => on(IPC.evDownloadError, cb),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch),
  },
  history: {
    list: (filter) => invoke(IPC.historyList, filter),
    clear: () => invoke(IPC.historyClear),
  },
  probe: {
    engines: () => invoke(IPC.probeEngines),
  },
  stats: {
    get: () => invoke(IPC.statsGet),
  },
  app: {
    pickDownloadDir: () => invoke(IPC.appPickDownloadDir),
    showInFolder: (path) => invoke(IPC.appShowInFolder, path),
    getBinaryStatus: () => invoke(IPC.appGetBinaryStatus),
    listFonts: () => invoke(IPC.appListFonts),
    cacheStatus: () => invoke(IPC.appCacheStatus),
    clearCache: (keys) => invoke(IPC.appCacheClear, { keys }),
    openLogDir: () => invoke(IPC.appOpenLogDir),
    log: (level, message) => invoke(IPC.appLog, { level, message }),
    onClipboardLink: (cb) => on(IPC.evClipboardLink, cb),
    update: {
      state: () => invoke(IPC.updateGetState),
      check: () => invoke(IPC.updateCheck),
      download: () => invoke(IPC.updateDownload),
      pause: () => invoke(IPC.updatePause),
      resume: () => invoke(IPC.updateResume),
      cancel: () => invoke(IPC.updateCancel),
      install: () => invoke(IPC.updateInstall),
      onState: (cb: (s: UpdateState) => void) => on(IPC.evUpdateState, cb),
    },
  },
};

contextBridge.exposeInMainWorld("mg", mg);
