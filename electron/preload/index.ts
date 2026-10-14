/**
 * preload —— contextBridge 白名单（docs/ARCHITECTURE.md §2）
 *
 * 唯一渲染层入口：`window.mg`。禁止原样暴露 ipcRenderer / 通配转发；
 * 事件订阅只暴露三个受控 on* 且返回解绑函数，channel 名不出 preload。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type MgBridge, type DownloadTaskView } from "../../types/ipc";

type Invoke = <T>(channel: string, input?: unknown) => Promise<T>;
const invoke: Invoke = (channel, input) => ipcRenderer.invoke(channel, input);

function on(channel: string, cb: (t: DownloadTaskView) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: DownloadTaskView) => cb(payload);
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
  app: {
    pickDownloadDir: () => invoke("app:pickDownloadDir"),
    showInFolder: (path) => invoke("app:showInFolder", path),
    onUpdateAvailable: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, info: { version: string }) => cb(info);
      ipcRenderer.on(IPC.evUpdateAvailable, listener);
      return () => ipcRenderer.removeListener(IPC.evUpdateAvailable, listener);
    },
  },
};

contextBridge.exposeInMainWorld("mg", mg);
