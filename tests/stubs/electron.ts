/**
 * vitest 环境下的 electron 桩：主进程模块静态 import electron 的类型/函数，
 * 纯 Node 测试环境没有 Electron runtime，用桩顶替（仅测试用）。
 *
 * 关键设计（boot.test.ts 用）：`app.whenReady()` 返回**永不 resolve** 的 Promise
 * —— index.ts 的 `whenReady().then(createWindow)` 不会真的建窗口（headless 建不了），
 * 但模块顶层的装配代码（单实例锁、store/engine/downloader 构造、registerIpc、
 * updater 挂载路径）全部照常执行 → 确定性验证「加载主进程入口不崩 + IPC 注册齐」。
 */
export const shell = {
  showItemInFolder(_path: string): void {
    /* noop in tests */
  },
  openExternal(_url: string): Promise<void> {
    return Promise.resolve();
  },
};

const appListeners: Record<string, ((...a: unknown[]) => void)[]> = {};

export const app = {
  requestSingleInstanceLock: () => true,
  setAppUserModelId: (_id: string) => {},
  getVersion: () => "0.0.0-test",
  getPath: (name: string) => {
    if (name === "userData") return process.env.MG_TEST_USERDATA || "/tmp/mg-userData";
    return "/tmp/mg-downloads";
  },
  whenReady: () =>
    new Promise<void>(() => {
      /* 永不 resolve：headless 下跳过 createWindow */
    }),
  on: (event: string, cb: (...a: unknown[]) => void) => {
    (appListeners[event] ||= []).push(cb);
  },
  quit: () => {},
  /** 测试钩子：手动触发某生命周期事件 */
  _emit(event: string, ...args: unknown[]): void {
    for (const cb of appListeners[event] ?? []) cb(...args);
  },
  _listenerNames: () => Object.keys(appListeners),
};

export class BrowserWindow {
  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  webContents = {
    send: (_c: string, _p: unknown) => {},
    openDevTools: () => {},
    loadURL: async () => {},
    loadFile: async () => {},
    setWindowOpenHandler: () => {},
  };
  isDestroyed(): boolean {
    return true;
  }
  isMinimized(): boolean {
    return false;
  }
  on(): void {}
  once(): void {}
  focus(): void {}
  restore(): void {}
  show(): void {}
}

export const ipcMain = {
  _handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void {
    this._handlers.set(channel, listener);
  },
};

export const session = {
  defaultSession: {
    setPermissionRequestHandler: () => {},
  },
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const contextBridge = {
  exposeInMainWorld: (_name: string, _api: unknown) => {},
};

export const ipcRenderer = {
  invoke: async () => ({ ok: true, data: null }),
  on: () => {},
  removeListener: () => {},
};

export default {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  contextBridge,
  ipcRenderer,
};
